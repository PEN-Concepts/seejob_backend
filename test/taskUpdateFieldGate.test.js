/* WHITELIST gate on PUT /jobtask/update/:id  (sub-permission tighten, task 13).
 *
 * Proves, against real MySQL (mysql-memory-server) + supertest, that a non-owning
 * PRIMARY assignee (a cross-account sub) may change ONLY their own completion —
 * `assignee_completed` and `completion_response` — and NOTHING else. Every other
 * field is refused with 403 ASSIGNEE_COMPLETION_ONLY and the row stays unchanged,
 * while the OWNER can still write everything. This is a pure sub check-off box,
 * not wired to the owner's status tick or the percentage.
 *
 *   G(900) owner GC (owns the job + created the task)
 *   S(910) cross-company sub — the task's PRIMARY assignee (tasks.user_id = 910)
 *   X(920) another user (re-assignment target the sub must not be able to set)
 *
 * Run: NODE_PATH=<backend>/node_modules node test/taskUpdateFieldGate.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_taskfieldgate_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();

    // ---- schema (superset of what the update handler touches up to its gate) ----
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT, category INT, business VARCHAR(150) NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30))");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(150), status INT DEFAULT 1)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY, job_id INT NULL, user_id INT NULL, team_id INT NULL, created_by INT NULL, task_type VARCHAR(20), task_name VARCHAR(150), description TEXT NULL, status INT NULL, priority VARCHAR(20) NULL, start_date DATE NULL, end_date DATE NULL, time VARCHAR(20) NULL, duration_days INT NULL, complete_percentage INT NULL, is_calendar_task INT NULL, is_appointment_task INT NULL, is_urgent INT NULL, nudge DATETIME NULL, status_note TEXT NULL, completion_response TEXT NULL, audio_note VARCHAR(255) NULL, assignee_completed INT NULL, image VARCHAR(255) NULL, created_at DATETIME NULL, archived_at DATETIME NULL)");
    await conn.query("CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT, seen_at DATETIME NULL, response TEXT NULL, responded_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT NULL)");
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_leader INT NULL, created_by INT NULL)");

    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,business,created_by,created_at) VALUES
      (900,'Owner GC','g@x.com',14,2,'Acme Builders',NULL, NOW() - INTERVAL 200 DAY),
      (910,'Cross Sub','s@x.com',14,2,'Bravo Framing',NULL, NOW() - INTERVAL 200 DAY),
      (920,'Other','x@x.com',14,2,'Charlie',NULL, NOW() - INTERVAL 200 DAY)`);
    await conn.query("INSERT INTO subscriptions (user_id,status) VALUES (900,'active'),(910,'active'),(920,'active')");
    await conn.query("INSERT INTO job (id,created_by,name,status) VALUES (1900,900,'G job',1)");
    // Task on G's job whose PRIMARY assignee (tasks.user_id) is the cross-company sub S.
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,description,priority,status,complete_percentage,start_date,duration_days,is_urgent,assignee_completed,created_at) VALUES (2900,1900,910,900,'job','Framing','desc','low',0,20,'2026-09-10',3,0,0, NOW())");

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/jobtask', require('../routes/tasks'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id, role: 14, category: 2, email: id + '@x.com', working_id: id }, process.env.ACCESS_TOKEN);
    const row = async () => { const [[r]] = await conn.query('SELECT * FROM tasks WHERE id=2900'); return r; };
    const subPut = (body) => request(app).put('/api/jobtask/update/2900').set('Authorization', tok(910)).send(body);

    // ---- BLOCKED for the sub: every non-completion field -> 403, row unchanged ----
    // Each carries user_id:910 (real FE edits always echo the primary assignee) so
    // the only *changed* field is the one under test.
    const blocked = [
      ['complete_percentage', { complete_percentage: 50, user_id: 910 }],
      ['start_date',          { start_date: '2026-09-01', user_id: 910 }],
      ['duration_days',       { duration_days: 9, user_id: 910 }],
      ['task_name',           { task_name: 'Hacked', user_id: 910 }],
      ['priority',            { priority: 'high', user_id: 910 }],
      ['description',         { description: 'changed', user_id: 910 }],
      ['is_urgent',           { is_urgent: 1, user_id: 910 }],
      ['status_note',         { status_note: 'note', user_id: 910 }],
      ['is_calendar_task',    { is_calendar_task: 1, user_id: 910 }],
    ];
    for (const [label, body] of blocked) {
      const r = await subPut(body);
      ok(r.status === 403 && r.body.code === 'ASSIGNEE_COMPLETION_ONLY',
        `sub CANNOT write ${label} -> 403 ASSIGNEE_COMPLETION_ONLY`, r.status + ' ' + JSON.stringify(r.body));
    }
    // spot-check the row is genuinely untouched by the refusals above
    {
      const t = await row();
      ok(Number(t.complete_percentage) === 20, 'percent still 20 after all refusals', t.complete_percentage);
      ok(t.task_name === 'Framing', 'task_name still "Framing" after all refusals', t.task_name);
    }

    // sub cannot re-assign the task to someone else
    const rReassign = await subPut({ user_id: 920 });
    ok(rReassign.status === 403 && rReassign.body.code === 'ASSIGNEE_COMPLETION_ONLY',
      'sub CANNOT re-assign (user_id -> 920) -> 403 ASSIGNEE_COMPLETION_ONLY', rReassign.status + ' ' + JSON.stringify(rReassign.body));
    ok(Number((await row()).user_id) === 910, 'primary assignee unchanged (still 910)', (await row()).user_id);

    // ---- ALLOWED for the sub: completion_response, then assignee_completed ----
    const rC = await subPut({ completion_response: 'Done, sealed the deck.', user_id: 910 });
    ok(rC.status === 200, 'sub CAN write completion_response -> 200', rC.status + ' ' + JSON.stringify(rC.body));
    ok((await row()).completion_response === 'Done, sealed the deck.', 'completion_response saved', (await row()).completion_response);

    const rD = await subPut({ assignee_completed: 1, user_id: 910 });
    ok(rD.status === 200, 'sub CAN write assignee_completed -> 200', rD.status + ' ' + JSON.stringify(rD.body));
    {
      const t = await row();
      ok(Number(t.assignee_completed) === 1, 'assignee_completed set to 1', t.assignee_completed);
      ok(Number(t.status) !== 1, 'sub checkoff did NOT tick the owner status', t.status);
      ok(Number(t.complete_percentage) === 20, 'sub checkoff did NOT move the percentage (still 20)', t.complete_percentage);
    }

    // ---- unchanged echo (full-object PUT repeating current values) is NOT refused ----
    const rE = await subPut({ user_id: 910, task_name: 'Framing', priority: 'low', description: 'desc', complete_percentage: 20, start_date: '2026-09-10' });
    ok(rE.status === 200, 'sub full-object PUT echoing unchanged values -> 200 (no false reject)', rE.status + ' ' + JSON.stringify(rE.body));

    // ---- OWNER can still write everything ----
    const rO = await request(app).put('/api/jobtask/update/2900').set('Authorization', tok(900)).send({ complete_percentage: 60, task_name: 'Framing v2', user_id: 910 });
    {
      const t = await row();
      ok(rO.status === 200 && Number(t.complete_percentage) === 60 && t.task_name === 'Framing v2',
        'owner CAN write percent + name -> 200', rO.status + ' pct=' + t.complete_percentage + ' name=' + t.task_name);
    }

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 6).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
