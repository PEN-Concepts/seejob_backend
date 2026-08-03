/* Editing an ALREADY-APPLIED schedule: change its start date (re-cascade onto
 * the SAME calendar tasks), put an active schedule back ON HOLD (pull tasks off
 * the calendar, keep the plan), and re-start a held schedule.
 * Real MySQL. Run: NODE_PATH=<backend>/node_modules node test/scheduleHoldEdit.test.js
 */
'use strict';
process.env.TZ = 'America/Los_Angeles';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const ymd = (v) => (v == null ? null : String(v).slice(0, 10));

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_holdedit_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1'; process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root'; process.env.DB_PASSWORD_DEV = ''; process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const { ensureScheduleTemplateTables } = require('../services/dbMigrations');
    const cascade = require('../services/scheduleCascade');
    conn = await pool.getConnection();
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(190), created_by INT) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(190)) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE tasks (id INT AUTO_INCREMENT PRIMARY KEY, task_name VARCHAR(255), user_id INT NULL, team_id INT NULL,
      duration_days INT DEFAULT 1, start_date DATETIME NULL, end_date DATETIME NULL, description TEXT NULL, job_id INT NULL,
      created_at DATETIME NULL, created_by INT NULL, task_type VARCHAR(20) DEFAULT 'job', is_calendar_task INT DEFAULT 0,
      is_appointment_task INT DEFAULT 0, priority VARCHAR(20) DEFAULT 'low', status INT DEFAULT 0, status_note VARCHAR(255) NULL, archived_at DATETIME NULL) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE stages (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, name VARCHAR(255), csi_code VARCHAR(150) NULL,
      job_id INT, owner_type VARCHAR(8) DEFAULT 'job', status INT DEFAULT 1, progress_status INT DEFAULT 0, created_at DATETIME NULL, updated_at DATETIME NULL) ENGINE=InnoDB`);
    await ensureScheduleTemplateTables(conn);
    await conn.query("INSERT INTO job (id, name, created_by) VALUES (600,'Adams Res',100)");
    const [tpl] = await conn.query("INSERT INTO schedule_templates (name, account_owner_id, status) VALUES ('Home', 100, 'active')");
    const templateId = tpl.insertId; const ti = [];
    for (const [name, dur, so] of [['Site Prep', 3, 1], ['Foundation', 5, 2], ['Framing', 4, 3]]) {
      const [r] = await conn.query('INSERT INTO schedule_template_items (template_id, name, default_duration_days, sort_order) VALUES (?, ?, ?, ?)', [templateId, name, dur, so]); ti.push(r.insertId);
    }
    for (let i = 1; i < ti.length; i++) await conn.query('INSERT INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?, ?)', [ti[i], ti[i - 1]]);

    const liveTasks = async () => Number((await conn.query('SELECT COUNT(*) c FROM tasks WHERE job_id=600 AND is_calendar_task=1 AND archived_at IS NULL', []))[0][0].c);
    const archivedTasks = async () => Number((await conn.query('SELECT COUNT(*) c FROM tasks WHERE job_id=600 AND archived_at IS NOT NULL', []))[0][0].c);

    // Apply WITH a start date → active, 3 live tasks.
    const applied = await cascade.applyTemplateToJob(conn, { templateId, jobId: 600, ownerType: 'job', startDate: '2026-07-27', actorId: 100 });
    const sid = applied.scheduleId;
    ok((await liveTasks()) === 3, 'setup: 3 live calendar tasks after apply', String(await liveTasks()));
    const [firstTasks] = await conn.query('SELECT task_id FROM job_schedule_items WHERE schedule_id=? ORDER BY sort_order', [sid]);
    const taskIdsBefore = firstTasks.map((r) => r.task_id).join(',');
    const [[t0]] = await conn.query('SELECT start_date FROM tasks WHERE id=?', [firstTasks[0].task_id]);

    // ── CHANGE START DATE on the active schedule (re-cascade onto SAME tasks) ──
    await cascade.startHeldSchedule(conn, sid, { startDate: '2026-09-01', actorId: 100 });
    ok((await liveTasks()) === 3, 'date-change: still 3 live tasks (no new ones created)', String(await liveTasks()));
    const [afterTasks] = await conn.query('SELECT task_id FROM job_schedule_items WHERE schedule_id=? ORDER BY sort_order', [sid]);
    ok(afterTasks.map((r) => r.task_id).join(',') === taskIdsBefore, 'date-change: same task ids reused (updated, not recreated)', afterTasks.map((r) => r.task_id).join(','));
    const [[items1]] = await conn.query('SELECT computed_start_date FROM job_schedule_items WHERE schedule_id=? ORDER BY sort_order LIMIT 1', [sid]);
    ok(ymd(items1.computed_start_date) === '2026-09-01', 'date-change: first item re-cascaded to the new start date', ymd(items1.computed_start_date));
    const [[t1]] = await conn.query('SELECT start_date FROM tasks WHERE id=?', [firstTasks[0].task_id]);
    ok(ymd(t1.start_date) === '2026-09-01' && ymd(t1.start_date) !== ymd(t0.start_date), 'date-change: the linked task date moved', ymd(t1.start_date));

    // ── PUT the active schedule ON HOLD (pull off the calendar) ──
    await cascade.holdSchedule(conn, sid);
    const [[js]] = await conn.query('SELECT status, start_date FROM job_schedules WHERE id=?', [sid]);
    ok(js.status === 'on_hold' && js.start_date == null, 'hold: status on_hold + start_date NULL', JSON.stringify(js));
    const [held] = await conn.query('SELECT computed_start_date, task_id, stage_id FROM job_schedule_items WHERE schedule_id=?', [sid]);
    ok(held.every((i) => i.computed_start_date == null && i.task_id == null && i.stage_id == null), 'hold: items cleared (no dates, unlinked)', 'some remain');
    ok((await liveTasks()) === 0, 'hold: ZERO live calendar tasks (pulled off)', String(await liveTasks()));
    ok((await archivedTasks()) === 3, 'hold: the 3 tasks are archived (not deleted)', String(await archivedTasks()));

    // ── on_hold must NEVER notify a sub — even an edit that recomputes item dates ──
    await conn.query('UPDATE job_schedule_items SET assignee_user_id = 101 WHERE schedule_id = ?', [sid]);
    const holdEditPayloads = await cascade.recomputeSchedule(conn, sid, {});
    ok(Array.isArray(holdEditPayloads) && holdEditPayloads.length === 0,
      'on_hold edit: recomputeSchedule dispatches ZERO notifications (assigned sub never notified for a held plan)', JSON.stringify(holdEditPayloads));

    // ── RE-START the held schedule → active again, fresh tasks ──
    await cascade.startHeldSchedule(conn, sid, { startDate: '2026-10-05', actorId: 100 });
    const [[js2]] = await conn.query('SELECT status, start_date FROM job_schedules WHERE id=?', [sid]);
    ok(js2.status === 'active' && ymd(js2.start_date) === '2026-10-05', 're-start: active + new start date', JSON.stringify(js2));
    ok((await liveTasks()) === 3, 're-start: 3 live calendar tasks again', String(await liveTasks()));
    const [[items2]] = await conn.query('SELECT computed_start_date FROM job_schedule_items WHERE schedule_id=? ORDER BY sort_order LIMIT 1', [sid]);
    ok(ymd(items2.computed_start_date) === '2026-10-05', 're-start: cascaded from the new date', ymd(items2.computed_start_date));

    // Contrast: an ACTIVE schedule DOES notify on a date-moving edit (the gate is
    // status-specific, not a blanket off). Bump the first item's duration → downstream shifts.
    const [[firstIt]] = await conn.query('SELECT id FROM job_schedule_items WHERE schedule_id=? ORDER BY sort_order LIMIT 1', [sid]);
    await conn.query('UPDATE job_schedule_items SET duration_days = duration_days + 2 WHERE id = ?', [firstIt.id]);
    const activeEditPayloads = await cascade.recomputeSchedule(conn, sid, { changedItemId: firstIt.id });
    ok(Array.isArray(activeEditPayloads) && activeEditPayloads.length > 0,
      'active edit: recomputeSchedule DOES dispatch (assigned sub notified on a real active schedule)', String((activeEditPayloads || []).length));

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
