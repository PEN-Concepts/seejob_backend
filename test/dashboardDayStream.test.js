/* The merged day stream, §8 multi-day counting, all-day rows, and the §3 bands.
 *
 * Covers the 15 Sep day-stream checklist items 1-4, plus the inspection
 * checklist items 1-4 from the "fourth source" ruling.
 *
 * Run: node test/dashboardDayStream.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The Thursday of the current week, so the Thu-Wed span is deterministic. */
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
    db = await createDB({ dbName: 'seejob_daystream_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, created_at DATETIME NULL, business VARCHAR(190) NULL)");
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

    const { ensureNotepadSchema } = require('../services/notepadSchema');
    await ensureNotepadSchema(conn);
    const { ensureDashboardSchema } = require('../services/dashboardSchema');
    await ensureDashboardSchema(conn);

    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at,business) VALUES
      (700,'Poul','poul@x.com',14,4,NULL,NOW(),NULL),
      (710,'Josh','josh@x.com',2,1,700,NOW(),NULL),
      -- 711 carries a COMPANY; 710 does not. §4 renders company-over-person for
      -- one and the person alone for the other, so both shapes are covered.
      (711,'Martin Hernandez','martin@x.com',2,1,700,NOW(),'P & C PLASTERING')`);
    await conn.query("INSERT INTO `job` (id,name,created_by,color,job_address,job_city,created_at) VALUES (10,'Lynes - ADU & Main House',700,'#d9457a','301 Fair Oaks','Arroyo Grande',NOW()),(11,'Samuel - DECK',700,'#d94a2a','1145 Vard Loomis','Arroyo Grande',NOW())");
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,scope,origin,account_owner_id) VALUES (1,700,'task','Lynes - ADU & Main House',10,'company','auto',700)");

    const THU = thisThursday();
    const dayName = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    note(`week under test: Thu ${fmt(THU)} .. Wed ${fmt(plus(THU, 6))}`);

    // A FIVE-WORKING-DAY inspection starting Thursday. Weekends skipped.
    await conn.query("INSERT INTO job_schedules (id,job_id,skip_saturday,skip_sunday) VALUES (900,10,1,1)");
    await conn.query(
      "INSERT INTO job_schedule_items (id,schedule_id,name,duration_days,computed_start_date,is_inspection,assignee_user_id) VALUES (1,900,'rough electric',5,?,1,710)",
      [fmt(THU)]);

    // All-day vs no-time notepad tasks on the Thursday.
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by) VALUES (1,1,'Order dumpster',?,1,'new',700)",
      [fmt(THU) + ' 00:00:00']);
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by) VALUES (2,1,'No-time task',?,0,'new',700)",
      [fmt(THU) + ' 00:00:00']);
    // Two ASSIGNED rows so the assignee map is actually exercised — it never was.
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by,assign_to) VALUES (91,1,'Assigned to a company',?,1,'new',700,711)",
      [fmt(THU) + ' 00:00:00']);
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by,assign_to) VALUES (92,1,'Assigned to a person',?,1,'new',700,710)",
      [fmt(THU) + ' 00:00:00']);
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,all_day,status,created_by) VALUES (3,1,'Timed task',?,0,'new',700)",
      [fmt(THU) + ' 14:00:00']);

    // A master_calendar_tasks row that must NEVER reach the stream.
    await conn.query("INSERT INTO master_calendar_tasks (id,title,created_by,created_at) VALUES (1,'Rough Electric TRADE LIST ENTRY',700,NOW())");

    // Planner goal on Thursday only.
    await conn.query("INSERT INTO spartan_goals (user_id,goal,start_time,duration_minutes,recurrence,day_of_week) VALUES (700,'Gym','06:00',60,'weekly','4')");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
    const tok = (id, role, category) => 'Bearer ' + jwt.sign(
      { id, role, category, email: 'u' + id + '@x.com' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const from = fmt(plus(THU, -1));
    const to = fmt(plus(THU, 8));
    const res = await request(app).get(`/api/dashboard/day?from=${from}&to=${to}`).set('Authorization', tok(700, 14, 4));
    ok(res.status === 200, 'day stream responds 200', String(res.status) + ' ' + JSON.stringify(res.body).slice(0, 160));
    const days = (res.body && res.body.days) || {};

    const insp = (d) => (days[d] || []).filter((i) => i.kind === 'inspection');

    // ── 1. Thu-Wed across five WORKING days, 1/5 .. 5/5, not Sat or Sun ──
    const expected = [plus(THU, 0), plus(THU, 1), plus(THU, 4), plus(THU, 5), plus(THU, 6)];
    const sat = plus(THU, 2), sun = plus(THU, 3);
    const seen = [];
    expected.forEach((d, i) => {
      const rows = insp(fmt(d));
      const r = rows[0];
      const good = r && r.day_index === i + 1 && r.day_total === 5;
      if (!good) fail++; else pass++;
      rec.push(`${good ? '  ✓' : '  ✗'} ${dayName(d)} ${fmt(d)} shows ${i + 1}/5` +
        (good ? '' : '  -> ' + JSON.stringify(rows)));
      if (r) seen.push(`${dayName(d)} ${r.day_index}/${r.day_total}`);
    });
    ok(insp(fmt(sat)).length === 0, `Saturday ${fmt(sat)} has NO inspection row — skipped days do not count`, JSON.stringify(insp(fmt(sat))));
    ok(insp(fmt(sun)).length === 0, `Sunday ${fmt(sun)} has NO inspection row`, JSON.stringify(insp(fmt(sun))));
    note('multi-day fan-out: ' + seen.join(', '));

    // ── inspection ruling items 1 & 2 ───────────────────────────────────
    const first = insp(fmt(THU))[0];
    ok(first && fmt(THU) === fmt(THU) && first.title === 'rough electric',
      'the inspection appears on its computed_start_date', JSON.stringify(first));
    ok(first && first.untimed === true && first.all_day === false,
      'an inspection is UNTIMED, not all_day — all_day stays the stored column',
      JSON.stringify({ untimed: first && first.untimed, all_day: first && first.all_day }));
    ok(first && first.is_inspection === true,
      'it is flagged is_inspection so the page can render INSPECTION — <name>', JSON.stringify(first && first.is_inspection));
    ok(first && first.job_name === 'Lynes - ADU & Main House' && /301 Fair Oaks/.test(first.address || ''),
      'it carries the job name AND street address for the address line',
      JSON.stringify({ job: first && first.job_name, addr: first && first.address }));

    // ── inspection ruling item 3: the trade list never reaches the stream ─
    const everyTitle = Object.values(days).flat().map((i) => i.title);
    ok(!everyTitle.some((t) => /TRADE LIST ENTRY/.test(String(t))),
      'NO row from master_calendar_tasks reaches the day stream',
      JSON.stringify(everyTitle.filter((t) => /TRADE/.test(String(t)))));

    // ── 2. all-day vs a no-time task with all_day = 0 ───────────────────
    const thuItems = days[fmt(THU)] || [];
    const allDayRow = thuItems.find((i) => i.kind === 'task' && i.title === 'Order dumpster');
    const noTimeRow = thuItems.find((i) => i.kind === 'task' && i.title === 'No-time task');
    const timedRow = thuItems.find((i) => i.kind === 'task' && i.title === 'Timed task');
    ok(allDayRow && allDayRow.all_day === true, 'an all_day = 1 task renders as ALL DAY', JSON.stringify(allDayRow));
    ok(noTimeRow && noTimeRow.all_day === false,
      'a NO-TIME task with all_day = 0 is NOT all-day — two different states',
      JSON.stringify(noTimeRow));
    ok(timedRow && timedRow.time === '14:00' && timedRow.all_day === false,
      'a timed task keeps its time', JSON.stringify(timedRow));

    // ── 5. Planner goals come from the SERVER ───────────────────────────
    const gym = thuItems.find((i) => i.kind === 'planner');
    ok(gym && gym.title === 'Gym' && gym.time === '06:00',
      'the planner goal comes from spartan_goals on the server (no localStorage involved)',
      JSON.stringify(gym));
    ok(!(days[fmt(plus(THU, 1))] || []).some((i) => i.kind === 'planner'),
      'a weekly Thursday goal does NOT appear on Friday', JSON.stringify(days[fmt(plus(THU, 1))]));

    // ── §3 bands: roll-up rule ──────────────────────────────────────────
    // Job 10 gets TWO past-due items -> one rolled-up row with count 2.
    // Job 11 gets ONE -> named directly.
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,scope,origin,account_owner_id) VALUES (2,700,'task','Samuel - DECK',11,'company','auto',700)");
    await conn.query(`INSERT INTO check_list (section_id,name,due_date,all_day,status,created_by) VALUES
      (1,'Order countertops', NOW() - INTERVAL 5 DAY, 0, 'new', 700),
      (1,'Call the inspector', NOW() - INTERVAL 6 DAY, 0, 'new', 700),
      (2,'Seal the deck',      NOW() - INTERVAL 4 DAY, 0, 'new', 700)`);

    const ex = await request(app).get('/api/dashboard/exceptions').set('Authorization', tok(700, 14, 4));
    ok(ex.status === 200, 'exceptions responds 200', String(ex.status));
    const bands = (ex.body && ex.body.bands) || {};
    const pd = bands.past_due || [];

    const lynes = pd.find((r) => r.label === 'Lynes - ADU & Main House');
    ok(lynes && lynes.kind === 'rollup' && lynes.count === 2,
      'TWO past-due items on one job roll up to ONE row with a count of 2',
      JSON.stringify(pd));
    const sealed = pd.find((r) => r.label === 'Seal the deck');
    ok(sealed && sealed.kind === 'item' && sealed.count === 1,
      'ONE past-due item is named directly', JSON.stringify(pd));

    // ── 4. Incomplete Gantt: one row per job regardless of count ─────────
    await conn.query(`INSERT INTO job_schedule_items (schedule_id,name,duration_days,computed_start_date,is_inspection,assignee_user_id) VALUES
      (900,'unassigned A',1,?,0,NULL),(900,'unassigned B',1,?,0,NULL),(900,'unassigned C',1,?,0,NULL)`,
      [fmt(THU), fmt(THU), fmt(THU)]);
    const ex2 = await request(app).get('/api/dashboard/exceptions').set('Authorization', tok(700, 14, 4));
    const bands2 = (ex2.body && ex2.body.bands) || {};
    const inc = bands2.incomplete || [];
    const una = bands2.unassigned || [];

    // §4 UPDATED, NOT WEAKENED — THESE THREE ITEMS CHANGED BANDS ON PURPOSE.
    //
    // They are seeded with assignee_user_id NULL and a real start date, so
    // under the old single clause (`no assignee OR no date`) they counted as
    // INCOMPLETE. §4 splits that question in two because they are different
    // jobs of work: these need a PERSON, not a date. The roll-up rule they
    // were written to prove is unchanged and is asserted below on the band
    // they now belong to.
    const unaRows = una.filter((r) => r.kind === 'gantt' && r.label === 'Lynes - ADU & Main House');
    ok(unaRows.length === 1,
      'THREE items with nobody on them produce exactly ONE row for that job',
      JSON.stringify(una));
    ok(unaRows[0] && unaRows[0].count === 3 && unaRows[0].sub === 'nobody on it',
      'that single row carries the count and says what is missing — a person',
      JSON.stringify(unaRows[0]));

    // THE OLD EXPECTATION, KEPT AS A NEGATIVE so the two cannot silently
    // collapse back into one number.
    ok(!inc.some((r) => r.kind === 'gantt' && r.label === 'Lynes - ADU & Main House'),
      'and they are NOT in INCOMPLETE any more — "no assignee" and "no date" are two questions',
      JSON.stringify(inc));

    /* ── THE ASSIGNEE, WHICH NOTHING HAS EVER ASSERTED ──────────────────
     *
     * `assignee_name` has been emitted by this stream since it was written and
     * NO test has ever looked at it. That was found while adding
     * `assignee_company`: the new column made the user query throw against a
     * fixture that lacked it, the catch emptied BOTH maps, and all 25 tests
     * still passed — i.e. every assignee name could have vanished from the
     * dashboard and the suite would have said nothing.
     *
     * So both fields are pinned here, in both shapes §4 renders:
     *   711 has a company  -> company + person
     *   710 has none       -> person, and company NULL (§4's "no second line")
     */
    const thuRows = days[fmt(THU)] || [];
    const withCo = thuRows.find((r) => r.title === 'Assigned to a company');
    const noCo = thuRows.find((r) => r.title === 'Assigned to a person');
    ok(!!withCo && withCo.assignee_name === 'Martin Hernandez',
      'assignee_name is emitted in full', withCo && withCo.assignee_name);
    ok(!!withCo && withCo.assignee_company === 'P & C PLASTERING',
      'assignee_company is emitted when the user has one', withCo && withCo.assignee_company);
    ok(!!noCo && noCo.assignee_name === 'Josh' && noCo.assignee_company === null,
      'a user with no business gets a name and a NULL company, not an empty string',
      noCo && JSON.stringify({ n: noCo.assignee_name, c: noCo.assignee_company }));

    // ── §3: a band with zero items is ABSENT, not empty ─────────────────
    ok(!('stalled' in bands) || (bands.stalled && bands.stalled.length > 0),
      'a band with no items is absent from the payload entirely, never an empty array',
      JSON.stringify(Object.keys(bands)));

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
