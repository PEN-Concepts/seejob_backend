'use strict';

/**
 * Notepad hub — the boss's task manager (CCP 2026-09-08).
 *
 * Mounted at the SAME base path as routes/checklists.js and BEFORE it, so the
 * specific paths here (/hub, /access/*, /sections/order) win over
 * checklists.js's /sections/:id wildcards. Everything the old file does still
 * works untouched; this adds the collaboration layer on top.
 *
 * Every rule in §6, §7 and §9 is enforced HERE, server-side, on the request —
 * never by hiding a button. The verification checklist's permission block is
 * meant to be run with curl against these endpoints.
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const Joi = require('joi');
const auth = require('../services/authentication');
const logger = require('../common/logger');
const { getAccessMode } = require('../utils/access');
const { ensureNotepadSchema } = require('../services/notepadSchema');
const { requireNotepadMyTasks, publicFlags, mergeArmed, clientInviteArmed } = require('../services/featureFlags');
const notify = require('../services/notify');
const { logDestructiveJob } = require('../services/destructiveLog');
const mailer = require('../services/mailer');
const multer = require('multer');
const path = require('path');

// C9c: notepad row photos land in the same uploads dir the rest of the app
// uses, and are served by the existing express.static('/uploads') mount.
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
  filename: (req, file, cb) => cb(null, 'np-' + Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname)),
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 12 * 1024 * 1024 },
  // Images only. A non-image is rejected silently rather than 500ing.
  // C25: a TASK takes PICTURES only. Plans and PDFs live on the notepad,
  // where one link serves every task on the pad instead of the same document
  // hanging off six rows. A non-image is rejected rather than 500ing.
  fileFilter: (req, file, cb) => cb(null, String(file.mimetype || '').startsWith('image/')),
});
const {
  accountOwnerOf,
  isAccountOwner,
  isFullAccess,
  listAllowlist,
  getSectionAccess,
  isShareable,
  isSubcontractor,
  ensureNoJobNotepad,
  ensurePrivatePadsForDelegatedWork,
} = require('../services/notepadAccess');

// Contact categories (utils/access.js documents the model):
//   1 = employee-class (includes Family/Friend)  2 = contractor / subcontractor
//   3 = client
const CATEGORY_EMPLOYEE = 1;
const CATEGORY_CONTRACTOR = 2;
const CATEGORY_CLIENT = 3;

// §8: the merge is built but disarmed. Read live (not cached at require time)
// so flipping the env only needs a restart, and the tests can toggle it.

async function withConn(fn) {
  const connection = await pool.getConnection();
  try {
    return await fn(connection);
  } finally {
    connection.release();
  }
}

/** Expired-free users keep reading their pads but cannot write. */
async function canWrite(connection, userId) {
  try {
    return (await getAccessMode(userId, connection)) !== 'expired_free';
  } catch (e) {
    return true; // fail open, like the rest of the app
  }
}

function firstNameOf(full) {
  const s = String(full || '').trim();
  return s.split(/\s+/)[0] || s;
}

// ───────────────────────────────────────────────────────────────────────────
// §5 §7  GET /hub — the whole Notepads page in one read.
//
// Returns, for the caller:
//   - every pad they may see: their own, plus (if on the allowlist) every
//     COMPANY job/lead pad on the account, plus any pad live-shared with them
//   - the address READ LIVE from job/leads — never a stored copy, so fixing a
//     typo on the job updates every notepad and Maps link with no rewrite
//   - per-USER card order (§4)
//   - per-row author (§7) and delegation state (§3)
// ───────────────────────────────────────────────────────────────────────────
router.get('/hub', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      // NOTE: no back-fill here. Creating a job or lead creates its notepad
      // (the forward path, in routes/jobs.js and routes/leads.js). Back-filling
      // PRE-EXISTING jobs used to happen right here, on every page load, which
      // meant a page view silently bulk-inserted one row per job and per lead on
      // the account. That is now a one-off the owner approves:
      //   node scripts/backfillNotepads.js --report

      const owner = await accountOwnerOf(connection, uid);
      const full = await isFullAccess(connection, uid);

      // 3c: every user has a 'No Job Assigned' pad. One idempotent insert, not
      // the O(jobs) back-fill the note above retired — cheap enough to sit on
      // a page read, which is the only way "every user gets one" is true for
      // accounts that existed before this shipped.
      //
      // C40: except a SUBCONTRACTOR with no plan of their own. That pad is
      // for their own work, which is the paid half of the product; the free
      // half is the work the GC sends them.
      const callerIsSub = await isSubcontractor(connection, uid);
      const subMayOwnWork = !callerIsSub || (await subCanStartNotepad(connection, uid));
      if (subMayOwnWork) await ensureNoJobNotepad(connection, uid);

      // 3b/5b: an off-list user (a lower-level employee, or a subcontractor,
      // who is not an account member at all) gets a private pad for each job
      // they actually have delegated work on. Without it their work would be
      // re-homed into 'No Job Assigned' — visible, but filed under the wrong
      // heading. Bounded by the work they have been given, not by the size of
      // the account.
      if (!full) await ensurePrivatePadsForDelegatedWork(connection, uid);

      // Visibility, expressed once in SQL so a direct API call obeys exactly the
      // same rule the UI does.
      //   own pads                       always
      //   company pads on my account     only when on the allowlist
      //   pads live-shared with me       always
      const where = [`s.owner_user_id = ${connection.escape(uid)}`];
      if (full) {
        where.push(
          `(s.scope = 'company' AND COALESCE(s.account_owner_id, s.owner_user_id) = ${connection.escape(owner)})`,
        );
      }
      where.push(
        `EXISTS (SELECT 1 FROM checklist_section_shares sh WHERE sh.section_id = s.id AND sh.user_id = ${connection.escape(uid)})`,
      );

      const [sections] = await connection.query(
        `SELECT
            s.id, s.owner_user_id, s.type, s.title, s.job_id, s.lead_id,
            s.origin, s.scope, s.account_owner_id,
            COALESCE(o.sort_order, s.sort_order, 0) AS sort_order,
            j.name  AS job_name,
            j.color AS job_color,
            TRIM(CONCAT_WS(', ',
                 NULLIF(j.job_address, ''),
                 NULLIF(j.job_city, ''),
                 TRIM(CONCAT_WS(' ', NULLIF(j.job_state, ''), NULLIF(j.job_zipcode, '')))
            )) AS job_address,
            l.lead_name AS lead_name,
            l.project_street_address AS lead_address,
            owner.name AS owner_name,
            (SELECT COUNT(*) FROM checklist_section_shares sh2
              WHERE sh2.section_id = s.id AND sh2.is_client = 1) AS client_share_count,
            -- Any live share at all, client or colleague. Drives the share
            -- icon's "this has been shared" state, which was previously a
            -- guess made from the client count alone.
            (SELECT COUNT(*) FROM checklist_section_shares sh3
              WHERE sh3.section_id = s.id) AS share_count
          FROM checklist_sections s
          LEFT JOIN checklist_section_order o ON o.section_id = s.id AND o.user_id = ?
          LEFT JOIN \`job\`  j ON j.id = s.job_id
          LEFT JOIN leads    l ON l.id = s.lead_id
          LEFT JOIN \`user\` owner ON owner.id = s.owner_user_id
         WHERE (${where.join(' OR ')})
         ORDER BY sort_order ASC, s.id ASC`,
        [uid],
      );

      const ids = sections.map((s) => Number(s.id));
      let items = [];
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const [rows] = await connection.query(
          `SELECT
              c.id, c.section_id, c.name, c.photo, c.priority, c.due_date, c.status,
              c.assignee_completed, c.created_by, c.delegated_task_id, c.delegated_to,
              c.note,
              u.name AS created_by_name,
              du.name AS delegated_to_name,
              t.assignee_completed AS task_assignee_completed,
              t.status AS task_status
            FROM check_list c
            LEFT JOIN \`user\` u  ON u.id  = c.created_by
            LEFT JOIN \`user\` du ON du.id = c.delegated_to
            LEFT JOIN tasks t     ON t.id  = c.delegated_task_id
           WHERE c.section_id IN (${ph})
           ORDER BY (c.status = 'completed') ASC, (c.priority = 'high') DESC, c.id DESC`,
          ids,
        );
        items = rows;
      }

      // ── C9b/C9c: photos and the note flag, per row ─────────────────────
      // Two small extra reads rather than joins on the main query: a JOIN
      // against a one-to-many image table would multiply the item rows and
      // every consumer would have to de-duplicate them.
      const imagesByItem = new Map();
      const threadCountByItem = new Map();
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        try {
          const [imgs] = await connection.query(
            `SELECT i.id, i.item_id, i.filename, i.created_at
               FROM checklist_item_images i
               JOIN check_list c ON c.id = i.item_id
              WHERE c.section_id IN (${ph})
              ORDER BY i.id ASC`,
            ids,
          );
          for (const im of imgs) {
            const k = Number(im.item_id);
            if (!imagesByItem.has(k)) imagesByItem.set(k, []);
            imagesByItem.get(k).push({ id: Number(im.id), filename: im.filename, created_at: im.created_at });
          }
        } catch (e) {
          logger.error('notepad hub images read failed: ' + e.message);
        }
        try {
          // A delegated row can also carry the two-way thread. Either source
          // lights the paperclip.
          const [rn] = await connection.query(
            `SELECT c.id AS item_id, COUNT(n.id) AS n
               FROM check_list c
               JOIN checklist_item_notes n ON n.item_id = c.id
              WHERE c.section_id IN (${ph})
              GROUP BY c.id`,
            ids,
          );
          for (const r of rn) {
            threadCountByItem.set(Number(r.item_id), (threadCountByItem.get(Number(r.item_id)) || 0) + Number(r.n || 0));
          }
          const [tn] = await connection.query(
            `SELECT c.id AS item_id, COUNT(n.id) AS n
               FROM check_list c
               JOIN task_notes n ON n.task_id = c.delegated_task_id
              WHERE c.section_id IN (${ph}) AND c.delegated_task_id IS NOT NULL
              GROUP BY c.id`,
            ids,
          );
          for (const r of tn) threadCountByItem.set(Number(r.item_id), Number(r.n || 0));
        } catch (e) {
          logger.error('notepad hub thread-count read failed: ' + e.message);
        }
      }

      // ── 3b — DELEGATED WORK FOLLOWS THE PERSON, NOT THE NOTEPAD ──────────
      //
      // An off-list user has no My Tasks page (3a), so this is the ONLY place
      // their assigned work appears. The row itself lives in a company pad
      // they cannot see, so we fetch it separately and re-home it into their
      // own private pad for the same job.
      //
      // Strictly `c.delegated_to = uid`. Never a row delegated to anyone else,
      // and never an undelegated row from a pad they have no business reading —
      // this must not become a side door into the company's notepads.
      let borrowed = [];
      if (!full) {
        const [rows] = await connection.query(
          `SELECT
              c.id, c.section_id, c.name, c.photo, c.priority, c.due_date, c.status,
              c.assignee_completed, c.created_by, c.delegated_task_id, c.delegated_to,
              u.name AS created_by_name,
              du.name AS delegated_to_name,
              t.assignee_completed AS task_assignee_completed,
              t.status AS task_status,
              s.job_id AS src_job_id, s.lead_id AS src_lead_id
            FROM check_list c
            JOIN checklist_sections s ON s.id = c.section_id
            LEFT JOIN \`user\` u  ON u.id  = c.created_by
            LEFT JOIN \`user\` du ON du.id = c.delegated_to
            LEFT JOIN tasks t     ON t.id  = c.delegated_task_id
           WHERE c.delegated_to = ?
             AND COALESCE(s.account_owner_id, s.owner_user_id) = ?
             AND s.owner_user_id <> ?
           ORDER BY (c.status = 'completed') ASC, (c.priority = 'high') DESC, c.id DESC`,
          [uid, owner, uid],
        );
        borrowed = rows;

        // C42: the borrowed rows live in sections this caller cannot see, so
        // the per-section reads above skipped their photos and notes. Without
        // this the sub's own photo vanished from the strip the moment they
        // reopened the sheet, and no paperclip ever appeared on the row.
        if (borrowed.length) {
          const bids = borrowed.map((r) => Number(r.id));
          const bph = bids.map(() => '?').join(',');
          try {
            const [imgs] = await connection.query(
              `SELECT id, item_id, filename, created_at, mime, original_name, job_document_id
                 FROM checklist_item_images
                WHERE item_id IN (${bph})
                ORDER BY id ASC`,
              bids,
            );
            for (const im of imgs) {
              const k = Number(im.item_id);
              if (!imagesByItem.has(k)) imagesByItem.set(k, []);
              imagesByItem.get(k).push({
                id: Number(im.id),
                filename: im.filename,
                created_at: im.created_at,
                mime: im.mime || null,
                original_name: im.original_name || null,
                job_document_id: im.job_document_id == null ? null : Number(im.job_document_id),
              });
            }
          } catch (e) {
            logger.error('notepad hub borrowed-images read failed: ' + e.message);
          }
          try {
            const [bn] = await connection.query(
              `SELECT item_id, COUNT(*) AS n FROM checklist_item_notes
                WHERE item_id IN (${bph}) GROUP BY item_id`,
              bids,
            );
            for (const r of bn) {
              threadCountByItem.set(Number(r.item_id), (threadCountByItem.get(Number(r.item_id)) || 0) + Number(r.n || 0));
            }
          } catch (e) {
            logger.error('notepad hub borrowed-notes read failed: ' + e.message);
          }
        }
      }

      const bySection = new Map();
      for (const it of items) {
        const key = Number(it.section_id);
        if (!bySection.has(key)) bySection.set(key, []);
        bySection.get(key).push({
          ...it,
          // §3 pill state, computed once here so both platforms agree.
          //   'none'      -> gold-outline "Delegate"
          //   'delegated' -> green "Delegated"
          //   'done'      -> green "✓ <first name>"
          delegate_state: !it.delegated_task_id
            ? 'none'
            : Number(it.task_assignee_completed) === 1
              ? 'done'
              : 'delegated',
          delegated_first_name: firstNameOf(it.delegated_to_name),
          is_self_assigned: it.delegated_to != null && Number(it.delegated_to) === uid,
          can_edit: Number(it.created_by) === uid, // default rule: your own typing only
          // C9b/C9c — what the row's indicators read from.
          note: it.note || null,
          has_note: !!String(it.note || '').trim() || (threadCountByItem.get(Number(it.id)) || 0) > 0,
          images: imagesByItem.get(Number(it.id)) || [],
        });
      }

      // 3b: place each borrowed row in the caller's own pad for the same job or
      // lead. If they have none — the private pad was never created, or the row
      // came from a pad with no job behind it — it lands in their
      // 'No Job Assigned' pad, which 3c guarantees exists. Nothing is dropped:
      // a task you cannot see is worse than one filed in the wrong place.
      // C26: RECEIVED applies to SUBCONTRACTORS. An off-list employee sees
      // delegated work on their own pad too, but they may still keep private
      // notes there — that is what the §8 merge is for. Only a sub gets the
      // read-only, orange 'this list was sent to you' treatment.
      // (callerIsSub is resolved once, near the top of this handler.)
      // C26: which of MY pads are showing somebody else's delegated work.
      // A pad in that state is a RECEIVED list: the company owns what is on
      // it, so it is read-only apart from check off, note and photo.
      const receivedPads = new Set();
      if (borrowed.length) {
        const padForJob = new Map();
        const padForLead = new Map();
        let noJobPadId = null;
        for (const sec of sections) {
          if (Number(sec.owner_user_id) !== uid) continue;
          if (sec.job_id != null) padForJob.set(Number(sec.job_id), Number(sec.id));
          else if (sec.lead_id != null) padForLead.set(Number(sec.lead_id), Number(sec.id));
          else if (noJobPadId == null) noJobPadId = Number(sec.id);
        }
        for (const it of borrowed) {
          const target =
            (it.src_job_id != null && padForJob.get(Number(it.src_job_id))) ||
            (it.src_lead_id != null && padForLead.get(Number(it.src_lead_id))) ||
            noJobPadId;
          if (!target) continue;
          receivedPads.add(target);
          if (!bySection.has(target)) bySection.set(target, []);
          bySection.get(target).push({
            ...it,
            section_id: target,
            delegate_state: Number(it.task_assignee_completed) === 1 ? 'done' : 'delegated',
            delegated_first_name: firstNameOf(it.delegated_to_name),
            is_self_assigned: false,
            // 3b: check off, note and photo. Nothing else. They did not write
            // these words and they are not the boss of this task.
            can_edit: false,
            can_delete: false,
            can_delegate: false,
            delegated_to_me: true,
            // C42: same two fields the owner's copy of this row carries, read
            // from the same tables — so the sub and the sender cannot
            // disagree about whether a photo or a note exists.
            note: it.note || null,
            has_note: !!String(it.note || '').trim() || (threadCountByItem.get(Number(it.id)) || 0) > 0,
            images: imagesByItem.get(Number(it.id)) || [],
          });
        }
      }

      // C25: plan count per section, so the header pill can carry a number.
      const planCount = new Map();
      const inheritedPlanCount = new Map();
      if (sections.length) {
        const sph = sections.map(() => '?').join(',');
        try {
          const [pc] = await connection.query(
            // Counts BOTH kinds of link. Counting only job_document_id left
            // every lead notepad's badge reading zero while its plans dialog
            // showed the files.
            `SELECT section_id, COUNT(*) AS n FROM checklist_section_files
              WHERE section_id IN (${sph}) GROUP BY section_id`,
            sections.map((x) => Number(x.id)),
          );
          for (const r of pc) planCount.set(Number(r.section_id), Number(r.n || 0));
        } catch (e) {
          logger.error('notepad hub plan-count read failed: ' + e.message);
        }
      }

      // C26: a received pad inherits the company pad's PLANS for the same
      // job. The sub cannot see the company notepad, but the drawings are
      // exactly what they need to do the work, so the plans travel with the
      // task rather than with the pad.
      if (receivedPads.size) {
        try {
          const jobIds = sections
            .filter((x) => receivedPads.has(Number(x.id)) && x.job_id != null)
            .map((x) => Number(x.job_id));
          if (jobIds.length) {
            const jph = jobIds.map(() => '?').join(',');
            const [inherited] = await connection.query(
              `SELECT s2.job_id, COUNT(*) AS n
                 FROM checklist_section_files f
                 JOIN checklist_sections s2 ON s2.id = f.section_id
                WHERE s2.job_id IN (${jph}) AND s2.scope = 'company'
                GROUP BY s2.job_id`,
              jobIds,
            );
            for (const r of inherited) inheritedPlanCount.set(Number(r.job_id), Number(r.n || 0));
          }
        } catch (e) {
          logger.error('notepad hub inherited-plan read failed: ' + e.message);
        }
      }

      // C40: HIDDEN, never deleted. A sub who lapses keeps whatever they
      // wrote — it reappears intact the day they subscribe. Deleting a
      // person's notes because their card expired would be indefensible.
      const visibleSections = subMayOwnWork
        ? sections
        : sections.filter((x) => !(x.job_id == null && x.lead_id == null));

      const data = visibleSections.map((s) => {
        const isLead = s.lead_id != null;
        return {
          ...s,
          // Live address: job wins, then lead. Never persisted on the section.
          address: (isLead ? s.lead_address : s.job_address) || '',
          display_name: s.title || s.job_name || s.lead_name || 'Notepad',
          kind: isLead ? 'lead' : s.job_id != null ? 'job' : 'plain',
          shareable: isShareable(s), // §9 hand-made pads only
          client_shared: Number(s.client_share_count || 0) > 0,
          shared_with_anyone: Number(s.share_count || 0) > 0,
          items: bySection.get(Number(s.id)) || [],
          plan_count: planCount.get(Number(s.id)) || 0,
          // C26: this pad is showing work the company delegated to me.
          // Check off, note and photo only — no new tasks, no editing theirs.
          received: callerIsSub && receivedPads.has(Number(s.id)),
          // A received pad shows the company pad's plans for the same job.
          inherited_plan_count: s.job_id != null ? (inheritedPlanCount.get(Number(s.job_id)) || 0) : 0,
        };
      });

      // The "SHARED WITH" header row (§6) travels with the page so both
      // platforms render it from one source.
      const allowlist = await listAllowlist(connection, owner);
      const iAmOwner = await isAccountOwner(connection, uid);

      let pendingMerge = null;
      const [pm] = await connection.query(
        `SELECT id, owner_user_id, item_count FROM notepad_merge_queue
          WHERE employee_user_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1`,
        [uid],
      );
      if (pm.length) pendingMerge = { id: pm[0].id, item_count: Number(pm[0].item_count || 0) };

      res.status(200).json({
        success: true,
        data,
        access: {
          full_access: full,
          is_account_owner: iAmOwner,
          // C39: may this person start a notepad of their own? Only a
          // subcontractor is ever told no, and only when they have no plan
          // and no trial. Sent so the client can hide the button; the server
          // refuses independently.
          can_create_notepad: subMayOwnWork,
          can_delegate: full, // §6 "This IS the delegate permission"
          can_share: full,
          allowlist,
        },
        pending_merge: pendingMerge,
      });
    });
  } catch (err) {
    logger.error('notepad hub read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// §6  The allowlist.
// ───────────────────────────────────────────────────────────────────────────

router.get('/access', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const owner = await accountOwnerOf(connection, uid);
      res.json({
        success: true,
        full_access: await isFullAccess(connection, uid),
        is_account_owner: await isAccountOwner(connection, uid),
        allowlist: await listAllowlist(connection, owner),
      });
    });
  } catch (err) {
    logger.error('notepad access read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Who the owner can add. Employees and Family only — a client or a
 * subcontractor is never given company-wide notepad access.
 */
router.get('/access/candidates', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      if (!(await isAccountOwner(connection, uid))) {
        return res
          .status(403)
          .json({ success: false, code: 'NOTEPAD_GRANT_OWNER_ONLY', message: 'Only the account owner can manage access.' });
      }
      const [rows] = await connection.query(
        `SELECT u.id, u.name, u.email, sc.name AS subcategory
           FROM \`user\` u
           LEFT JOIN subcategory sc ON sc.id = u.subcategory
          WHERE u.created_by = ? AND u.category = ?
            AND NOT EXISTS (SELECT 1 FROM notepad_access a WHERE a.owner_user_id = ? AND a.user_id = u.id)
          ORDER BY u.name ASC`,
        [uid, CATEGORY_EMPLOYEE, uid],
      );
      res.json({
        success: true,
        data: rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          first_name: firstNameOf(r.name),
          email: r.email,
          is_family: String(r.subcategory || '') === 'Family/Friend',
        })),
      });
    });
  } catch (err) {
    logger.error('notepad access candidates error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * §8 step 1 — the count the owner sees BEFORE anything moves.
 * Read-only. Moves nothing, enqueues nothing.
 */
router.post('/access/preview', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const target = Number(req.body && req.body.user_id);
  if (!target) return res.status(400).json({ success: false, message: 'user_id is required' });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      if (!(await isAccountOwner(connection, uid))) {
        return res
          .status(403)
          .json({ success: false, code: 'NOTEPAD_GRANT_OWNER_ONLY', message: 'Only the account owner can manage access.' });
      }
      const preview = await previewMerge(connection, uid, target);
      res.json({ success: true, ...preview });
    });
  } catch (err) {
    logger.error('notepad access preview error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * §6 grant + §8 step 1 commit. Grants full access and ENQUEUES the merge.
 * The merge itself does NOT run here — it runs on the employee's Continue.
 */
router.post('/access/grant', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const target = Number(req.body && req.body.user_id);
  if (!target) return res.status(400).json({ success: false, message: 'user_id is required' });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      if (!(await isAccountOwner(connection, uid))) {
        return res
          .status(403)
          .json({ success: false, code: 'NOTEPAD_GRANT_OWNER_ONLY', message: 'Only the account owner can grant access.' });
      }
      if (!(await canWrite(connection, uid))) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Notepads.' });
      }
      // The grantee must be an employee-class member of THIS account. A
      // subcontractor or client id is rejected outright.
      const [[u]] = await connection.query(
        'SELECT id, name, category, created_by FROM `user` WHERE id = ? LIMIT 1',
        [target],
      );
      if (!u || Number(u.created_by) !== uid || Number(u.category) !== CATEGORY_EMPLOYEE) {
        return res
          .status(403)
          .json({ success: false, code: 'NOTEPAD_GRANT_NOT_ELIGIBLE', message: 'That person cannot be given notepad access.' });
      }

      const preview = await previewMerge(connection, uid, target);

      await connection.query(
        'INSERT IGNORE INTO notepad_access (owner_user_id, user_id, granted_by) VALUES (?, ?, ?)',
        [uid, target, uid],
      );
      if (preview.count > 0) {
        // Step 2 is queued, not run. The employee's own Continue triggers it, so
        // they get the chance to delete anything private first.
        const [existing] = await connection.query(
          `SELECT id FROM notepad_merge_queue WHERE owner_user_id = ? AND employee_user_id = ? AND status = 'pending' LIMIT 1`,
          [uid, target],
        );
        if (existing.length) {
          await connection.query('UPDATE notepad_merge_queue SET item_count = ? WHERE id = ?', [
            preview.count,
            existing[0].id,
          ]);
        } else {
          await connection.query(
            'INSERT INTO notepad_merge_queue (owner_user_id, employee_user_id, item_count) VALUES (?, ?, ?)',
            [uid, target, preview.count],
          );
        }
      }

      res.json({
        success: true,
        granted: true,
        merge_queued: preview.count > 0,
        ...preview,
        message:
          preview.count > 0
            ? `${firstNameOf(u.name)} now has full access. ${preview.count} item${preview.count === 1 ? '' : 's'} will move once they confirm.`
            : `${firstNameOf(u.name)} now has full access.`,
      });
    });
  } catch (err) {
    logger.error('notepad access grant error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * §8 REVOKE. The rows they contributed STAY in the company notepads (their
 * created_by is untouched, so authorship survives). Their private job pads are
 * re-created empty on their next read — there is no un-merge.
 */
router.delete('/access/:userId', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const target = Number(req.params.userId);
  if (!target) return res.status(400).json({ success: false, message: 'Invalid user id' });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      if (!(await isAccountOwner(connection, uid))) {
        return res
          .status(403)
          .json({ success: false, code: 'NOTEPAD_GRANT_OWNER_ONLY', message: 'Only the account owner can revoke access.' });
      }
      await connection.query('DELETE FROM notepad_access WHERE owner_user_id = ? AND user_id = ?', [uid, target]);
      await connection.query(
        `UPDATE notepad_merge_queue SET status = 'cancelled'
          WHERE owner_user_id = ? AND employee_user_id = ? AND status = 'pending'`,
        [uid, target],
      );
      res.json({ success: true, revoked: true });
    });
  } catch (err) {
    logger.error('notepad access revoke error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// §8  The merge. TWO STEPS. Step 2 runs on the EMPLOYEE's Continue, and even
// then only when NOTEPAD_MERGE_ARMED=1 — otherwise it is a dry run that logs
// and reports what it WOULD have moved.
// ───────────────────────────────────────────────────────────────────────────

/**
 * What would move: every item in the employee's PRIVATE auto job/lead pads,
 * paired with the company pad it would land in.
 */
async function previewMerge(connection, ownerId, employeeId) {
  const [rows] = await connection.query(
    `SELECT s.id AS from_section_id, s.title, s.job_id, s.lead_id, COUNT(c.id) AS n
       FROM checklist_sections s
       JOIN check_list c ON c.section_id = s.id
      WHERE s.owner_user_id = ? AND s.origin = 'auto' AND s.scope = 'private'
      GROUP BY s.id, s.title, s.job_id, s.lead_id
      HAVING n > 0`,
    [employeeId],
  );
  const notepads = rows.map((r) => ({
    from_section_id: Number(r.from_section_id),
    title: r.title,
    job_id: r.job_id,
    lead_id: r.lead_id,
    items: Number(r.n),
  }));
  return { count: notepads.reduce((a, b) => a + b.items, 0), notepads };
}

router.get('/access/merge/pending', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const [rows] = await connection.query(
        `SELECT q.id, q.owner_user_id, q.item_count, u.name AS owner_name
           FROM notepad_merge_queue q
           LEFT JOIN \`user\` u ON u.id = q.owner_user_id
          WHERE q.employee_user_id = ? AND q.status = 'pending'
          ORDER BY q.id ASC LIMIT 1`,
        [uid],
      );
      if (!rows.length) return res.json({ success: true, pending: null });
      res.json({
        success: true,
        pending: {
          id: Number(rows[0].id),
          item_count: Number(rows[0].item_count || 0),
          owner_name: rows[0].owner_name || 'the account owner',
        },
      });
    });
  } catch (err) {
    logger.error('notepad merge pending error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * The EMPLOYEE's Continue. This is the only path that can move rows.
 *
 * DISARMED BY DEFAULT. Without NOTEPAD_MERGE_ARMED=1 it does a full dry run:
 * it resolves every source pad and destination pad, counts the rows, writes a
 * notepad_merge_log row with dry_run=1, and returns the counts — moving
 * nothing and leaving the queue entry pending.
 */
router.post('/access/merge/confirm', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const [q] = await connection.query(
        `SELECT id, owner_user_id FROM notepad_merge_queue
          WHERE employee_user_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1`,
        [uid],
      );
      if (!q.length) return res.json({ success: true, merged: 0, message: 'Nothing to merge.' });
      const queueId = Number(q[0].id);
      const ownerId = Number(q[0].owner_user_id);

      const { notepads } = await previewMerge(connection, ownerId, uid);
      const plan = [];
      for (const pad of notepads) {
        const dest = await findOrCreateCompanyPad(connection, ownerId, pad);
        const [items] = await connection.query('SELECT id FROM check_list WHERE section_id = ?', [
          pad.from_section_id,
        ]);
        plan.push({
          from_section_id: pad.from_section_id,
          to_section_id: dest,
          title: pad.title,
          item_ids: items.map((r) => Number(r.id)),
        });
      }
      const total = plan.reduce((a, p) => a + p.item_ids.length, 0);

      // Log first, always — armed or not. "Log every merge: who, how many rows,
      // which notepads." A dry run is still a merge attempt worth reading back.
      for (const p of plan) {
        await connection.query(
          `INSERT INTO notepad_merge_log
             (owner_user_id, employee_user_id, from_section_id, to_section_id, rows_moved, item_ids, dry_run)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [ownerId, uid, p.from_section_id, p.to_section_id, p.item_ids.length, p.item_ids.join(','), mergeArmed() ? 0 : 1],
        );
      }

      await logDestructiveJob(connection, {
        kind: 'notepad_merge',
        accountOwnerId: ownerId,
        actorId: uid,
        summary: mergeArmed()
          ? `Merged ${total} item(s) from private job notepads into the company notepads across ${plan.length} notepad(s).`
          : `WOULD merge ${total} item(s) from private job notepads into the company notepads across ${plan.length} notepad(s). Merge is switched off.`,
        detail: JSON.stringify(plan.map((p) => ({ notepad: p.title, rows: p.item_ids.length, item_ids: p.item_ids }))),
        rowsAffected: total,
        dryRun: mergeArmed() ? 0 : 1,
      });

      if (!mergeArmed()) {
        logger.info(
          `[notepad-merge DRY RUN] employee=${uid} owner=${ownerId} would move ${total} row(s) across ${plan.length} notepad(s). Set NOTEPAD_MERGE_ARMED=1 to arm.`,
        );
        return res.json({
          success: true,
          armed: false,
          merged: 0,
          would_merge: total,
          notepads: plan.map((p) => ({ title: p.title, rows: p.item_ids.length })),
          message: `Dry run: ${total} item(s) would move. The merge is disarmed in this build.`,
        });
      }

      await connection.beginTransaction();
      try {
        for (const p of plan) {
          if (!p.item_ids.length || !p.to_section_id) continue;
          // No de-duplication — users manage duplicates themselves (§8).
          await connection.query('UPDATE check_list SET section_id = ? WHERE section_id = ?', [
            p.to_section_id,
            p.from_section_id,
          ]);
        }
        await connection.query(
          `UPDATE notepad_merge_queue SET status = 'done', confirmed_at = NOW() WHERE id = ?`,
          [queueId],
        );
        await connection.commit();
      } catch (e) {
        await connection.rollback();
        throw e;
      }
      logger.info(`[notepad-merge] employee=${uid} owner=${ownerId} moved ${total} row(s).`);
      res.json({ success: true, armed: true, merged: total });
    });
  } catch (err) {
    logger.error('notepad merge confirm error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/** The company pad an employee's private pad merges into, created if missing. */
async function findOrCreateCompanyPad(connection, ownerId, pad) {
  const col = pad.job_id ? 'job_id' : 'lead_id';
  const val = pad.job_id || pad.lead_id;
  if (!val) return null;
  const [[hit]] = await connection.query(
    `SELECT id FROM checklist_sections
      WHERE owner_user_id = ? AND origin = 'auto' AND scope = 'company' AND ${col} = ? LIMIT 1`,
    [ownerId, val],
  );
  if (hit) return Number(hit.id);
  const [r] = await connection.query(
    `INSERT INTO checklist_sections
       (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
     VALUES (?, NULL, 'task', ?, 0, ?, ?, 'auto', 'company', ?)`,
    [ownerId, pad.title, pad.job_id || null, pad.lead_id || null, ownerId],
  );
  return Number(r.insertId);
}

// ───────────────────────────────────────────────────────────────────────────
// §4  Per-user card order. Saved ON DROP.
// ───────────────────────────────────────────────────────────────────────────
const orderSchema = Joi.object({
  order: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
});

router.put('/sections/order', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const { error, value } = orderSchema.validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      // Only order pads the caller can actually see — a stray id from another
      // account must not create a phantom order row.
      const rows = [];
      for (let i = 0; i < value.order.length; i++) {
        const access = await getSectionAccess(connection, value.order[i], uid);
        if (access) rows.push([uid, Number(value.order[i]), i]);
      }
      if (!rows.length) return res.json({ success: true, saved: 0 });
      await connection.query(
        `INSERT INTO checklist_section_order (user_id, section_id, sort_order) VALUES ?
         ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)`,
        [rows],
      );
      res.json({ success: true, saved: rows.length });
    });
  } catch (err) {
    logger.error('notepad order save error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// §9  Per-notepad live share — hand-made pads only.
// ───────────────────────────────────────────────────────────────────────────

router.get('/sections/:id/share-candidates', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const sectionId = Number(req.params.id);
  try {
    await withConn(async (connection) => {
      const access = await getSectionAccess(connection, sectionId, uid);
      if (!access || access.role === 'share') {
        return res.status(403).json({ success: false, message: 'You cannot share this notepad.' });
      }
      if (!isShareable(access.section)) {
        return res.status(403).json({
          success: false,
          code: 'NOTEPAD_AUTO_NOT_SHAREABLE',
          message: 'Job and lead notepads cannot be shared.',
        });
      }
      const owner = await accountOwnerOf(connection, uid);
      // CONTRACTORS AND SUBCONTRACTORS ARE EXCLUDED — from the list here and,
      // independently, at the share endpoint below.
      const [rows] = await connection.query(
        `SELECT u.id, u.name, u.email, u.category, sc.name AS subcategory
           FROM \`user\` u
           LEFT JOIN subcategory sc ON sc.id = u.subcategory
          WHERE u.created_by = ? AND u.category IN (?, ?) AND u.id <> ?
          ORDER BY u.name ASC`,
        [owner, CATEGORY_EMPLOYEE, CATEGORY_CLIENT, uid],
      );
      const groups = { employees: [], family: [], clients: [] };
      for (const r of rows) {
        const entry = { id: Number(r.id), name: r.name, email: r.email };
        if (Number(r.category) === CATEGORY_CLIENT) groups.clients.push(entry);
        else if (String(r.subcategory || '') === 'Family/Friend') groups.family.push(entry);
        else groups.employees.push(entry);
      }
      const [already] = await connection.query(
        `SELECT sh.user_id, sh.invited_email, sh.is_client, u.name
           FROM checklist_section_shares sh
           LEFT JOIN \`user\` u ON u.id = sh.user_id
          WHERE sh.section_id = ?`,
        [sectionId],
      );
      res.json({
        success: true,
        groups,
        shared_with: already.map((a) => ({
          user_id: Number(a.user_id || 0),
          name: a.name || a.invited_email,
          first_name: firstNameOf(a.name || a.invited_email),
          is_client: Number(a.is_client) === 1,
          pending_invite: !a.user_id,
        })),
      });
    });
  } catch (err) {
    logger.error('notepad share candidates error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const liveShareSchema = Joi.object({
  user_id: Joi.number().integer().positive().allow(null).optional(),
  email: Joi.string().email().allow('', null).optional(),
  // The client-invite path sends an email. Nothing reaches a client silently:
  // the client MUST have confirmed the warning before this arrives.
  confirm_email: Joi.boolean().optional(),
}).or('user_id', 'email');

router.post('/sections/:id/live-share', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const sectionId = Number(req.params.id);
  const { error, value } = liveShareSchema.validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    await withConn(async (connection) => {
      const access = await getSectionAccess(connection, sectionId, uid);
      if (!access || access.role === 'share') {
        return res.status(403).json({ success: false, message: 'You cannot share this notepad.' });
      }
      if (!(await canWrite(connection, uid))) {
        return res.status(403).json({ success: false, message: 'Your plan does not allow modifying Notepads.' });
      }
      // §9 the share icon appears ONLY on hand-made pads — and the API says so
      // too, so a crafted request cannot share a job pad.
      if (!isShareable(access.section)) {
        return res.status(403).json({
          success: false,
          code: 'NOTEPAD_AUTO_NOT_SHAREABLE',
          message: 'Job and lead notepads cannot be shared.',
        });
      }

      let isClient = 0;
      let targetId = Number(value.user_id || 0);
      let invitedEmail = null;

      if (targetId) {
        const [[u]] = await connection.query(
          'SELECT id, name, email, category FROM `user` WHERE id = ? LIMIT 1',
          [targetId],
        );
        if (!u) return res.status(404).json({ success: false, message: 'That person was not found.' });
        // Reject subcontractor ids at the API — independently of the list.
        if (Number(u.category) === CATEGORY_CONTRACTOR) {
          return res.status(403).json({
            success: false,
            code: 'NOTEPAD_SHARE_SUBCONTRACTOR_REJECTED',
            message: 'Notepads cannot be shared with contractors or subcontractors.',
          });
        }
        isClient = Number(u.category) === CATEGORY_CLIENT ? 1 : 0;
      } else {
        // Not-yet-joined client. An email WILL be sent, so the caller must have
        // ticked the confirmation.
        invitedEmail = String(value.email || '').trim().toLowerCase();
        isClient = 1;
        if (!value.confirm_email) {
          return res.status(400).json({
            success: false,
            code: 'NOTEPAD_SHARE_NEEDS_EMAIL_CONFIRM',
            message: 'Sending an invitation email needs explicit confirmation.',
          });
        }
      }

      await connection.query(
        `INSERT IGNORE INTO checklist_section_shares
           (section_id, user_id, invited_email, is_client, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [sectionId, targetId || 0, invitedEmail, isClient, uid],
      );

      let emailSent = false;
      if (invitedEmail) {
        const title = access.section.title || 'a notepad';
        // DISARMED BY DEFAULT, like the merge. The share is RECORDED either way,
        // so the client gets access the moment they sign in — but nothing leaves
        // the building until the owner has armed it and watched it fire once.
        // "Nothing reaches a client without Poul's review" (§15) is the rule;
        // this makes it true of the transport, not just the confirmation dialog.
        if (!clientInviteArmed()) {
          logger.info(
            `[notepad-client-invite DRY RUN] section=${sectionId} to=${invitedEmail} — share recorded, NO email sent. Set NOTEPAD_CLIENT_INVITE_ARMED=1 to arm.`,
          );
          await logDestructiveJob(connection, {
            kind: 'client_invite',
            actorId: uid,
            summary: `Would email an invitation to ${invitedEmail} for notepad "${title}"`,
            detail: JSON.stringify({ section_id: sectionId, to: invitedEmail }),
            dryRun: 1,
          });
        } else {
          try {
            await mailer.sendMail({
              to: invitedEmail,
              subject: `You've been given access to "${title}" on See Job Run`,
              text: `You have been given access to the list "${title}" on See Job Run. Sign in with this email address to see it.`,
              html: `<p>You have been given access to the list <strong>${String(title).replace(/</g, '&lt;')}</strong> on See Job Run.</p><p>Sign in with this email address to see it. It stays live — anything the sender changes, you see.</p>`,
            });
            emailSent = true;
            await logDestructiveJob(connection, {
              kind: 'client_invite',
              actorId: uid,
              summary: `Emailed an invitation to ${invitedEmail} for notepad "${title}"`,
              detail: JSON.stringify({ section_id: sectionId, to: invitedEmail }),
              dryRun: 0,
            });
          } catch (e) {
            logger.error('notepad client invite email failed: ' + e.message);
          }
        }
      } else if (targetId) {
        try {
          await notify.insertNotification(connection, {
            senderId: uid,
            receiverId: targetId,
            content: `You were given access to the notepad "${access.section.title}".`,
            url: '/m/notepad',
          });
        } catch (e) {
          /* best-effort */
        }
      }

      res.json({
        success: true,
        shared: true,
        // Distinguish "an email went out" from "we recorded it but the sender is
        // switched off", so the UI can say which actually happened.
        emailed: emailSent,
        email_pending: !!invitedEmail && !emailSent,
      });
    });
  } catch (err) {
    logger.error('notepad live share error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/sections/:id/live-share/:userId', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const sectionId = Number(req.params.id);
  const target = Number(req.params.userId);
  try {
    await withConn(async (connection) => {
      const access = await getSectionAccess(connection, sectionId, uid);
      if (!access || access.role === 'share') {
        return res.status(403).json({ success: false, message: 'You cannot change this notepad.' });
      }
      await connection.query('DELETE FROM checklist_section_shares WHERE section_id = ? AND user_id = ?', [
        sectionId,
        target,
      ]);
      res.json({ success: true, revoked: true });
    });
  } catch (err) {
    logger.error('notepad live share revoke error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Feature flags. Deliberately NOT gated: the client has to be able to ask
// whether the rebuild is switched on, and a 404 here would be indistinguishable
// from an old backend that predates the flag. Both answers mean the same thing
// to the client (fall back), but this one is explicit.
// ───────────────────────────────────────────────────────────────────────────
router.get('/feature-flags', auth.authenticateToken, (req, res) => {
  res.json({ success: true, flags: publicFlags() });
});

// ───────────────────────────────────────────────────────────────────────────
// Migration-policy rule 9 — the owner-readable activity log.
//
// Every gated job (merge, purge, client invite, back-fill) writes a row to
// destructive_job_log, armed or dry-run. This serves it back to the ACCOUNT
// OWNER so he can read what happened, or what would have happened, without a
// shell or a database client. Owner-only: it is a record of things done to his
// data, and nobody else's business.
// ───────────────────────────────────────────────────────────────────────────
router.get('/admin/activity', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      if (!(await isAccountOwner(connection, uid))) {
        return res.status(403).json({
          success: false,
          code: 'ACTIVITY_OWNER_ONLY',
          message: 'Only the account owner can read the activity log.',
        });
      }
      const [rows] = await connection.query(
        `SELECT l.id, l.kind, l.summary, l.detail, l.rows_affected, l.dry_run, l.created_at,
                u.name AS actor_name
           FROM destructive_job_log l
           LEFT JOIN \`user\` u ON u.id = l.actor_user_id
          WHERE l.account_owner_id = ? OR l.account_owner_id IS NULL
          ORDER BY l.id DESC
          LIMIT 200`,
        [uid],
      );
      res.json({
        success: true,
        data: rows.map((r) => ({
          id: Number(r.id),
          kind: r.kind,
          summary: r.summary,
          detail: r.detail,
          rows_affected: Number(r.rows_affected || 0),
          // The UI leans on this: a dry run must never read like it happened.
          happened: Number(r.dry_run) === 0,
          actor_name: r.actor_name || null,
          created_at: r.created_at,
        })),
      });
    });
  } catch (err) {
    logger.error('activity log read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

// ═══════════════════════════════════════════════════════════════════════════
// C9c — PHOTOS ON A NOTEPAD ROW
//
// check_list.photo is a single VARCHAR and cannot hold a set, so images live
// in checklist_item_images. Access is decided by the row's SECTION, not by the
// row: if you may read the notepad you may see its pictures, and 3b's
// delegated-row rule already says an assignee may add a photo even though they
// may not edit the words.
// ═══════════════════════════════════════════════════════════════════════════

/** The section a row belongs to, plus how this caller relates to it. */
/**
 * C39 mirror of the server-side gate in routes/checklists.js, so the client
 * can hide a button it would only be refused for pressing. Deliberately NOT
 * getAccessMode(): role 12 is in NEVER_GATED_ROLES, which is what keeps
 * received work free, so that call always answers "paid" for a sub.
 */
const SUB_TRIAL_DAYS = 60;
async function subCanStartNotepad(connection, userId) {
  try {
    const [subs] = await connection.query(
      "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
      [Number(userId)],
    );
    if (subs.length) return true;
    const [[u]] = await connection.query(
      'SELECT created_at FROM `user` WHERE id = ? LIMIT 1',
      [Number(userId)],
    );
    if (!u || !u.created_at) return true;   // unknown age: fail OPEN
    return Date.now() - new Date(u.created_at).getTime() <= SUB_TRIAL_DAYS * 86400000;
  } catch (e) {
    return true;   // never hide a control because a lookup hiccuped
  }
}

async function itemSectionAccess(connection, itemId, uid) {
  const [[row]] = await connection.query(
    'SELECT id, section_id, created_by, delegated_to, delegated_task_id FROM check_list WHERE id = ? LIMIT 1',
    [Number(itemId)],
  );
  if (!row) return null;

  const access = await getSectionAccess(connection, row.section_id, uid);
  if (access) return { row, access };

  // C19: EVERYONE CONNECTED TO THE ROW CAN JOIN THE CONVERSATION.
  //
  // Section access alone was too narrow. A row in a COMPANY pad delegated to
  // an off-list worker is invisible to them as a section — 3b re-homes it
  // into their own pad only for display — so the section check said no, and
  // the person the task actually belongs to could not read or answer the
  // notes about their own work.
  //
  // This widens the CONVERSATION only. The 'assignee' role is narrower than
  // owner everywhere it is checked, and it does not hand over the section:
  // they still cannot see the rest of the pad.
  if (Number(row.delegated_to || 0) === Number(uid)) {
    return { row, access: { section: null, role: 'assignee' } };
  }

  // A SECONDARY assignee on the linked task is just as connected to it as
  // the primary one.
  if (row.delegated_task_id) {
    const [m] = await connection.query(
      'SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ? LIMIT 1',
      [Number(row.delegated_task_id), Number(uid)],
    );
    if (m.length) return { row, access: { section: null, role: 'assignee' } };
  }

  return null;
}

router.get('/items/:id/photos', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const found = await itemSectionAccess(connection, req.params.id, uid);
      if (!found) return res.status(403).json({ success: false, message: 'Not your notepad.' });
      const [rows] = await connection.query(
        'SELECT id, filename, uploaded_by, created_at, mime, original_name, job_document_id FROM checklist_item_images WHERE item_id = ? ORDER BY id ASC',
        [Number(req.params.id)],
      );
      res.json({ success: true, data: rows });
    });
  } catch (err) {
    logger.error('notepad item photos read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post(
  '/items/:id/photos',
  auth.authenticateToken,
  requireNotepadMyTasks,
  photoUpload.array('photos', 10),
  async (req, res) => {
    const uid = Number(res.locals.id);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, message: 'No files uploaded.' });
    try {
      await withConn(async (connection) => {
        await ensureNotepadSchema(connection);
        const found = await itemSectionAccess(connection, req.params.id, uid);
        if (!found) return res.status(403).json({ success: false, message: 'Not your notepad.' });
        for (const f of files) {
          await connection.query(
            'INSERT INTO checklist_item_images (item_id, filename, uploaded_by, mime, original_name) VALUES (?, ?, ?, ?, ?)',
            [Number(req.params.id), f.filename, uid, f.mimetype || null, f.originalname || null],
          );
        }
        const [rows] = await connection.query(
          'SELECT id, filename, uploaded_by, created_at, mime, original_name, job_document_id FROM checklist_item_images WHERE item_id = ? ORDER BY id ASC',
          [Number(req.params.id)],
        );
        res.status(201).json({ success: true, data: rows });
      });
    } catch (err) {
      logger.error('notepad item photo upload error: ' + err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  },
);

router.delete('/photos/:imageId', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const [[img]] = await connection.query(
        'SELECT id, item_id, filename, uploaded_by FROM checklist_item_images WHERE id = ? LIMIT 1',
        [Number(req.params.imageId)],
      );
      if (!img) return res.status(404).json({ success: false, message: 'No such photo.' });
      const found = await itemSectionAccess(connection, img.item_id, uid);
      if (!found) return res.status(403).json({ success: false, message: 'Not your notepad.' });
      // Your own picture, or the notepad is yours. A share recipient cannot
      // delete somebody else's photo.
      const mine = Number(img.uploaded_by) === uid;
      if (!mine && found.access.role !== 'owner' && found.access.role !== 'full') {
        return res.status(403).json({ success: false, message: 'You can only remove photos you added.' });
      }
      await connection.query('DELETE FROM checklist_item_images WHERE id = ?', [Number(req.params.imageId)]);
      res.json({ success: true, deleted: true });
    });
  } catch (err) {
    logger.error('notepad item photo delete error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// C19 — THE ROW NOTE IS A THREAD
//
// One note per row could not be replied to. These endpoints back a chat-style
// panel: author, initials and timestamp per message.
//
// The legacy check_list.note is migrated in on first read rather than by a
// destructive backfill — nothing already typed is lost, and no migration has
// to be approved to ship this.
// ═══════════════════════════════════════════════════════════════════════════

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((x) => x[0].toUpperCase()).join('');
}

/** Fold a legacy single note into the thread, once, the first time it is read. */
async function absorbLegacyNote(connection, itemId) {
  const [[row]] = await connection.query(
    'SELECT id, note, created_by FROM check_list WHERE id = ? LIMIT 1',
    [Number(itemId)],
  );
  if (!row || !String(row.note || '').trim()) return;
  const [[existing]] = await connection.query(
    'SELECT COUNT(*) AS n FROM checklist_item_notes WHERE item_id = ?',
    [Number(itemId)],
  );
  if (Number(existing.n) > 0) return;
  await connection.query(
    'INSERT INTO checklist_item_notes (item_id, user_id, body) VALUES (?, ?, ?)',
    [Number(itemId), row.created_by || null, String(row.note)],
  );
}

router.get('/items/:id/notes', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const found = await itemSectionAccess(connection, req.params.id, uid);
      if (!found) return res.status(403).json({ success: false, message: 'Not your notepad.' });
      await absorbLegacyNote(connection, req.params.id);
      const [rows] = await connection.query(
        `SELECT n.id, n.body, n.created_at, n.user_id, u.name AS author_name
           FROM checklist_item_notes n
           LEFT JOIN \`user\` u ON u.id = n.user_id
          WHERE n.item_id = ?
          ORDER BY n.id ASC`,
        [Number(req.params.id)],
      );
      res.json({
        success: true,
        data: rows.map((r) => ({
          id: Number(r.id),
          body: r.body,
          created_at: r.created_at,
          user_id: r.user_id == null ? null : Number(r.user_id),
          author_name: r.author_name || 'Someone',
          initials: initialsOf(r.author_name),
          is_mine: Number(r.user_id) === uid,
        })),
      });
    });
  } catch (err) {
    logger.error('notepad item notes read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const itemNoteSchema = Joi.object({ body: Joi.string().trim().min(1).max(4000).required() });

router.post('/items/:id/notes', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const { error, value } = itemNoteSchema.validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const found = await itemSectionAccess(connection, req.params.id, uid);
      if (!found) return res.status(403).json({ success: false, message: 'Not your notepad.' });
      await absorbLegacyNote(connection, req.params.id);
      const [r] = await connection.query(
        'INSERT INTO checklist_item_notes (item_id, user_id, body) VALUES (?, ?, ?)',
        [Number(req.params.id), uid, value.body],
      );
      const [[me]] = await connection.query('SELECT name FROM `user` WHERE id = ? LIMIT 1', [uid]);
      res.status(201).json({
        success: true,
        data: {
          id: Number(r.insertId),
          body: value.body,
          created_at: new Date(),
          user_id: uid,
          author_name: (me && me.name) || 'You',
          initials: initialsOf(me && me.name),
          is_mine: true,
        },
      });
    });
  } catch (err) {
    logger.error('notepad item note write error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// C24 — ATTACH A PLAN OR PDF FROM THE JOB'S FILES
//
// Deliberately a LINK, not an upload. Plans live in the job's Files and are
// versioned there; copying a plan set onto a notepad row would leave two
// files that drift apart, and the field would have no way to tell which was
// current. Photos are still uploaded, because a photo taken on a phone has no
// other home.
// ═══════════════════════════════════════════════════════════════════════════

/** The job (or lead) a row's notepad hangs off, for scoping the file list. */
async function rowJobContext(connection, itemId) {
  const [[r]] = await connection.query(
    `SELECT s.job_id, s.lead_id
       FROM check_list c
       JOIN checklist_sections s ON s.id = c.section_id
      WHERE c.id = ? LIMIT 1`,
    [Number(itemId)],
  );
  return r || { job_id: null, lead_id: null };
}

router.get('/items/:id/job-files', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const found = await itemSectionAccess(connection, req.params.id, uid);
      if (!found) return res.status(403).json({ success: false, message: 'Not your notepad.' });

      const ctx = await rowJobContext(connection, req.params.id);
      if (!ctx.job_id) {
        // No job behind this notepad, so there are no job files to offer. Not
        // an error — the picker simply says so.
        return res.json({ success: true, data: [], reason: 'NO_JOB' });
      }
      const [rows] = await connection.query(
        'SELECT id, name, path, type FROM job_documents WHERE job_id = ? ORDER BY id DESC',
        [Number(ctx.job_id)],
      );
      res.json({ success: true, data: rows });
    });
  } catch (err) {
    logger.error('notepad row job-files read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const linkFilesSchema = Joi.object({
  document_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(20).required(),
});

router.post('/items/:id/job-files', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const { error, value } = linkFilesSchema.validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const found = await itemSectionAccess(connection, req.params.id, uid);
      if (!found) return res.status(403).json({ success: false, message: 'Not your notepad.' });

      const ctx = await rowJobContext(connection, req.params.id);
      if (!ctx.job_id) {
        return res.status(400).json({ success: false, code: 'NO_JOB', message: 'This notepad has no job to take files from.' });
      }
      // Only documents belonging to THIS job. A document id from another job
      // is refused outright rather than silently ignored.
      const ph = value.document_ids.map(() => '?').join(',');
      const [docs] = await connection.query(
        `SELECT id, name, path, type FROM job_documents WHERE job_id = ? AND id IN (${ph})`,
        [Number(ctx.job_id), ...value.document_ids],
      );
      if (docs.length !== value.document_ids.length) {
        return res.status(403).json({ success: false, message: 'Those files are not on this job.' });
      }
      for (const d of docs) {
        // Idempotent: linking the same plan twice is a no-op, not a duplicate.
        const [[dupe]] = await connection.query(
          'SELECT id FROM checklist_item_images WHERE item_id = ? AND job_document_id = ? LIMIT 1',
          [Number(req.params.id), Number(d.id)],
        );
        if (dupe) continue;
        await connection.query(
          `INSERT INTO checklist_item_images (item_id, filename, uploaded_by, mime, original_name, job_document_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [Number(req.params.id), d.path || '', uid, null, d.name || null, Number(d.id)],
        );
      }
      const [rows] = await connection.query(
        `SELECT id, filename, uploaded_by, created_at, mime, original_name, job_document_id
           FROM checklist_item_images WHERE item_id = ? ORDER BY id ASC`,
        [Number(req.params.id)],
      );
      res.status(201).json({ success: true, data: rows });
    });
  } catch (err) {
    logger.error('notepad row job-file link error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// C25 — PLANS ON THE NOTEPAD
//
// A plan set describes the whole job, not one line of it. Attached per task
// the same PDF ended up hanging off six rows; on the section, one link serves
// every task on the pad. Tasks keep PHOTOS only.
//
// Still a LINK to job_documents, never a copy: plans are versioned in the job
// Files, and a duplicate here would drift from whatever the job holds.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What a section hangs off, for scoping which documents may be offered.
 * A notepad belongs to a job OR a lead, never both, and each keeps its files
 * in its own table.
 */
async function sectionSource(connection, sectionId) {
  const [[r]] = await connection.query(
    'SELECT job_id, lead_id FROM checklist_sections WHERE id = ? LIMIT 1',
    [Number(sectionId)],
  );
  if (r && r.job_id) return { kind: 'job', id: Number(r.job_id) };
  if (r && r.lead_id) return { kind: 'lead', id: Number(r.lead_id) };
  return null;
}

/** The documents a source offers, normalised to one shape. */
async function sourceDocuments(connection, src) {
  if (!src) return [];
  const table = src.kind === 'lead' ? 'lead_documents' : 'job_documents';
  const col = src.kind === 'lead' ? 'lead_id' : 'job_id';
  try {
    const [rows] = await connection.query(
      `SELECT id, name, path, type FROM ${table} WHERE ${col} = ? ORDER BY id DESC`,
      [src.id],
    );
    return rows;
  } catch (e) {
    // lead_documents is absent on some installs. An empty list is the honest
    // answer; a 500 would make the whole plans dialog look broken.
    logger.error('notepad plans: ' + table + ' read failed: ' + e.message);
    return [];
  }
}

/** Everything linked to a section, from either table, in one shape. */
async function linkedPlans(connection, sectionId) {
  const [jobLinks] = await connection.query(
    `SELECT f.id, f.job_document_id, NULL AS lead_document_id, d.name, d.path, d.type
       FROM checklist_section_files f
       JOIN job_documents d ON d.id = f.job_document_id
      WHERE f.section_id = ? AND f.job_document_id IS NOT NULL
      ORDER BY f.id ASC`,
    [Number(sectionId)],
  );
  let leadLinks = [];
  try {
    const [rows] = await connection.query(
      `SELECT f.id, NULL AS job_document_id, f.lead_document_id, d.name, d.path, d.type
         FROM checklist_section_files f
         JOIN lead_documents d ON d.id = f.lead_document_id
        WHERE f.section_id = ? AND f.lead_document_id IS NOT NULL
        ORDER BY f.id ASC`,
      [Number(sectionId)],
    );
    leadLinks = rows;
  } catch (e) { /* no lead_documents table on this install */ }
  return [...jobLinks, ...leadLinks];
}

router.get('/sections/:id/plans', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const access = await getSectionAccess(connection, req.params.id, uid);
      if (!access) return res.status(403).json({ success: false, message: 'Not your notepad.' });

      const src = await sectionSource(connection, req.params.id);
      const linked = await linkedPlans(connection, req.params.id);
      const available = await sourceDocuments(connection, src);
      res.json({ success: true, linked, available, reason: src ? '' : 'NO_JOB' });
    });
  } catch (err) {
    logger.error('notepad section plans read error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const sectionPlanSchema = Joi.object({
  document_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(50).required(),
});

router.post('/sections/:id/plans', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  const { error, value } = sectionPlanSchema.validate(req.body || {});
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const access = await getSectionAccess(connection, req.params.id, uid);
      if (!access) return res.status(403).json({ success: false, message: 'Not your notepad.' });

      const src = await sectionSource(connection, req.params.id);
      if (!src) {
        return res.status(400).json({ success: false, code: 'NO_JOB', message: 'This notepad has no job or lead to take plans from.' });
      }
      // Only documents on THIS job. An id from another job is refused
      // outright rather than silently dropped.
      // Only documents on THIS job or lead. An id from anywhere else is
      // refused outright rather than silently dropped.
      const offered = await sourceDocuments(connection, src);
      const allowed = new Set(offered.map((d) => Number(d.id)));
      if (!value.document_ids.every((id) => allowed.has(Number(id)))) {
        return res.status(403).json({ success: false, message: 'Those files are not on this job.' });
      }
      const col = src.kind === 'lead' ? 'lead_document_id' : 'job_document_id';
      for (const id of value.document_ids) {
        // The UNIQUE key on (section_id, <col>) makes re-linking a no-op.
        await connection.query(
          `INSERT IGNORE INTO checklist_section_files (section_id, ${col}, added_by) VALUES (?, ?, ?)`,
          [Number(req.params.id), Number(id), uid],
        );
      }
      res.status(201).json({ success: true, linked: await linkedPlans(connection, req.params.id) });
    });
  } catch (err) {
    logger.error('notepad section plan link error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/sections/plans/:linkId', auth.authenticateToken, requireNotepadMyTasks, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    await withConn(async (connection) => {
      await ensureNotepadSchema(connection);
      const [[link]] = await connection.query(
        'SELECT id, section_id FROM checklist_section_files WHERE id = ? LIMIT 1',
        [Number(req.params.linkId)],
      );
      if (!link) return res.status(404).json({ success: false, message: 'No such link.' });
      const access = await getSectionAccess(connection, link.section_id, uid);
      if (!access) return res.status(403).json({ success: false, message: 'Not your notepad.' });
      // Unlinking removes the REFERENCE only. The document stays in the job
      // Files, untouched — this must never delete somebody's plan set.
      await connection.query('DELETE FROM checklist_section_files WHERE id = ?', [Number(req.params.linkId)]);
      res.json({ success: true, deleted: true });
    });
  } catch (err) {
    logger.error('notepad section plan unlink error: ' + err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports.previewMerge = previewMerge;
