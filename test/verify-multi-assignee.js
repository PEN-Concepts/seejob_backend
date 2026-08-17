/* Multi-assignee data layer proof on REAL local MySQL (mysql-memory-server).
 * Proves: multi-assign write, per-person seen (independent), seen-preserving
 * re-sync, shared-complete membership, and legacy backfill/backward-compat.
 * Imports the real attachAssignees; replicates the route SQL for sync/seen.
 * Run: node test/verify-multi-assignee.js */
'use strict';
const { attachAssignees } = require('../services/taskAssignees');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

// --- exact copy of the route's syncTaskAssignees (kept in lock-step) ---
async function syncTaskAssignees(conn, taskId, userIds) {
  if (!Array.isArray(userIds) || !userIds.length) {
    await conn.query('DELETE FROM task_assignees WHERE task_id=?', [taskId]);
    return;
  }
  const ph = userIds.map(() => '?').join(',');
  await conn.query(`DELETE FROM task_assignees WHERE task_id=? AND user_id NOT IN (${ph})`, [taskId, ...userIds]);
  const rows = userIds.map(() => '(?, ?)').join(',');
  const params = [];
  userIds.forEach((u) => { params.push(taskId, u); });
  await conn.query(`INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES ${rows}`, params);
}
// --- exact copy of the /seen per-person stamp ---
async function stampSeen(conn, taskId, uid) {
  await conn.query('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)', [taskId, uid]);
  await conn.query('UPDATE task_assignees SET seen_at = NOW() WHERE task_id=? AND user_id=? AND seen_at IS NULL', [taskId, uid]);
}
const seenOf = (arr, uid) => (arr.find((a) => Number(a.user_id) === uid) || {}).seen_at || null;

(async () => {
  let db, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_multi_test', logLevel: 'ERROR' });
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({ host: '127.0.0.1', port: db.port, user: db.username || 'root', password: '', database: db.dbName });

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), business_name VARCHAR(120) NULL, created_by INT NULL)');
    await conn.query(`CREATE TABLE tasks (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, team_id INT NULL,
      created_by INT NULL, status TINYINT DEFAULT 0, assignee_completed TINYINT DEFAULT 0, assignee_seen_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE task_assignees (id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, user_id INT NOT NULL,
      seen_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_task_user (task_id, user_id))`);
    await conn.query(`INSERT INTO \`user\`(id,name,business_name,created_by) VALUES
      (74,'Owner Poul',NULL,NULL),(2,'Bill Garcia',NULL,74),(3,'Rolando Torres','C & R TILE',74),(4,'John Bates','John Bates Painting',74)`);

    // 1) Multi-assign create: assignees [2,3,4], primary=2 mirrored to tasks.user_id
    const [ins] = await conn.query('INSERT INTO tasks (user_id, created_by) VALUES (?, ?)', [2, 74]);
    const taskId = ins.insertId;
    await syncTaskAssignees(conn, taskId, [2, 3, 4]);
    const [[cnt]] = await conn.query('SELECT COUNT(*) n FROM task_assignees WHERE task_id=?', [taskId]);
    ok(cnt.n === 3, 'create: 3 assignees written to task_assignees');
    const [[pri]] = await conn.query('SELECT user_id FROM tasks WHERE id=?', [taskId]);
    ok(Number(pri.user_id) === 2, 'create: tasks.user_id = primary (2) for backward-compat');

    // 2) Read returns assignees[] with names + business_name + null seen
    let [t] = await conn.query('SELECT id FROM tasks WHERE id=?', [taskId]);
    await attachAssignees(conn, t);
    ok(t[0].assignees.length === 3, 'read: attachAssignees returns all 3');
    ok(t[0].assignees.every((a) => a.seen_at === null), 'read: everyone starts unseen (gold)');
    ok(t[0].assignees.some((a) => a.business_name === 'C & R TILE'), 'read: business_name included');

    // 3) Per-person seen is INDEPENDENT — only Rolando (3) opens it
    await stampSeen(conn, taskId, 3);
    [t] = await conn.query('SELECT id FROM tasks WHERE id=?', [taskId]);
    await attachAssignees(conn, t);
    ok(seenOf(t[0].assignees, 3) !== null, 'seen: Rolando (3) now seen (green)');
    ok(seenOf(t[0].assignees, 2) === null && seenOf(t[0].assignees, 4) === null, 'seen: Bill (2) + John (4) still unseen');

    // 4) Re-sync (edit assignees → [2,3-removed→keep 2,3? change to 2,4]) preserves kept seen
    const seenBefore = seenOf((await (async () => { const [x] = await conn.query('SELECT id FROM tasks WHERE id=?', [taskId]); await attachAssignees(conn, x); return x; })())[0].assignees, 3);
    await stampSeen(conn, taskId, 2);            // Bill opens it too
    await syncTaskAssignees(conn, taskId, [2, 4]); // reassign: drop Rolando(3), keep Bill(2), add John(4)
    [t] = await conn.query('SELECT id FROM tasks WHERE id=?', [taskId]);
    await attachAssignees(conn, t);
    const ids = t[0].assignees.map((a) => Number(a.user_id)).sort();
    ok(JSON.stringify(ids) === JSON.stringify([2, 4]), 're-sync: set is now {2,4}, Rolando removed');
    ok(seenOf(t[0].assignees, 2) !== null, 're-sync: Bill (2) KEPT his seen stamp (INSERT IGNORE, not wiped)');
    ok(seenOf(t[0].assignees, 4) === null, 're-sync: newly-added John (4) starts unseen');

    // 5) Shared-complete membership: ANY current assignee (John=4) is allowed
    const [mem4] = await conn.query('SELECT 1 FROM task_assignees WHERE task_id=? AND user_id=? LIMIT 1', [taskId, 4]);
    ok(mem4.length === 1, 'complete: John (4) is an assignee → may check the shared box');
    const [mem3] = await conn.query('SELECT 1 FROM task_assignees WHERE task_id=? AND user_id=? LIMIT 1', [taskId, 3]);
    ok(mem3.length === 0, 'complete: removed Rolando (3) is NOT an assignee → cannot check it');

    // 6) Legacy backfill / backward-compat: a pre-existing single-assignee task with a
    //    prior per-task seen stamp seeds task_assignees carrying that seen.
    const [legacy] = await conn.query("INSERT INTO tasks (user_id, created_by, assignee_seen_at) VALUES (3, 74, '2026-08-10 09:00:00')");
    await conn.query(`INSERT IGNORE INTO task_assignees (task_id, user_id, seen_at)
                      SELECT id, user_id, assignee_seen_at FROM tasks WHERE id=? AND user_id IS NOT NULL`, [legacy.insertId]);
    let [lt] = await conn.query('SELECT id FROM tasks WHERE id=?', [legacy.insertId]);
    await attachAssignees(conn, lt);
    ok(lt[0].assignees.length === 1 && Number(lt[0].assignees[0].user_id) === 3, 'backfill: legacy task seeded with its single assignee');
    ok(lt[0].assignees[0].seen_at !== null, 'backfill: legacy per-task seen carried onto the assignee row');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e.message); process.exitCode = 2; }
  finally { try { if (conn) await conn.end(); } catch {} try { if (db && db.stop) await db.stop(); } catch {} }
})();
