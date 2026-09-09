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
const {
  accountOwnerOf,
  isAccountOwner,
  isFullAccess,
  listAllowlist,
  getSectionAccess,
  isShareable,
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
              WHERE sh2.section_id = s.id AND sh2.is_client = 1) AS client_share_count
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
        });
      }

      const data = sections.map((s) => {
        const isLead = s.lead_id != null;
        return {
          ...s,
          // Live address: job wins, then lead. Never persisted on the section.
          address: (isLead ? s.lead_address : s.job_address) || '',
          display_name: s.title || s.job_name || s.lead_name || 'Notepad',
          kind: isLead ? 'lead' : s.job_id != null ? 'job' : 'plain',
          shareable: isShareable(s), // §9 hand-made pads only
          client_shared: Number(s.client_share_count || 0) > 0,
          items: bySection.get(Number(s.id)) || [],
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
module.exports.previewMerge = previewMerge;
