/* TWO OWNERS IN ONE CALL, AND WHY THEY MUST NOT BE COLLAPSED.
 *
 * `buildDayStream` takes `owner` for jobs and `padOwner` for the notepad
 * company clause. That is justified — and it is also the exact shape of
 * the bug it came out of: two values in one function that both answer
 * "whose account is this", one of which GRANTS.
 *
 * The justification, stated so the next person does not "tidy" it away:
 *
 *   JOBS are owned by a business. A subcontractor is a SEPARATE business,
 *   so the inviting contractor's jobs are none of theirs — resolved by
 *   resolveAccountOwner, which promotes employees only.
 *
 *   NOTEPADS are how work is DELEGATED. A subcontractor belongs to the
 *   contractor's notepad account on purpose; that is the mechanism by
 *   which the GC sends them work — resolved by accountOwnerOf, which
 *   promotes anyone to their inviter.
 *
 * So the single call below must return BOTH: the delegated notepad task,
 * and not one job row belonging to the contractor. Collapse the two
 * parameters either way and one of those two halves breaks.
 *
 * Run: node test/dashboardTwoOwners.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_two_owners', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), created_by INT NULL, status INT DEFAULT 1, color VARCHAR(20) NULL, client_id INT NULL, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(90) NULL, job_zipcode VARCHAR(20) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150), user_id INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, user_id INT, created_by INT, task_type VARCHAR(20), task_name VARCHAR(190) NULL, status INT DEFAULT 0, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, shared_with_user_id INT NULL, type VARCHAR(20) NULL, title VARCHAR(190), sort_order INT DEFAULT 0, job_id INT NULL, lead_id INT NULL, origin VARCHAR(20) NULL, scope VARCHAR(20) NULL, account_owner_id INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE checklist_section_shares (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, user_id INT)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT, name VARCHAR(255), due_date DATETIME NULL, status VARCHAR(20) NULL, all_day TINYINT DEFAULT 0, delegated_to INT NULL, assign_to INT NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE notepad_access (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, user_id INT, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE appointments (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL, subject VARCHAR(190) NULL, description TEXT NULL, doa DATETIME NULL, all_day TINYINT DEFAULT 0, address VARCHAR(190) NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE job_schedules (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, skip_saturday TINYINT DEFAULT 1, skip_sunday TINYINT DEFAULT 1)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY AUTO_INCREMENT, schedule_id INT, name VARCHAR(190), duration_days INT DEFAULT 1, computed_start_date DATE NULL, computed_end_date DATE NULL, is_inspection TINYINT DEFAULT 0, assignee_user_id INT NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE spartan_goals (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, goal VARCHAR(255), start_time VARCHAR(8) NULL, duration_minutes INT NULL, recurrence VARCHAR(32) DEFAULT 'daily', day_of_week VARCHAR(64) NULL, is_special TINYINT DEFAULT 0, sort_order INT DEFAULT 0, reminder_lead_min INT DEFAULT 10, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("CREATE TABLE spartan_goal_log (id INT PRIMARY KEY AUTO_INCREMENT, goal_id INT NOT NULL, user_id INT NOT NULL, log_date DATE NOT NULL, status VARCHAR(20) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_goal_date (goal_id, log_date))");

    // 700 the GC, 720 a SUBCONTRACTOR the GC invited.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (700,'Poul (GC)','gc@x.com',14,4,NULL,NOW()),
      (720,'Subcontractor','sub@x.com',12,2,700,NOW())`);

    // The GC's own job — the subcontractor must NOT see it.
    await conn.query("INSERT INTO `job` (id,name,created_by,status,color,created_at) VALUES (10,'GC PRIVATE JOB',700,1,'#111',NOW())");

    const TODAY = fmt(new Date());

    // A COMPANY pad on the GC's account, carrying a dated task. This is the
    // delegated work: the subcontractor is on the GC's notepad allowlist,
    // so notepadHub shows it to them, and the dashboard must agree.
    await conn.query(
      "INSERT INTO checklist_sections (id,owner_user_id,type,title,job_id,scope,account_owner_id) VALUES (900,700,'task','Company pad',NULL,'company',700)",
    );
    await conn.query(
      "INSERT INTO check_list (id,section_id,name,due_date,status,created_by) VALUES (9001,900,'DELEGATED TASK',?, 'new',700)",
      [TODAY + ' 09:00:00'],
    );
    // On the allowlist -> isFullAccess true -> the company clause applies.
    await conn.query('INSERT INTO notepad_access (owner_user_id,user_id) VALUES (700,720)');

    // The GC's OWN appointment, on the GC's own job, today. It exists so the
    // contractor's job NAME can actually reach a payload — the job map alone
    // never emits a name unless some row references the job, so without this
    // the "collapsing leaks" demonstration below would pass for the wrong
    // reason: nothing to leak rather than nothing leaked.
    await conn.query(
      "INSERT INTO appointments (id,job_id,user_id,subject,doa,all_day,created_by) VALUES (8001,10,700,'GC private appointment',?,0,700)",
      [TODAY + ' 14:00:00'],
    );

    const { buildDayStream } = require('../services/dashboardDay');
    const { resolveAccountOwner } = require('../services/accountScope');
    const { accountOwnerOf, isFullAccess } = require('../services/notepadAccess');

    const uid = 720;
    const owner = await resolveAccountOwner(conn, uid);     // jobs   -> 720 (themself)
    const padOwner = await accountOwnerOf(conn, uid);       // pads   -> 700 (the GC)
    const full = await isFullAccess(conn, uid);

    ok(owner === 720, 'the JOB owner for a subcontractor is themself', String(owner));
    ok(padOwner === 700, 'the NOTEPAD owner for the same user is the inviting GC', String(padOwner));
    ok(full === true, 'and they are on the GC\'s notepad allowlist', String(full));
    note(`owner=${owner} padOwner=${padOwner} — the two values this test exists to keep apart`);

    // ── ONE CALL. BOTH HALVES. ──────────────────────────────────────────
    const stream = await buildDayStream(conn, { uid, owner, padOwner, from: TODAY, to: TODAY, full });
    const rows = (stream && stream.days && stream.days[TODAY]) || [];
    const titles = rows.map((r) => r.title);

    ok(titles.includes('DELEGATED TASK'),
      'the subcontractor RECEIVES the delegated notepad work (padOwner half)',
      JSON.stringify(titles));

    const jobNames = rows.map((r) => r.job_name).filter(Boolean);
    ok(!jobNames.includes('GC PRIVATE JOB'),
      'and NOT ONE row carrying the contractor\'s job (owner half)',
      JSON.stringify(jobNames));

    // Belt and braces: the contractor's job must not appear anywhere in the
    // payload, under any key — name, colour or address.
    const blob = JSON.stringify(stream);
    ok(!blob.includes('GC PRIVATE JOB'), 'the job name appears nowhere in the payload');
    ok(!blob.includes('#111'), 'nor its colour');

    // ── the collapse, in both directions, proven rather than argued ─────
    // If someone "tidies" the two parameters into one, one half breaks. This
    // demonstrates which, so the next person sees the cost of collapsing.
    const collapsedToJobOwner = await buildDayStream(
      conn, { uid, owner, padOwner: owner, from: TODAY, to: TODAY, full },
    );
    const t1 = ((collapsedToJobOwner.days || {})[TODAY] || []).map((r) => r.title);
    ok(!t1.includes('DELEGATED TASK'),
      'collapsing padOwner -> owner LOSES the delegated work (that is the cost)',
      JSON.stringify(t1));

    const collapsedToPadOwner = await buildDayStream(
      conn, { uid, owner: padOwner, padOwner, from: TODAY, to: TODAY, full },
    );
    const blob2 = JSON.stringify(collapsedToPadOwner);
    ok(blob2.includes('GC PRIVATE JOB'),
      'collapsing owner -> padOwner LEAKS the contractor\'s job (that is the original bug)',
      'expected the leak to be demonstrable, and it is');

    note('both collapses are shown to break something — the two values are not interchangeable');

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
