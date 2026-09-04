/* GET /jobs/job-schedule — multi-day fan-out + on-hold gate  (tasks 11 & 12).
 *
 * Proves against real MySQL (mysql-memory-server) + supertest:
 *  1. A multi-day Gantt trade appears once per WORKING day it spans (skip Sat/Sun
 *     honoured), each cell tagged DAY N OF M.
 *  2. A trade that STARTED before the window but runs into it shows only its
 *     in-window working days, with day_index continuing from its true start.
 *  3. A trade whose parent schedule is on_hold/archived is HIDDEN.
 *  4. A plain single-day task shows once (day_total 1).
 *
 * Window under test: Mon 2026-09-07 .. Sun 2026-09-13.
 *
 * Run: NODE_PATH=<backend>/node_modules node test/jobScheduleFanout.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_jsfanout_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT, category INT, created_by INT NULL)");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(150), status INT DEFAULT 1)");
    await conn.query("CREATE TABLE tasks (id INT PRIMARY KEY, job_id INT NULL, user_id INT NULL, team_id INT NULL, created_by INT NULL, task_type VARCHAR(20), task_name VARCHAR(150), status INT NULL, start_date DATE NULL, end_date DATE NULL, duration_days INT NULL, complete_percentage INT NULL, is_calendar_task INT NULL, assignee_completed INT NULL, archived_at DATETIME NULL)");
    await conn.query("CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT)");
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120))");
    await conn.query("CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)");
    await conn.query("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, contact_id INT)");
    await conn.query("CREATE TABLE job_schedules (id INT PRIMARY KEY, job_id INT, owner_type VARCHAR(8) DEFAULT 'job', start_date DATE NULL, skip_saturday TINYINT DEFAULT 0, skip_sunday TINYINT DEFAULT 0, status VARCHAR(12) DEFAULT 'active', created_by INT NULL)");
    await conn.query("CREATE TABLE job_schedule_items (id INT PRIMARY KEY, schedule_id INT, name VARCHAR(255), duration_days INT DEFAULT 1, computed_start_date DATE NULL, computed_end_date DATE NULL, pinned_start_date DATE NULL, task_id INT NULL)");
    await conn.query("CREATE TABLE gantt_stage_progress (id INT PRIMARY KEY AUTO_INCREMENT, schedule_item_id INT, percent INT DEFAULT 0)");

    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by) VALUES (900,'Owner','g@x.com',14,2,NULL)");
    await conn.query("INSERT INTO job (id,created_by,name,status) VALUES (1900,900,'Job A',1)");

    // Active schedule (weekends skipped) with two trades.
    await conn.query("INSERT INTO job_schedules (id,job_id,start_date,skip_saturday,skip_sunday,status,created_by) VALUES (10,1900,'2026-09-07',1,1,'active',900)");
    // On-hold schedule with one trade — must be hidden.
    await conn.query("INSERT INTO job_schedules (id,job_id,start_date,skip_saturday,skip_sunday,status,created_by) VALUES (11,1900,'2026-09-07',1,1,'on_hold',900)");

    // Trade A: Framing, 5 working days from Mon 09-07 -> 09-07..09-11 (Mon-Fri).
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status,start_date,end_date,duration_days,is_calendar_task,assignee_completed) VALUES (200,1900,900,900,'job','Framing',0,'2026-09-07','2026-09-11',5,0,0)");
    await conn.query("INSERT INTO job_schedule_items (id,schedule_id,name,duration_days,computed_start_date,computed_end_date,task_id) VALUES (300,10,'Framing',5,'2026-09-07','2026-09-11',200)");
    await conn.query("INSERT INTO gantt_stage_progress (schedule_item_id,percent) VALUES (300,40)");

    // Trade B: Sitework, 4 working days from Fri 09-04 -> 09-04,09-07,09-08,09-09.
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status,start_date,end_date,duration_days,is_calendar_task,assignee_completed) VALUES (201,1900,900,900,'job','Sitework',0,'2026-09-04','2026-09-09',4,0,0)");
    await conn.query("INSERT INTO job_schedule_items (id,schedule_id,name,duration_days,computed_start_date,computed_end_date,task_id) VALUES (301,10,'Sitework',4,'2026-09-04','2026-09-09',201)");
    await conn.query("INSERT INTO gantt_stage_progress (schedule_item_id,percent) VALUES (301,10)");

    // Trade C: Roofing on the ON-HOLD schedule -> hidden.
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status,start_date,end_date,duration_days,is_calendar_task,assignee_completed) VALUES (202,1900,900,900,'job','Roofing',0,'2026-09-08','2026-09-09',2,0,0)");
    await conn.query("INSERT INTO job_schedule_items (id,schedule_id,name,duration_days,computed_start_date,computed_end_date,task_id) VALUES (302,11,'Roofing',2,'2026-09-08','2026-09-09',202)");

    // Plain single-day task (no schedule item) on Wed 09-09.
    await conn.query("INSERT INTO tasks (id,job_id,user_id,created_by,task_type,task_name,status,start_date,duration_days,complete_percentage,is_calendar_task,assignee_completed) VALUES (203,1900,900,900,'job','Inspection',0,'2026-09-09',1,40,0,0)");

    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/jobs', require('../routes/jobs'));
    const tok = 'Bearer ' + jwt.sign({ id: 900, role: 14, category: 2, email: 'g@x.com', working_id: 900 }, process.env.ACCESS_TOKEN);

    const res = await request(app).get('/jobs/job-schedule?start=2026-09-07&end=2026-09-13&today=2026-09-07').set('Authorization', tok);
    ok(res.status === 200, 'GET job-schedule -> 200', res.status + ' ' + JSON.stringify(res.body).slice(0, 200));
    const items = (res.body && res.body.items) || [];
    const byTitle = (t) => items.filter((x) => x.title === t).sort((a, b) => a.date < b.date ? -1 : 1);

    // 1) Framing fans out to 5 working days Mon-Fri
    const fr = byTitle('Framing');
    ok(fr.length === 5, 'Framing -> 5 working-day cells', fr.length + ' ' + JSON.stringify(fr.map((x) => x.date)));
    ok(fr.map((x) => x.date).join(',') === '2026-09-07,2026-09-08,2026-09-09,2026-09-10,2026-09-11', 'Framing dates are Mon-Fri (weekend skipped)', JSON.stringify(fr.map((x) => x.date)));
    ok(fr.every((x, i) => x.day_index === i + 1 && x.day_total === 5), 'Framing cells tagged DAY 1..5 OF 5', JSON.stringify(fr.map((x) => `${x.day_index}/${x.day_total}`)));
    ok(fr.every((x) => x.type === 'schedule' && x.percent === 40), 'Framing cells are schedule type, percent 40', JSON.stringify(fr.map((x) => x.type + ':' + x.percent)));

    // 2) Sitework started 09-04; only 09-07/08/09 fall in the window, day_index continues 2/3/4 of 4
    const sw = byTitle('Sitework');
    ok(sw.map((x) => x.date).join(',') === '2026-09-07,2026-09-08,2026-09-09', 'Sitework shows only in-window working days', JSON.stringify(sw.map((x) => x.date)));
    ok(sw.map((x) => `${x.day_index}/${x.day_total}`).join(',') === '2/4,3/4,4/4', 'Sitework day_index continues from true start (2/4,3/4,4/4)', JSON.stringify(sw.map((x) => `${x.day_index}/${x.day_total}`)));

    // 3) Roofing (on-hold schedule) hidden
    ok(byTitle('Roofing').length === 0, 'Roofing (on_hold schedule) is HIDDEN', JSON.stringify(byTitle('Roofing')));

    // 4) plain single-day task
    const insp = byTitle('Inspection');
    ok(insp.length === 1 && insp[0].date === '2026-09-09', 'Inspection shows once on 09-09', JSON.stringify(insp.map((x) => x.date)));
    ok(insp[0] && insp[0].day_total === 1 && insp[0].type === 'task', 'Inspection is single-day task (day_total 1)', JSON.stringify(insp[0]));
    // Every row carries a percent now — a plain task exposes its complete_percentage.
    ok(insp[0] && insp[0].percent === 40, 'plain task carries its complete_percentage (40) — one rule for the screen', JSON.stringify(insp[0] && insp[0].percent));

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 6).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
