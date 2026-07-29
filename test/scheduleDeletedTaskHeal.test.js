/* Self-heal: if a schedule item's linked calendar task was DELETED (hard delete)
 * or archived, re-dating / re-starting the schedule must RECREATE the calendar
 * task instead of silently updating nothing. This reproduces the "Lynes" bug:
 * items linked to task_ids that no longer exist → nothing on the Master Calendar.
 * Real MySQL. Run: NODE_PATH=<backend>/node_modules node test/scheduleDeletedTaskHeal.test.js
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
    db = await createDB({ dbName: 'seejob_delheal_test', logLevel: 'ERROR' });
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
    await conn.query("INSERT INTO job (id, name, created_by) VALUES (700,'Lynes ADU',100)");
    const [tpl] = await conn.query("INSERT INTO schedule_templates (name, account_owner_id, status) VALUES ('Home', 100, 'active')");
    const templateId = tpl.insertId; const ti = [];
    for (const [name, dur, so] of [['Site Prep', 3, 1], ['Foundation', 5, 2], ['Framing', 4, 3]]) {
      const [r] = await conn.query('INSERT INTO schedule_template_items (template_id, name, default_duration_days, sort_order) VALUES (?, ?, ?, ?)', [templateId, name, dur, so]); ti.push(r.insertId);
    }
    for (let i = 1; i < ti.length; i++) await conn.query('INSERT INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?, ?)', [ti[i], ti[i - 1]]);

    const liveTasks = async () => Number((await conn.query('SELECT COUNT(*) c FROM tasks WHERE job_id=700 AND is_calendar_task=1 AND archived_at IS NULL', []))[0][0].c);

    // Apply WITH a start date → active, 3 live calendar tasks.
    const applied = await cascade.applyTemplateToJob(conn, { templateId, jobId: 700, ownerType: 'job', startDate: '2026-07-29', actorId: 100 });
    const sid = applied.scheduleId;
    ok((await liveTasks()) === 3, 'setup: 3 live calendar tasks after apply', String(await liveTasks()));
    const [itemsA] = await conn.query('SELECT id, task_id FROM job_schedule_items WHERE schedule_id=? ORDER BY sort_order', [sid]);
    const deletedIds = itemsA.map((r) => r.task_id);

    // ── Simulate the bug: HARD-DELETE the calendar tasks, leaving the schedule
    //    items still pointing at the now-missing task_ids (dangling links). ──
    await conn.query('DELETE FROM tasks WHERE id IN (?)', [deletedIds]);
    ok((await liveTasks()) === 0, 'repro: tasks hard-deleted → 0 live calendar tasks (dangling item links remain)', String(await liveTasks()));
    const [itemsStillLinked] = await conn.query('SELECT task_id FROM job_schedule_items WHERE schedule_id=? AND task_id IS NOT NULL', [sid]);
    ok(itemsStillLinked.length === 3, 'repro: items still carry the (now-dangling) task_ids', String(itemsStillLinked.length));

    // ── Re-date the schedule (same as "set start date / Save Changes"). With the
    //    OLD code this UPDATEs 0 rows (tasks gone) → still 0 tasks. With the FIX
    //    it recreates the calendar tasks and relinks. ──
    await cascade.startHeldSchedule(conn, sid, { startDate: '2026-08-10', actorId: 100 });
    ok((await liveTasks()) === 3, 'FIX: re-dating recreated the 3 missing calendar tasks', String(await liveTasks()));
    const [itemsB] = await conn.query('SELECT task_id, computed_start_date FROM job_schedule_items WHERE schedule_id=? ORDER BY sort_order', [sid]);
    ok(itemsB.every((r) => r.task_id && !deletedIds.includes(r.task_id)), 'FIX: items relinked to NEW task ids (not the deleted ones)', itemsB.map((r) => r.task_id).join(','));
    ok(ymd(itemsB[0].computed_start_date) === '2026-08-10', 'FIX: recreated tasks cascaded from the new start date', ymd(itemsB[0].computed_start_date));
    const [newTasks] = await conn.query('SELECT is_calendar_task, task_type, job_id FROM tasks WHERE job_id=700 AND archived_at IS NULL', []);
    ok(newTasks.length === 3 && newTasks.every((t) => Number(t.is_calendar_task) === 1 && t.task_type === 'job'), 'FIX: recreated tasks are is_calendar_task=1, task_type=job, job_id=700', JSON.stringify(newTasks));

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
