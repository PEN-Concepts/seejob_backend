/* Time Tracking line-item edit — PUT /clockin/entry/:id. Edits notes and/or
 * time (date + start/stop → recomputed duration). Self-scoped; completed rows
 * only; never edits a running timer.
 * Real MySQL (mysql-memory-server) + supertest against routes/clockin.js.
 * Run: NODE_PATH=<backend>/node_modules node test/clockinEntryUpdate.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_ttedit_test', logLevel: 'ERROR' });
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
    // A(501): completed row #1 (2h) + active row #2. B(502): completed row #3.
    await conn.query(`INSERT INTO clockin (id, job_id, created_by, is_task_active, start_date, start_time, stop_date, stop_time, task_duration, additional_notes) VALUES
      (1,1,501,0,'2026-07-20','08:00:00','2026-07-20','10:00:00','02:00:00','old note'),
      (2,1,501,1,'2026-07-21','09:00:00',NULL,NULL,NULL,NULL),
      (3,1,502,0,'2026-07-20','08:00:00','2026-07-20','09:00:00','01:00:00','b note')`);

    const express = require('express');
    app = express(); app.use(express.json());
    app.use('/api/clockin', require('../routes/clockin'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);
    const A = tok(501), B = tok(502);
    const getRow = async (id) => (await conn.query('SELECT * FROM clockin WHERE id = ?', [id]))[0][0];

    // ── notes-only edit ──
    const e1 = await request(app).put('/api/clockin/entry/1').set('Authorization', A).send({ notes: 'framed the wall' });
    ok(e1.status === 200, 'notes: 200', e1.status + ' ' + JSON.stringify(e1.body));
    ok((await getRow(1)).additional_notes === 'framed the wall', 'notes: additional_notes updated', (await getRow(1)).additional_notes);
    ok(String((await getRow(1)).task_duration) === '02:00:00', 'notes-only: duration untouched', String((await getRow(1)).task_duration));

    // ── time edit → duration recomputed (08:00 → 11:30 = 3.5h) ──
    const e2 = await request(app).put('/api/clockin/entry/1').set('Authorization', A).send({ work_date: '2026-07-20', start_time: '08:00', stop_time: '11:30' });
    ok(e2.status === 200, 'time: 200', e2.status + '');
    ok(String((await getRow(1)).task_duration) === '03:30:00', 'time: duration recomputed to 03:30:00', String((await getRow(1)).task_duration));
    ok(String((await getRow(1)).stop_time) === '11:30:00', 'time: stop_time saved (HH:MM padded)', String((await getRow(1)).stop_time));

    // ── overnight crossing (22:00 → 02:00 = 4h) ──
    const e3 = await request(app).put('/api/clockin/entry/1').set('Authorization', A).send({ work_date: '2026-07-20', start_time: '22:00', stop_time: '02:00' });
    ok(String((await getRow(1)).task_duration) === '04:00:00', 'overnight: 22:00→02:00 = 04:00:00', String((await getRow(1)).task_duration));

    // ── cannot edit another user's entry ──
    const e4 = await request(app).put('/api/clockin/entry/3').set('Authorization', A).send({ notes: 'hax' });
    ok(e4.status === 404, "cross-user: A cannot edit B's entry (404)", e4.status + '');
    ok((await getRow(3)).additional_notes === 'b note', "cross-user: B's note untouched", (await getRow(3)).additional_notes);

    // ── cannot edit a running timer ──
    const e5 = await request(app).put('/api/clockin/entry/2').set('Authorization', A).send({ notes: 'x' });
    ok(e5.status === 404, 'active: running timer not editable (404)', e5.status + '');

    // ── bad id ──
    const e6 = await request(app).put('/api/clockin/entry/abc').set('Authorization', A).send({ notes: 'x' });
    ok(e6.status === 400, 'bad id -> 400', e6.status + '');

  } catch (e) { fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e)); }
  finally {
    console.log(rec.join('\n')); console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
