/* Field-scoped ownership gate on PUT /jobtask/update/:id  (task 5).
 *
 * Proves, against real MySQL (mysql-memory-server) + supertest, that a caller who
 * passes ONLY the assignee branch (a cross-account PRIMARY assignee — a sub) can
 * NO LONGER write the owner-only fields, while keeping every other capability:
 *   - PUT {complete_percentage} by the sub-assignee  -> 403 PERCENT_OWNER_ONLY, row unchanged
 *   - PUT {start_date}          by the sub-assignee  -> 403 SCHEDULE_OWNER_ONLY, row unchanged
 *   - PUT {task_name}           by the sub-assignee  -> allowed (content edit), name changed
 *   - PUT {complete_percentage} by the OWNER         -> allowed, percent changed
 *   - a full-object PUT that ECHOES the unchanged percent/date by the sub -> allowed (no false reject)
 *
 *   G(900) owner GC (owns the job + created the task)
 *   S(910) cross-company sub — the task's PRIMARY assignee (tasks.user_id = 910)
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
      (910,'Cross Sub','s@x.com',14,2,'Bravo Framing',NULL, NOW() - INTERVAL 200 DAY)`);
    await conn.query("INSERT INTO subscriptions (user_id,status) VALUES (900,'active'),(910,'active')");
    await conn.query("INSERT INTO job (id,created_by,name,status) VALUES (1900,900,'G job',1)");
    // Task on G's job whose PRIMARY assignee (tasks.user_id) is the cross-company sub S.
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status,complete_percentage,start_date,duration_days,created_at) VALUES (2900,1900,910,900,'job','Framing',0,20,'2026-09-10',3, NOW())");

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/jobtask', require('../routes/tasks'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id, role: 14, category: 2, email: id + '@x.com', working_id: id }, process.env.ACCESS_TOKEN);
    const pctOf = async () => { const [[r]] = await conn.query('SELECT complete_percentage, start_date, task_name FROM tasks WHERE id=2900'); return r; };

    // 1) sub-assignee cannot write percent
    const r1 = await request(app).put('/api/jobtask/update/2900').set('Authorization', tok(910)).send({ complete_percentage: 50 });
    let row = await pctOf();
    ok(r1.status === 403 && r1.body.code === 'PERCENT_OWNER_ONLY', '1: sub PUT complete_percentage -> 403 PERCENT_OWNER_ONLY', r1.status + ' ' + JSON.stringify(r1.body));
    ok(Number(row.complete_percentage) === 20, '1: percent unchanged after refusal (still 20)', row.complete_percentage);

    // 2) sub-assignee cannot write dates
    const r2 = await request(app).put('/api/jobtask/update/2900').set('Authorization', tok(910)).send({ start_date: '2026-09-01' });
    row = await pctOf();
    ok(r2.status === 403 && r2.body.code === 'SCHEDULE_OWNER_ONLY', '2: sub PUT start_date -> 403 SCHEDULE_OWNER_ONLY', r2.status + ' ' + JSON.stringify(r2.body));
    ok(String(row.start_date).slice(0, 10) === '2026-09-10', '2: start_date unchanged after refusal', String(row.start_date));

    // 3) sub-assignee CAN still edit a content field (task_name). Real FE edits
    //    include user_id, so keep the sub as the primary assignee across the PUT.
    const r3 = await request(app).put('/api/jobtask/update/2900').set('Authorization', tok(910)).send({ task_name: 'Framing v2', user_id: 910 });
    row = await pctOf();
    ok(r3.status === 200, '3: sub PUT task_name -> 200 (content edit allowed)', r3.status + ' ' + JSON.stringify(r3.body));
    ok(row.task_name === 'Framing v2', '3: task_name changed by sub', row.task_name);

    // 4) a full-object echo of the UNCHANGED percent/date by the sub is NOT falsely refused
    const r4 = await request(app).put('/api/jobtask/update/2900').set('Authorization', tok(910)).send({ task_name: 'Framing v3', user_id: 910, complete_percentage: 20, start_date: '2026-09-10' });
    ok(r4.status === 200, '4: sub full-object PUT echoing unchanged percent+date -> 200 (no false reject)', r4.status + ' ' + JSON.stringify(r4.body));

    // 5) the OWNER can still write percent
    const r5 = await request(app).put('/api/jobtask/update/2900').set('Authorization', tok(900)).send({ complete_percentage: 60 });
    row = await pctOf();
    ok(r5.status === 200 && Number(row.complete_percentage) === 60, '5: owner PUT complete_percentage -> 200 and percent = 60', r5.status + ' pct=' + row.complete_percentage);

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
