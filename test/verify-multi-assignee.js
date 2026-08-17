/* Multi-assignee proof on REAL local MySQL (mysql-memory-server).
 *
 * Two layers:
 *   A) Data layer — multi-assign write, per-person seen (independent),
 *      seen-preserving re-sync, shared-complete membership, legacy backfill.
 *      Imports the real attachAssignees; replicates the route SQL for sync/seen.
 *   B) Route layer — drives the REAL `PATCH /tasks/:id/complete` handler
 *      (routes/tasks.js, mounted in express + supertest, auth stubbed) to prove
 *      the FINAL completion model end-to-end: a delegated assignee's check-off
 *      raises `assignee_completed` only (status stays 0 → task stays on the
 *      list), while the boss/GC (and a self-assigned user) FINALIZES `status`.
 *
 * SCHEMA IS REAL: the `user` table uses the production column name `business`
 * (NOT `business_name`). attachAssignees selects `u.business AS business_name`,
 * so if anyone reverts that alias the test fails on an unknown column — the gap
 * that let the 2026-08-17 prod outage slip past the old fabricated schema.
 *
 * Run: node test/verify-multi-assignee.js   (exit 0 = pass)
 */
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
  let db, pool, conn, server;
  try {
    process.env.NODE_ENV = 'test';
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_multi_test', logLevel: 'ERROR' });
    // config/connection reads these DEV vars — set BEFORE requiring it.
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection'); // real pool the route will use
    conn = await pool.getConnection();

    // ---- Real-ish schema (production column names). `business`, NOT business_name. ----
    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), business VARCHAR(120) NULL, role INT NULL, category INT NULL, created_by INT NULL)');
    await conn.query(`CREATE TABLE tasks (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, team_id INT NULL,
      created_by INT NULL, status TINYINT DEFAULT 0, assignee_completed TINYINT DEFAULT 0, assignee_seen_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE task_assignees (id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, user_id INT NOT NULL,
      seen_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_task_user (task_id, user_id))`);
    await conn.query('CREATE TABLE teams (id INT PRIMARY KEY, team_leader INT NULL)');
    // 74 = owner/GC (role 14); 372,360 = contractors under 74 (category 2 ≠ employee=1,
    // so resolveOwnerId returns SELF → NOT same account → genuinely delegated);
    // 90 = employee foreman of 74 (category 1 → resolves to owner 74, acts-as-GC);
    // 999 = unrelated external GC.
    await conn.query(`INSERT INTO \`user\`(id,name,business,role,category,created_by) VALUES
      (74,'Owner Poul',NULL,14,2,NULL),
      (372,'Rolando Torres','C & R TILE',12,2,74),
      (360,'John Bates','John Bates Painting',12,2,74),
      (90,'Foreman Bill',NULL,5,1,74),
      (999,'External Contractor',NULL,12,2,NULL),
      (998,'External GC (other account)',NULL,14,2,NULL)`);
    // 998 is a role-14 GC on a DIFFERENT account — used to prove the cross-account
    // /complete fix: without the ownsTask requirement on the role-14 branch, 998
    // could finalize account 74's tasks by id. Case 7 asserts it is now refused.

    console.log('A) DATA LAYER');
    // 1) Multi-assign create: assignees [372,360], primary=372 mirrored to tasks.user_id
    const [ins] = await conn.query('INSERT INTO tasks (user_id, created_by) VALUES (?, ?)', [372, 74]);
    const taskId = ins.insertId;
    await syncTaskAssignees(conn, taskId, [372, 360]);
    const [[cnt]] = await conn.query('SELECT COUNT(*) n FROM task_assignees WHERE task_id=?', [taskId]);
    ok(cnt.n === 2, 'create: assignees written to task_assignees');
    const [[pri]] = await conn.query('SELECT user_id FROM tasks WHERE id=?', [taskId]);
    ok(Number(pri.user_id) === 372, 'create: tasks.user_id = primary for backward-compat');

    // 2) Read returns assignees[] with names + business (aliased business_name) + null seen
    let [t] = await conn.query('SELECT id FROM tasks WHERE id=?', [taskId]);
    await attachAssignees(conn, t);
    ok(t[0].assignees.length === 2, 'read: attachAssignees returns all assignees');
    ok(t[0].assignees.every((a) => a.seen_at === null), 'read: everyone starts unseen (gold)');
    ok(t[0].assignees.some((a) => a.business_name === 'C & R TILE'),
       'read: business (real column) surfaced as business_name — catches the u.business alias regression');

    // 3) Per-person seen is INDEPENDENT — only Rolando (372) opens it
    await stampSeen(conn, taskId, 372);
    [t] = await conn.query('SELECT id FROM tasks WHERE id=?', [taskId]);
    await attachAssignees(conn, t);
    ok(seenOf(t[0].assignees, 372) !== null, 'seen: Rolando (372) now seen (green)');
    ok(seenOf(t[0].assignees, 360) === null, 'seen: John (360) still unseen (independent)');

    // 4) Re-sync preserves kept seen; new member starts unseen
    await syncTaskAssignees(conn, taskId, [372, 90]); // drop 360, keep 372, add 90
    [t] = await conn.query('SELECT id FROM tasks WHERE id=?', [taskId]);
    await attachAssignees(conn, t);
    const ids = t[0].assignees.map((a) => Number(a.user_id)).sort((a, b) => a - b);
    ok(JSON.stringify(ids) === JSON.stringify([90, 372]), 're-sync: set is now {372,90}, 360 removed');
    ok(seenOf(t[0].assignees, 372) !== null, 're-sync: Rolando (372) KEPT his seen stamp (INSERT IGNORE, not wiped)');
    ok(seenOf(t[0].assignees, 90) === null, 're-sync: newly-added foreman (90) starts unseen');

    // 5) Legacy backfill: pre-existing single-assignee task with a prior per-task seen
    const [legacy] = await conn.query("INSERT INTO tasks (user_id, created_by, assignee_seen_at) VALUES (360, 74, '2026-08-10 09:00:00')");
    await conn.query(`INSERT IGNORE INTO task_assignees (task_id, user_id, seen_at)
                      SELECT id, user_id, assignee_seen_at FROM tasks WHERE id=? AND user_id IS NOT NULL`, [legacy.insertId]);
    let [lt] = await conn.query('SELECT id FROM tasks WHERE id=?', [legacy.insertId]);
    await attachAssignees(conn, lt);
    ok(lt[0].assignees.length === 1 && Number(lt[0].assignees[0].user_id) === 360, 'backfill: legacy task seeded with its single assignee');
    ok(lt[0].assignees[0].seen_at !== null, 'backfill: legacy per-task seen carried onto the assignee row');

    // ---- B) ROUTE LAYER: drive the REAL PATCH /:id/complete handler ----
    console.log('\nB) ROUTE LAYER — real PATCH /tasks/:id/complete (FINAL completion model)');
    let ACTOR = null;
    const authMod = require('../services/authentication');
    authMod.authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const express = require('express');
    const request = require('supertest');
    const tasksRouter = require('../routes/tasks');
    const app = express();
    app.use(express.json());
    app.use('/tasks', tasksRouter);
    server = app.listen(0);

    // helper: build a fresh task with a roster
    const mkTask = async (createdBy, primary, roster) => {
      const [r] = await conn.query('INSERT INTO tasks (user_id, created_by, status, assignee_completed) VALUES (?, ?, 0, 0)', [primary, createdBy]);
      await syncTaskAssignees(conn, r.insertId, roster);
      return r.insertId;
    };
    const statusOf = async (id) => {
      const [[row]] = await conn.query('SELECT status, assignee_completed FROM tasks WHERE id=?', [id]);
      return row;
    };
    const complete = (id) => request(server).patch(`/tasks/${id}/complete`).send({ assignee_completed: true });

    // Case 1 — DELEGATED primary assignee checks their box → signal only, NO finalize
    ACTOR = { id: 372, role: 12 };
    let id1 = await mkTask(74, 372, [372, 360]);
    let r1 = await complete(id1);
    let s1 = await statusOf(id1);
    ok(r1.status === 200 && s1.status === 0 && s1.assignee_completed === 1,
       'delegated assignee check: status STAYS 0, assignee_completed=1 (ready-for-review, task stays)');
    ok(!('status' in r1.body), 'delegated assignee check: response omits status (no finalize)');

    // Case 2 — BROADCAST roster member (non-primary) checks → allowed, still no finalize
    ACTOR = { id: 360, role: 12 };
    let id2 = await mkTask(74, 372, [372, 360]);
    let r2 = await complete(id2);
    let s2 = await statusOf(id2);
    ok(r2.status === 200 && s2.status === 0 && s2.assignee_completed === 1,
       'broadcast member (non-primary) check: allowed via task_assignees membership, status STAYS 0');

    // Case 3 — BOSS/GC (not an assignee) checks a delegated task → FINALIZES
    ACTOR = { id: 74, role: 14 };
    let id3 = await mkTask(74, 372, [372, 360]);
    let r3 = await complete(id3);
    let s3 = await statusOf(id3);
    ok(r3.status === 200 && s3.status === 1 && s3.assignee_completed === 1 && r3.body.status === 1,
       'boss/GC check: FINALIZES status=1 for everyone (override)');

    // Case 4 — SELF-ASSIGNED (assignee == creator) checks → FINALIZES (no boss to report to)
    ACTOR = { id: 372, role: 12 };
    let id4 = await mkTask(372, 372, [372]);
    let r4 = await complete(id4);
    let s4 = await statusOf(id4);
    ok(r4.status === 200 && s4.status === 1 && r4.body.status === 1,
       'self-assigned check: FINALIZES status=1 (assignee IS the creator)');

    // Case 5 — Employee FOREMAN of the GC (acts-as-GC) on a delegated task → FINALIZES
    ACTOR = { id: 90, role: 5 };
    let id5 = await mkTask(74, 372, [372, 360]);
    let r5 = await complete(id5);
    let s5 = await statusOf(id5);
    ok(r5.status === 200 && s5.status === 1,
       'foreman-of-GC check (role∈[2,3,4,5] + owns account, not assignee): FINALIZES status=1');

    // Case 6 — Unrelated EXTERNAL non-member (role 12, other account) → 403, nothing changes
    ACTOR = { id: 999, role: 12 };
    let id6 = await mkTask(74, 372, [372, 360]);
    let r6 = await complete(id6);
    let s6 = await statusOf(id6);
    ok(r6.status === 403 && s6.status === 0 && s6.assignee_completed === 0,
       'external non-member: 403, task untouched');

    // Case 7 — CROSS-ACCOUNT SECURITY: a role-14 GC from ANOTHER account (not
    // assignee, not this account's owner) must NOT be able to finalize by id.
    // This is the fix for the /complete cross-account auth gap.
    ACTOR = { id: 998, role: 14 };
    let id7 = await mkTask(74, 372, [372, 360]);
    let r7 = await complete(id7);
    let s7 = await statusOf(id7);
    ok(r7.status === 403 && s7.status === 0 && s7.assignee_completed === 0,
       'cross-account role-14 GC: 403, task untouched (ownsTask now required for role 14)');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally {
    try { if (server) server.close(); } catch {}
    try { if (conn) conn.release(); } catch {}
    try { if (pool && pool.end) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
})();
