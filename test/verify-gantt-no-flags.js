/* No-conflict-flags + always-cascade. Seeds a flagged item (Framing pinned 8/27,
 * still deps OWI, has_conflict=1) and drives an UNRELATED edit — recompute must now
 * (a) clear the flag (has_conflict=0, no red ever) and (b) keep every task synced to
 * its computed date. Also proves a genuine "bust" no longer flags. Run from worktree.
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };
(async () => {
  let db, pool, conn, server;
  try {
    process.env.NODE_ENV = 'test'; process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_noflag', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV='127.0.0.1'; process.env.DB_PORT_DEV=String(db.port); process.env.DB_USER_DEV=db.username||'root'; process.env.DB_PASSWORD_DEV=''; process.env.DB_NAME_DEV=db.dbName;
    pool = require('../config/connection'); conn = await pool.getConnection();
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), created_by INT NULL, category INT NULL, role INT NULL)");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120), created_by INT NULL)");
    await conn.query(`CREATE TABLE job_schedules (id INT PRIMARY KEY, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', name VARCHAR(120) NULL, start_date DATE NULL, skip_saturday TINYINT DEFAULT 0, skip_sunday TINYINT DEFAULT 0, status VARCHAR(16) DEFAULT 'active', created_by INT NULL, updated_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE job_schedule_items (id INT PRIMARY KEY, schedule_id INT, name VARCHAR(160), duration_days INT, sort_order INT, depends_on_all TINYINT DEFAULT 0, is_start TINYINT DEFAULT 0, pinned_start_date DATE NULL, computed_start_date DATE NULL, computed_end_date DATE NULL, has_conflict TINYINT DEFAULT 0, conflict_reason TEXT NULL, task_id INT NULL, stage_id INT NULL, assignee_user_id INT NULL, template_item_id INT NULL, is_inspection TINYINT DEFAULT 0)`);
    await conn.query("CREATE TABLE job_schedule_deps (id INT PRIMARY KEY, schedule_id INT, item_id INT, depends_on_item_id INT, UNIQUE KEY u (schedule_id,item_id,depends_on_item_id))");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY, start_date DATETIME NULL, end_date DATETIME NULL, duration_days INT NULL, archived_at DATETIME NULL)");
    await conn.query("CREATE TABLE stages (id INT PRIMARY KEY, name VARCHAR(160), status TINYINT DEFAULT 1, updated_at DATETIME NULL)");
    await conn.query("INSERT INTO `user`(id,name,created_by,category,role) VALUES (74,'Poul',NULL,2,14)");
    await conn.query("INSERT INTO job(id,name,created_by) VALUES (224,'Samuel - DECK',74)");
    await conn.query("INSERT INTO job_schedules(id,job_id,owner_type,name,start_date,skip_saturday,skip_sunday,status,created_by) VALUES (6,224,'job','deck','2026-08-24',1,1,'active',74)");
    const items = [
      [211,'Door ordered',1,1,null,'2026-08-24','2026-08-24',0,1708],
      [213,'Demolition',2,2,'2026-08-25','2026-08-25','2026-08-26',0,1710],
      [212,'Order Wrought Iron',15,3,null,'2026-08-24','2026-09-11',0,1709],
      [214,'Framing changes',3,4,'2026-08-27','2026-08-27','2026-08-31',1,1711], // pinned + FLAGGED
      [216,'Fix drywall',4,5,null,'2026-09-18','2026-09-23',0,1713],
    ];
    for (const [id,name,dur,so,pin,cs,ce,hc,tid] of items) {
      await conn.query('INSERT INTO job_schedule_items(id,schedule_id,name,duration_days,sort_order,pinned_start_date,computed_start_date,computed_end_date,has_conflict,task_id) VALUES (?,?,?,?,?,?,?,?,?,?)', [id,6,name,dur,so,pin,cs,ce,hc,tid]);
      // seed the task with a STALE date to prove "always sync" corrects it
      await conn.query('INSERT INTO tasks(id,start_date,end_date,duration_days) VALUES (?,?,?,?)', [tid, '2026-01-01 00:00:00', '2026-01-01 00:00:00', dur]);
    }
    for (const [id,it,dep] of [[230,213,211],[232,214,211],[233,214,213],[234,214,212],[240,216,211]]) await conn.query('INSERT INTO job_schedule_deps(id,schedule_id,item_id,depends_on_item_id) VALUES (?,?,?,?)', [id,6,it,dep]);
    require('../services/authentication').authenticateToken = (req,_res,next)=>{ req.user={id:74,role:14,category:2,working_id:74}; next(); };
    const access = require('../utils/access'); access.requirePlan=()=>(_q,_s,n)=>n(); access.denyRestrictedJobData=(_q,_s,n)=>n(); access.isSameAccount=()=>true;
    require('../services/notify').dispatchScheduleNotification=async()=>{};
    require('../services/dbMigrations').ensureScheduleTemplateTables=async()=>{};
    const express=require('express'); const request=require('supertest');
    const app=express(); app.use(express.json()); app.use('/job-schedules', require('../routes/jobSchedules')); server=app.listen(0);
    const val = async (id,col) => (await conn.query(`SELECT ${col} v FROM job_schedule_items WHERE id=?`,[id]))[0][0].v;
    const taskStart = async (id) => (await conn.query('SELECT DATE(start_date) v FROM tasks WHERE id=?',[id]))[0][0].v;
    const ymd = (d)=> d? new Date(d).toISOString().slice(0,10) : null;

    ok(Number(await val(214,'has_conflict'))===1, 'setup: Framing seeded has_conflict=1');
    // UNRELATED edit that leaves Framing pinned+depending on OWI (would have flagged before)
    const res = await request(server).put('/job-schedules/6/items/216').send({ duration_days: 9 });
    ok(res.status===200, `A: edit succeeds (got ${res.status})`);
    ok(Number(await val(214,'has_conflict'))===0, `B: Framing has_conflict now 0 — NO red flag (even though still pinned + depends on OWI)`);
    ok((await val(214,'conflict_reason'))===null, 'C: conflict_reason cleared');
    // always-cascade: every task synced to its computed date (was seeded 2026-01-01)
    ok(ymd(await taskStart(1711))==='2026-08-27', `D: Framing task force-synced to computed 2026-08-27 (was stale, got ${ymd(await taskStart(1711))})`);
    ok(ymd(await taskStart(1709))==='2026-08-24', `E: OWI task force-synced to 2026-08-24 (got ${ymd(await taskStart(1709))})`);
    ok(ymd(await taskStart(1713))!=='2026-01-01', `F: Fix-drywall task synced off its stale date (got ${ymd(await taskStart(1713))})`);

    console.log(`\n${fail===0?'PASS ✅ no flags + always cascade':'FAIL ❌'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail===0?0:1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally { try{if(server)server.close();}catch{} try{if(conn)conn.release();}catch{} try{if(pool&&pool.end)await pool.end();}catch{} try{if(db&&db.stop)await db.stop();}catch{} }
})();
