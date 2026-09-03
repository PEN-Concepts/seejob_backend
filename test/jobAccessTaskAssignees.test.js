/* Multi-assignee job-page access (task_assignees) — CCP fix.
 *
 * Proves, against real MySQL (mysql-memory-server) + supertest, that a SECONDARY/
 * broadcast assignee (a row in task_assignees, NOT tasks.user_id) on a FOREIGN
 * job can now open that job's page and see it in their job list — while the
 * financial fail-closed behavior is untouched and a cross-company user with no
 * task at all still gets the 403.
 *
 *   G(900) foreign GC (owns the job)      · paid
 *   C(910) cross-company contractor       · paid · SECONDARY assignee on G's task
 *   N(920) cross-company contractor       · paid · NO task on the job
 *   M(930) G's own employee (created_by=G)· paid · same-account regression
 *
 * Run: NODE_PATH=<backend>/node_modules node test/jobAccessTaskAssignees.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt, access;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_taskassignee_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    access = require('../utils/access');
    conn = await pool.getConnection();

    // ---- schema (superset of what /all-tasks + /jobs_general + canViewJob touch) ----
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT, category INT, business VARCHAR(150) NULL, mobile VARCHAR(40) NULL, street VARCHAR(200) NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30))");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(150), status INT DEFAULT 1, client_id INT NULL, inspector_id INT NULL, job_address VARCHAR(200) NULL, color VARCHAR(30) NULL, sort_order INT NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, user_id INT NULL, lead_name VARCHAR(150), project_street_address VARCHAR(200) NULL, status INT DEFAULT 1, bid_status VARCHAR(50) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY, job_id INT NULL, user_id INT NULL, team_id INT NULL, created_by INT NULL, task_type VARCHAR(20), task_name VARCHAR(150), status INT NULL, priority VARCHAR(20) NULL, start_date DATE NULL, time VARCHAR(20) NULL, duration_days INT NULL, is_calendar_task INT NULL, is_appointment_task INT NULL, assignee_completed INT NULL, image VARCHAR(255) NULL, created_at DATETIME NULL, archived_at DATETIME NULL)");
    await conn.query("CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT, seen_at DATETIME NULL, response TEXT NULL, responded_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks_images (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, file_path VARCHAR(255), file_name VARCHAR(255), kind VARCHAR(20) NULL, uploaded_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(30), team_leader INT NULL, created_by INT NULL)");
    await conn.query("CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT NULL)");
    await conn.query("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', contact_id INT NULL, user_id INT NULL)");
    await conn.query("CREATE TABLE subcontractor_seed_jobs (id INT PRIMARY KEY AUTO_INCREMENT, new_job_id INT NULL)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY, name VARCHAR(200), photo VARCHAR(255) NULL, created_by INT NULL, assign_to INT NULL, job_id INT NULL, type VARCHAR(20) DEFAULT 'task', status VARCHAR(20) NULL, priority VARCHAR(20) NULL, due_date DATE NULL, is_calendar INT DEFAULT 0, is_appointment INT DEFAULT 0, calendar_task_id INT NULL, appointment_id INT NULL)");

    // ---- accounts (all paid so no expired filtering interferes) ----
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,business,created_by,created_at) VALUES
      (900,'Foreign GC','g@x.com',14,2,'Acme Builders',NULL, NOW() - INTERVAL 200 DAY),
      (910,'Cross Contractor','c@x.com',14,2,'Bravo Framing',NULL, NOW() - INTERVAL 200 DAY),
      (920,'Other Contractor','n@x.com',14,2,'Charlie Electric',NULL, NOW() - INTERVAL 200 DAY),
      (930,'GC Employee','m@x.com',14,1,'Acme Builders',900, NOW() - INTERVAL 200 DAY)`);
    await conn.query("INSERT INTO subscriptions (user_id,status) VALUES (900,'active'),(910,'active'),(920,'active'),(930,'active')");

    // ---- G's job + a task on it whose PRIMARY assignee is G; C is a SECONDARY assignee ----
    await conn.query("INSERT INTO job (id,created_by,name,status,job_address,color) VALUES (1900,900,'G foreign job',1,'12 Main St','#123456')");
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status,start_date,created_at) VALUES (2900,1900,900,900,'job','Framing (broadcast)',0, CURDATE(), NOW())");
    await conn.query("INSERT INTO task_assignees (task_id,user_id) VALUES (2900,910)"); // C = broadcast/secondary

    // =====================================================================
    // A) canViewJob primitive
    // =====================================================================
    ok((await access.canViewJob(910, 1900, conn)) === true,  'A: canViewJob(C secondary/broadcast assignee, foreign job) = TRUE (page opens)');
    ok((await access.canViewJob(920, 1900, conn)) === false, 'A: canViewJob(N no task at all, foreign job) = FALSE (403)');
    ok((await access.canViewJob(900, 1900, conn)) === true,  'A: canViewJob(G owner, own job) = TRUE (regression)');
    ok((await access.canViewJob(930, 1900, conn)) === true,  'A: canViewJob(M same-account employee, account job) = TRUE (regression)');

    // =====================================================================
    // B) Financial fail-closed is UNTOUCHED — budget ownership uses isSameAccount,
    //    which is still FALSE for the cross-company secondary assignee.
    // =====================================================================
    ok((await access.isSameAccount(910, 900, conn)) === false, 'B: isSameAccount(C, G) = FALSE — budget ownsOwnerRecord still denies C (no budget figures)');
    ok((await access.isSameAccount(920, 900, conn)) === false, 'B: isSameAccount(N, G) = FALSE — budget still denies N');
    ok((await access.isSameAccount(930, 900, conn)) === true,  'B: isSameAccount(M, G) = TRUE — same-account employee (control)');

    // =====================================================================
    // C) HTTP — job page (jobs_general) + job list (all-tasks)
    // =====================================================================
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/jobs', require('../routes/jobs'));
    const tok = (id, category) => 'Bearer ' + jwt.sign({ id, role: 14, category, email: id + '@x.com', working_id: id }, process.env.ACCESS_TOKEN);

    // C1) job page opens for the secondary assignee, 403 for the no-task user
    const pgC = await request(app).get('/api/jobs/jobs_general/1900').set('Authorization', tok(910, 2));
    ok(pgC.status === 200 && pgC.body && pgC.body.data && pgC.body.data.id === 1900, 'C: GET jobs_general/1900 as C (secondary assignee) -> 200 (job page opens)', pgC.status);
    const pgN = await request(app).get('/api/jobs/jobs_general/1900').set('Authorization', tok(920, 2));
    ok(pgN.status === 403, 'C: GET jobs_general/1900 as N (no task) -> 403', pgN.status);

    // C2) job appears in the secondary assignee's job list; NOT in the no-task user's
    const listC = await request(app).get('/api/jobs/all-tasks').set('Authorization', tok(910, 2));
    const cJobIds = (listC.body && listC.body.jobs || []).map((j) => Number(j.id));
    ok(listC.status === 200 && cJobIds.includes(1900), 'C: GET all-tasks as C -> job 1900 appears in their job list', JSON.stringify(cJobIds));
    const listN = await request(app).get('/api/jobs/all-tasks').set('Authorization', tok(920, 2));
    const nJobIds = (listN.body && listN.body.jobs || []).map((j) => Number(j.id));
    ok(listN.status === 200 && !nJobIds.includes(1900), 'C: GET all-tasks as N -> job 1900 does NOT appear (no task)', JSON.stringify(nJobIds));

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
