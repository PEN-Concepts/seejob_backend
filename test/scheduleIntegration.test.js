/* Integration test for the Schedule Template backend. Boots a REAL local MySQL
 * (via mysql-memory-server), creates a minimal legacy schema, seeds users/plans,
 * then exercises the ACTUAL Express routers (requirePlan gate + cascade hook +
 * notification dispatch) via supertest, plus the service layer directly.
 * Covers: (1) seed, (2) apply, (3) cascade, (4) re-apply, (5) cycle, + Gold gating.
 * Run: node test/scheduleIntegration.test.js   (exit 0 = pass, 1 = fail)
 *
 * NOTE: this is a heavyweight integration test — on first run mysql-memory-server
 * downloads a real MySQL binary (cached thereafter). It is intentionally NOT wired
 * into a watch/CI-by-default loop; run it on demand via `npm run test:integration`. */

'use strict';
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const { createDB } = require('mysql-memory-server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ FAIL: ' + m)); };
const section = (t) => console.log('\n=== ' + t + ' ===');

const OWNER = 100, A = 101, B = 102, NONGOLD = 103, JOB = 500;
const SECRET = 'test_access_secret';
const tokenFor = (id, role, workingId) => jwt.sign({ id, role, working_id: workingId || id }, SECRET);

(async () => {
  const db = await createDB({ dbName: 'seejob_test', logLevel: 'ERROR' });
  console.log('MySQL up on port', db.port);

  // Env MUST be set before requiring config/connection (pool built at require).
  process.env.ACCESS_TOKEN = SECRET;
  process.env.TZ = 'America/Los_Angeles';
  process.env.API_URL = '/api/v1';
  delete process.env.NODE_ENV; // use the DEV pool branch
  process.env.DB_HOST_DEV = '127.0.0.1';
  process.env.DB_PORT_DEV = String(db.port);
  process.env.DB_USER_DEV = db.username || 'root';
  process.env.DB_PASSWORD_DEV = '';
  process.env.DB_NAME_DEV = db.dbName;

  const pool = require('../config/connection');
  const { ensureScheduleTemplateTables } = require('../services/dbMigrations');
  const cascade = require('../services/scheduleCascade');
  const engine = require('../services/scheduleEngine');

  try {
    const ddl = [
      `CREATE TABLE user (id INT PRIMARY KEY, name VARCHAR(150), email VARCHAR(190), password VARCHAR(190),
         role INT, created_by INT NULL, category INT NULL, status INT DEFAULT 1, working_id INT NULL,
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
      `CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(80), amount DECIMAL(10,2) DEFAULT 0,
         \`interval\` VARCHAR(20) DEFAULT 'monthly', is_active INT DEFAULT 1, description VARCHAR(255)) ENGINE=InnoDB`,
      `CREATE TABLE plan_features (id INT AUTO_INCREMENT PRIMARY KEY, plan_id INT, feature_key VARCHAR(80)) ENGINE=InnoDB`,
      `CREATE TABLE subscriptions (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, plan_id INT, amount DECIMAL(10,2) DEFAULT 0,
         billing_interval VARCHAR(20) DEFAULT 'monthly', status VARCHAR(20) DEFAULT 'active',
         next_billing_at DATETIME NULL, authorize_subscription_id VARCHAR(80) NULL,
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
      `CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(190), created_by INT) ENGINE=InnoDB`,
      `CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(190)) ENGINE=InnoDB`,
      `CREATE TABLE tasks (id INT AUTO_INCREMENT PRIMARY KEY, task_name VARCHAR(255), user_id INT NULL, team_id INT NULL,
         duration_days INT DEFAULT 1, start_date DATETIME NULL, end_date DATETIME NULL, description TEXT NULL,
         image VARCHAR(255) NULL, audio_note VARCHAR(255) NULL, assignee_completed INT DEFAULT 0, job_id INT NULL,
         created_at DATETIME NULL, created_by INT NULL, task_type VARCHAR(20) DEFAULT 'job', is_calendar_task INT DEFAULT 0,
         is_appointment_task INT DEFAULT 0, time DATETIME NULL, priority VARCHAR(20) DEFAULT 'low', status INT DEFAULT 0,
         status_note VARCHAR(255) NULL, complete_percentage INT NULL, nudge INT NULL, archived_at DATETIME NULL) ENGINE=InnoDB`,
      `CREATE TABLE stages (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, name VARCHAR(255), csi_code VARCHAR(150) NULL,
         job_id INT, owner_type VARCHAR(8) DEFAULT 'job', status INT DEFAULT 1, progress_status INT DEFAULT 0,
         created_at DATETIME NULL, updated_at DATETIME NULL) ENGINE=InnoDB`,
      `CREATE TABLE user_device_tokens (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, fcm_token VARCHAR(255)) ENGINE=InnoDB`,
      `CREATE TABLE notifications (id INT AUTO_INCREMENT PRIMARY KEY, sender_id INT NULL, receiver_id INT, content TEXT,
         status INT DEFAULT 1, url VARCHAR(120) NULL, created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
      `CREATE TABLE job_contacts (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, job_id INT, contact_id INT, owner_type VARCHAR(8) DEFAULT 'job') ENGINE=InnoDB`,
      `CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_leader INT NULL) ENGINE=InnoDB`,
      `CREATE TABLE team_user (id INT AUTO_INCREMENT PRIMARY KEY, team_id INT, user_id INT) ENGINE=InnoDB`,
      `CREATE TABLE contact (id INT AUTO_INCREMENT PRIMARY KEY, request_by INT, request_to INT, status VARCHAR(20))`,
    ];
    for (const q of ddl) await pool.query(q);

    await pool.query(`INSERT INTO plans (id,name) VALUES (4,'Gold'),(2,'Silver')`);
    await pool.query(
      `INSERT INTO user (id,name,email,password,role,created_by,category) VALUES
        (?,?,?,?,?,?,?),(?,?,?,?,?,?,?),(?,?,?,?,?,?,?),(?,?,?,?,?,?,?)`,
      [
        OWNER, 'Owner GC', 'owner@test.com', 'hash', 14, null, null,
        A, 'Sub A', 'a@test.com', 'hash', 12, OWNER, 2,
        B, 'Sub B', 'b@test.com', 'hash', 12, OWNER, 2,
        NONGOLD, 'NonGold GC', 'nongold@test.com', 'hash', 14, null, null,
      ]
    );
    await pool.query(`INSERT INTO subscriptions (user_id,plan_id,status) VALUES (?,?, 'active'),(?,?, 'active')`,
      [OWNER, 4, NONGOLD, 2]);
    await pool.query(`INSERT INTO job (id,name,created_by) VALUES (?,?,?)`, [JOB, 'Test Home Build', OWNER]);

    await ensureScheduleTemplateTables(pool);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/schedule-templates', require('../routes/scheduleTemplates'));
    app.use('/api/v1/job-schedules', require('../routes/jobSchedules'));
    app.use('/api/v1/tasks', require('../routes/tasks'));

    const goldTok = tokenFor(OWNER, 14);
    const nonGoldTok = tokenFor(NONGOLD, 14);
    const auth = (t) => ({ Authorization: 'Bearer ' + t });

    // ---------- T1: seed ----------
    section('T1 — Seed template correctness');
    const [[tpl]] = await pool.query("SELECT * FROM schedule_templates WHERE is_seed=1 LIMIT 1");
    ok(!!tpl, 'seed template exists: ' + (tpl && tpl.name));
    const [tItems] = await pool.query('SELECT * FROM schedule_template_items WHERE template_id=? ORDER BY sort_order', [tpl.id]);
    ok(tItems.length === 42, `42 items (got ${tItems.length})`);
    const byOrd = Object.fromEntries(tItems.map((i) => [i.sort_order, i]));
    const [d7] = await pool.query('SELECT depends_on_item_id FROM schedule_template_deps WHERE item_id=?', [byOrd[7].id]);
    const d7ords = d7.map((d) => (tItems.find((i) => i.id === d.depends_on_item_id) || {}).sort_order).sort((a, b) => a - b);
    ok(d7ords.join(',') === '4,5,6', `item 7 deps map to stable ids of items 4,5,6 (got ${d7ords.join(',')})`);
    ok(byOrd[42].depends_on_all === 1, 'item 42 depends_on_all = 1');
    const [d42] = await pool.query('SELECT * FROM schedule_template_deps WHERE item_id=?', [byOrd[42].id]);
    ok(d42.length === 0, 'item 42 has no explicit dep rows');
    const [allDeps] = await pool.query('SELECT COUNT(*) c FROM schedule_template_deps d JOIN schedule_template_items i ON i.id=d.item_id WHERE i.template_id=?', [tpl.id]);
    ok(allDeps[0].c === 46, `total explicit dependency edges = 46 (got ${allDeps[0].c})`);

    // ---------- Gold gating ----------
    section('GATE — Gold-only enforcement (server-side 403)');
    const assignments = [1, 2, 3].map((n) => ({ template_item_id: byOrd[n].id, assignee_user_id: A }))
      .concat([4, 5, 6].map((n) => ({ template_item_id: byOrd[n].id, assignee_user_id: B })));
    const applyBody = { job_id: JOB, owner_type: 'job', start_date: '2026-07-08', skip_saturday: false, skip_sunday: true, assignments };

    const rNon = await request(app).post(`/api/v1/schedule-templates/${tpl.id}/apply`).set(auth(nonGoldTok)).send(applyBody);
    ok(rNon.status === 403 && rNon.body.code === 'PLAN_UPGRADE_REQUIRED',
      `non-Gold apply → 403 PLAN_UPGRADE_REQUIRED (got ${rNon.status} ${rNon.body.code || ''})`);
    const rNonList = await request(app).get('/api/v1/schedule-templates').set(auth(nonGoldTok));
    ok(rNonList.status === 403, `non-Gold browse templates → 403 (got ${rNonList.status})`);

    // ---------- T2: apply ----------
    section('T2 — Apply (Gold) creates 42 tasks + 42 stages, dates, batched notifications');
    await pool.query('DELETE FROM notifications');
    const rApply = await request(app).post(`/api/v1/schedule-templates/${tpl.id}/apply`).set(auth(goldTok)).send(applyBody);
    ok(rApply.status === 201 && rApply.body.success, `Gold apply → 201 success (got ${rApply.status})`);
    const sid = rApply.body.schedule_id;
    const [jsItems] = await pool.query('SELECT * FROM job_schedule_items WHERE schedule_id=? ORDER BY sort_order', [sid]);
    ok(jsItems.length === 42, `42 job_schedule_items (got ${jsItems.length})`);
    ok(jsItems.filter((i) => i.task_id).length === 42, `42 tasks linked (got ${jsItems.filter((i) => i.task_id).length})`);
    ok(jsItems.filter((i) => i.stage_id).length === 42, `42 stages linked (got ${jsItems.filter((i) => i.stage_id).length})`);
    const [[taskCnt]] = await pool.query('SELECT COUNT(*) c FROM tasks WHERE job_id=? AND is_calendar_task=1 AND archived_at IS NULL', [JOB]);
    ok(taskCnt.c === 42, `42 calendar tasks in DB (got ${taskCnt.c})`);
    const [[stageCnt]] = await pool.query('SELECT COUNT(*) c FROM stages WHERE job_id=? AND status=1', [JOB]);
    ok(stageCnt.c === 42, `42 active stages in DB (got ${stageCnt.c})`);
    const jbo = Object.fromEntries(jsItems.map((i) => [i.sort_order, i]));
    const latest456 = [4, 5, 6].map((n) => String(jbo[n].computed_end_date).slice(0, 10)).sort().pop();
    const exp7 = engine.addWorkingDays(latest456, 1, false, true);
    ok(String(jbo[7].computed_start_date).slice(0, 10) === exp7,
      `item 7 starts day after latest of 4/5/6 skipping Sundays (${String(jbo[7].computed_start_date).slice(0,10)} == ${exp7})`);
    const dowLocal = (v) => engine.parseYMD(String(v).slice(0, 10)).getDay(); // LOCAL, not UTC
    const anySun = jsItems.some((i) => dowLocal(i.computed_start_date) === 0 || dowLocal(i.computed_end_date) === 0);
    ok(!anySun, 'no computed start/end lands on a Sunday (skip_sunday honored)');
    await sleep(1000);
    const [notifs] = await pool.query('SELECT receiver_id, content FROM notifications ORDER BY receiver_id');
    ok(notifs.length === 2, `exactly 2 notifications — one batched per assignee (got ${notifs.length})`);
    const aNote = notifs.find((n) => n.receiver_id === A);
    ok(aNote && (aNote.content.match(/•/g) || []).length === 3, `A's single notification batches all 3 trades (got ${aNote ? (aNote.content.match(/•/g)||[]).length : 'none'})`);

    // ---------- T3: cascade via PUT /tasks/update ----------
    section('T3 — Cascade after a duration edit through PUT /tasks/update/:id (calendar-drag path)');
    await pool.query('DELETE FROM notifications');
    const item4 = jbo[4], item7 = jbo[7];
    const before7 = String(item7.computed_start_date).slice(0, 10);
    const dragBody = {
      start_date: String(item4.computed_start_date).slice(0, 10),
      duration_days: item4.duration_days + 5,
      user_id: B,
      task_name: item4.name,
    };
    const rDrag = await request(app).put(`/api/v1/tasks/update/${item4.task_id}`).set(auth(goldTok)).send(dragBody);
    ok(rDrag.status === 200, `task update (drag) → 200 (got ${rDrag.status})`);
    const [[new7]] = await pool.query('SELECT computed_start_date FROM job_schedule_items WHERE id=?', [item7.id]);
    ok(String(new7.computed_start_date).slice(0, 10) > before7,
      `downstream item 7 shifted later (${before7} → ${String(new7.computed_start_date).slice(0,10)})`);
    const [[t7]] = await pool.query('SELECT start_date FROM tasks WHERE id=?', [item7.task_id]);
    ok(String(t7.start_date).slice(0, 10) === String(new7.computed_start_date).slice(0, 10), 'linked task 7 start_date updated to match cascade');
    await sleep(1000);
    const [cascNotifs] = await pool.query('SELECT DISTINCT receiver_id FROM notifications');
    const recips = cascNotifs.map((n) => n.receiver_id).sort();
    ok(recips.length === 1 && recips[0] === B, `only B (moved items 4/5/6) notified; A not (recipients: ${recips.join(',')})`);

    // ---------- T4: re-apply ----------
    section('T4 — Re-apply archives the old schedule (not duplicated)');
    const rRe = await request(app).post(`/api/v1/schedule-templates/${tpl.id}/apply`).set(auth(goldTok))
      .send({ ...applyBody, start_date: '2026-08-03' });
    ok(rRe.status === 201, `re-apply → 201 (got ${rRe.status})`);
    const [[oldS]] = await pool.query('SELECT status FROM job_schedules WHERE id=?', [sid]);
    ok(oldS.status === 'archived', `old schedule archived (got ${oldS.status})`);
    const [[activeS]] = await pool.query("SELECT COUNT(*) c FROM job_schedules WHERE job_id=? AND status='active'", [JOB]);
    ok(activeS.c === 1, `exactly one active schedule remains (got ${activeS.c})`);
    const [[oldTasksArch]] = await pool.query('SELECT COUNT(*) c FROM tasks WHERE id IN (?) AND archived_at IS NOT NULL', [jsItems.map((i) => i.task_id)]);
    ok(oldTasksArch.c === 42, `all 42 old tasks archived (got ${oldTasksArch.c})`);
    const [[oldStagesDel]] = await pool.query('SELECT COUNT(*) c FROM stages WHERE id IN (?) AND status=0', [jsItems.map((i) => i.stage_id)]);
    ok(oldStagesDel.c === 42, `all 42 old stages soft-deleted (got ${oldStagesDel.c})`);
    const [[totalActiveTasks]] = await pool.query('SELECT COUNT(*) c FROM tasks WHERE job_id=? AND archived_at IS NULL', [JOB]);
    ok(totalActiveTasks.c === 42, `still 42 active tasks (fresh set, not 84) (got ${totalActiveTasks.c})`);

    // ---------- T5: cycle rejected ----------
    section('T5 — Dependency cycle rejected at the API/DB apply path');
    const rNew = await request(app).post('/api/v1/schedule-templates').set(auth(goldTok)).send({ name: 'Cycle Test' });
    const cyId = rNew.body.data.template.id;
    const rI1 = await request(app).post(`/api/v1/schedule-templates/${cyId}/items`).set(auth(goldTok)).send({ name: 'A' });
    const rI2 = await request(app).post(`/api/v1/schedule-templates/${cyId}/items`).set(auth(goldTok)).send({ name: 'B' });
    const iA = rI1.body.data.id, iB = rI2.body.data.id;
    const rDep1 = await request(app).post(`/api/v1/schedule-templates/${cyId}/items/${iB}/deps`).set(auth(goldTok)).send({ depends_on_item_id: iA });
    ok(rDep1.status === 201, `B depends on A added (got ${rDep1.status})`);
    const rDep2 = await request(app).post(`/api/v1/schedule-templates/${cyId}/items/${iA}/deps`).set(auth(goldTok)).send({ depends_on_item_id: iB });
    ok(rDep2.status === 409 && rDep2.body.code === 'CYCLE', `A depends on B (cycle) → 409 CYCLE at dep-add (got ${rDep2.status} ${rDep2.body.code || ''})`);
    await pool.query('INSERT INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?,?)', [iA, iB]);
    const rApplyCycle = await request(app).post(`/api/v1/schedule-templates/${cyId}/apply`).set(auth(goldTok))
      .send({ job_id: JOB, owner_type: 'job', start_date: '2026-07-08', assignments: [] });
    ok(rApplyCycle.status === 409 && rApplyCycle.body.code === 'CYCLE', `apply of cyclic template → 409 CYCLE, not silently computed (got ${rApplyCycle.status} ${rApplyCycle.body.code || ''})`);

    console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
  } catch (e) {
    console.error('\nFATAL', e);
    fail++;
  } finally {
    try { await pool.end(); } catch (_) {}
    try { await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
