/* Add a NEW trade to an active schedule from the combined Gantt page's add-row:
 * name + days + depends-on[] + assign-to. Mirrors POST /job-schedules/:sid/items:
 * insert item (with assignee) + deps[] → recompute → materialize a linked calendar
 * task (carrying the assignee). Verifies the new trade lands AFTER its deps, becomes
 * a real linked calendar task with the chosen assignee, and multi-dep placement uses
 * the latest dependency. Real MySQL.
 * Run: NODE_PATH=<backend>/node_modules node test/scheduleAddTrade.test.js
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
    db = await createDB({ dbName: 'seejob_addtrade_test', logLevel: 'ERROR' });
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
      is_appointment_task INT DEFAULT 0, priority VARCHAR(20) DEFAULT 'low', status INT DEFAULT 0, archived_at DATETIME NULL) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE stages (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, name VARCHAR(255), csi_code VARCHAR(150) NULL, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', status INT DEFAULT 1, progress_status INT DEFAULT 0, created_at DATETIME NULL, updated_at DATETIME NULL) ENGINE=InnoDB`);
    await ensureScheduleTemplateTables(conn);
    await conn.query("INSERT INTO job (id, name, created_by) VALUES (700,'Adams Res',100)");
    const [tpl] = await conn.query("INSERT INTO schedule_templates (name, account_owner_id, status) VALUES ('Home', 100, 'active')");
    const templateId = tpl.insertId; const map = {};
    for (const [name, dur, so] of [['A Site Prep', 3, 1], ['B Foundation', 5, 2], ['C Framing', 4, 3]]) {
      const [r] = await conn.query('INSERT INTO schedule_template_items (template_id, name, default_duration_days, sort_order) VALUES (?, ?, ?, ?)', [templateId, name, dur, so]); map[name[0]] = r.insertId;
    }
    await conn.query('INSERT INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?, ?)', [map.B, map.A]);
    await conn.query('INSERT INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?, ?)', [map.C, map.B]);
    const applied = await cascade.applyTemplateToJob(conn, { templateId, jobId: 700, ownerType: 'job', startDate: '2026-07-27', actorId: 100 });
    const sid = applied.scheduleId;
    const itemByName = async (n) => (await conn.query('SELECT * FROM job_schedule_items WHERE schedule_id=? AND name LIKE ? LIMIT 1', [sid, n + '%']))[0][0];
    const liveTasks = async () => Number((await conn.query('SELECT COUNT(*) c FROM tasks WHERE job_id=700 AND is_calendar_task=1 AND archived_at IS NULL', []))[0][0].c);

    // Mirror POST /:sid/items: insert item (+assignee) + deps[] → recompute → task.
    async function addTrade({ name, dur, deps = [], assignee = null }) {
      await conn.beginTransaction();
      try {
        const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order),0)+1 so FROM job_schedule_items WHERE schedule_id=?', [sid]);
        const [ins] = await conn.query('INSERT INTO job_schedule_items (schedule_id,name,duration_days,sort_order,assignee_user_id,depends_on_all,is_inspection) VALUES (?,?,?,?,?,0,0)', [sid, name, dur, mx.so, assignee]);
        const iid = ins.insertId;
        const [validRows] = await conn.query('SELECT id FROM job_schedule_items WHERE schedule_id=?', [sid]);
        const valid = new Set(validRows.map((r) => Number(r.id)));
        for (const d of deps.map(Number).filter((x) => valid.has(x) && x !== iid)) {
          await conn.query('INSERT IGNORE INTO job_schedule_deps (schedule_id,item_id,depends_on_item_id) VALUES (?,?,?)', [sid, iid, d]);
        }
        await cascade.recomputeSchedule(conn, sid, { changedItemId: iid });
        const [[it]] = await conn.query('SELECT * FROM job_schedule_items WHERE id=?', [iid]);
        const st = it.computed_start_date ? `${ymd(it.computed_start_date)} 00:00:00` : null;
        const en = it.computed_end_date ? `${ymd(it.computed_end_date)} 00:00:00` : null;
        const [tR] = await conn.query('INSERT INTO tasks (task_name,user_id,duration_days,start_date,end_date,job_id,created_at,created_by,task_type,is_calendar_task,is_appointment_task,priority) VALUES (?,?,?,?,?,?,NOW(),100,?,1,0,?)', [it.name, it.assignee_user_id || null, it.duration_days, st, en, 700, 'job', 'low']);
        await conn.query('UPDATE job_schedule_items SET task_id=? WHERE id=?', [tR.insertId, iid]);
        await conn.commit();
        return iid;
      } catch (e) { await conn.rollback(); throw e; }
    }

    ok((await liveTasks()) === 3, 'setup: 3 trades/tasks (A→B→C)', String(await liveTasks()));
    const A = await itemByName('A'), B = await itemByName('B');

    // Add D depends on A, assigned to user 55.
    const dId = await addTrade({ name: 'D Rough-in', dur: 8, deps: [A.id], assignee: 55 });
    const D = await itemByName('D');
    ok(ymd(D.computed_start_date) > ymd(A.computed_end_date), 'add: D starts after its dependency A finishes', ymd(D.computed_start_date) + ' vs A end ' + ymd(A.computed_end_date));
    ok(D.task_id != null, 'add: D became a real linked calendar task', String(D.task_id));
    const [[dTask]] = await conn.query('SELECT is_calendar_task, user_id FROM tasks WHERE id=?', [D.task_id]);
    ok(dTask && Number(dTask.is_calendar_task) === 1 && Number(dTask.user_id) === 55, 'add: D task is a calendar task carrying the chosen assignee', JSON.stringify(dTask));
    ok((await liveTasks()) === 4, 'add: 4 live calendar tasks now', String(await liveTasks()));

    // Add E depending on BOTH A and B → must start after the LATER one (B).
    await addTrade({ name: 'E Utilities', dur: 2, deps: [A.id, B.id], assignee: null });
    const E = await itemByName('E');
    ok(ymd(E.computed_start_date) > ymd(B.computed_end_date), 'multi-dep: E starts after the LATER dependency (B) finishes', ymd(E.computed_start_date) + ' vs B end ' + ymd(B.computed_end_date));
    const [[eDep]] = await conn.query('SELECT COUNT(*) c FROM job_schedule_deps WHERE item_id=?', [E.id]);
    ok(Number(eDep.c) === 2, 'multi-dep: E has both dependency edges recorded', String(eDep.c));
    ok((await liveTasks()) === 5, 'multi-dep: 5 live calendar tasks now', String(await liveTasks()));

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
