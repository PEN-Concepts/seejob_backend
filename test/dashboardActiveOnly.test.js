/* §1 — EVERY DASHBOARD LIST IS CURRENT JOBS AND LIVE LEADS ONLY.
 *
 * THE DEFECT. Live, STALLED carries fifteen rows and nine of them are
 * finished: a lead untouched for 151 days, a remodel at 80. A count that
 * includes work completed in June is worse than no count, because it teaches
 * the reader not to look.
 *
 * Nothing filtered by state anywhere on this page. `visibleJobsForUser` ran
 * `jobScopeWhere` alone, whose clauses 1 and 2 carry no status test at all
 * (only clause 3, "an active job with a task assigned to an account member",
 * mentions status — and it is an OR, so it cannot exclude anything the other
 * two let through). `visibleLeadsForUser` had no status test whatsoever. The
 * two /exceptions INCOMPLETE queries built their own SQL from `jobScopeWhere`
 * and inherited the same gap.
 *
 * THE COLUMNS, confirmed rather than assumed:
 *   job.status     0 = completed, 1 = current, 2 = archived
 *                  routes/jobs.js:1553 — "expecting status = 0 (completed)
 *                  or 2 (archived)", guard `[0, 2, 1].includes(status)`
 *   leads.status   3 = closed/converted (routes/leads.js:760)
 *   leads.bid_status 'Archived' — a SEPARATE archive flag (routes/leads.js:202)
 *
 * THE FILTER IS IN THE QUERY, NOT THE TEMPLATE. A template that hides rows
 * the query still returns leaks the moment anything else consumes that query
 * — which is exactly how the tenant-scope bug worked. These checks therefore
 * read the HTTP payload, which is what any consumer gets.
 *
 * NON-VACUITY: remove `AND j.status = 1` from accountScope and this file
 * fails loudly, naming the finished jobs by name. Numbers are in the report.
 *
 * Run: node test/dashboardActiveOnly.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_active_only', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, timezone VARCHAR(64) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(30) NULL, client_id INT NULL, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(90) NULL, job_zipcode VARCHAR(20) NULL, created_at DATETIME NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL, status INT NULL, bid_status VARCHAR(40) NULL, created_at DATETIME NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL, created_by INT NULL, task_type VARCHAR(20) NULL, task_name VARCHAR(190) NULL, status INT DEFAULT 0, due_date DATETIME NULL, all_day TINYINT DEFAULT 0, archived_at DATETIME NULL, created_at DATETIME NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, lead_id INT NULL, origin VARCHAR(20) NULL, scope VARCHAR(20) NULL, account_owner_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_section_shares (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, user_id INT)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), due_date DATETIME NULL, status VARCHAR(20) NULL, all_day TINYINT DEFAULT 0, delegated_to INT NULL, assign_to INT NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE notepad_access (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, user_id INT, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE appointments (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL, subject VARCHAR(190) NULL, description TEXT NULL, doa DATETIME NULL, all_day TINYINT DEFAULT 0, address VARCHAR(190) NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_schedules (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, skip_saturday TINYINT DEFAULT 1, skip_sunday TINYINT DEFAULT 1)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, schedule_id INT, name VARCHAR(190), duration_days INT DEFAULT 1, computed_start_date DATE NULL, computed_end_date DATE NULL, is_inspection TINYINT DEFAULT 0, assignee_user_id INT NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE spartan_goals (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, goal VARCHAR(255), start_time VARCHAR(8) NULL, duration_minutes INT NULL, recurrence VARCHAR(32) DEFAULT 'daily', day_of_week VARCHAR(64) NULL, is_special TINYINT DEFAULT 0, sort_order INT DEFAULT 0, reminder_lead_min INT DEFAULT 10, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE spartan_goal_log (id INT PRIMARY KEY AUTO_INCREMENT, goal_id INT NOT NULL, user_id INT NOT NULL, log_date DATE NOT NULL, status VARCHAR(20) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_goal_date (goal_id, log_date))");

    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by) VALUES (700,'Owner Olly','olly@x.com',14,4,NULL)");

    // ── THE FIXTURE. One of each state, all long-stalled so STALLED would
    //    list every one of them if the filter were absent.
    const OLD = fmt(daysAgo(151));
    await conn.query(
      "INSERT INTO `job` (id,name,created_by,status,color,created_at,updated_at) VALUES " +
      "(10,'ACTIVE Samuel - DECK',700,1,'#b4651f',?,?)," +
      "(11,'COMPLETED Sawyer - REMODEL',700,0,'#123456',?,?)," +
      "(12,'ARCHIVED Old Barn',700,2,'#654321',?,?)," +
      // A GENUINELY QUIET ACTIVE JOB. Job 10 gets a pad and a schedule item
      // below, both stamped today, so it has recent activity and is
      // correctly NOT stalled — asserting it there would have been asserting
      // my own misreading. This one has nothing attached, so if the filter
      // were too wide it is the row that proves it.
      "(13,'ACTIVE Quiet Job',700,1,'#0abbcc',?,?)," +
      // QUIET FINISHED JOBS, with nothing attached to them at all.
      // Jobs 11 and 12 carry pads and schedule items stamped TODAY (they have
      // to, for the past_due and incomplete checks), which makes them
      // not-stalled regardless of state — so "stalled: NO completed job"
      // passed with the filter REMOVED. That check was vacuous and the
      // non-vacuity run is what exposed it. These two are the real test: old,
      // finished, and with no activity to save them.
      "(14,'COMPLETED Quiet Remodel',700,0,'#777777',?,?)," +
      "(15,'ARCHIVED Quiet Barn',700,2,'#888888',?,?)",
      [OLD, OLD, OLD, OLD, OLD, OLD, OLD, OLD, OLD, OLD, OLD, OLD],
    );
    await conn.query(
      "INSERT INTO leads (id,lead_name,user_id,status,bid_status,created_at,updated_at) VALUES " +
      "(20,'LIVE Bethel - HOME',700,1,NULL,?,?)," +
      "(21,'CLOSED New job',700,3,NULL,?,?)," +
      "(22,'ARCHIVEDBID Fair Oaks',700,1,'Archived',?,?)," +
      "(23,'NULLSTATUS Kept',700,NULL,NULL,?,?)",
      [OLD, OLD, OLD, OLD, OLD, OLD, OLD, OLD],
    );

    // Gantt gaps + no-schedule, on all three jobs, so INCOMPLETE would carry
    // the finished ones too.
    await conn.query("INSERT INTO job_schedules (id,job_id) VALUES (1,10),(2,11)");
    await conn.query("INSERT INTO job_schedule_items (id,schedule_id,name,assignee_user_id,computed_start_date) VALUES (1,1,'Frame',NULL,NULL),(2,2,'Frame',NULL,NULL)");

    // PAST DUE — one task on each job, plus one on a pad with NO job.
    const YESTERDAY = fmt(daysAgo(1));
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,origin,scope) VALUES (1,700,'task','Active pad',10,'auto','private'),(2,700,'task','Completed pad',11,'auto','private'),(3,700,'task','Archived pad',12,'auto','private'),(4,700,'task','No-job pad',NULL,'manual','private')");
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,status,created_by) VALUES " +
      "(100,1,'LATE on active',?, NULL,700)," +
      "(101,2,'LATE on completed',?, NULL,700)," +
      "(102,3,'LATE on archived',?, NULL,700)," +
      "(103,4,'LATE with no job',?, NULL,700)",
      [YESTERDAY, YESTERDAY, YESTERDAY, YESTERDAY],
    );

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    const OWNER = 'Bearer ' + jwt.sign({ id: 700 }, process.env.ACCESS_TOKEN);

    const get = (p) => request(app).get(p).set('Authorization', OWNER);
    const names = (arr, k) => (arr || []).map((r) => String(r[k] || ''));
    const joined = (arr, k) => names(arr, k).join(' | ');

    // ════════════════════════════════════════════════════════════════════
    // LIST 1 — GET /stalled
    // ════════════════════════════════════════════════════════════════════
    const st = await get('/api/dashboard/stalled');
    ok(st.status === 200, 'stalled: 200', `${st.status} ${JSON.stringify(st.body).slice(0, 200)}`);
    const stNames = names(st.body.stalled, 'name');
    note(`stalled returned ${stNames.length}: ${stNames.join(' | ') || '(none)'}`);
    ok(stNames.some((n) => n === 'ACTIVE Quiet Job'),
      'stalled: a quiet ACTIVE job is still there (the filter is not simply off)', joined(st.body.stalled, 'name'));
    ok(!stNames.some((n) => n === 'ACTIVE Samuel - DECK'),
      'stalled: an active job WITH recent activity is correctly absent — stalled still means stalled',
      joined(st.body.stalled, 'name'));
    ok(stNames.some((n) => n.startsWith('LIVE')),
      'stalled: the LIVE lead is still there', joined(st.body.stalled, 'name'));
    ok(stNames.some((n) => n.startsWith('NULLSTATUS')),
      'stalled: a lead with NULL status is LIVE, not hidden', joined(st.body.stalled, 'name'));
    ok(!stNames.some((n) => n.startsWith('COMPLETED')),
      'stalled: NO completed job', joined(st.body.stalled, 'name'));
    ok(!stNames.some((n) => n.startsWith('ARCHIVED ')) && !stNames.some((n) => n.startsWith('ARCHIVED')),
      'stalled: NO archived job', joined(st.body.stalled, 'name'));
    ok(!stNames.some((n) => n.startsWith('CLOSED')),
      'stalled: NO closed lead (status 3)', joined(st.body.stalled, 'name'));
    ok(!stNames.some((n) => n.startsWith('ARCHIVEDBID')),
      'stalled: NO archived-bid lead (bid_status)', joined(st.body.stalled, 'name'));
    ok(stNames.length === 3,
      'stalled: exactly 3 of the 8 seeded targets survive (4 finished excluded, 1 active but busy)',
      `${stNames.length}: ${stNames.join(' | ')}`);

    // ════════════════════════════════════════════════════════════════════
    // LIST 2-4 — GET /exceptions (past_due, incomplete, stalled)
    // ════════════════════════════════════════════════════════════════════
    const ex = await get('/api/dashboard/exceptions');
    ok(ex.status === 200, 'exceptions: 200', `${ex.status} ${JSON.stringify(ex.body).slice(0, 200)}`);
    const bands = ex.body.bands || {};

    const pd = bands.past_due || [];
    const pdAll = pd.flatMap((r) => (r.items ? r.items.map((i) => i.label) : [r.label]));
    note(`past_due returned ${pdAll.length}: ${pdAll.join(' | ') || '(none)'}`);
    ok(pdAll.some((n) => n === 'LATE on active'), 'past_due: the active job\'s late task stays', pdAll.join(' | '));
    ok(pdAll.some((n) => n === 'LATE with no job'),
      'past_due: a task on a pad with NO JOB stays — §5 gives it a NO JOB chip', pdAll.join(' | '));
    ok(!pdAll.some((n) => n === 'LATE on completed'), 'past_due: NO task from a completed job', pdAll.join(' | '));
    ok(!pdAll.some((n) => n === 'LATE on archived'), 'past_due: NO task from an archived job', pdAll.join(' | '));
    ok(pdAll.length === 2, 'past_due: exactly 2 of 4 survive', `${pdAll.length}: ${pdAll.join(' | ')}`);

    const inc = bands.incomplete || [];
    const incNames = names(inc, 'label');
    note(`incomplete returned ${incNames.length}: ${incNames.join(' | ') || '(none)'}`);
    ok(incNames.some((n) => n.startsWith('ACTIVE')), 'incomplete: the active job stays', incNames.join(' | '));
    ok(!incNames.some((n) => n.startsWith('COMPLETED')), 'incomplete: NO completed job', incNames.join(' | '));
    ok(!incNames.some((n) => n.startsWith('ARCHIVED')), 'incomplete: NO archived job', incNames.join(' | '));

    const exSt = names(bands.stalled || [], 'label');
    ok(!exSt.some((n) => n.startsWith('COMPLETED') || n.startsWith('ARCHIVED') || n.startsWith('CLOSED')),
      'exceptions.stalled: nothing finished (the same rule, the same helper)', exSt.join(' | '));

    // ════════════════════════════════════════════════════════════════════
    // LIST 5 — GET /day, the day stream itself
    // ════════════════════════════════════════════════════════════════════
    const today = fmt(new Date());
    await conn.query("INSERT INTO job_schedule_items (id,schedule_id,name,computed_start_date,computed_end_date,is_inspection) VALUES (10,1,'ACTIVE inspection',?,?,1),(11,2,'COMPLETED inspection',?,?,1)", [today, today, today, today]);
    const day = await get(`/api/dashboard/day?from=${today}&to=${today}`);
    ok(day.status === 200, 'day: 200', `${day.status} ${JSON.stringify(day.body).slice(0, 200)}`);
    const rows = Object.values(day.body.days || {}).flat();
    const dayNames = rows.map((r) => String(r.title || r.name || ''));
    note(`day returned ${dayNames.length}: ${dayNames.join(' | ') || '(none)'}`);
    ok(dayNames.some((n) => n.includes('ACTIVE inspection')),
      'day: the active job\'s inspection stays', dayNames.join(' | '));
    ok(!dayNames.some((n) => n.includes('COMPLETED inspection')),
      'day: NO inspection from a completed job', dayNames.join(' | '));

    // ════════════════════════════════════════════════════════════════════
    // THE AMBER GUARANTEE — nothing was ADDED anywhere.
    // ════════════════════════════════════════════════════════════════════
    const everything = [...stNames, ...pdAll, ...incNames, ...exSt, ...dayNames];
    ok(!everything.some((n) => n.startsWith('COMPLETED') || n.startsWith('ARCHIVED') || n.startsWith('CLOSED')),
      'NOTHING finished appears in ANY list on this page',
      everything.filter((n) => n.startsWith('COMPLETED') || n.startsWith('ARCHIVED') || n.startsWith('CLOSED')).join(' | '));
  } catch (e) {
    fail++;
    rec.push('  ✗ HARNESS: ' + (e && e.stack ? e.stack : e));
  } finally {
    try { if (conn) conn.release(); } catch (e) { /* ignore */ }
    try { if (pool && pool.end) await pool.end(); } catch (e) { /* ignore */ }
    try { if (db && db.stop) await db.stop(); } catch (e) { /* ignore */ }
  }

  console.log('\n§1 — CURRENT JOBS AND LIVE LEADS ONLY\n');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
