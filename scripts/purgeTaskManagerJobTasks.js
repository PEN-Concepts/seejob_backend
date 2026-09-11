/**
 * CCP §14 — remove the JOB tasks that came off the old Task Manager page.
 *
 * ============================ READ THIS FIRST =============================
 * THIS SCRIPT DELETES TASK ROWS PERMANENTLY. It is DISARMED by default and was
 * NOT RUN as part of the build that added it. The hold is deliberate: the
 * delete is permanent and the backup status of that database is unconfirmed.
 *
 *   node scripts/purgeTaskManagerJobTasks.js                 # report only (default)
 *   node scripts/purgeTaskManagerJobTasks.js --report        # same, explicit
 *   node scripts/purgeTaskManagerJobTasks.js --execute       # refuses without the env flag
 *   TASK_PURGE_ARMED=1 node scripts/purgeTaskManagerJobTasks.js --execute
 *
 * --report writes TASKS-PENDING-DELETION.md (id, title, job, assignee, due
 * date, created date, completion state) and deletes nothing.
 *
 * --execute logs the COUNT and EVERY ID it removes, to stdout and to a
 * timestamped file. That is the purgeShoppingLists lesson: that purge ran and
 * nobody could read what it had done afterwards.
 *
 * Scope: tasks that live under a JOB on the old Task Manager page — i.e. rows
 * in `tasks` with a non-null job_id whose task_type is not 'lead'. Poul's
 * decision is DELETE, not merge. Personal daily tasks (no job) are NOT touched.
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const pool = require('../config/connection');
const { logDestructiveJob } = require('../services/destructiveLog');

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const ARMED = String(process.env.TASK_PURGE_ARMED || '') === '1';
// Optional narrowing while reviewing, e.g. --account=42
const accountArg = args.find((a) => a.startsWith('--account='));
const ACCOUNT = accountArg ? Number(accountArg.split('=')[1]) : null;

const SELECT_SQL = `
  SELECT
    t.id,
    t.task_name                                   AS title,
    t.job_id,
    j.name                                        AS job_name,
    COALESCE(u.name, '(unassigned)')              AS assignee,
    t.start_date                                  AS due_date,
    t.created_at,
    t.created_by,
    CASE WHEN t.status = 1 THEN 'completed' ELSE 'open' END AS completion_state
  FROM tasks t
  LEFT JOIN \`job\`  j ON j.id = t.job_id
  LEFT JOIN \`user\` u ON u.id = t.user_id
  WHERE t.job_id IS NOT NULL
    AND (t.task_type IS NULL OR t.task_type <> 'lead')
    ${'' /* account narrowing appended below when requested */}
`;

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function ymd(d) {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x.getTime())) return String(d);
  return x.toISOString().slice(0, 10);
}

(async () => {
  let connection;
  try {
    connection = await pool.getConnection();

    let sql = SELECT_SQL;
    const params = [];
    if (ACCOUNT) {
      sql += ' AND t.created_by = ?';
      params.push(ACCOUNT);
    }
    sql += ' ORDER BY j.name ASC, t.id ASC';

    const [rows] = await connection.query(sql, params);
    const count = rows.length;

    // ── report mode (the default) ───────────────────────────────────────────
    if (!EXECUTE) {
      const out = [];
      out.push('# TASKS PENDING DELETION');
      out.push('');
      out.push('CCP §14 — jobs come off the old Task Manager page and the tasks under');
      out.push('them are to be DELETED, not merged (Poul\'s decision).');
      out.push('');
      out.push(`**COUNT: ${count}**`);
      out.push('');
      out.push(`Generated: ${new Date().toISOString()}`);
      out.push(ACCOUNT ? `Scope: account ${ACCOUNT}` : 'Scope: all accounts');
      out.push('');
      out.push('Nothing has been deleted. To delete, run:');
      out.push('');
      out.push('```');
      out.push('TASK_PURGE_ARMED=1 node scripts/purgeTaskManagerJobTasks.js --execute');
      out.push('```');
      out.push('');
      out.push('| id | title | job | assignee | due | created | state |');
      out.push('|---:|---|---|---|---|---|---|');
      for (const r of rows) {
        out.push(
          `| ${r.id} | ${esc(r.title)} | ${esc(r.job_name)} | ${esc(r.assignee)} | ${ymd(r.due_date)} | ${ymd(r.created_at)} | ${r.completion_state} |`,
        );
      }
      out.push('');

      const dest = path.join(__dirname, '..', 'TASKS-PENDING-DELETION.md');
      fs.writeFileSync(dest, out.join('\n'), 'utf8');
      // Rule 9: also land it where the owner can read it, without a shell.
      await logDestructiveJob(connection, {
        kind: 'task_purge',
        accountOwnerId: ACCOUNT || null,
        summary: `WOULD delete ${count} task(s) from the retired Task Manager job list. Nothing was deleted.`,
        detail: JSON.stringify(rows.map((r) => ({ id: r.id, job: r.job_name, title: r.title }))),
        rowsAffected: count,
        dryRun: 1,
      });
      console.log(`REPORT ONLY — nothing deleted.`);
      console.log(`Affected tasks: ${count}`);
      console.log(`Written to: ${dest}`);
      return;
    }

    // ── execute mode ────────────────────────────────────────────────────────
    if (!ARMED) {
      console.error('REFUSING TO RUN.');
      console.error('--execute requires TASK_PURGE_ARMED=1 in the environment.');
      console.error(`This would have deleted ${count} task(s).`);
      process.exitCode = 1;
      return;
    }

    const ids = rows.map((r) => Number(r.id));
    if (!ids.length) {
      console.log('Nothing to delete.');
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(__dirname, '..', `task-purge-${stamp}.log`);
    const header = [
      `task purge ${new Date().toISOString()}`,
      ACCOUNT ? `account: ${ACCOUNT}` : 'account: ALL',
      `count: ${ids.length}`,
      'ids:',
      ids.join(','),
      '',
      'detail:',
      ...rows.map(
        (r) => `  ${r.id}\t${r.job_name}\t${r.title}\t${r.assignee}\t${ymd(r.due_date)}\t${r.completion_state}`,
      ),
      '',
    ].join('\n');
    fs.writeFileSync(logPath, header, 'utf8');

    await connection.beginTransaction();
    try {
      const ph = ids.map(() => '?').join(',');
      // Children first, so nothing is orphaned.
      await connection.query(`DELETE FROM task_assignees WHERE task_id IN (${ph})`, ids);
      await connection.query(`DELETE FROM tasks_images   WHERE task_id IN (${ph})`, ids);
      try {
        await connection.query(`DELETE FROM task_notes WHERE task_id IN (${ph})`, ids);
      } catch (e) {
        /* table may not exist on an old schema */
      }
      const [res] = await connection.query(`DELETE FROM tasks WHERE id IN (${ph})`, ids);
      await connection.commit();

      const tail = `\ndeleted rows: ${res.affectedRows}\n`;
      fs.appendFileSync(logPath, tail, 'utf8');
      await logDestructiveJob(connection, {
        kind: 'task_purge',
        accountOwnerId: ACCOUNT || null,
        summary: `Deleted ${res.affectedRows} task(s) from the retired Task Manager job list.`,
        detail: JSON.stringify({ ids, log: logPath }),
        rowsAffected: res.affectedRows,
        dryRun: 0,
      });
      console.log(`DELETED ${res.affectedRows} task(s).`);
      console.log(`ids: ${ids.join(',')}`);
      console.log(`log: ${logPath}`);
    } catch (e) {
      await connection.rollback();
      fs.appendFileSync(logPath, `\nFAILED, rolled back: ${e.message}\n`, 'utf8');
      throw e;
    }
  } catch (err) {
    console.error('purgeTaskManagerJobTasks failed:', err && err.message);
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
