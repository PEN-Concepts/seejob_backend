/* §4 AND §4b — THE FOUR COUNTS, AND ONE DATE FOR SEVERAL ROWS.
 *
 * §4 SPLITS AN EXISTING LIST, IT DOES NOT ADD ONE. The old INCOMPLETE query
 * was `assignee_user_id IS NULL OR computed_start_date IS NULL`, so "nobody
 * is doing this" and "this has no date" arrived as a single number. They are
 * different jobs of work, so they are now two counts. Every row counted was
 * already inside INCOMPLETE; nothing new is shown to anybody, which is what
 * keeps this pass AMBER.
 *
 * §4b IS A SNOOZE AND IT IS NAMED FOR WHAT IT DOES. `Check back on` sets a
 * date. It is not a dismiss, it hides nothing permanently, and it touches
 * only the caller's own view. The bulk form takes the date ONCE and applies
 * it to everything ticked, writing EXACTLY what the single control writes:
 * the same upsert into dashboard_stall_snooze, per row.
 *
 * WHAT IT MUST NOT DO, and each has a check below: invent a target_type for
 * late TASKS, delete anything, half-apply a batch, or accept a date in the
 * past.
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const daysAhead = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_bulk_snooze', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
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

    // 700 the owner, 800 a SEPARATE business.
    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by) VALUES (700,'Owner','o@x.com',14,4,NULL),(800,'Foreign','f@x.com',14,4,NULL)");

    const OLD = fmt(daysAgo(120));
    await conn.query(
      "INSERT INTO `job` (id,name,created_by,status,color,created_at,updated_at) VALUES " +
      "(10,'Samuel - DECK',700,1,'#b4651f',?,?)," +
      "(11,'Lynes - ADU',700,1,'#8d5a8e',?,?)," +
      "(12,'Quiet Job',700,1,'#0abbcc',?,?)," +
      "(90,'FOREIGN JOB',800,1,'#999999',?,?)",
      [OLD, OLD, OLD, OLD, OLD, OLD, OLD, OLD],
    );
    await conn.query("INSERT INTO leads (id,lead_name,user_id,status,created_at,updated_at) VALUES (20,'Bethel - HOME',700,1,?,?)", [OLD, OLD]);

    // ── §4 THE SPLIT. Job 10 gets 2 items with NO ASSIGNEE and 1 with an
    //    assignee but NO DATE. Job 11 gets 3 with no date only.
    await conn.query("INSERT INTO job_schedules (id,job_id) VALUES (1,10),(2,11)");
    await conn.query(
      "INSERT INTO job_schedule_items (id,schedule_id,name,assignee_user_id,computed_start_date) VALUES " +
      "(1,1,'Frame',NULL,'2026-09-21')," +
      "(2,1,'Roof',NULL,'2026-09-22')," +
      "(3,1,'Paint',700,NULL)," +
      "(4,2,'Slab',700,NULL),(5,2,'Trim',700,NULL),(6,2,'Tile',700,NULL)",
    );

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    const OWNER = 'Bearer ' + jwt.sign({ id: 700 }, process.env.ACCESS_TOKEN);
    const get = (p) => request(app).get(p).set('Authorization', OWNER);
    const post = (p, b) => request(app).post(p).set('Authorization', OWNER).send(b);

    // ════════════════════════════════════════════════════════════════════
    // §4 — FOUR COUNTS, AND THE SPLIT IS A SPLIT
    // ════════════════════════════════════════════════════════════════════
    const ex = await get('/api/dashboard/exceptions');
    ok(ex.status === 200, '§4 exceptions: 200', `${ex.status} ${JSON.stringify(ex.body).slice(0, 200)}`);
    const bands = ex.body.bands || {};
    const counts = ex.body.counts || {};
    note(`counts = ${JSON.stringify(counts)}`);

    ok(counts.late !== undefined && counts.unassigned !== undefined
      && counts.incomplete !== undefined && counts.stalled !== undefined,
      '§4 all FOUR counts are present', JSON.stringify(counts));

    ok(Number(counts.unassigned) === 2,
      '§4 UNASSIGNED counts the 2 items with nobody on them', String(counts.unassigned));
    // 4 undated gantt items (1 on Samuel, 3 on Lynes) PLUS job 12, which has
    // no schedule at all and is an incomplete row in its own right. The first
    // version of this expectation said 4 and forgot the no-schedule job —
    // my arithmetic, not the code's.
    ok(Number(counts.incomplete) === 5,
      '§4 INCOMPLETE counts the 4 undated items + 1 job with no schedule, NOT the unassigned ones',
      String(counts.incomplete));

    const una = (bands.unassigned || []).map((r) => `${r.label}:${r.count}`);
    const inc = (bands.incomplete || []).map((r) => `${r.label}:${r.count}`);
    note(`unassigned rows: ${una.join(' | ')}`);
    note(`incomplete rows: ${inc.join(' | ')}`);
    ok(una.includes('Samuel - DECK:2'), '§4 the unassigned row rolls up to its job', una.join(' | '));
    ok(inc.includes('Samuel - DECK:1') && inc.includes('Lynes - ADU:3'),
      '§4 the incomplete rows keep their own counts', inc.join(' | '));

    // NOTHING NEW: the two bands together equal the old single band.
    // The old single band held: job 10 → 3 matching items, job 11 → 3, job 12
    // → 1 no-schedule row = 7. The two halves must still total 7.
    ok(Number(counts.unassigned) + Number(counts.incomplete) === 7,
      '§4 the split is a SPLIT — the two halves total exactly what INCOMPLETE held alone',
      `${counts.unassigned} + ${counts.incomplete}`);

    // An item with NEITHER counts ONCE, under unassigned.
    await conn.query("INSERT INTO job_schedule_items (id,schedule_id,name,assignee_user_id,computed_start_date) VALUES (7,1,'Neither',NULL,NULL)");
    const ex2 = await get('/api/dashboard/exceptions');
    ok(Number(ex2.body.counts.unassigned) === 3 && Number(ex2.body.counts.incomplete) === 5,
      '§4 an item with neither a person nor a date is counted ONCE, as unassigned — the other count does not move',
      JSON.stringify(ex2.body.counts));

    // Every job/lead row carries a target_type the snooze understands.
    const jobRows = [...(bands.unassigned || []), ...(bands.incomplete || [])];
    ok(jobRows.every((r) => r.target_type === 'job' && Number(r.id) > 0),
      '§4b every Unassigned/Incomplete row is a JOB row — no page is a mix',
      JSON.stringify(jobRows.map((r) => r.target_type)));

    // ════════════════════════════════════════════════════════════════════
    // §4b — ONE DATE, SEVERAL ROWS
    // ════════════════════════════════════════════════════════════════════
    const WHEN = fmt(daysAhead(14));
    const bulk = await post('/api/dashboard/stall-snooze/bulk', {
      check_back_on: WHEN,
      targets: [
        { target_type: 'job', target_id: 10 },
        { target_type: 'job', target_id: 12 },
        { target_type: 'lead', target_id: 20 },
      ],
    });
    ok(bulk.status === 200, '§4b bulk: 200', `${bulk.status} ${JSON.stringify(bulk.body)}`);
    ok(Number(bulk.body.snoozed) === 3, '§4b it reports how many it did', JSON.stringify(bulk.body));

    const [rows] = await conn.query(
      "SELECT target_type, target_id, DATE_FORMAT(check_back_on,'%Y-%m-%d') AS d FROM dashboard_stall_snooze WHERE user_id = 700 ORDER BY target_type, target_id",
    );
    ok(rows.length === 3, '§4b exactly three rows written', JSON.stringify(rows));
    ok(rows.every((r) => r.d === WHEN), '§4b ONE date on all of them', JSON.stringify(rows));

    // IT IS THE SAME WRITE THE SINGLE CONTROL MAKES.
    const single = await post('/api/dashboard/stall-snooze', {
      target_type: 'job', target_id: 11, check_back_on: WHEN,
    });
    ok(single.status === 200, '§4b the single control still works', JSON.stringify(single.body));
    const [[one]] = await conn.query(
      "SELECT target_type, target_id, DATE_FORMAT(check_back_on,'%Y-%m-%d') AS d FROM dashboard_stall_snooze WHERE user_id = 700 AND target_id = 11",
    );
    const [[bulkRow]] = await conn.query(
      "SELECT target_type, target_id, DATE_FORMAT(check_back_on,'%Y-%m-%d') AS d FROM dashboard_stall_snooze WHERE user_id = 700 AND target_id = 10",
    );
    ok(one.target_type === bulkRow.target_type && one.d === bulkRow.d,
      '§4b a bulk row is INDISTINGUISHABLE from a single-control row',
      JSON.stringify([one, bulkRow]));

    // NOTHING WAS DELETED.
    const [[jc]] = await conn.query('SELECT COUNT(*) AS n FROM `job`');
    const [[lc]] = await conn.query('SELECT COUNT(*) AS n FROM leads');
    const [[ic]] = await conn.query('SELECT COUNT(*) AS n FROM job_schedule_items');
    ok(Number(jc.n) === 4 && Number(lc.n) === 1 && Number(ic.n) === 7,
      '§4b NOTHING was deleted — jobs, leads and schedule items all intact',
      `jobs=${jc.n} leads=${lc.n} items=${ic.n}`);

    // IT IS A SNOOZE: the rows leave STALLED, and come back later.
    const st = await get('/api/dashboard/stalled');
    const stIds = (st.body.stalled || []).map((r) => `${r.target_type}:${r.id}`);
    ok(!stIds.includes('job:10') && !stIds.includes('lead:20'),
      '§4b the snoozed rows leave the stalled list', stIds.join(' | '));

    // ── the refusals ────────────────────────────────────────────────────
    const past = await post('/api/dashboard/stall-snooze/bulk', {
      check_back_on: fmt(daysAgo(1)), targets: [{ target_type: 'job', target_id: 10 }],
    });
    ok(past.status === 400, '§4b a date in the past is refused — nothing is hidden for good', String(past.status));

    const task = await post('/api/dashboard/stall-snooze/bulk', {
      check_back_on: WHEN, targets: [{ target_type: 'task', target_id: 1 }],
    });
    ok(task.status === 400,
      '§4b there is NO target_type for a late task — Late gets no snooze and none was invented',
      `${task.status} ${JSON.stringify(task.body)}`);

    const [before] = await conn.query('SELECT COUNT(*) AS n FROM dashboard_stall_snooze');
    const foreign = await post('/api/dashboard/stall-snooze/bulk', {
      check_back_on: WHEN,
      targets: [{ target_type: 'job', target_id: 12 }, { target_type: 'job', target_id: 90 }],
    });
    ok(foreign.status === 403, '§4b a foreign target is refused', `${foreign.status} ${JSON.stringify(foreign.body)}`);
    const [after] = await conn.query('SELECT COUNT(*) AS n FROM dashboard_stall_snooze');
    ok(Number(before[0].n) === Number(after[0].n),
      '§4b ALL OR NOTHING — a batch with one bad target writes NOTHING, so "6 rows" cannot turn out to mean five',
      `${before[0].n} -> ${after[0].n}`);

    const empty = await post('/api/dashboard/stall-snooze/bulk', { check_back_on: WHEN, targets: [] });
    ok(empty.status === 400, '§4b an empty selection is refused', String(empty.status));
  } catch (e) {
    fail++;
    rec.push('  ✗ HARNESS: ' + (e && e.stack ? e.stack : e));
  } finally {
    try { if (conn) conn.release(); } catch (e) { /* ignore */ }
    try { if (pool && pool.end) await pool.end(); } catch (e) { /* ignore */ }
    try { if (db && db.stop) await db.stop(); } catch (e) { /* ignore */ }
  }

  console.log('\n§4 THE FOUR COUNTS + §4b CHECK BACK ON, IN BULK\n');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
