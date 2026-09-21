/* SKIPPED IS A THIRD STATE, AND THE DAY CARD CAN NOW SEE IT.
 *
 * The phone dashboard has always been able to mark a goal 'skipped' — a
 * saved status with its own glyph and an un-skip. `services/dashboardDay.js`
 * only ever read 'completed', so the same goal on the same day read
 * "skipped" on the phone and "missed" on the web. Skipping a habit on
 * purpose is genuinely different from failing to do it.
 *
 * The three states are mutually exclusive and the table enforces it:
 * UNIQUE (goal_id, log_date) means one row per goal per day, so a goal
 * cannot be both done and skipped. The tests assert that pairing directly
 * rather than trusting it.
 *
 * Run: node test/dashboardGoalSkipped.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_skip_test', logLevel: 'ERROR' });
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
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(20) NULL, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(90) NULL, job_zipcode VARCHAR(20) NULL, created_at DATETIME NULL)");
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
    await conn.query("CREATE TABLE spartan_goals (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, goal VARCHAR(255), start_time VARCHAR(8) NULL, duration_minutes INT NULL, recurrence VARCHAR(32) DEFAULT 'daily', day_of_week VARCHAR(64) NULL, is_special TINYINT DEFAULT 0, sort_order INT DEFAULT 0, reminder_lead_min INT DEFAULT 10, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query(`CREATE TABLE spartan_goal_log (
      id INT PRIMARY KEY AUTO_INCREMENT, goal_id INT NOT NULL, user_id INT NOT NULL,
      log_date DATE NOT NULL, status VARCHAR(20) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_goal_date (goal_id, log_date), INDEX idx_spartan_log_user (user_id))`);

    const { ensureDashboardSchema } = require('../services/dashboardSchema');
    await ensureDashboardSchema(conn);

    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,created_at) VALUES (700,'Poul','poul@x.com',14,4,NULL,NOW())");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,created_at) VALUES (701,'Someone else','other@x.com',14,4,NULL,NOW())");

    const D0 = new Date(); D0.setHours(0, 0, 0, 0);
    const D1 = plus(D0, 1);

    // Four daily goals: one skipped today, one completed today, one with no
    // log at all, and one another USER skipped — the scoping check.
    for (const [id, name] of [[1, 'Skipped today'], [2, 'Done today'], [3, 'Untouched'], [4, 'Other user\'s']]) {
      await conn.query(
        "INSERT INTO spartan_goals (id,user_id,goal,start_time,recurrence,sort_order) VALUES (?,?,?,'08:00','daily',?)",
        [id, id === 4 ? 701 : 700, name, id],
      );
    }
    await conn.query("INSERT INTO spartan_goal_log (goal_id,user_id,log_date,status) VALUES (1,700,?,'skipped')", [fmt(D0)]);
    await conn.query("INSERT INTO spartan_goal_log (goal_id,user_id,log_date,status) VALUES (2,700,?,'completed')", [fmt(D0)]);
    await conn.query("INSERT INTO spartan_goal_log (goal_id,user_id,log_date,status) VALUES (4,701,?,'skipped')", [fmt(D0)]);

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

    // ── the new state ───────────────────────────────────────────────────
    const g1 = goal(d0, 1);
    ok(!!g1, 'the skipped goal is on the day', JSON.stringify(d0.map((r) => r.id)));
    ok(g1 && g1.skipped === true, 'it comes back skipped: true', JSON.stringify(g1));
    ok(g1 && g1.complete === false,
      'and NOT complete — skipped is a third state, not a done', JSON.stringify(g1));

    // ── the states do not bleed into one another ───────────────────────
    const g2 = goal(d0, 2);
    ok(g2 && g2.complete === true, 'a completed goal is still complete', JSON.stringify(g2));
    ok(g2 && g2.skipped === false,
      'and is NOT also skipped — one log row per goal per day', JSON.stringify(g2));

    const g3 = goal(d0, 3);
    ok(g3 && g3.complete === false && g3.skipped === false,
      'a goal with no log row is neither', JSON.stringify(g3));

    // ── scoping, the same rule complete already had ────────────────────
    ok(!goal(d0, 4), 'another user\'s goal is not on this dashboard at all',
      JSON.stringify(d0.map((r) => r.id)));

    // A skip is logged against ONE DAY, not the goal. The same daily goal
    // tomorrow is untouched — the bug this mirrors on the complete side.
    const g1t = goal(d1, 1);
    ok(g1t && g1t.skipped === false,
      'tomorrow\'s instance of the same goal is NOT skipped', JSON.stringify(g1t));

    // ── every planner row carries the field ────────────────────────────
    const planners = [...d0, ...d1].filter((r) => r.kind === 'planner');
    ok(planners.length > 0 && planners.every((r) => typeof r.skipped === 'boolean'),
      'every planner row carries a boolean skipped, never undefined',
      JSON.stringify(planners.map((r) => [r.id, r.skipped])));

    // ── and nothing else grew one ──────────────────────────────────────
    const nonPlanners = [...d0, ...d1].filter((r) => r.kind !== 'planner');
    ok(nonPlanners.every((r) => r.skipped === undefined),
      'a task or appointment has no skipped field — only goals can be skipped',
      JSON.stringify(nonPlanners.map((r) => [r.kind, r.skipped])));

    // ── the stored row is what is being read ───────────────────────────
    const [[row]] = await conn.query(
      "SELECT status FROM spartan_goal_log WHERE goal_id = 1 AND log_date = ?", [fmt(D0)]);
    ok(row && row.status === 'skipped',
      'non-vacuity: the log row this asserts on genuinely says skipped',
      JSON.stringify(row));

  } catch (err) {
    fail++; rec.push('  ✗ threw: ' + (err && err.stack || err));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
