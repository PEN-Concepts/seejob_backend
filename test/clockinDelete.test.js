/* Time Tracking delete controls — DELETE /clockin/entry/:id and
 * DELETE /clockin/job/:jobId/entries. Both must be self-scoped (a user can
 * only delete their own rows) and must never delete a running timer.
 * Real MySQL (mysql-memory-server) + supertest against routes/clockin.js.
 * Run: NODE_PATH=<backend>/node_modules node test/clockinDelete.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_ttdel_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();
    await conn.query(`CREATE TABLE clockin (
      id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, task_id INT NULL,
      start_time TIME NULL, start_date DATE NULL, stop_time TIME NULL, stop_date DATE NULL,
      task_duration TIME NULL, additional_notes TEXT NULL,
      created_by INT NULL, is_task_active TINYINT DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    // A(501): 3 completed on job 1, 1 completed on job 2, 1 ACTIVE on job 1. B(502): 1 completed on job 1.
    await conn.query(`INSERT INTO clockin (id, job_id, created_by, is_task_active, task_duration) VALUES
      (1,1,501,0,'01:00:00'),(2,1,501,0,'02:00:00'),(3,1,501,0,'00:30:00'),
      (4,2,501,0,'03:00:00'),(5,1,501,1,NULL),(6,1,502,0,'04:00:00')`);

    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/clockin', require('../routes/clockin'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const A = tok(501), B = tok(502);
    const count = async (w, p) => Number((await conn.query(`SELECT COUNT(*) c FROM clockin WHERE ${w}`, p))[0][0].c);

    // ── single entry delete: own completed row ──
    const d1 = await request(app).delete('/api/clockin/entry/1').set('Authorization', A);
    ok(d1.status === 200 && d1.body.deleted === 1, 'entry: own completed entry deletes (200, deleted:1)', d1.status + ' ' + JSON.stringify(d1.body));
    ok((await count('id = 1', [])) === 0, 'entry: row is actually gone', 'still present');

    // ── cannot delete another user's entry ──
    const d2 = await request(app).delete('/api/clockin/entry/6').set('Authorization', A);
    ok(d2.status === 404, "entry: A cannot delete B's entry (404)", d2.status + '');
    ok((await count('id = 6', [])) === 1, "entry: B's row untouched", 'was deleted!');

    // ── cannot delete an active/running timer ──
    const d3 = await request(app).delete('/api/clockin/entry/5').set('Authorization', A);
    ok(d3.status === 404, 'entry: active running timer is not deletable (404)', d3.status + '');
    ok((await count('id = 5', [])) === 1, 'entry: active timer row survives', 'was deleted!');

    // ── delete ALL of A's completed entries for job 1 (rows 2,3 remain; 1 already gone) ──
    const dj = await request(app).delete('/api/clockin/job/1/entries').set('Authorization', A);
    ok(dj.status === 200 && dj.body.deleted === 2, 'job: deletes A\'s remaining completed job-1 entries (deleted:2)', dj.status + ' ' + JSON.stringify(dj.body));
    ok((await count('job_id = 1 AND created_by = 501 AND is_task_active = 0', [])) === 0, 'job: no completed job-1 rows left for A', 'some remain');
    ok((await count('id = 5', [])) === 1, 'job: A\'s active job-1 timer still survives', 'active deleted!');
    ok((await count('id = 6', [])) === 1, "job: B's job-1 entry untouched", 'B deleted!');
    ok((await count('id = 4', [])) === 1, "job: A's job-2 entry untouched", 'job 2 deleted!');

    // ── bad ids ──
    const bad = await request(app).delete('/api/clockin/entry/abc').set('Authorization', A);
    ok(bad.status === 400, 'entry: non-numeric id -> 400', bad.status + '');

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
