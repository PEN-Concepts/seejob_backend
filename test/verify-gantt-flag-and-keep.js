/* HTTP-flow repro of the Gantt "Depends on" bug against the DEPLOYED (origin/main)
 * jobSchedules routes + cascade + engine, seeded with the ACTUAL prod graph of
 * Samuel-DECK (schedule 6). Drives the real DELETE /job-schedules/6/deps/234
 * (remove Framing changes → Order Wrought Iron) and checks persistence + recompute.
 * Run from this worktree: node repro-gantt.js
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

(async () => {
  let db, pool, conn, server;
  try {
    process.env.NODE_ENV = 'test';
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_gantt', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('./config/connection');
    conn = await pool.getConnection();

    // ---- minimal schema (only what the deployed cascade/engine/routes touch) ----
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), created_by INT NULL, category INT NULL, role INT NULL)");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120), created_by INT NULL)");
    await conn.query(`CREATE TABLE job_schedules (id INT PRIMARY KEY, job_id INT, owner_type VARCHAR(8) DEFAULT 'job',
      name VARCHAR(120) NULL, start_date DATE NULL, skip_saturday TINYINT DEFAULT 0, skip_sunday TINYINT DEFAULT 0,
      status VARCHAR(16) DEFAULT 'active', created_by INT NULL, updated_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE job_schedule_items (id INT PRIMARY KEY, schedule_id INT, name VARCHAR(160),
      duration_days INT, sort_order INT, depends_on_all TINYINT DEFAULT 0, pinned_start_date DATE NULL,
      computed_start_date DATE NULL, computed_end_date DATE NULL, has_conflict TINYINT DEFAULT 0,
      conflict_reason TEXT NULL, task_id INT NULL, stage_id INT NULL, assignee_user_id INT NULL,
      template_item_id INT NULL, is_inspection TINYINT DEFAULT 0)`);
    await conn.query("CREATE TABLE job_schedule_deps (id INT PRIMARY KEY, schedule_id INT, item_id INT, depends_on_item_id INT, UNIQUE KEY u (schedule_id,item_id,depends_on_item_id))");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY, start_date DATETIME NULL, end_date DATETIME NULL, duration_days INT NULL, archived_at DATETIME NULL)");
    await conn.query("CREATE TABLE stages (id INT PRIMARY KEY, name VARCHAR(160), status TINYINT DEFAULT 1, updated_at DATETIME NULL)");

    await conn.query("INSERT INTO `user`(id,name,created_by,category,role) VALUES (74,'Poul',NULL,2,14)");
    await conn.query("INSERT INTO job(id,name,created_by) VALUES (224,'Samuel - DECK',74)");
    await conn.query(`INSERT INTO job_schedules(id,job_id,owner_type,name,start_date,skip_saturday,skip_sunday,status,created_by)
      VALUES (6,224,'job','Samuel deck','2026-08-24',1,1,'active',74)`);

    // items (id, name, dur, sort, pinned, computed_start, computed_end, task_id) — exact prod values
    const items = [
      [211,'Door ordered',1,1,null,'2026-08-24','2026-08-24',1708],
      [213,'Demolition Stucco & Deck railing',2,2,'2026-08-25','2026-08-25','2026-08-26',1710],
      [212,'Order Wrought Iron',15,3,null,'2026-08-24','2026-09-11',1709],
      [214,'Framing changes',3,4,null,'2026-09-14','2026-09-16',1711],
      [215,'Deck flashing & coating',3,5,null,'2026-09-17','2026-09-21',1712],
      [217,'Door Installed',1,6,null,'2026-09-22','2026-09-22',1714],
      [216,'Fix drywall in house and trim and Paint',4,7,null,'2026-09-23','2026-09-28',1713],
      [218,'Stucco lath, Scratch & brown',5,8,null,'2026-09-23','2026-09-29',1715],
      [219,'Color Stucco',1,9,'2026-09-28','2026-09-28','2026-09-28',1716],
      [220,'Color deck',1,10,null,'2026-09-30','2026-09-30',1717],
      [221,'Railings Installed',1,11,null,'2026-09-30','2026-09-30',1718],
    ];
    for (const [id,name,dur,so,pin,cs,ce,tid] of items) {
      await conn.query(`INSERT INTO job_schedule_items(id,schedule_id,name,duration_days,sort_order,pinned_start_date,computed_start_date,computed_end_date,task_id) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id,6,name,dur,so,pin,cs,ce,tid]);
      await conn.query('INSERT INTO tasks(id,start_date,end_date,duration_days) VALUES (?,?,?,?)', [tid, cs+' 00:00:00', ce+' 00:00:00', dur]);
    }
    const deps = [[230,213,211],[232,214,211],[233,214,213],[234,214,212],[235,215,211],[236,215,213],[237,215,214],[238,215,212],[239,217,211],[240,217,213],[241,217,214],[242,217,215],[243,217,212],[244,218,211],[245,218,213],[246,218,214],[247,218,215],[248,218,217],[249,218,212],[250,220,211],[251,220,213],[252,220,214],[253,220,215],[254,220,217],[255,220,218],[256,220,212],[257,220,219],[258,219,211],[259,219,213],[260,219,214],[261,219,215],[262,219,217],[263,219,218],[264,219,212],[265,216,211],[266,216,213],[267,216,214],[268,216,215],[269,216,217],[270,216,212],[405,221,219],[406,221,217],[407,221,218]];
    for (const [id,it,dep] of deps) await conn.query('INSERT INTO job_schedule_deps(id,schedule_id,item_id,depends_on_item_id) VALUES (?,?,?,?)', [id,6,it,dep]);

    // ---- stub auth + access gates + notify so the real handler runs ----
    require('./services/authentication').authenticateToken = (req,_res,next)=>{ req.user={id:74,role:14,category:2,working_id:74}; next(); };
    const access = require('./utils/access');
    access.requirePlan = () => (_req,_res,next)=>next();
    access.denyRestrictedJobData = (_req,_res,next)=>next();
    access.isSameAccount = () => true;
    const notify = require('./services/notify');
    notify.dispatchScheduleNotification = async () => {};
    const mig = require('./services/dbMigrations');
    mig.ensureScheduleTemplateTables = async () => {};

    const express = require('express'); const request = require('supertest');
    const app = express(); app.use(express.json());
    app.use('/job-schedules', require('./routes/jobSchedules'));
    server = app.listen(0);

    const itemRow = async (id) => (await conn.query('SELECT computed_start_date, computed_end_date FROM job_schedule_items WHERE id=?',[id]))[0][0];
    const depExists = async (id) => (await conn.query('SELECT 1 FROM job_schedule_deps WHERE id=?',[id]))[0].length>0;
    const taskRow = async (id) => (await conn.query('SELECT DATE(start_date) s, DATE(end_date) e FROM tasks WHERE id=?',[id]))[0][0];
    const ymd = (d)=> d? new Date(d).toISOString().slice(0,10) : null;

    // ---- SCENARIO 2 FIRST: an UNRELATED edit while the Color-Stucco conflict exists ----
    // Change "Fix drywall" (216) duration — 216 is not on Color Stucco's chain, so the
    // pre-existing conflict remains → reject-at-write-time should roll the edit back.
    const dur216Before = (await conn.query('SELECT duration_days FROM job_schedule_items WHERE id=216'))[0][0].duration_days;
    const res2 = await request(server).put('/job-schedules/6/items/216').send({ duration_days: 9 });
    const dur216After = (await conn.query('SELECT duration_days FROM job_schedule_items WHERE id=216'))[0][0].duration_days;
    const cs219 = (await conn.query('SELECT has_conflict, conflict_reason FROM job_schedule_items WHERE id=219'))[0][0];
    console.log(`\n--- SCENARIO 2 (FLAG-AND-KEEP): PUT /items/216 {duration_days:9} while Color-Stucco conflict exists → HTTP ${res2.status} ---`);
    ok(res2.status === 200, `S2a: unrelated edit now PERSISTS (got ${res2.status}) — schedule stays editable despite an unrelated conflict`);
    ok(Number(dur216After) === 9, `S2b: the edit persisted (duration ${dur216After})`);
    ok(Number(cs219.has_conflict) === 1 && /Stucco lath/.test(cs219.conflict_reason || ''), `S2c: the busted row (Color Stucco) is FLAGGED has_conflict=1 + reason for the UI (reason: ${cs219.conflict_reason})`);

    console.log('\n--- BEFORE: Framing(214) computed + dep 234 present ---');
    const before = await itemRow(214); console.log('  Framing:', ymd(before.computed_start_date),'→',ymd(before.computed_end_date), '| dep234 present:', await depExists(234));

    // THE ACTION: remove Framing→Order-Wrought-Iron (dep row 234)
    const res = await request(server).delete('/job-schedules/6/deps/234').send({});
    console.log(`\n--- DELETE /job-schedules/6/deps/234 → HTTP ${res.status} ${res.body && res.body.message ? '('+res.body.message+')' : ''} ---`);

    ok(res.status === 200, `A: DELETE returns 200 (got ${res.status})`);
    ok(!(await depExists(234)), 'B: dep 234 (Framing→Order Wrought Iron) is GONE from job_schedule_deps');
    const after = await itemRow(214);
    ok(ymd(after.computed_start_date) === '2026-08-27', `C: Framing computed_start moved to 2026-08-27 (got ${ymd(after.computed_start_date)})`);
    const t = await taskRow(1711);
    ok(ymd(t.s) === '2026-08-27', `D: Framing's linked task 1711 start moved to 2026-08-27 (got ${ymd(t.s)})`);
    // Color Stucco conflict should also be gone (schedule now conflict-free)
    const cs = await itemRow(219);
    ok(!!cs, `E: schedule still intact (Color Stucco row present, computed ${ymd(cs.computed_start_date)})`);

    console.log(`\n${fail === 0 ? 'BE PERSISTS THE REMOVAL ✅ (bug is NOT the deployed backend)' : 'BE DID NOT PERSIST ❌ (backend root cause)'} — ${pass} passed, ${fail} failed`);
    process.exitCode = 0;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally {
    try { if (server) server.close(); } catch {}
    try { if (conn) conn.release(); } catch {}
    try { if (pool && pool.end) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
})();
