/**
 * One-off historical notepad back-fill (migration-policy rules 4 + 6 + 10).
 *
 * ============================ READ THIS FIRST =============================
 * Creating a job or lead creates its notepad — that is the FORWARD path and it
 * runs automatically (routes/jobs.js, routes/leads.js). This script is for the
 * jobs and leads that already existed BEFORE the feature shipped.
 *
 * It used to be a side effect of opening the Notepads page, which meant a page
 * view silently bulk-inserted one row per job and per lead on the account. Now
 * it counts first and waits for approval:
 *
 *   node scripts/backfillNotepads.js                 # report only (default)
 *   node scripts/backfillNotepads.js --report        # same, explicit
 *   node scripts/backfillNotepads.js --apply         # refuses without the env flag
 *   NOTEPAD_BACKFILL_ARMED=1 node scripts/backfillNotepads.js --apply
 *
 * Purely ADDITIVE — it only ever INSERTs notepad rows, never deletes or edits
 * anything. Reversible with:
 *   DELETE FROM checklist_sections WHERE origin='auto' AND id NOT IN (...used...)
 * Both modes write an owner-readable row to destructive_job_log.
 * ==========================================================================
 */

const pool = require('../config/connection');
const { ensureNotepadSchema } = require('../services/notepadSchema');
const { logDestructiveJob } = require('../services/destructiveLog');
const { backfillArmed } = require('../services/featureFlags');
const { accountMemberIds, isFullAccess, accountOwnerOf } = require('../services/notepadAccess');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const accountArg = args.find((a) => a.startsWith('--account='));
const ONLY_ACCOUNT = accountArg ? Number(accountArg.split('=')[1]) : null;

/**
 * What is missing, per account. Rule 4 asks for per-account counts; with one
 * real account today that is one row, but the shape is right for later.
 */
async function plan(connection) {
  // Every account owner = a user who is not an employee of someone else.
  const [owners] = await connection.query(
    `SELECT u.id, u.name, u.email
       FROM \`user\` u
      WHERE (u.created_by IS NULL OR u.category IS NULL OR u.category <> 1)
      ${ONLY_ACCOUNT ? 'AND u.id = ' + Number(ONLY_ACCOUNT) : ''}
      ORDER BY u.id ASC`,
  );

  const out = [];
  for (const o of owners) {
    const ownerId = Number(o.id);
    const members = await accountMemberIds(connection, ownerId);
    if (!members.length) continue;
    const list = members.join(',');

    const [[jobs]] = await connection.query(
      `SELECT COUNT(*) AS n FROM \`job\` j
        WHERE j.created_by IN (${list})
          AND NOT EXISTS (SELECT 1 FROM checklist_sections s
                           WHERE s.owner_user_id = ? AND s.origin='auto' AND s.scope='company' AND s.job_id = j.id)`,
      [ownerId],
    );
    const [[leads]] = await connection.query(
      `SELECT COUNT(*) AS n FROM leads l
        WHERE l.user_id IN (${list})
          AND NOT EXISTS (SELECT 1 FROM checklist_sections s
                           WHERE s.owner_user_id = ? AND s.origin='auto' AND s.scope='company' AND s.lead_id = l.id)`,
      [ownerId],
    );

    // Off-list members each get their own private pad per job/lead.
    let privateRows = 0;
    const offList = [];
    for (const m of members) {
      if (m === ownerId) continue;
      if (await isFullAccess(connection, m)) continue;
      const [[pj]] = await connection.query(
        `SELECT COUNT(*) AS n FROM \`job\` j
          WHERE j.created_by IN (${list})
            AND NOT EXISTS (SELECT 1 FROM checklist_sections s
                             WHERE s.owner_user_id = ? AND s.origin='auto' AND s.scope='private' AND s.job_id = j.id)`,
        [m],
      );
      const [[pl]] = await connection.query(
        `SELECT COUNT(*) AS n FROM leads l
          WHERE l.user_id IN (${list})
            AND NOT EXISTS (SELECT 1 FROM checklist_sections s
                             WHERE s.owner_user_id = ? AND s.origin='auto' AND s.scope='private' AND s.lead_id = l.id)`,
        [m],
      );
      const n = Number(pj.n) + Number(pl.n);
      if (n > 0) offList.push({ user_id: m, rows: n });
      privateRows += n;
    }

    const total = Number(jobs.n) + Number(leads.n) + privateRows;
    if (total > 0) {
      out.push({
        owner_id: ownerId,
        owner: o.name || o.email || `#${ownerId}`,
        company_job_pads: Number(jobs.n),
        company_lead_pads: Number(leads.n),
        private_pads: privateRows,
        off_list_members: offList,
        total,
      });
    }
  }
  return out;
}

/** The INSERTs, per account. Additive only. */
async function apply(connection, row) {
  const ownerId = row.owner_id;
  const members = await accountMemberIds(connection, ownerId);
  const list = members.join(',');
  let inserted = 0;

  const doPads = async (padOwner, scope) => {
    const [j] = await connection.query(
      `INSERT INTO checklist_sections
          (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
       SELECT ?, NULL, 'task', j.name, 0, j.id, NULL, 'auto', ?, ?
         FROM \`job\` j
        WHERE j.created_by IN (${list})
          AND NOT EXISTS (SELECT 1 FROM checklist_sections s
                           WHERE s.owner_user_id = ? AND s.origin='auto' AND s.scope = ? AND s.job_id = j.id)`,
      [padOwner, scope, ownerId, padOwner, scope],
    );
    const [l] = await connection.query(
      `INSERT INTO checklist_sections
          (owner_user_id, shared_with_user_id, type, title, sort_order, job_id, lead_id, origin, scope, account_owner_id)
       SELECT ?, NULL, 'task', l.lead_name, 0, NULL, l.id, 'auto', ?, ?
         FROM leads l
        WHERE l.user_id IN (${list})
          AND NOT EXISTS (SELECT 1 FROM checklist_sections s
                           WHERE s.owner_user_id = ? AND s.origin='auto' AND s.scope = ? AND s.lead_id = l.id)`,
      [padOwner, scope, ownerId, padOwner, scope],
    );
    inserted += (j.affectedRows || 0) + (l.affectedRows || 0);
  };

  await doPads(ownerId, 'company');
  for (const m of row.off_list_members) await doPads(m.user_id, 'private');
  return inserted;
}

(async () => {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureNotepadSchema(connection);

    const rows = await plan(connection);
    const grand = rows.reduce((a, r) => a + r.total, 0);

    console.log(APPLY ? 'BACK-FILL — apply mode' : 'BACK-FILL — REPORT ONLY (nothing written)');
    console.log('');
    if (!rows.length) {
      console.log('Nothing to back-fill. Every job and lead already has its notepad.');
    }
    for (const r of rows) {
      console.log(`account ${r.owner_id} (${r.owner})`);
      console.log(`   company job notepads to create : ${r.company_job_pads}`);
      console.log(`   company lead notepads to create: ${r.company_lead_pads}`);
      console.log(`   private notepads (off-list)    : ${r.private_pads}`);
      for (const m of r.off_list_members) console.log(`       user ${m.user_id}: ${m.rows}`);
      console.log(`   TOTAL for this account         : ${r.total}`);
      console.log('');
    }
    console.log(`GRAND TOTAL notepads that would be created: ${grand}`);

    if (!APPLY) {
      await logDestructiveJob(connection, {
        kind: 'notepad_backfill',
        accountOwnerId: ONLY_ACCOUNT || (rows[0] && rows[0].owner_id) || null,
        summary: `WOULD create ${grand} notepad(s) for jobs and leads that pre-date the feature. Nothing written.`,
        detail: JSON.stringify(rows),
        rowsAffected: grand,
        dryRun: 1,
      });
      console.log('\nNothing was written. To apply:');
      console.log('  NOTEPAD_BACKFILL_ARMED=1 node scripts/backfillNotepads.js --apply');
      return;
    }

    if (!backfillArmed()) {
      console.error('\nREFUSING TO RUN.');
      console.error('--apply requires NOTEPAD_BACKFILL_ARMED=1 in the environment.');
      console.error(`This would have created ${grand} notepad(s).`);
      process.exitCode = 1;
      return;
    }

    let written = 0;
    await connection.beginTransaction();
    try {
      for (const r of rows) written += await apply(connection, r);
      await connection.commit();
    } catch (e) {
      await connection.rollback();
      throw e;
    }
    await logDestructiveJob(connection, {
      kind: 'notepad_backfill',
      accountOwnerId: ONLY_ACCOUNT || (rows[0] && rows[0].owner_id) || null,
      summary: `Created ${written} notepad(s) for jobs and leads that pre-dated the feature.`,
      detail: JSON.stringify(rows),
      rowsAffected: written,
      dryRun: 0,
    });
    console.log(`\nCREATED ${written} notepad(s).`);
  } catch (err) {
    console.error('backfillNotepads failed:', err && err.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    try {
      await pool.end();
    } catch (e) {
      /* ignore */
    }
  }
})();
