/* §3b READ-BACK + §3c NO INSPECTION CHECKBOX.
 *
 * services/dashboardDay.js referenced spartan_goal_log ZERO times. A goal
 * ticked on the dashboard was written to the log by the FE and then came back
 * unticked on the next load, so the tick appeared to vanish — the write alone
 * was never going to be enough, which is why the ruling says "the write AND
 * the read".
 *
 * And inspection rows must not offer a checkbox at all: job_schedule_items has
 * no completion column, and all three candidate targets write to a DIFFERENT
 * record than the one ticked.
 *
 * Real MySQL via mysql-memory-server, real route, real HTTP. Every assertion
 * reads what the ENDPOINT returned, never an intermediate.
 *
 * Run: node test/dashboardPlannerComplete.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_planner_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(20) NULL, client_id INT NULL, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(90) NULL, job_zipcode VARCHAR(20) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, user_id INT, created_by INT, task_type VARCHAR(20), task_name VARCHAR(190) NULL, status INT DEFAULT 0, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), due_date DATETIME NULL, status VARCHAR(20) NULL, assign_to INT NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(30), created_at DATETIME NULL)");
    await conn.query("CREATE TABLE appointments (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL, subject VARCHAR(190) NULL, description TEXT NULL, doa DATETIME NULL, all_day TINYINT DEFAULT 0, address VARCHAR(190) NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_schedules (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, skip_saturday TINYINT DEFAULT 1, skip_sunday TINYINT DEFAULT 1)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, schedule_id INT, name VARCHAR(190), duration_days INT DEFAULT 1, computed_start_date DATE NULL, computed_end_date DATE NULL, is_inspection TINYINT DEFAULT 0, assignee_user_id INT NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE master_calendar_tasks (id INT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(190), sort_order INT DEFAULT 0, created_by INT NULL, created_at DATETIME NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE chat_conversations (id INT PRIMARY KEY AUTO_INCREMENT, type VARCHAR(20), job_id INT NULL, owner_id INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE chat_messages (id INT PRIMARY KEY AUTO_INCREMENT, conversation_id INT, sender_id INT NULL, body TEXT, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_documents (id INT PRIMARY KEY AUTO_INCREMENT, path VARCHAR(255), name VARCHAR(255), job_id INT, mime_type VARCHAR(100) NULL, created_by INT NULL, created_at DATETIME NULL, type VARCHAR(40) NULL)");
    await conn.query("CREATE TABLE division_lineitems (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(20) NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE spartan_goals (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, goal VARCHAR(255), start_time VARCHAR(8) NULL, duration_minutes INT NULL, recurrence VARCHAR(32) DEFAULT 'daily', day_of_week VARCHAR(64) NULL, is_special TINYINT DEFAULT 0, sort_order INT DEFAULT 0, reminder_lead_min INT DEFAULT 10, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    // The real shape, from routes/spartan.js ensureTables().
    await conn.query(`CREATE TABLE spartan_goal_log (
      id INT AUTO_INCREMENT PRIMARY KEY, goal_id INT NOT NULL, user_id INT NOT NULL,
      log_date DATE NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_goal_date (goal_id, log_date), INDEX idx_spartan_log_user (user_id))`);

    await require('../services/notepadSchema').ensureNotepadSchema(conn);
    await require('../services/dashboardSchema').ensureDashboardSchema(conn);

    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,created_at) VALUES (700,'Poul','poul@x.com',14,4,NULL,NOW())");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,created_at) VALUES (701,'Someone else','other@x.com',14,4,NULL,NOW())");
    await conn.query("INSERT INTO `job` (id,name,created_by,color,job_address,created_at) VALUES (10,'Lynes',700,'#d9457a','301 Fair Oaks',NOW())");

    const D0 = new Date(); D0.setHours(0, 0, 0, 0);
    const D1 = plus(D0, 1);
    note(`days under test: ${fmt(D0)} and ${fmt(D1)}`);

    // Five daily goals, so each assertion gets its own and they cannot interfere.
    for (const [id, name] of [[1, 'Ticked today'], [2, 'Never ticked'], [3, 'Ticked tomorrow only'],
                              [4, 'Ticked by someone else'], [5, 'Logged with the SHORT sentinel']]) {
      await conn.query(
        "INSERT INTO spartan_goals (id,user_id,goal,start_time,recurrence,sort_order) VALUES (?,700,?,'08:00','daily',?)",
        [id, name, id]);
    }

    await conn.query("INSERT INTO spartan_goal_log (goal_id,user_id,log_date,status) VALUES (1,700,?,'completed')", [fmt(D0)]);
    await conn.query("INSERT INTO spartan_goal_log (goal_id,user_id,log_date,status) VALUES (3,700,?,'completed')", [fmt(D1)]);
    // Goal 4 belongs to 700 but the LOG row is stamped to another user.
    await conn.query("INSERT INTO spartan_goal_log (goal_id,user_id,log_date,status) VALUES (4,701,?,'completed')", [fmt(D0)]);
    // The short sentinel BE #40 ruled against. It must NOT count.
    await conn.query("INSERT INTO spartan_goal_log (goal_id,user_id,log_date,status) VALUES (5,700,?,'complete')", [fmt(D0)]);

    // An inspection on D0, so §3c has a row to assert.
    await conn.query("INSERT INTO job_schedules (id,job_id,skip_saturday,skip_sunday) VALUES (1,10,0,0)");
    await conn.query(
      "INSERT INTO job_schedule_items (id,schedule_id,name,duration_days,computed_start_date,is_inspection) VALUES (1,1,'rough electric',1,?,1)",
      [fmt(D0)]);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    const tok = 'Bearer ' + jwt.sign({ id: 700 }, process.env.ACCESS_TOKEN);

    const res = await request(app)
      .get(`/api/dashboard/day?from=${fmt(D0)}&to=${fmt(D1)}`)
      .set('Authorization', tok);
    ok(res.status === 200, 'GET /dashboard/day responds 200', String(res.status));

    const byDay = (res.body && res.body.days) || {};
    const d0 = byDay[fmt(D0)] || [];
    const d1 = byDay[fmt(D1)] || [];
    const goal = (rows, id) => rows.find((r) => r.kind === 'planner' && Number(r.id) === id);

    // ── §3b read-back ──────────────────────────────────────────────────
    ok(d0.some((r) => r.kind === 'planner'), 'planner rows are in the day stream at all',
      JSON.stringify(d0.map((r) => [r.kind, r.id])));

    const g1 = goal(d0, 1);
    ok(g1 && g1.complete === true,
      'A LOGGED GOAL READS complete:true — this is the bug: dashboardDay never looked at spartan_goal_log',
      g1 ? JSON.stringify(g1.complete) : 'row missing');

    const g2 = goal(d0, 2);
    ok(g2 && g2.complete === false, 'a goal with no log row for that date is complete:false',
      g2 ? JSON.stringify(g2.complete) : 'row missing');

    // DATE-SCOPED, both directions.
    const g3today = goal(d0, 3);
    const g3tmrw = goal(d1, 3);
    ok(g3today && g3today.complete === false,
      'a goal logged TOMORROW is not complete today',
      g3today ? JSON.stringify(g3today.complete) : 'row missing');
    ok(g3tmrw && g3tmrw.complete === true,
      'and the same goal IS complete on the day it was logged',
      g3tmrw ? JSON.stringify(g3tmrw.complete) : 'row missing');
    ok(goal(d1, 1) && goal(d1, 1).complete === false,
      "and yesterday's tick does not carry forward to tomorrow",
      goal(d1, 1) ? JSON.stringify(goal(d1, 1).complete) : 'row missing');

    // USER-SCOPED. The unique key is (goal_id, log_date) only, so a log row
    // stamped to another user would otherwise tick this user's goal.
    const g4 = goal(d0, 4);
    ok(g4 && g4.complete === false,
      "ANOTHER USER'S LOG ROW DOES NOT TICK MY GOAL — the unique key does not include user_id",
      g4 ? JSON.stringify(g4.complete) : 'row missing');

    // SENTINEL SPELLING. Same rule as BE #40.
    const g5 = goal(d0, 5);
    ok(g5 && g5.complete === false,
      "the SHORT sentinel 'complete' does not count — 'completed' is the spelling",
      g5 ? JSON.stringify(g5.complete) : 'row missing');

    // ── §3c no inspection checkbox ─────────────────────────────────────
    const insp = d0.find((r) => r.kind === 'inspection');
    ok(!!insp, 'the inspection row is present', JSON.stringify(d0.map((r) => r.kind)));
    ok(insp && insp.checkbox === false,
      'AN INSPECTION ROW OFFERS NO CHECKBOX — set in the row builder, not the template',
      insp ? JSON.stringify(insp.checkbox) : 'row missing');
    ok(insp && insp.is_inspection === true, 'and it is still flagged as an inspection');

    // Everything else that CAN be ticked still can be.
    ok(d0.filter((r) => r.kind === 'planner').every((r) => r.checkbox === true),
      'planner rows still offer a checkbox');
    ok(d0.filter((r) => r.kind === 'appointment').every((r) => r.checkbox === false),
      'appointments still offer none');

    // ── NO CASCADE, NO MAIL. Reading the dashboard writes nothing. ─────
    const [[sched]] = await conn.query("SELECT computed_start_date, updated_at FROM job_schedule_items WHERE id = 1");
    ok(String(sched.computed_start_date).slice(0, 10) === fmt(D0),
      'reading the dashboard did not move the schedule item',
      String(sched.computed_start_date));
    ok(sched.updated_at == null, 'and did not stamp updated_at on it', String(sched.updated_at));
    const [[logCount]] = await conn.query("SELECT COUNT(*) AS c FROM spartan_goal_log");
    ok(Number(logCount.c) === 4, 'the goal log still holds exactly the 4 seeded rows — the read wrote none',
      String(logCount.c));
    const [[taskCount]] = await conn.query("SELECT COUNT(*) AS c FROM tasks");
    ok(Number(taskCount.c) === 0, 'and no task row was created or touched', String(taskCount.c));

    // ── NON-VACUITY ────────────────────────────────────────────────────
    // Prove the fixture could have shown the bug: goal 1 IS logged completed
    // for D0, so a build that ignores spartan_goal_log returns complete:false
    // for it — which is exactly what main did.
    const [[seed]] = await conn.query(
      "SELECT COUNT(*) AS c FROM spartan_goal_log WHERE goal_id = 1 AND user_id = 700 AND log_date = ? AND status = 'completed'",
      [fmt(D0)]);
    ok(Number(seed.c) === 1,
      'non-vacuity: the log row this asserts on genuinely exists in the database',
      String(seed.c));
  } catch (e) {
    fail++; rec.push('  ✗ threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db) await db.stop(); } catch {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
