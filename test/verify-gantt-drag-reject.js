/* Calendar-drag validation: a drag that moves an item BEFORE its own dependencies
 * finish is rejected (calendar snaps back) via rejectBustFor; a Gantt edit (no
 * rejectBustFor) never blocks and just cascades; a valid drag is allowed. Calls
 * recomputeSchedule directly. Run from worktree: node test/verify-gantt-drag-reject.js
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };
(async () => {
  let db, pool, conn;
  try {
    process.env.NODE_ENV = 'test'; process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_drag', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV='127.0.0.1'; process.env.DB_PORT_DEV=String(db.port); process.env.DB_USER_DEV=db.username||'root'; process.env.DB_PASSWORD_DEV=''; process.env.DB_NAME_DEV=db.dbName;
    pool = require('../config/connection'); conn = await pool.getConnection();
    require('../services/notify').dispatchScheduleNotification=async()=>{};
    const { recomputeSchedule } = require('../services/scheduleCascade');

    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120))");
    await conn.query(`CREATE TABLE job_schedules (id INT PRIMARY KEY, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', start_date DATE, skip_saturday TINYINT, skip_sunday TINYINT, status VARCHAR(16) DEFAULT 'active')`);
    await conn.query(`CREATE TABLE job_schedule_items (id INT PRIMARY KEY, schedule_id INT, name VARCHAR(160), duration_days INT, sort_order INT, depends_on_all TINYINT DEFAULT 0, is_start TINYINT DEFAULT 0, pinned_start_date DATE NULL, computed_start_date DATE NULL, computed_end_date DATE NULL, has_conflict TINYINT DEFAULT 0, conflict_reason TEXT NULL, task_id INT NULL, stage_id INT NULL, assignee_user_id INT NULL)`);
    await conn.query("CREATE TABLE job_schedule_deps (id INT PRIMARY KEY, schedule_id INT, item_id INT, depends_on_item_id INT)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY, start_date DATETIME NULL, end_date DATETIME NULL, duration_days INT NULL, archived_at DATETIME NULL)");
    await conn.query("INSERT INTO job(id,name) VALUES (224,'Samuel - DECK')");
    await conn.query("INSERT INTO job_schedules(id,job_id,owner_type,start_date,skip_saturday,skip_sunday,status) VALUES (6,224,'job','2026-08-24',1,1,'active')");
    // Demolition (213) ends 8/26; Framing (214) depends on it.
    await conn.query("INSERT INTO job_schedule_items(id,schedule_id,name,duration_days,sort_order,pinned_start_date,task_id) VALUES (213,6,'Demolition',2,1,'2026-08-25',1710),(214,6,'Framing changes',3,2,NULL,1711)");
    await conn.query("INSERT INTO job_schedule_deps(id,schedule_id,item_id,depends_on_item_id) VALUES (233,6,214,213)");
    await conn.query("INSERT INTO tasks(id,start_date,end_date,duration_days) VALUES (1710,'2026-08-25','2026-08-26',2),(1711,'2026-09-01','2026-09-03',3)");

    const setPin = (d) => conn.query('UPDATE job_schedule_items SET pinned_start_date=? WHERE id=214',[d]);
    const hc = async () => (await conn.query('SELECT has_conflict FROM job_schedule_items WHERE id=214'))[0][0].has_conflict;
    const threw = async (opts) => { try { await recomputeSchedule(conn, 6, opts); return false; } catch (e) { return e.code || true; } };

    // A — DRAG to an INVALID date (Aug 20, before Demolition ends 8/26): reject.
    await setPin('2026-08-20');
    ok((await threw({ changedItemId:214, rejectBustFor:214 })) === 'SCHEDULE_CONFLICT', 'A: drag Framing to Aug 20 (before its dep finishes) → REJECTED (calendar snaps back)');

    // B — same invalid state, but a GANTT edit (no rejectBustFor) must NOT block.
    const gantt = await threw({ changedItemId:214 });
    ok(gantt === false, 'B: a Gantt edit does NOT block on the same bust (no rejectBustFor)');
    ok(Number(await hc()) === 0, 'B: and it still writes no conflict flag (has_conflict=0)');

    // C — DRAG to a VALID date (Aug 27, after Demolition): allowed.
    await setPin('2026-08-27');
    ok((await threw({ changedItemId:214, rejectBustFor:214 })) === false, 'C: drag Framing to Aug 27 (valid) → ALLOWED, cascades');

    console.log(`\n${fail===0?'PASS ✅':'FAIL ❌'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail===0?0:1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally { try{if(conn)conn.release();}catch{} try{if(pool&&pool.end)await pool.end();}catch{} try{if(db&&db.stop)await db.stop();}catch{} }
})();
