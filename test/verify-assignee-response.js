/* Per-assignee one-time response — drives the REAL POST /tasks/:id/assignee-response
 * against real MySQL. Proves: own-row-only, write-once lock, assignee-only, and that
 * attachAssignees returns response/responded_at. Run: node test/verify-assignee-response.js
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

(async () => {
  let db, pool, conn, server;
  try {
    process.env.NODE_ENV = 'test';
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_resp', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), business VARCHAR(120) NULL, role INT NULL, category INT NULL, created_by INT NULL)');
    await conn.query('CREATE TABLE tasks (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, created_by INT NULL, task_name VARCHAR(255) NULL)');
    await conn.query(`CREATE TABLE task_assignees (id INT AUTO_INCREMENT PRIMARY KEY, task_id INT, user_id INT,
      seen_at DATETIME NULL, response TEXT NULL, responded_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY u (task_id,user_id))`);

    await conn.query(`INSERT INTO \`user\`(id,name,business,role,category,created_by) VALUES
      (74,'Owner Poul','OAK COAST',14,2,NULL),(372,'Rolando','Vega',12,2,74),(373,'Maria',NULL,12,2,74),(360,'Outsider',NULL,12,2,74)`);

    // Task primary = 372; roster = 372 + 373. 360 is NOT an assignee. 74 is the boss.
    const [tr] = await conn.query("INSERT INTO tasks (user_id, created_by, task_name) VALUES (372, 74, 'Install trim')");
    const taskId = tr.insertId;
    await conn.query('INSERT INTO task_assignees (task_id, user_id) VALUES (?,372),(?,373)', [taskId, taskId]);

    let ACTOR = { id: 372, role: 12 };
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const express = require('express');
    const request = require('supertest');
    const app = express(); app.use(express.json());
    app.use('/tasks', require('../routes/tasks'));
    server = app.listen(0);
    const { attachAssignees } = require('../services/taskAssignees');
    const rowOf = async (uid) => (await conn.query('SELECT response, responded_at FROM task_assignees WHERE task_id=? AND user_id=?', [taskId, uid]))[0][0];

    // A — assignee 372 submits → 200, locked, saved
    ACTOR = { id: 372, role: 12 };
    let r = await request(server).post(`/tasks/${taskId}/assignee-response`).send({ response: 'Trim done, caulked.' });
    ok(r.status === 200 && r.body.locked === true && r.body.response === 'Trim done, caulked.', 'A: assignee submits → 200 locked + saved');
    const a372 = await rowOf(372);
    ok(a372.response === 'Trim done, caulked.' && a372.responded_at, 'A: 372 row has response + responded_at');
    // own-row isolation: 373 untouched
    const a373 = await rowOf(373);
    ok(a373.response === null && a373.responded_at === null, 'A: 373 row untouched (own-row-only write)');

    // B — 372 submits again → 409, original UNCHANGED (write-once lock)
    r = await request(server).post(`/tasks/${taskId}/assignee-response`).send({ response: 'CHANGED my mind' });
    ok(r.status === 409 && r.body.locked === true, 'B: second submit → 409 locked');
    ok((await rowOf(372)).response === 'Trim done, caulked.', 'B: original response unchanged after 2nd submit');

    // C — outsider 360 (not an assignee) → 403, writes nothing
    ACTOR = { id: 360, role: 12 };
    r = await request(server).post(`/tasks/${taskId}/assignee-response`).send({ response: 'sneaky' });
    ok(r.status === 403, 'C: non-assignee → 403');
    const [[{ n360 }]] = await conn.query('SELECT COUNT(*) n360 FROM task_assignees WHERE task_id=? AND user_id=360', [taskId]);
    ok(Number(n360) === 0, 'C: no row created for non-assignee');

    // D — boss 74 (not an assignee) → 403
    ACTOR = { id: 74, role: 14 };
    r = await request(server).post(`/tasks/${taskId}/assignee-response`).send({ response: 'boss reply' });
    ok(r.status === 403, 'D: boss/non-assignee → 403 (cannot respond)');

    // E — empty text → 400
    ACTOR = { id: 373, role: 12 };
    r = await request(server).post(`/tasks/${taskId}/assignee-response`).send({ response: '   ' });
    ok(r.status === 400, 'E: empty response → 400');

    // F — 373 submits properly → 200; now both rows have responses
    r = await request(server).post(`/tasks/${taskId}/assignee-response`).send({ response: 'Painted too.' });
    ok(r.status === 200 && r.body.response === 'Painted too.', 'F: second assignee submits their own → 200');

    // G — attachAssignees returns response/responded_at per person
    const tasksArr = [{ id: taskId }];
    await attachAssignees(pool, tasksArr);
    const roster = tasksArr[0].assignees;
    const g372 = roster.find((x) => x.user_id === 372);
    const g373 = roster.find((x) => x.user_id === 373);
    ok(g372 && g372.response === 'Trim done, caulked.' && !!g372.responded_at, 'G: attachAssignees returns 372 response+responded_at');
    ok(g373 && g373.response === 'Painted too.' && !!g373.responded_at, 'G: attachAssignees returns 373 response+responded_at');

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
