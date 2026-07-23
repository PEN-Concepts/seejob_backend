/* Job time-tracking (clockin) — the extend-existing gaps:
 *   - single active timer per user (can't double-start; 409 ACTIVE_TIMER_EXISTS)
 *   - start/stop produces a correct task_duration; notes (remarks->additional_notes) save
 *   - GET /report aggregates totals per job + per day, honors job/date filters,
 *     and never leaks another user's entries.
 * Real MySQL (mysql-memory-server) + supertest against routes/clockin.js.
 * Run: NODE_PATH=<backend>/node_modules node test/clockinTimeTracking.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_clockin_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();
    await conn.query('CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(160))');
    await conn.query("INSERT INTO job (id,name) VALUES (1,'Alpha Remodel'),(2,'Beta Kitchen')");
    await conn.query(`CREATE TABLE clockin (
      id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, task_id INT NULL,
      start_time TIME NULL, start_date DATE NULL, stop_time TIME NULL, stop_date DATE NULL,
      task_duration TIME NULL, break_duration TIME NULL, is_break TINYINT DEFAULT 0,
      start_break TIME NULL, break_start_date DATE NULL, stop_break TIME NULL,
      break_stop_date DATE NULL, break_type VARCHAR(40) NULL, additional_notes TEXT NULL,
      created_by INT NULL, is_task_active TINYINT DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/clockin', require('../routes/clockin'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const A = tok(501), B = tok(502);

    // ---- START: begins a job-tied timer ----
    const s1 = await request(app).post('/api/clockin/start').set('Authorization', A).send({ job_id: 1 });
    ok(s1.status === 201 && s1.body.clockin_id, 'start: begins a timer (201 + clockin_id)', JSON.stringify(s1.body));
    const [act] = await conn.query('SELECT is_task_active, job_id FROM clockin WHERE id = ?', [s1.body.clockin_id]);
    ok(act[0] && Number(act[0].is_task_active) === 1 && Number(act[0].job_id) === 1, 'start: row is active + tied to the job', JSON.stringify(act[0]));

    // ---- CANNOT double-start a 2nd concurrent timer (same user) ----
    const s2 = await request(app).post('/api/clockin/start').set('Authorization', A).send({ job_id: 2 });
    ok(s2.status === 409 && s2.body.code === 'ACTIVE_TIMER_EXISTS', 'start: 2nd concurrent start for SAME user -> 409 ACTIVE_TIMER_EXISTS (no double-start)', s2.status + ' ' + JSON.stringify(s2.body.code));
    ok(s2.body.active && Number(s2.body.active.id) === Number(s1.body.clockin_id), 'start: 409 returns the running timer so the UI can prompt to resolve it', JSON.stringify(s2.body.active));
    const [cnt] = await conn.query('SELECT COUNT(*) AS c FROM clockin WHERE created_by = 501 AND is_task_active = 1');
    ok(Number(cnt[0].c) === 1, 'start: still exactly ONE active timer for the user (2nd was not inserted)', String(cnt[0].c));

    // ---- A DIFFERENT user CAN start concurrently (per-user, not global) ----
    const s3 = await request(app).post('/api/clockin/start').set('Authorization', B).send({ job_id: 1 });
    ok(s3.status === 201, 'start: a different user can start their own timer concurrently', String(s3.status));

    // ---- STOP: correct duration + notes saved ----
    // Seed a timer that started ~1h ago so the computed duration is deterministic.
    const past = new Date(Date.now() - 3600 * 1000);
    const seed = await conn.query(
      "INSERT INTO clockin (job_id, start_time, start_date, created_by, is_task_active) VALUES (1, ?, ?, 501, 1)",
      [past.toTimeString().slice(0, 8), ymd(past)]
    );
    const seedId = seed[0].insertId;
    const st = await request(app).put('/api/clockin/stop/' + seedId).set('Authorization', A).send({ remarks: 'Framed the east wall' });
    ok(st.status === 200, 'stop: 200', JSON.stringify(st.body));
    const durSec = (() => { const [h, m, s] = String(st.body.task_duration || '0:0:0').split(':').map(Number); return h * 3600 + m * 60 + s; })();
    ok(durSec >= 3590 && durSec <= 3610, 'stop: task_duration ~1h for a ~1h session (correct duration)', st.body.task_duration + ' (' + durSec + 's)');
    const [stopped] = await conn.query('SELECT additional_notes, is_task_active FROM clockin WHERE id = ?', [seedId]);
    ok(stopped[0] && stopped[0].additional_notes === 'Framed the east wall', 'stop: notes saved to additional_notes', JSON.stringify(stopped[0] && stopped[0].additional_notes));
    ok(stopped[0] && Number(stopped[0].is_task_active) === 0, 'stop: timer no longer active');

    // ---- REPORT: totals per job + per day, filters, no cross-user leak ----
    // Completed entries: A -> job1 Jul20 (1h + 0.5h), job2 Jul21 (2h); B -> job1 Jul20 (5h, must NOT appear for A).
    await conn.query(`INSERT INTO clockin (job_id, start_date, stop_date, task_duration, created_by, is_task_active) VALUES
      (1,'2026-07-20','2026-07-20','01:00:00',501,0),
      (1,'2026-07-20','2026-07-20','00:30:00',501,0),
      (2,'2026-07-21','2026-07-21','02:00:00',501,0),
      (1,'2026-07-20','2026-07-20','05:00:00',502,0)`);

    const rep = await request(app).get('/api/clockin/report?from=2026-07-20&to=2026-07-21').set('Authorization', A);
    ok(rep.status === 200, 'report: 200', String(rep.status));
    ok(rep.body.entries.length === 3, 'report: 3 of A\'s entries (B\'s row excluded — no cross-user leak)', String(rep.body.entries.length));
    ok(Number(rep.body.totalSeconds) === 12600, 'report: grand total = 5400 + 7200 = 12600s (3.5h + 2h)', String(rep.body.totalSeconds));
    const jobT = Object.fromEntries(rep.body.totalsPerJob.map((j) => [j.job_id, j.seconds]));
    ok(jobT[1] === 5400 && jobT[2] === 7200, 'report: totals PER JOB (job1=5400, job2=7200)', JSON.stringify(jobT));
    const dayT = Object.fromEntries(rep.body.totalsPerDay.map((d) => [d.date, d.seconds]));
    ok(dayT['2026-07-20'] === 5400 && dayT['2026-07-21'] === 7200, 'report: totals PER DAY (Jul20=5400, Jul21=7200)', JSON.stringify(dayT));

    const repJob = await request(app).get('/api/clockin/report?from=2026-07-20&to=2026-07-21&job_id=1').set('Authorization', A);
    ok(repJob.body.entries.length === 2 && Number(repJob.body.totalSeconds) === 5400, 'report: job_id filter -> only job1 (2 entries, 5400s)', repJob.body.entries.length + '/' + repJob.body.totalSeconds);

    const repDay = await request(app).get('/api/clockin/report?from=2026-07-21&to=2026-07-21').set('Authorization', A);
    ok(repDay.body.entries.length === 1 && Number(repDay.body.totalSeconds) === 7200, 'report: date filter -> only Jul21 (1 entry, 7200s)', repDay.body.entries.length + '/' + repDay.body.totalSeconds);

    const repB = await request(app).get('/api/clockin/report?from=2026-07-20&to=2026-07-21').set('Authorization', B);
    ok(repB.body.entries.length === 1 && Number(repB.body.totalSeconds) === 18000, 'report: user B sees only their own 5h entry (scoping)', repB.body.entries.length + '/' + repB.body.totalSeconds);
  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
