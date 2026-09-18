/* 'completed', NOT 'complete'.
 *
 * check_list.status only ever holds 'active', 'archived' or 'completed'. The
 * notepad writes 'completed' (routes/checklists.js, and the Joi schema allows
 * only 'new' | 'completed'); nothing anywhere writes the short form.
 *
 * Two places on the dashboard compared against 'complete':
 *
 *   services/dashboardDay.js  complete: status === 'complete'
 *       -> ALWAYS false. An item ticked off on the notepad rendered UNTICKED
 *          on the dashboard.
 *
 *   routes/dashboard.js       AND (... LOWER(c.status) <> 'complete')
 *       -> NEVER matched. Items already ticked off kept appearing in PAST DUE.
 *
 * The four existing dashboard suites are 77/77 and did not catch either,
 * because every fixture in them seeds status 'new'. The completed path had no
 * coverage at all, which is why a one-letter difference survived review and
 * shipped. This seeds 'completed' and asserts both behaviours.
 *
 * Run: node test/dashboardCompletedSentinel.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function thisThursday() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7));
  return d;
}
const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_sentinel_test', logLevel: 'ERROR' });
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
    await conn.query("CREATE TABLE job_documents (id INT PRIMARY KEY AUTO_INCREMENT, path VARCHAR(255), name VARCHAR(255), job_id INT, mime_type VARCHAR(100) NULL, created_by INT NULL, created_at DATETIME NULL, type VARCHAR(40) NULL)");
    await conn.query("CREATE TABLE division_lineitems (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(20) NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE spartan_goals (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, goal VARCHAR(255), start_time VARCHAR(8) NULL, duration_minutes INT NULL, recurrence VARCHAR(32) DEFAULT 'daily', day_of_week VARCHAR(64) NULL, is_special TINYINT DEFAULT 0, sort_order INT DEFAULT 0, reminder_lead_min INT DEFAULT 10, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

    await require('../services/notepadSchema').ensureNotepadSchema(conn);
    await require('../services/dashboardSchema').ensureDashboardSchema(conn);

    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,created_at) VALUES (700,'Poul','poul@x.com',14,4,NULL,NOW())");
    await conn.query("INSERT INTO `job` (id,name,created_by,color,job_address,created_at) VALUES (10,'Lynes',700,'#d9457a','301 Fair Oaks',NOW())");
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,scope,origin,account_owner_id) VALUES (1,700,'task','Lynes',10,'company','auto',700)");

    const THU = thisThursday();
    note(`day under test: ${fmt(THU)}`);

    // THE FIXTURE THE OTHER SUITES NEVER HAD: one ticked, one not, same day.
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by) VALUES (1,1,'Ticked on the notepad',?,1,'completed',700)",
      [fmt(THU) + ' 00:00:00']);
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by) VALUES (2,1,'Still open',?,1,'new',700)",
      [fmt(THU) + ' 00:00:00']);
    // And one ALREADY TICKED and PAST DUE, for the band.
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by) VALUES (3,1,'Ticked and overdue',DATE_SUB(NOW(), INTERVAL 5 DAY),0,'completed',700)");
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by) VALUES (4,1,'Open and overdue',DATE_SUB(NOW(), INTERVAL 5 DAY),0,'new',700)");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    const tok = 'Bearer ' + jwt.sign({ id: 700 }, process.env.ACCESS_TOKEN);

    // ── the day stream ───────────────────────────────────────────────────
    const day = await request(app)
      .get(`/api/dashboard/day?from=${fmt(THU)}&to=${fmt(plus(THU, 1))}`)
      .set('Authorization', tok);
    ok(day.status === 200, 'GET /dashboard/day responds 200', String(day.status));

    const rows = ((day.body && day.body.days) || {})[fmt(THU)] || [];
    const ticked = rows.find((r) => r.kind === 'task' && r.id === 1);
    const open = rows.find((r) => r.kind === 'task' && r.id === 2);

    ok(!!ticked, 'the notepad-completed item is IN the day stream', JSON.stringify(rows.map((r) => [r.kind, r.id])));
    ok(!!open, 'so is the open one');
    ok(ticked && ticked.complete === true,
      "A NOTEPAD-COMPLETED ITEM REPORTS complete:true — this is the bug: 'completed' was compared against 'complete'",
      ticked ? JSON.stringify(ticked.complete) : 'row missing');
    ok(open && open.complete === false,
      'and an open item still reports complete:false',
      open ? JSON.stringify(open.complete) : 'row missing');

    // ── the PAST DUE band ────────────────────────────────────────────────
    const ex = await request(app).get('/api/dashboard/exceptions').set('Authorization', tok);
    ok(ex.status === 200, 'GET /dashboard/exceptions responds 200', String(ex.status));
    const pastDue = ((ex.body && ex.body.bands) || {}).past_due || [];
    // The band reshapes rows: the checklist item's id is `item_id`, not `id`.
    const ids = pastDue.map((r) => Number(r.item_id));

    ok(!ids.includes(3),
      'A TICKED-OFF OVERDUE ITEM IS NOT IN PAST DUE — the filter never matched before',
      JSON.stringify(ids));
    ok(ids.includes(4),
      'but an open overdue item still is — the filter did not simply remove everything',
      JSON.stringify(ids));

    // ── non-vacuity ──────────────────────────────────────────────────────
    rec.push('\nNON-VACUITY');
    note("the fixtures above seed status 'completed'; the four existing dashboard");
    note('suites seed only \'new\', which is why 77/77 passed with this bug in them.');
    ok(String('completed').toLowerCase() !== 'complete',
      "'completed' and 'complete' are genuinely different strings — the whole bug in one line");
    const oldRule = (s) => String(s || '').toLowerCase() === 'complete';
    const newRule = (s) => String(s || '').toLowerCase() === 'completed';
    ok(oldRule('completed') === false && newRule('completed') === true,
      'THE OLD COMPARISON returns false for a completed item; the new one returns true',
      `old=${oldRule('completed')} new=${newRule('completed')}`);
    ok(oldRule('new') === false && newRule('new') === false,
      'and both agree an open item is not complete — the fix does not invert anything');

  } catch (err) {
    fail++;
    rec.push('  ✗ HARNESS ERROR: ' + ((err && err.stack) || err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
  }

  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
