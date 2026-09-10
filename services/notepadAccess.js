'use strict';

/**
 * Notepad access + auto-pad service (CCP 2026-09-08, §5 §6 §7 §9).
 *
 * THE ACCESS MODEL — two states, no middle tier:
 *
 *   ON THE LIST  (a notepad_access row, or you ARE the account owner)
 *       -> sees every company job and lead notepad on the account, including
 *          all future ones. Add / assign / check off / delete, same as the
 *          owner. This IS the delegate permission.
 *   NOT ON THE LIST
 *       -> own notepads only. Cannot delegate. Cannot share. Receives assigned
 *          tasks in My Tasks and nowhere else.
 *
 * Granting is the one thing full access does NOT include: only the resolved
 * account owner may write notepad_access, otherwise permission spreads
 * silently.
 *
 * Everything in here is enforcement, not decoration. The routes call these
 * helpers before any read or write; hiding a button is never the control.
 */

const { resolveOwnerId } = require('../utils/access');
const { ensureNotepadSchema } = require('./notepadSchema');

/**
 * 3c — the one name for a notepad with no job behind it. Exported so the
 * retirement of 'Personal' is a single edit and not a search-and-replace: any
 * code that needs the label imports it rather than typing it again.
 */
const NO_JOB_TITLE = 'No Job Assigned';

/**
 * The account this user belongs to.
 *
 * DELIBERATELY WIDER THAN resolveOwnerId. That shared helper only walks up for
 * category-1 employees, so a SUBCONTRACTOR or a CLIENT resolves to themselves —
 * correct for billing, where a subcontractor must not inherit the GC's plan,
 * and wrong here, where it made them look like their own account owner and
 * therefore FULL ACCESS (5b). A subcontractor would have been handed a My Tasks
 * page and an empty notepad instead of the GC's delegated work.
 *
 * For notepad purposes the rule is simply: whoever created you owns the account
 * you belong to. Kept local so nothing about billing or entitlement moves.
 */
async function accountOwnerOf(connection, userId) {
  const uid = Number(userId);
  const resolved = Number(await resolveOwnerId(uid, connection));
  if (resolved !== uid) return resolved;
  try {
    const [[u]] = await connection.query('SELECT created_by FROM \`user\` WHERE id = ? LIMIT 1', [uid]);
    if (u && u.created_by && Number(u.created_by) !== uid) return Number(u.created_by);
  } catch (e) {
    /* fall through — treating them as their own owner is the safe default */
  }
  return uid;
}

/**
 * C26 — is this user a SUBCONTRACTOR (contact category 2)?
 *
 * The distinction matters because an off-list EMPLOYEE and an off-list
 * SUBCONTRACTOR are not the same case. An employee keeps private notes on a
 * job pad and those get merged into the company pad when they are granted
 * access (§8). A subcontractor has no such path: the pad they see is the
 * company's work sent to them, and a task they invented on it would be
 * invisible to whoever owns the job.
 */
async function isSubcontractor(connection, userId) {
  try {
    const [[u]] = await connection.query(
      'SELECT category FROM `user` WHERE id = ? LIMIT 1',
      [Number(userId)],
    );
    return !!u && Number(u.category) === 2;
  } catch (e) {
    return false;   // fail OPEN: never lock someone out on a failed lookup
  }
}

/** True only when the caller IS the account owner (grants are owner-only). */
async function isAccountOwner(connection, userId) {
  return (await accountOwnerOf(connection, userId)) === Number(userId);
}

/**
 * Is this user on the global allowlist for their account?
 * The account owner is implicitly on it and cannot be removed.
 */
async function isFullAccess(connection, userId) {
  const uid = Number(userId);
  const owner = await accountOwnerOf(connection, uid);
  if (owner === uid) return true;
  const [rows] = await connection.query(
    'SELECT 1 FROM notepad_access WHERE owner_user_id = ? AND user_id = ? LIMIT 1',
    [owner, uid],
  );
  return rows.length > 0;
}

/** Everyone on the account: the owner plus their employees (category 1). */
async function accountMemberIds(connection, ownerId) {
  const [rows] = await connection.query(
    'SELECT id FROM `user` WHERE id = ? OR (created_by = ? AND category = 1)',
    [ownerId, ownerId],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * The allowlist as the "SHARED WITH" row renders it: avatar initials + first
 * name. The owner is NOT included — the row lists who has been GRANTED access.
 */
async function listAllowlist(connection, ownerId) {
  const [rows] = await connection.query(
    `SELECT a.user_id, u.name, u.email, a.granted_at
       FROM notepad_access a
       JOIN \`user\` u ON u.id = a.user_id
      WHERE a.owner_user_id = ?
      ORDER BY a.granted_at ASC, a.id ASC`,
    [ownerId],
  );
  return rows.map((r) => {
    const full = String(r.name || '').trim();
    const first = full.split(/\s+/)[0] || full;
    const initials = full
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join('');
    return {
      user_id: Number(r.user_id),
      name: full,
      first_name: first,
      initials: initials || '?',
      granted_at: r.granted_at,
    };
  });
}

/**
 * 3b/5b — a private pad for every job an OFF-LIST user actually has work on.
 *
 * ensureAutoNotepads only back-fills for ACCOUNT MEMBERS (the owner plus
 * category-1 employees). A subcontractor is category 2, so it never made them
 * a pad at all — and without one, a row delegated to them would be re-homed
 * into their "No Job Assigned" card, which is technically visible but filed
 * under the wrong heading.
 *
 * This creates a pad ONLY for a job or lead where a row is already delegated
 * to this user. It is bounded by the work they have been given, not by the
 * size of the account, so it stays cheap enough for the page read.

 * Idempotent: the NOT EXISTS makes a repeat call a no-op.
 */
async function ensurePrivatePadsForDelegatedWork(connection, userId) {
  const uid = Number(userId);
  const owner = await accountOwnerOf(connection, uid);

  // Jobs.
  await connection.query(
    `INSERT INTO checklist_sections
        (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
     SELECT DISTINCT ?, NULL, 'task', j.name, 0, j.id, NULL, 'auto', 'private', ?
       FROM check_list c
       JOIN checklist_sections s ON s.id = c.section_id
       JOIN \`job\` j ON j.id = s.job_id
      WHERE c.delegated_to = ?
        AND COALESCE(s.account_owner_id, s.owner_user_id) = ?
        AND NOT EXISTS (
          SELECT 1 FROM checklist_sections x
           WHERE x.owner_user_id = ? AND x.origin = 'auto' AND x.scope = 'private' AND x.job_id = j.id
        )`,
    [uid, owner, uid, owner, uid],
  );

  // Leads — a bid can carry delegated work too.
  await connection.query(
    `INSERT INTO checklist_sections
        (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
     SELECT DISTINCT ?, NULL, 'task', l.lead_name, 0, NULL, l.id, 'auto', 'private', ?
       FROM check_list c
       JOIN checklist_sections s ON s.id = c.section_id
       JOIN leads l ON l.id = s.lead_id
      WHERE c.delegated_to = ?
        AND COALESCE(s.account_owner_id, s.owner_user_id) = ?
        AND NOT EXISTS (
          SELECT 1 FROM checklist_sections x
           WHERE x.owner_user_id = ? AND x.origin = 'auto' AND x.scope = 'private' AND x.lead_id = l.id
        )`,
    [uid, owner, uid, owner, uid],
  );
}

/**
 * 3c — THE 'NO JOB ASSIGNED' PAD, one per user, replacing 'Personal'.
 *
 * Every user gets one, owner included, and it is always theirs privately —
 * there is no company version, because the whole point is the work that has no
 * job behind it yet.
 *
 * sort_order -1 puts it first on a page the user has never dragged. It is not
 * pinned: the moment they reorder anything, checklist_section_order supplies a
 * per-user value and COALESCE prefers it, so the card moves like any other (3d).
 *
 * Deliberately its own function rather than part of ensureAutoNotepads. This is
 * ONE idempotent insert per user, so it is cheap enough to run on a page read;
 * the job and lead back-fill next to it is O(jobs) and is not.
 */
async function ensureNoJobNotepad(connection, userId) {
  const uid = Number(userId);
  const owner = await accountOwnerOf(connection, uid);
  await connection.query(
    `INSERT INTO checklist_sections
        (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
     SELECT ?, NULL, 'task', ?, -1, NULL, NULL, 'auto', 'private', ?
       FROM DUAL
      WHERE NOT EXISTS (
        SELECT 1 FROM checklist_sections s
         WHERE s.owner_user_id = ? AND s.origin = 'auto' AND s.job_id IS NULL AND s.lead_id IS NULL
      )`,
    [uid, NO_JOB_TITLE, owner, uid],
  );
}

/**
 * §5 — every job and lead on the account gets a notepad, named after it, with
 * the address READ LIVE (never copied: see the reads in routes/checklists.js,
 * which JOIN job/leads on every request).
 *
 * Company pads (scope='company') are back-filled for the whole account.
 * Private pads (scope='private') are created only for an OFF-LIST caller, and
 * only for themselves — an on-list user shares the company pad instead (§7).
 *
 * Idempotent and cheap on the warm path: the two NOT EXISTS inserts touch
 * nothing once the pads exist.
 */
async function ensureAutoNotepads(connection, userId) {
  await ensureNotepadSchema(connection);
  const uid = Number(userId);
  const owner = await accountOwnerOf(connection, uid);
  const full = await isFullAccess(connection, uid);

  // Who owns an auto pad: the company pad belongs to the account owner; an
  // off-list member's private pad belongs to that member.
  const padOwner = full ? owner : uid;
  const scope = full ? 'company' : 'private';

  const members = await accountMemberIds(connection, owner);
  if (!members.length) return;
  const memberList = members.join(',');

  await ensureNoJobNotepad(connection, uid);

  // JOBS. `job.created_by` is any member of the account.
  await connection.query(
    `INSERT INTO checklist_sections
        (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
     SELECT ?, NULL, 'task', j.name, 0, j.id, NULL, 'auto', ?, ?
       FROM \`job\` j
      WHERE j.created_by IN (${memberList})
        AND NOT EXISTS (
          SELECT 1 FROM checklist_sections s
           WHERE s.owner_user_id = ? AND s.origin = 'auto' AND s.scope = ? AND s.job_id = j.id
        )`,
    [padOwner, scope, owner, padOwner, scope],
  );

  // LEADS. `leads.user_id` is the owning member.
  await connection.query(
    `INSERT INTO checklist_sections
        (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
     SELECT ?, NULL, 'task', l.lead_name, 0, NULL, l.id, 'auto', ?, ?
       FROM leads l
      WHERE l.user_id IN (${memberList})
        AND NOT EXISTS (
          SELECT 1 FROM checklist_sections s
           WHERE s.owner_user_id = ? AND s.origin = 'auto' AND s.scope = ? AND s.lead_id = l.id
        )`,
    [padOwner, scope, owner, padOwner, scope],
  );
}

/**
 * Create the ONE company pad for a job or lead the moment it is created (§5).
 * Called from routes/jobs.js and routes/leads.js. Never throws into the caller:
 * a notepad is not worth failing a job create over.
 */
/**
 * §5 "Link the notepad to the owner/client in the background."
 *
 * Resolve the client behind a job or lead. Stored on the section rather than
 * derived on read: a job's client can be reassigned, and a lead pad has no job
 * to derive from at all, so "derivable" is not the same as "linked". Nothing
 * surfaces it in the UI yet — that is the spec's instruction, and the column is
 * there so the client-portal work has something to join on later.
 */
async function resolveClientFor(connection, kind, recordId) {
  try {
    if (kind === 'job') {
      const [[j]] = await connection.query('SELECT client_id FROM `job` WHERE id = ? LIMIT 1', [Number(recordId)]);
      return j && j.client_id ? Number(j.client_id) : null;
    }
    // Leads carry the prospective client on the lead row; column names have
    // varied, so probe rather than assume, and fail to null.
    const [cols] = await connection.query("SHOW COLUMNS FROM leads LIKE 'client_id'");
    if (!cols.length) return null;
    const [[l]] = await connection.query('SELECT client_id FROM leads WHERE id = ? LIMIT 1', [Number(recordId)]);
    return l && l.client_id ? Number(l.client_id) : null;
  } catch (e) {
    return null;
  }
}

async function createAutoNotepadFor(connection, kind, recordId, creatorUserId, title) {
  try {
    await ensureNotepadSchema(connection);
    const owner = await accountOwnerOf(connection, creatorUserId);
    const jobId = kind === 'job' ? Number(recordId) : null;
    const leadId = kind === 'lead' ? Number(recordId) : null;
    const clientId = await resolveClientFor(connection, kind, recordId);
    const [existing] = await connection.query(
      `SELECT id FROM checklist_sections
        WHERE owner_user_id = ? AND origin = 'auto' AND scope = 'company'
          AND ${jobId ? 'job_id = ?' : 'lead_id = ?'} LIMIT 1`,
      [owner, jobId || leadId],
    );
    if (existing.length) {
      // Keep the background link current if the client was set after creation.
      if (clientId) {
        await connection.query(
          'UPDATE checklist_sections SET client_user_id = ? WHERE id = ? AND (client_user_id IS NULL OR client_user_id <> ?)',
          [clientId, existing[0].id, clientId],
        );
      }
      return Number(existing[0].id);
    }
    const [r] = await connection.query(
      `INSERT INTO checklist_sections
         (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id, client_user_id, owner_contact_id)
       VALUES (?, NULL, 'task', ?, 0, ?, ?, 'auto', 'company', ?, ?, ?)`,
      [owner, String(title || '').trim() || 'Notepad', jobId, leadId, owner, clientId, owner],
    );

    // §7: an OFF-LIST member gets their own private pad for this job/lead. This
    // is bounded (the members of one account, once, at an explicit user action)
    // — unlike the old page-load back-fill it replaces, which ran on every read.
    try {
      const members = await accountMemberIds(connection, owner);
      for (const m of members) {
        if (m === owner) continue;
        if (await isFullAccess(connection, m)) continue; // shares the company pad
        await connection.query(
          `INSERT INTO checklist_sections
             (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id, client_user_id)
           SELECT ?, NULL, 'task', ?, 0, ?, ?, 'auto', 'private', ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM checklist_sections s
               WHERE s.owner_user_id = ? AND s.origin='auto' AND s.scope='private'
                 AND ${jobId ? 's.job_id = ?' : 's.lead_id = ?'})`,
          [m, String(title || '').trim() || 'Notepad', jobId, leadId, owner, clientId, m, jobId || leadId],
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('createAutoNotepadFor private pads:', e && e.message);
    }

    return Number(r.insertId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('createAutoNotepadFor:', e && e.message);
    return null;
  }
}

/**
 * §5 — lead → job conversion "changes NOTHING about the notepad". Re-point the
 * SAME row: same title, same items, same origin/scope. Only job_id/lead_id move,
 * which is what flips the card border from blue to gold (the border is derived,
 * not stored).
 */
async function repointNotepadLeadToJob(connection, leadId, jobId) {
  try {
    await ensureNotepadSchema(connection);
    await connection.query(
      'UPDATE checklist_sections SET job_id = ?, lead_id = NULL WHERE lead_id = ? AND origin = ?',
      [Number(jobId), Number(leadId), 'auto'],
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('repointNotepadLeadToJob:', e && e.message);
  }
}

/**
 * The single authorisation gate for one section. Returns null when the caller
 * has no business seeing it at all — callers turn that into a 403 (§6: "An
 * off-list user's request for a company notepad must 403").
 *
 * role:
 *   'owner'  full control, it is their own pad
 *   'full'   on the allowlist, company pad — same powers as the owner (§6)
 *   'share'  a per-notepad share recipient — check off and ADD only (§9)
 */
async function getSectionAccess(connection, sectionId, userId) {
  await ensureNotepadSchema(connection);
  const uid = Number(userId);
  const [[section]] = await connection.query(
    `SELECT id, owner_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id
       FROM checklist_sections WHERE id = ? LIMIT 1`,
    [Number(sectionId)],
  );
  if (!section) return null;

  if (Number(section.owner_user_id) === uid) return { section, role: 'owner' };

  // A COMPANY pad is readable/writable by anyone on the allowlist for that
  // account. A PRIVATE pad never is, no matter who asks.
  if (String(section.scope) === 'company') {
    const owner = await accountOwnerOf(connection, uid);
    if (Number(section.account_owner_id || section.owner_user_id) === owner && (await isFullAccess(connection, uid))) {
      return { section, role: 'full' };
    }
  }

  const [shared] = await connection.query(
    'SELECT 1 FROM checklist_section_shares WHERE section_id = ? AND user_id = ? LIMIT 1',
    [Number(sectionId), uid],
  );
  if (shared.length) return { section, role: 'share' };

  return null;
}

/** §9 — the share icon exists ONLY on hand-made pads. Enforced, not hidden. */
function isShareable(section) {
  return String(section && section.origin) === 'manual';
}

/**
 * C43 — ONE CONVERSATION PER PIECE OF WORK.
 *
 * A notepad row that has been delegated exists twice: as a check_list
 * row and as the tasks row it became. Notes were being written to two
 * different tables depending on which page you were standing on, so the
 * boss on Notepads and the assignee on My Tasks were talking past each
 * other in separate threads about the same job.
 *
 * The CHECK_LIST row is the anchor whenever one exists — it is where the
 * work originated. A task with no notepad row behind it (created straight
 * on My Tasks) keeps its own task_notes thread.
 *
 * Returns { kind: "item"|"task", id }.
 */
async function resolveThreadAnchor(connection, { itemId = null, taskId = null }) {
  if (itemId) return { kind: "item", id: Number(itemId) };
  if (!taskId) return null;
  try {
    const [[row]] = await connection.query(
      'SELECT id FROM check_list WHERE delegated_task_id = ? LIMIT 1',
      [Number(taskId)],
    );
    if (row) return { kind: "item", id: Number(row.id) };
  } catch (e) {
    /* fall through to the task thread */
  }
  return { kind: "task", id: Number(taskId) };
}

/**
 * Fold any pre-existing task_notes for this item's task into the item
 * thread, once. COPY, never move: the old rows stay where they are, so
 * nothing is destroyed if this ever has to be reversed.
 */
async function absorbTaskNotes(connection, itemId) {
  try {
    const [[row]] = await connection.query(
      'SELECT delegated_task_id FROM check_list WHERE id = ? LIMIT 1',
      [Number(itemId)],
    );
    if (!row || !row.delegated_task_id) return;
    const [[done]] = await connection.query(
      'SELECT COUNT(*) AS n FROM checklist_item_notes WHERE item_id = ? AND absorbed_task_id = ?',
      [Number(itemId), Number(row.delegated_task_id)],
    );
    if (Number(done.n) > 0) return;
    await connection.query(
      `INSERT INTO checklist_item_notes (item_id, user_id, body, created_at, absorbed_task_id)
         SELECT ?, n.user_id, n.body, n.created_at, ?
           FROM task_notes n WHERE n.task_id = ?`,
      [Number(itemId), Number(row.delegated_task_id), Number(row.delegated_task_id)],
    );
  } catch (e) {
    /* nothing to absorb, or the column is not there yet */
  }
}

module.exports = {
  accountOwnerOf,
  isAccountOwner,
  isSubcontractor,
  resolveThreadAnchor,
  absorbTaskNotes,
  isFullAccess,
  accountMemberIds,
  listAllowlist,
  ensureAutoNotepads,
  ensureNoJobNotepad,
  ensurePrivatePadsForDelegatedWork,
  NO_JOB_TITLE,
  createAutoNotepadFor,
  repointNotepadLeadToJob,
  getSectionAccess,
  isShareable,
};
