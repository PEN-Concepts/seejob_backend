/* /jobs/job-lead-options must apply the assigned-task rule: a Subcontractor or
 * Client sees a job/lead ONLY if they have a task assigned to them under it —
 * never the owner's whole job/lead list. Real MySQL + supertest.
 * Run: NODE_PATH=<backend>/node_modules node test/jobLeadOptionsVisibility.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_joblead_vis', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE user (id INT PRIMARY KEY, created_by INT, role INT, category INT)`);
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120), address VARCHAR(190), city VARCHAR(90),
      state VARCHAR(90), zipcode VARCHAR(20), contract_status VARCHAR(40), type VARCHAR(40), status INT,
      color VARCHAR(20), created_by INT, sort_order INT DEFAULT 0)`);
    await conn.query(`CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(120), lead_type VARCHAR(40), status VARCHAR(10),
      project_street_address VARCHAR(190), project_town VARCHAR(90), project_state VARCHAR(90), leads_zipcode VARCHAR(20),
      user_id INT, bid_status VARCHAR(40), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, task_type VARCHAR(20),
      user_id INT, team_id INT, created_by INT, archived_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)`);
    await conn.query(`CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, contact_id INT)`);

    await conn.query(`INSERT INTO user (id,created_by,role,category) VALUES (74,NULL,14,4),(400,74,3,2),(376,74,3,3)`);
    // 4 jobs (incl. an archived one), all owned by 74.
    await conn.query(`INSERT INTO job (id,name,status,created_by) VALUES
      (1,'Job One',1,74),(2,'Job Two',1,74),(3,'Job Three',1,74),(4,'Job Archived',5,74)`);
    // 2 leads owned by 74.
    await conn.query(`INSERT INTO leads (id,lead_name,status,user_id,bid_status) VALUES
      (1,'Lead One','1',74,NULL),(2,'Lead Two','1',74,NULL)`);
    // Sub 400 assigned to Job One + Job Two (task_type job). Client 376 assigned to Lead One.
    await conn.query(`INSERT INTO tasks (job_id,task_type,user_id,created_by) VALUES
      (1,'job',400,74),(2,'job',400,74),(1,'lead',376,74)`);

    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/jobs', require('../routes/jobs'));

    const call = (claims) => request(app).get('/jobs/job-lead-options')
      .set('Authorization', 'Bearer ' + jwt.sign(claims, process.env.ACCESS_TOKEN));
    const OWNER = { id: 74, working_id: 74, role: 14, category: 4, email: 'poul@t.co' };
    const SUB = { id: 400, working_id: 74, role: 3, category: 2, email: 'sub@t.co' };
    const CLIENT = { id: 376, working_id: 74, role: 3, category: 3, email: 'client@t.co' };
    const jobsOf = (b) => (b || []).filter(x => x.kind === 'job').map(x => x.name).sort();
    const leadsOf = (b) => (b || []).filter(x => x.kind === 'lead').map(x => x.name).sort();

    const o = await call(OWNER); const ob = o.body;
    ok(jobsOf(ob).length === 4, 'OWNER sees all 4 jobs (incl. archived)', JSON.stringify(jobsOf(ob)));
    ok(leadsOf(ob).join(',') === 'Lead One,Lead Two', 'OWNER sees both leads', JSON.stringify(leadsOf(ob)));

    const s = await call(SUB); const sb = s.body;
    ok(JSON.stringify(jobsOf(sb)) === JSON.stringify(['Job One', 'Job Two']),
      'SUB with tasks on 2 jobs sees EXACTLY those 2 jobs, nothing else (no Job Three/Archived)', JSON.stringify(jobsOf(sb)));
    ok(leadsOf(sb).length === 0, 'SUB sees NO leads (none assigned)', JSON.stringify(leadsOf(sb)));

    const c = await call(CLIENT); const cb = c.body;
    ok(jobsOf(cb).length === 0, 'CLIENT sees NO jobs (none assigned)', JSON.stringify(jobsOf(cb)));
    ok(JSON.stringify(leadsOf(cb)) === JSON.stringify(['Lead One']),
      'CLIENT sees ONLY the one lead they have an assigned task under (not Lead Two)', JSON.stringify(leadsOf(cb)));
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
