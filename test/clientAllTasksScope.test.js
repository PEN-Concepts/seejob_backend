/* Round 8 (CLIENT ONLY): GET /jobs/all-tasks (the "My Daily Tasks" source) must
 * show a Client ONLY the tasks assigned to them — not the owner's whole account
 * (the "26 tasks" bug). Subcontractors are intentionally UNCHANGED this round.
 * Run: NODE_PATH=<backend>/node_modules node test/clientAllTasksScope.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_client_alltasks', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE user (id INT PRIMARY KEY, name VARCHAR(120), role INT, category INT, created_by INT)`);
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120), job_address VARCHAR(190), status INT, color VARCHAR(20), created_by INT, sort_order INT DEFAULT 0)`);
    await conn.query(`CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(120), project_street_address VARCHAR(190), status VARCHAR(10), user_id INT, bid_status VARCHAR(40), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, task_type VARCHAR(20), user_id INT, team_id INT, created_by INT, archived_at DATETIME NULL, status INT DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)`);
    await conn.query(`CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, contact_id INT)`);
    await conn.query(`CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20))`);
    await conn.query(`CREATE TABLE check_list (id INT PRIMARY KEY, name VARCHAR(120), photo VARCHAR(190), assign_to INT, job_id INT, priority VARCHAR(20), due_date DATETIME, status INT, is_calendar TINYINT, is_appointment TINYINT, calendar_task_id INT, appointment_id INT, created_by INT, type VARCHAR(20))`);
    await conn.query(`CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT)`);

    await conn.query(`INSERT INTO user (id,name,role,category,created_by) VALUES
      (74,'Poul',14,4,NULL),(86,'Emp',3,1,74),(376,'Joshua Client',3,3,74),(400,'Sub',3,2,74)`);
    await conn.query(`INSERT INTO job (id,name,status,created_by) VALUES (1,'Job One',1,74),(2,'Job Two',1,74)`);
    // 5 account tasks (all created_by owner 74). t4 assigned to CLIENT 376; t5 to SUB 400.
    await conn.query(`INSERT INTO tasks (job_id,task_type,user_id,created_by) VALUES
      (1,'job',86,74),(1,'job',86,74),(2,'job',86,74),(1,'job',376,74),(1,'job',400,74)`);

    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/jobs', require('../routes/jobs'));

    const call = (claims) => request(app).get('/jobs/all-tasks')
      .set('Authorization', 'Bearer ' + jwt.sign(claims, process.env.ACCESS_TOKEN));
    const OWNER = { id: 74, working_id: 74, role: 14, category: 4, email: 'poul@t.co' };
    const CLIENT = { id: 376, working_id: 74, role: 3, category: 3, email: 'client@t.co' };
    const SUB = { id: 400, working_id: 74, role: 3, category: 2, email: 'sub@t.co' };
    const countTasks = (b) => {
      let n = 0;
      for (const k in (b.jobTasksByJobId || {})) n += b.jobTasksByJobId[k].length;
      for (const k in (b.leadTasksByLeadId || {})) n += b.leadTasksByLeadId[k].length;
      n += (b.noJobTasks || []).length;
      return n;
    };

    const o = await call(OWNER);
    ok(countTasks(o.body) === 5, 'OWNER sees all 5 account tasks', String(countTasks(o.body)));

    const c = await call(CLIENT);
    ok(countTasks(c.body) === 1, 'CLIENT sees ONLY the 1 task assigned to them (not the owner\'s 5)', String(countTasks(c.body)));
    ok((c.body.jobs || []).length === 1 && Number(c.body.jobs[0].id) === 1,
      'CLIENT sees only the job they have an assigned task on', JSON.stringify((c.body.jobs || []).map(j => j.id)));

    const s = await call(SUB);
    ok(countTasks(s.body) === 5, 'SUB is UNCHANGED this round — still account-wide (Round 8 is client-only)', String(countTasks(s.body)));
  } catch (e) {
    ok(false, 'harness error', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : String(e));
  } finally {
    rec.forEach((l) => console.log(l));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
