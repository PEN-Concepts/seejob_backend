/* CROSS-COMPANY GUARDS ON 8 PREVIOUSLY-UNGUARDED ROUTES.
 *
 * invitations.js has no router-level guard, and these 8 routes carried no
 * per-route ownership check and no caller reference in their SQL — any logged-in
 * user could act on any company's rows by passing an id. Audit finding #2,
 * confirmed LIVE cross-company (a user of company A deleted/overwrote company B's
 * rows). Each now carries the shared ownership guard from utils/ownership.js.
 *
 * This proves, through the REAL routers, that after the fix:
 *   - company A acting on company B's row is REFUSED (403), and B's row is
 *     UNCHANGED — for the destructive routes, the guard runs BEFORE the DELETE;
 *   - company B acting on its OWN row still works and still mutates it (rule 11:
 *     a refusal must be the guard, not a missing row or a 500).
 *
 * Route #1 (GET /by-job/:job_id) has a pre-existing `db is not defined` bug and
 * 500s for everyone; it is guarded defensively (cross -> 403) but its
 * same-company call is a 500 for reasons unrelated to this change. Not fixed
 * here — reported separately.
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x === undefined ? '' : x)}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret'; delete process.env.NODE_ENV; process.env.API_URL = '/api';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_xtenant_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1'; process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root'; process.env.DB_PASSWORD_DEV = ''; process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection'); conn = await pool.getConnection();
    const q = (s, p) => conn.query(s, p);

    await q("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), mobile VARCHAR(40), role INT, category INT NULL, created_by INT NULL, status INT DEFAULT 1, token_version INT DEFAULT 0)");
    await q("CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120), created_by INT)");
    await q("CREATE TABLE leads (id INT PRIMARY KEY, name VARCHAR(120), user_id INT)");
    await q("CREATE TABLE tasks (id INT PRIMARY KEY, task_name VARCHAR(120), user_id INT NULL, job_id INT NULL, created_by INT, remove_by INT NULL, is_appointment_task INT DEFAULT 0)");
    await q("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, contact_id INT, owner_type VARCHAR(20) DEFAULT 'job')");
    await q("CREATE TABLE appointments (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, job_id INT NULL, user_id INT NULL, created_by INT NULL)");
    await q("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, is_appointment INT DEFAULT 0, appointment_id INT NULL)");
    await q("CREATE TABLE employees_leaves (id INT PRIMARY KEY, leave_type VARCHAR(60), quota INT, created_by INT, created_at DATETIME NULL)");
    await q("CREATE TABLE leave_request (id INT PRIMARY KEY, emp_id INT, status VARCHAR(30) DEFAULT 'pending', approver INT NULL, created_by INT)");
    await q("CREATE TABLE daily_report (id INT PRIMARY KEY, job_id INT, foreman_id INT NULL, date DATE NULL)");
    await q("CREATE TABLE safety_cours (id INT PRIMARY KEY, name VARCHAR(120), description VARCHAR(255), duration VARCHAR(60), status INT DEFAULT 0, created_by INT, generated_by INT NULL, attachments VARCHAR(190) NULL, created_at DATETIME NULL)");
    await q("INSERT INTO `user` (id,name,email,mobile,role,category,created_by) VALUES (100,'A Owner','a@x.com','111',14,2,NULL),(101,'A Emp','ae@x.com','112',5,1,100),(200,'B Owner','b@x.com','222',14,2,NULL),(201,'B Emp','be@x.com','223',5,1,200),(250,'B Contact','bc@x.com','250250',12,2,200)");
    await q("INSERT INTO job (id,name,created_by) VALUES (900,'A Job',100),(901,'B Job',200)");
    await q("INSERT INTO tasks (id,task_name,user_id,job_id,created_by,is_appointment_task) VALUES (810,'A task',100,900,100,1),(800,'B task',200,901,200,1)");
    await q("INSERT INTO job_contacts (job_id,contact_id,owner_type) VALUES (901,250,'job'),(900,101,'job')");
    await q("INSERT INTO appointments (id,task_id,job_id,user_id,created_by) VALUES (5001,800,901,200,200),(5010,800,901,200,200),(5002,810,900,100,100)");
    await q("INSERT INTO employees_leaves (id,leave_type,quota,created_by) VALUES (700,'PTO',5,200),(701,'PTO',5,200),(710,'PTO',5,100)");
    await q("INSERT INTO leave_request (id,emp_id,status,created_by) VALUES (600,201,'pending',200),(610,101,'pending',100)");
    await q("INSERT INTO daily_report (id,job_id) VALUES (500,901),(510,900)");
    await q("INSERT INTO safety_cours (id,name,description,duration,status,created_by) VALUES (400,'B course','d','1h',1,200),(410,'A course','d','1h',1,100)");

    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/invitations', require('../routes/invitations'));
    app.use('/api/user', require('../routes/users'));
    app.use('/api/safety_course', require('../routes/safety_course'));
    const request = require('supertest'); const jwt = require('jsonwebtoken');
    const tok = (id) => 'Bearer ' + jwt.sign({ id, tv: 0 }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
    const call = async (m, p, who, body) => { let r = request(app)[m](p).set('Authorization', tok(who)); if (body) r = r.send(body); return r; };
    const val = async (s, p) => { const [r] = await conn.query(s, p); return r[0]; };
    const A = 100, B = 200; // A acts across the boundary; B owns the rows

    // #2 read PII — cross gets 403 and no rows; same gets the contact.
    let r = await call('get', '/api/invitations/get_job_contacts/901', A);
    ok(r.status === 403, '#2 get_job_contacts: cross-company is 403', r.status);
    r = await call('get', '/api/invitations/get_job_contacts/901', B);
    ok(r.status === 200 && Array.isArray(r.body) && r.body.length === 1, '#2 get_job_contacts: owner still gets the contact', JSON.stringify(r.body).slice(0, 120));
    ok(r.body[0] && (r.body[0].email || r.body[0].mobile), '#2: owner receives the PII (email/mobile)', JSON.stringify(r.body[0]));

    // #3 delete appointments by task — destructive, must refuse BEFORE delete.
    r = await call('delete', '/api/invitations/appointments/by-task/800', A);
    ok(r.status === 403, '#3 appt/by-task: cross-company is 403', r.status);
    ok((await val("SELECT COUNT(*) c FROM appointments WHERE task_id=800")).c === 2, "#3: B's appointments untouched after cross attempt (guard ran before DELETE)");
    r = await call('delete', '/api/invitations/appointments/by-task/800', B);
    ok(r.status === 200 && (await val("SELECT COUNT(*) c FROM appointments WHERE task_id=800")).c === 0, '#3: owner can still delete its own', r.status);

    // #4 update employees_leaves — write.
    r = await call('put', '/api/invitations/update/700', A, { leave_type: 'HACKED', quota: 99 });
    ok(r.status === 403, '#4 update: cross-company is 403', r.status);
    ok((await val("SELECT leave_type FROM employees_leaves WHERE id=700")).leave_type === 'PTO', "#4: B's leave row unchanged after cross attempt");
    r = await call('put', '/api/invitations/update/700', B, { leave_type: 'REALPTO', quota: 7 });
    ok(r.status === 200 && (await val("SELECT leave_type FROM employees_leaves WHERE id=700")).leave_type === 'REALPTO', '#4: owner can still update its own', r.status);

    // #5 delete employees_leaves — destructive.
    r = await call('delete', '/api/invitations/delete/701', A);
    ok(r.status === 403, '#5 delete: cross-company is 403', r.status);
    ok((await val("SELECT COUNT(*) c FROM employees_leaves WHERE id=701")).c === 1, "#5: B's leave row still exists after cross attempt (guard ran before DELETE)");
    r = await call('delete', '/api/invitations/delete/701', B);
    ok(r.status === 200 && (await val("SELECT COUNT(*) c FROM employees_leaves WHERE id=701")).c === 0, '#5: owner can still delete its own', r.status);

    // #6 approve leave_request — write.
    r = await call('put', '/api/user/approve-leave/600', A, { approverId: A });
    ok(r.status === 403, '#6 approve-leave: cross-company is 403', r.status);
    ok((await val("SELECT status FROM leave_request WHERE id=600")).status === 'pending', "#6: B's leave_request unchanged after cross attempt");
    r = await call('put', '/api/user/approve-leave/600', B, { approverId: B });
    ok(r.status === 200 && (await val("SELECT status FROM leave_request WHERE id=600")).status === 'approved', '#6: owner can still approve its own', r.status);

    // #7 delete daily_report — destructive.
    r = await call('delete', '/api/user/daily-report/500', A);
    ok(r.status === 403, '#7 daily-report: cross-company is 403', r.status);
    ok((await val("SELECT COUNT(*) c FROM daily_report WHERE id=500")).c === 1, "#7: B's daily report still exists after cross attempt (guard ran before DELETE)");
    r = await call('delete', '/api/user/daily-report/500', B);
    ok(r.status === 200 && (await val("SELECT COUNT(*) c FROM daily_report WHERE id=500")).c === 0, '#7: owner can still delete its own', r.status);

    // #8 edit safety course — write.
    r = await call('put', '/api/safety_course/course/400', A, { name: 'HACKED', description: 'x', duration: '1h', status: 1 });
    ok(r.status === 403, '#8 course: cross-company is 403', r.status);
    ok((await val("SELECT name FROM safety_cours WHERE id=400")).name === 'B course', "#8: B's course unchanged after cross attempt");
    r = await call('put', '/api/safety_course/course/400', B, { name: 'REALCOURSE', description: 'x', duration: '1h', status: 1 });
    ok(r.status === 200 && (await val("SELECT name FROM safety_cours WHERE id=400")).name === 'REALCOURSE', '#8: owner can still edit its own', r.status);

    // #1 by-job: guarded defensively; cross must be 403 (the route itself has a
    // pre-existing db-not-defined bug, so a same-company 200 is not assertable).
    r = await call('get', '/api/invitations/by-job/901', A);
    ok(r.status === 403, '#1 by-job: cross-company is 403 (defensive; route otherwise 500s for all)', r.status);

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    conn.release(); if (pool.end) await pool.end(); if (db.stop) await db.stop();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log(rec.join('\n'));
    console.error('HARNESS ERROR:', e && e.message);
    try { if (conn) conn.release(); if (pool && pool.end) await pool.end(); if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(1);
  }
})();
