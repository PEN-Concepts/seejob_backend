/* Job Schedule week view — synthetic-data functional test (real local MySQL via
 * mysql-memory-server + supertest). Verifies GET /api/jobs/job-schedule:
 *   - MERGES milestones (tasks.is_calendar_task=1) + assigned tasks (=0) into one
 *     list, with type='milestone'|'task';
 *   - excludes COMPLETED (status=1) and ARCHIVED (archived_at) at the QUERY level;
 *   - keeps worker-done-but-not-finalized (assignee_completed=1, status=0) items;
 *   - excludes items outside the [start,end] window and on inactive jobs (status<>1);
 *   - unassigned job tasks appear with a BLANK assignee (never "Unassigned");
 *   - team-assigned tasks show the team name; person-assigned show the user name;
 *   - ROLE SCOPE: owner/employee see all active account jobs; a contractor sees
 *     only jobs they're assigned to.
 * Run: node test/jobSchedule.functional.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_jobsched_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();

    // ---- Schema (only the columns the endpoint touches) ----
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), role INT NULL, category INT NULL, created_by INT NULL)");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(150), status INT, created_by INT NULL)");
    await conn.query(`CREATE TABLE tasks (
      id INT PRIMARY KEY, task_name VARCHAR(200), job_id INT, task_type VARCHAR(20),
      start_date DATETIME NULL, end_date DATETIME NULL, is_calendar_task TINYINT DEFAULT 0,
      user_id INT NULL, team_id INT NULL, status INT DEFAULT 0, assignee_completed TINYINT DEFAULT 0,
      archived_at DATETIME NULL, created_by INT NULL)`);
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120))");
    await conn.query("CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)");
    await conn.query("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, contact_id INT)");

    // ---- Seed accounts: 700 owner(role14), 701 employee(cat1), 702 contractor(cat2) ----
    await conn.query(`INSERT INTO \`user\` (id,name,role,category,created_by) VALUES
      (700,'Owner Olly',14,NULL,NULL),
      (701,'Employee Eve',5,1,700),
      (702,'Contractor Cody',12,2,700)`);
    await conn.query("INSERT INTO teams (id,team_name) VALUES (800,'Crew A')");

    // ---- Jobs: 10/11/14 active account jobs; 12 completed job; 13 external ----
    await conn.query(`INSERT INTO job (id,name,status,created_by) VALUES
      (10,'Maple Reno',1,700),
      (11,'Oak Build',1,700),
      (12,'Done Job',0,700),
      (13,'External Job',1,999),
      (14,'Elm Job',1,700)`);

    // Contractor 702 is assigned tasks on jobs 10 & 11 only (not 14).
    // Window = 2026-09-01 .. 2026-09-07.
    const IN = "'2026-09-02 08:00:00'";
    const OUT = "'2026-10-15 08:00:00'";
    await conn.query(`INSERT INTO tasks (id,task_name,job_id,task_type,start_date,is_calendar_task,user_id,team_id,status,assignee_completed,archived_at,created_by) VALUES
      (1,'Framing begins',10,'job',${IN},1,NULL,NULL,0,0,NULL,700),          -- milestone, unassigned
      (2,'Order lumber',10,'job',${IN},0,702,NULL,0,0,NULL,700),             -- task, assigned to contractor
      (3,'Site cleanup',11,'job',${IN},0,702,NULL,0,0,NULL,700),             -- task on job 11 (contractor)
      (4,'Old finished task',10,'job',${IN},0,701,NULL,1,1,NULL,700),        -- COMPLETED (status=1) -> excluded
      (5,'Awaiting signoff',10,'job',${IN},0,701,NULL,0,1,NULL,700),         -- worker-done only -> INCLUDED
      (6,'Next month task',10,'job',${OUT},0,701,NULL,0,0,NULL,700),         -- out of window -> excluded
      (7,'Archived task',10,'job',${IN},0,701,NULL,0,0,'2026-09-02 09:00:00',700), -- archived -> excluded
      (8,'Stucco',10,'job',${IN},1,NULL,800,0,0,NULL,700),                   -- milestone, team-assigned
      (9,'On completed job',12,'job',${IN},0,701,NULL,0,0,NULL,700),         -- job inactive -> excluded
      (10,'On elm job',14,'job',${IN},0,701,NULL,0,0,NULL,700),              -- owner sees; contractor NOT (not on job 14)
      (11,'On external job',13,'job',${IN},0,999,NULL,0,0,NULL,700)          -- neither owner nor contractor sees
    `);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/jobs', require('../routes/jobs'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const range = '?start=2026-09-01&end=2026-09-07';

    // ===== Owner (role 14) — sees all active account jobs (10,11,14) =====
    const oRes = await request(app).get('/api/jobs/job-schedule' + range).set('Authorization', tok(700));
    ok(oRes.status === 200 && Array.isArray(oRes.body.items), 'owner: 200 + items[]', JSON.stringify(oRes.body).slice(0, 200));
    const oItems = oRes.body.items || [];
    const oIds = oItems.map((i) => Number(i.id)).sort((a, b) => a - b);
    ok(JSON.stringify(oIds) === JSON.stringify([1, 2, 3, 5, 8, 10]), 'owner: exactly tasks 1,2,3,5,8,10 (completed/archived/out-of-window/inactive-job/external all excluded)', JSON.stringify(oIds));

    const byId = (arr, id) => arr.find((i) => Number(i.id) === id);
    ok(byId(oItems, 4) === undefined, 'exclude: completed task (status=1) never returned');
    ok(byId(oItems, 7) === undefined, 'exclude: archived task never returned');
    ok(byId(oItems, 6) === undefined, 'exclude: out-of-window task never returned');
    ok(byId(oItems, 9) === undefined, 'exclude: task on inactive job (status<>1) never returned');
    ok(byId(oItems, 11) === undefined, 'exclude: external-account job task never returned');
    ok(!!byId(oItems, 5), 'keep: worker-done-only task (assignee_completed=1, status=0) IS returned');

    const m1 = byId(oItems, 1), t2 = byId(oItems, 2), st = byId(oItems, 8);
    ok(m1 && m1.type === 'milestone', 'merge: is_calendar_task=1 -> type "milestone"', m1 && m1.type);
    ok(t2 && t2.type === 'task', 'merge: is_calendar_task=0 -> type "task"', t2 && t2.type);
    ok(m1 && m1.assignee_name === '', 'unassigned: milestone assignee_name is BLANK (never "Unassigned")', m1 && JSON.stringify(m1.assignee_name));
    ok(t2 && t2.assignee_name === 'Contractor Cody', 'assignee: person name returned', t2 && t2.assignee_name);
    ok(st && st.assignee_name === 'Crew A', 'assignee: team name returned for team task', st && st.assignee_name);
    ok(m1 && m1.job_name === 'Maple Reno', 'job_name returned', m1 && m1.job_name);
    ok(m1 && m1.date === '2026-09-02', 'date normalized to YYYY-MM-DD', m1 && m1.date);
    ok(t2 && String(t2.assignee_name).toLowerCase().indexOf('unassigned') === -1, 'never emits literal "Unassigned"');

    // ===== Contractor (cat 2) — self-scoped to assigned jobs (10 & 11), NOT 14 =====
    const cRes = await request(app).get('/api/jobs/job-schedule' + range).set('Authorization', tok(702));
    const cItems = cRes.body.items || [];
    const cIds = cItems.map((i) => Number(i.id)).sort((a, b) => a - b);
    ok(cRes.status === 200, 'contractor: 200');
    ok(JSON.stringify(cIds) === JSON.stringify([1, 2, 3, 5, 8]), 'role-scope: contractor sees jobs 10 & 11 (all their items) but NOT job 14 task (10)', JSON.stringify(cIds));
    ok(cItems.every((i) => Number(i.id) !== 10), 'role-scope: contractor does NOT see the Elm-job task (not assigned to that job)');

    // ===== Employee (cat 1) — inherits owner, sees the full account like the owner =====
    const eRes = await request(app).get('/api/jobs/job-schedule' + range).set('Authorization', tok(701));
    const eIds = (eRes.body.items || []).map((i) => Number(i.id)).sort((a, b) => a - b);
    ok(JSON.stringify(eIds) === JSON.stringify([1, 2, 3, 5, 8, 10]), 'role-scope: employee (category 1) sees the whole account like the owner', JSON.stringify(eIds));

    // ===== Bad input =====
    const bad = await request(app).get('/api/jobs/job-schedule?start=nope&end=2026-09-07').set('Authorization', tok(700));
    ok(bad.status === 400, 'validation: bad date -> 400', String(bad.status));

  } catch (e) {
    fail++; rec.push('  ✗ THREW: ' + e.message + '\n' + (e.stack || ''));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
    console.log('\nJob Schedule functional test');
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
