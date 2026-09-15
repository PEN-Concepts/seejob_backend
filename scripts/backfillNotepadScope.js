/**
 * One-off scope back-fill: legacy JOB and LEAD notepads from 'private' to
 * 'company'.
 *
 * ============================ READ THIS FIRST =============================
 * THE BUG THIS FIXES. notepadHub.js returns a notepad when the viewer owns it,
 * OR it is scope='company' and the viewer is on the allowlist, OR it is
 * explicitly shared with them. notepadSchema.js added the column as
 * VARCHAR(8) NOT NULL DEFAULT 'private', so every notepad that existed before
 * the rebuild was stamped private — and only createAutoNotepadFor writes
 * 'company', for jobs and leads created after the flag went on.
 *
 * So a granted admin sees none of the company's older job pads. Their grant is
 * working exactly as written; the pads are simply not marked as company
 * property. The QUERY IS CORRECT AND IS NOT TO BE CHANGED. The data is wrong.
 *
 * WHAT IT TOUCHES: notepads with a job_id or a lead_id. Nothing else.
 *
 * WHAT IT MUST NEVER TOUCH: a notepad with neither. 'No Job Assigned',
 * 'My Notepad', 'Shopping List' and every other personal pad stay private
 * permanently. Personal means private, with no exception. That rule is
 * enforced three times over — in the plan query, again in the UPDATE's own
 * WHERE, and by an independent guard set that is diffed against the plan
 * before a single row is written.
 *
 *   node scripts/backfillNotepadScope.js                 # report only (default)
 *   node scripts/backfillNotepadScope.js --report        # same, explicit
 *   node scripts/backfillNotepadScope.js --apply         # refuses without the env flag
 *   NOTEPAD_BACKFILL_ARMED=1 node scripts/backfillNotepadScope.js --apply
 *
 * Idempotent: the plan only selects rows NOT already 'company', so a second
 * run finds nothing and writes nothing.
 *
 * Reversible. Note the ids from the applied report and:
 *   UPDATE checklist_sections SET scope='private' WHERE id IN (<those ids>);
 *
 * Both modes write an owner-readable row to destructive_job_log.
 * ==========================================================================
 */

const pool = require('../config/connection');
const { ensureNotepadSchema } = require('../services/notepadSchema');
const { logDestructiveJob } = require('../services/destructiveLog');
const { backfillArmed } = require('../services/featureFlags');
const { accountOwnerOf } = require('../services/notepadAccess');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const accountArg = args.find((a) => a.startsWith('--account='));
const ONLY_ACCOUNT = accountArg ? Number(accountArg.split('=')[1]) : null;

/**
 * The rows that WOULD change: attached to a job or a lead, and not already
 * company-scoped.
 */
async function plan(connection) {
  const [rows] = await connection.query(
    `SELECT s.id, s.title, s.owner_user_id, s.job_id, s.lead_id, s.scope,
            s.account_owner_id, s.origin,
            j.name AS job_name,
            l.lead_name AS lead_name,
            u.name AS owner_name
       FROM checklist_sections s
       LEFT JOIN \`job\`   j ON j.id = s.job_id
       LEFT JOIN leads     l ON l.id = s.lead_id
       LEFT JOIN \`user\`  u ON u.id = s.owner_user_id
      WHERE (s.job_id IS NOT NULL OR s.lead_id IS NOT NULL)
        AND (s.scope IS NULL OR s.scope <> 'company')
      ORDER BY COALESCE(j.name, l.lead_name), s.id`,
  );
  return rows;
}

/**
 * The guard set, built INDEPENDENTLY of plan(): every notepad with no job and
 * no lead. Nothing in here may ever appear in the plan. Deriving it separately
 * and diffing is the point — if the plan query were ever loosened, a shared
 * helper would be loosened with it and the check would agree with the bug.
 */
async function personalPads(connection) {
  const [rows] = await connection.query(
    `SELECT id, title, owner_user_id, scope
       FROM checklist_sections
      WHERE job_id IS NULL AND lead_id IS NULL`,
  );
  return rows;
}

function groupForReport(rows) {
  const byTarget = new Map();
  for (const r of rows) {
    const key = r.job_id != null
      ? `JOB ${r.job_id} — ${r.job_name || '(unnamed job)'}`
      : `LEAD ${r.lead_id} — ${r.lead_name || '(unnamed lead)'}`;
    const list = byTarget.get(key) || [];
    list.push(r);
    byTarget.set(key, list);
  }
  return byTarget;
}

(async () => {
  let connection;
  let exitCode = 0;
  try {
    connection = await pool.getConnection();
    await ensureNotepadSchema(connection);

    let rows = await plan(connection);
    if (ONLY_ACCOUNT) {
      const keep = [];
      for (const r of rows) {
        const owner = await accountOwnerOf(connection, r.owner_user_id);
        if (Number(owner) === ONLY_ACCOUNT) keep.push(r);
      }
      rows = keep;
    }

    // ---- the guard, before anything is written ----
    const personal = await personalPads(connection);
    const personalIds = new Set(personal.map((r) => Number(r.id)));
    const leaked = rows.filter((r) => personalIds.has(Number(r.id)));

    console.log('');
    console.log('=== NOTEPAD SCOPE BACK-FILL — ' + (APPLY ? 'APPLY' : 'REPORT ONLY') + ' ===');
    console.log('');
    console.log('Personal pads on this database (never touched): ' + personal.length);
    console.log('Job/lead pads still at private:                 ' + rows.length);
    console.log('');

    if (leaked.length) {
      console.error('STOP. The plan contains ' + leaked.length + ' notepad(s) with NO job and NO lead:');
      for (const r of leaked) console.error('  id=' + r.id + '  "' + r.title + '"');
      console.error('Nothing has been written. This is a stop-everything failure.');
      process.exitCode = 1;
      return;
    }
    console.log('Guard: zero personal pads in the plan. OK.');
    console.log('');

    const grouped = groupForReport(rows);
    for (const [target, list] of grouped) {
      console.log(target + '   (' + list.length + ')');
      for (const r of list) {
        console.log('    id=' + r.id + '  "' + r.title + '"  owner=' + (r.owner_name || r.owner_user_id) +
          '  scope=' + r.scope + '  account_owner_id=' + (r.account_owner_id == null ? 'NULL' : r.account_owner_id));
      }
    }
    if (!rows.length) console.log('Nothing to do — every job and lead notepad is already company-scoped.');
    console.log('');

    const summary = rows.length + ' job/lead notepad(s) at private, across ' + grouped.size + ' job(s)/lead(s)';

    if (!APPLY) {
      console.log('REPORT ONLY. Nothing was written.');
      console.log('To apply:  NOTEPAD_BACKFILL_ARMED=1 node scripts/backfillNotepadScope.js --apply');
      await logDestructiveJob(connection, {
        kind: 'notepad_scope', actorId: null, accountOwnerId: ONLY_ACCOUNT,
        summary: 'DRY RUN: ' + summary, detail: JSON.stringify(rows.map((r) => r.id)),
        rowsAffected: 0, dryRun: 1,
      });
      return;
    }

    if (!backfillArmed()) {
      console.error('--apply requires NOTEPAD_BACKFILL_ARMED=1 in the environment. Nothing written.');
      process.exitCode = 1;
      return;
    }

    // ---- apply ----
    let written = 0;
    for (const r of rows) {
      // Set account_owner_id EXPLICITLY, so the COALESCE in the hub's
      // visibility clause stops being load-bearing.
      const owner = await accountOwnerOf(connection, r.owner_user_id);
      const [res] = await connection.query(
        `UPDATE checklist_sections
            SET scope = 'company',
                account_owner_id = ?
          WHERE id = ?
            AND (job_id IS NOT NULL OR lead_id IS NOT NULL)
            AND (scope IS NULL OR scope <> 'company')`,
        [Number(owner), Number(r.id)],
      );
      written += res.affectedRows || 0;
    }

    // Counts ACTUALLY written, not intended.
    console.log('Rows written: ' + written + '  (planned: ' + rows.length + ')');
    if (written !== rows.length) {
      console.log('NOTE: written differs from planned — a row changed underneath this run.');
    }

    // Prove the invariant held, from the stored rows rather than from intent.
    const [[stillPrivate]] = await connection.query(
      `SELECT COUNT(*) AS n FROM checklist_sections
        WHERE (job_id IS NOT NULL OR lead_id IS NOT NULL) AND (scope IS NULL OR scope <> 'company')`,
    );
    const [[personalFlipped]] = await connection.query(
      `SELECT COUNT(*) AS n FROM checklist_sections
        WHERE job_id IS NULL AND lead_id IS NULL AND scope = 'company'`,
    );
    console.log('Job/lead pads still private after the run: ' + stillPrivate.n + '  (expect 0)');
    console.log('Personal pads wrongly set to company:      ' + personalFlipped.n + '  (expect 0)');
    if (Number(personalFlipped.n) > 0) {
      console.error('STOP: a personal pad is company-scoped. Investigate before going further.');
      process.exitCode = 1;
    }

    await logDestructiveJob(connection, {
      kind: 'notepad_scope', actorId: null, accountOwnerId: ONLY_ACCOUNT,
      summary: 'APPLIED: ' + written + ' notepad(s) private -> company',
      detail: JSON.stringify(rows.map((r) => r.id)),
      rowsAffected: written, dryRun: 0,
    });
  } catch (err) {
    console.error('backfillNotepadScope failed:', err && err.message);
    exitCode = 1;
  } finally {
    try { if (connection) connection.release(); } catch (e) {}
    try { await pool.end(); } catch (e) {}
    if (exitCode) process.exitCode = exitCode;
  }
})();
