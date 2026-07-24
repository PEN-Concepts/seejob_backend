/* Schedule Builder HOLD state — cascade service layer.
 *   - apply ON HOLD  → status 'on_hold', NULL start_date, items but NO computed
 *     dates and NO tasks/stages pushed to the Master Calendar.
 *   - startHeldSchedule → sets the date, cascades through the dependency chain,
 *     creates the calendar tasks/stages (the deferred push).
 *   - apply WITH a start date is unchanged (active + tasks up front).
 * Real MySQL (mysql-memory-server), cascade functions exercised directly.
 * Run: NODE_PATH=<backend>/node_modules node test/scheduleHold.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
process.env.TZ = 'America/Los_Angeles';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const ymd = (v) => (v == null ? null : String(v).slice(0, 10));

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_hold_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const { ensureScheduleTemplateTables } = require('../services/dbMigrations');
    const cascade = require('../services/scheduleCascade');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(190), created_by INT) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(190)) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE tasks (id INT AUTO_INCREMENT PRIMARY KEY, task_name VARCHAR(255), user_id INT NULL, team_id INT NULL,
      duration_days INT DEFAULT 1, start_date DATETIME NULL, end_date DATETIME NULL, description TEXT NULL, job_id INT NULL,
      created_at DATETIME NULL, created_by INT NULL, task_type VARCHAR(20) DEFAULT 'job', is_calendar_task INT DEFAULT 0,
      is_appointment_task INT DEFAULT 0, priority VARCHAR(20) DEFAULT 'low', status INT DEFAULT 0) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE stages (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, name VARCHAR(255), csi_code VARCHAR(150) NULL,
      job_id INT, owner_type VARCHAR(8) DEFAULT 'job', status INT DEFAULT 1, progress_status INT DEFAULT 0, created_at DATETIME NULL, updated_at DATETIME NULL) ENGINE=InnoDB`);
    await ensureScheduleTemplateTables(conn);
    await conn.query("INSERT INTO job (id, name, created_by) VALUES (500,'Adams Res',100),(501,'Beta Job',100)");

    // Seed a 4-trade template in a dependency chain 1←2←3←4 (durations 3,5,4,2).
    const [tpl] = await conn.query("INSERT INTO schedule_templates (name, account_owner_id, status) VALUES ('New Home', 100, 'active')");
    const templateId = tpl.insertId;
    const ti = [];
    for (const [name, dur, so] of [['Site Prep', 3, 1], ['Foundation', 5, 2], ['Framing', 4, 3], ['Final Inspection', 2, 4]]) {
      const [r] = await conn.query('INSERT INTO schedule_template_items (template_id, name, default_duration_days, sort_order) VALUES (?, ?, ?, ?)', [templateId, name, dur, so]);
      ti.push(r.insertId);
    }
    for (let i = 1; i < ti.length; i++) {
      await conn.query('INSERT INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?, ?)', [ti[i], ti[i - 1]]);
    }
    const jobTaskCount = async (jobId) => Number((await conn.query('SELECT COUNT(*) c FROM tasks WHERE job_id = ? AND is_calendar_task = 1', [jobId]))[0][0].c);
    const jobStageCount = async (jobId) => Number((await conn.query('SELECT COUNT(*) c FROM stages WHERE job_id = ?', [jobId]))[0][0].c);

    // ── 1) APPLY ON HOLD ──
    const held = await cascade.applyTemplateToJob(conn, { templateId, jobId: 500, ownerType: 'job', startDate: null, onHold: true, actorId: 100 });
    const sid = held.scheduleId;
    const [[js]] = await conn.query('SELECT status, start_date FROM job_schedules WHERE id = ?', [sid]);
    ok(js.status === 'on_hold', 'hold: schedule status is on_hold', js.status);
    ok(js.start_date == null, 'hold: start_date is NULL', String(js.start_date));
    const [hitems] = await conn.query('SELECT computed_start_date, task_id, stage_id FROM job_schedule_items WHERE schedule_id = ?', [sid]);
    ok(hitems.length === 4, 'hold: 4 items created', String(hitems.length));
    ok(hitems.every((i) => i.computed_start_date == null), 'hold: no computed dates', JSON.stringify(hitems.map((i) => i.computed_start_date)));
    ok(hitems.every((i) => i.task_id == null && i.stage_id == null), 'hold: no task/stage linkage', 'some linked');
    ok((await jobTaskCount(500)) === 0, 'hold: ZERO tasks pushed to the calendar', String(await jobTaskCount(500)));
    ok((await jobStageCount(500)) === 0, 'hold: ZERO stages created', String(await jobStageCount(500)));
    ok(held.notifPayloads.length === 0, 'hold: no notifications sent', String(held.notifPayloads.length));

    // ── 2) held schedule is visible to the active/on_hold query ──
    const [[vis]] = await conn.query("SELECT id FROM job_schedules WHERE job_id = 500 AND owner_type = 'job' AND status IN ('active','on_hold') ORDER BY id DESC LIMIT 1");
    ok(vis && vis.id === sid, 'hold: held schedule is returned by the GET query', JSON.stringify(vis));

    // ── 3) TAKE OFF HOLD — set start date → cascade + push ──
    await cascade.startHeldSchedule(conn, sid, { startDate: '2026-07-27', actorId: 100 });
    const [[js2]] = await conn.query('SELECT status, start_date FROM job_schedules WHERE id = ?', [sid]);
    ok(js2.status === 'active', 'start: status is now active', js2.status);
    ok(ymd(js2.start_date) === '2026-07-27', 'start: start_date persisted', ymd(js2.start_date));
    const [ditems] = await conn.query('SELECT name, sort_order, computed_start_date, computed_end_date, task_id, stage_id FROM job_schedule_items WHERE schedule_id = ? ORDER BY sort_order', [sid]);
    ok(ditems.every((i) => i.computed_start_date != null), 'start: all items have computed dates', 'some null');
    ok(ymd(ditems[0].computed_start_date) === '2026-07-27', 'start: first trade starts on the start date', ymd(ditems[0].computed_start_date));
    // Cascade: each trade starts strictly after the previous one ends.
    let cascadeOk = true;
    for (let i = 1; i < ditems.length; i++) {
      if (!(ymd(ditems[i].computed_start_date) > ymd(ditems[i - 1].computed_end_date))) cascadeOk = false;
    }
    ok(cascadeOk, 'start: dates cascade down the dependency chain (each starts after its dep ends)', JSON.stringify(ditems.map((i) => [ymd(i.computed_start_date), ymd(i.computed_end_date)])));
    ok(ditems.every((i) => i.task_id != null && i.stage_id != null), 'start: every item now linked to a task + stage', 'some unlinked');
    ok((await jobTaskCount(500)) === 4, 'start: 4 tasks pushed to the Master Calendar', String(await jobTaskCount(500)));
    ok((await jobStageCount(500)) === 4, 'start: 4 stages created', String(await jobStageCount(500)));

    // ── 4) APPLY WITH A START DATE (existing behavior unchanged) ──
    const active = await cascade.applyTemplateToJob(conn, { templateId, jobId: 501, ownerType: 'job', startDate: '2026-08-03', actorId: 100 });
    const [[js3]] = await conn.query('SELECT status, start_date FROM job_schedules WHERE id = ?', [active.scheduleId]);
    ok(js3.status === 'active' && ymd(js3.start_date) === '2026-08-03', 'apply-with-date: active + start date set immediately', JSON.stringify(js3));
    ok((await jobTaskCount(501)) === 4, 'apply-with-date: tasks pushed up front (unchanged behavior)', String(await jobTaskCount(501)));
    const [aitems] = await conn.query('SELECT computed_start_date FROM job_schedule_items WHERE schedule_id = ?', [active.scheduleId]);
    ok(aitems.every((i) => i.computed_start_date != null), 'apply-with-date: items have computed dates immediately', 'some null');

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
