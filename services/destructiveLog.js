'use strict';

/**
 * Migration-policy rule 9: "Destructive jobs log what they did, in a place the
 * owner can read."
 *
 * A timestamped file next to the script on the EC2 box, and a raw MySQL table,
 * are both places the owner CANNOT read — he has neither a shell nor a DB
 * client. Everything gated (the notepad merge, the task purge, the client-invite
 * email, the historical back-fill) writes here as well as to its own log, and
 * `GET /checklists/admin/activity` serves it back to the account owner in the UI.
 *
 * Dry runs are recorded too, and marked as such. "What it WOULD have done" is
 * exactly the thing he needs to read before approving it.
 */

const { ensureNotepadSchema } = require('./notepadSchema');

/**
 * Record one gated job. Never throws into the caller: failing to log must not
 * fail — or worse, half-fail — the operation being logged.
 *
 * @param {object} connection  an open mysql2 connection or the pool
 * @param {object} entry
 * @param {string} entry.kind          'notepad_merge' | 'task_purge' | 'client_invite' | 'notepad_backfill'
 * @param {number} [entry.accountOwnerId]
 * @param {number} [entry.actorId]
 * @param {string} entry.summary       one plain-English line the owner will read
 * @param {string} [entry.detail]      JSON or text; the ids, for anyone chasing it
 * @param {number} [entry.rowsAffected]
 * @param {number} entry.dryRun        1 = would have done this, 0 = did it
 */
async function logDestructiveJob(connection, entry) {
  try {
    await ensureNotepadSchema(connection);
    await connection.query(
      `INSERT INTO destructive_job_log
         (account_owner_id, kind, actor_user_id, summary, detail, rows_affected, dry_run)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.accountOwnerId ?? null,
        String(entry.kind || 'unknown').slice(0, 32),
        entry.actorId ?? null,
        String(entry.summary || '').slice(0, 500),
        entry.detail == null ? null : String(entry.detail),
        Number(entry.rowsAffected || 0),
        entry.dryRun ? 1 : 0,
      ],
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('destructiveLog:', e && e.message);
  }
}

module.exports = { logDestructiveJob };
