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

/** The account this user belongs to. Employees resolve to their GC. */
async function accountOwnerOf(connection, userId) {
  return Number(await resolveOwnerId(Number(userId), connection));
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

module.exports = {
  accountOwnerOf,
  isAccountOwner,
  isFullAccess,
  accountMemberIds,
  listAllowlist,
  ensureAutoNotepads,
  createAutoNotepadFor,
  repointNotepadLeadToJob,
  getSectionAccess,
  isShareable,
};
