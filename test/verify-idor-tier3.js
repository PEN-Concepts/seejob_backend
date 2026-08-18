/* IDOR remediation — Tier 3, real local MySQL. Covers the endpoints that used
 * their own (not the shared-module) ownership helpers:
 *   - notepads /view/:filename + /view_audio/:filename (were UNAUTHENTICATED) →
 *     login + the file must belong to a notepad in the caller's account.
 *   - notepads /updatestatus + /notepad/mark-removed → only touch owned notes.
 *   - time_card /approve-leave + /reject-leave → manager-of-account only.
 * checklists /:id/keep uses the same getAccessibleChecklistItem as its already-
 * guarded siblings (its local plan gate blocks a clean end-to-end mount) — wiring
 * grep-verified.
 * Run: node test/verify-idor-tier3.js
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
    db = await createDB({ dbName: 'seejob_idor_t3', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), category INT NULL, created_by INT NULL)');
    await conn.query('CREATE TABLE notepad (id INT PRIMARY KEY, user_id INT NULL, image VARCHAR(255) NULL, audio_note VARCHAR(255) NULL, status INT NULL, remove_by INT NULL)');
    await conn.query('CREATE TABLE notepad_gallery (id INT PRIMARY KEY AUTO_INCREMENT, notepad_id INT NULL, image VARCHAR(255) NULL)');
    await conn.query('CREATE TABLE leave_request (id INT PRIMARY KEY, manager_id INT NULL, status VARCHAR(20) NULL, approver INT NULL)');

    await conn.query(`INSERT INTO \`user\`(id,name,category,created_by) VALUES (74,'Owner',2,NULL),(86,'Emp',1,74),(999,'External',2,NULL)`);
    await conn.query("INSERT INTO notepad (id,user_id,image,audio_note,status) VALUES (500,74,'mine.jpg','mine.m4a',0),(501,999,'theirs.jpg','theirs.m4a',0)");
    await conn.query("INSERT INTO leave_request (id,manager_id,status) VALUES (600,74,'pending'),(601,999,'pending')");

    let ACTOR = null;
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const express = require('express');
    const request = require('supertest');
    const app = express();
    app.use(express.json());
    app.use('/np', require('../routes/notepads'));
    app.use('/tc', require('../routes/time_card'));
    server = app.listen(0);
    const as = (u) => { ACTOR = { id: u, role: u === 86 ? 5 : 14 }; };
    const R = () => request(server);

    console.log('notepads /view* (were unauthenticated)');
    as(74); ok((await R().get('/np/view/theirs.jpg')).status === 403, 'view: cross-account file → 403');
    as(74); ok((await R().get('/np/view/unknown.jpg')).status === 403, 'view: unknown file → 403');
    as(74); ok((await R().get('/np/view/mine.jpg')).status !== 403, 'view: own file → not 403 (ownership passes; 404 only because no file on disk)');
    as(74); ok((await R().get('/np/view_audio/theirs.m4a')).status === 403, 'view_audio: cross-account file → 403');
    as(74); ok((await R().get('/np/view_audio/mine.m4a')).status !== 403, 'view_audio: own file → not 403');

    console.log('\nnotepads /updatestatus + /mark-removed');
    as(74); ok((await R().post('/np/updatestatus').send({ ids: [501], status: 1 })).status === 403, 'updatestatus: cross-account id → 403');
    as(74); ok((await R().post('/np/updatestatus').send({ ids: [500], status: 1 })).status === 200, 'updatestatus: own id → 200');
    as(74); ok((await R().post('/np/notepad/mark-removed').send({ ids: [501], user_id: 74 })).status === 403, 'mark-removed: cross-account id → 403');
    as(74); ok((await R().post('/np/notepad/mark-removed').send({ ids: [500], user_id: 74 })).status === 200, 'mark-removed: own id → 200');
    // ensure the cross-account note was NOT actually modified
    const [[n501]] = await conn.query('SELECT status, remove_by FROM notepad WHERE id=501');
    ok(Number(n501.status) === 0 && n501.remove_by === null, 'cross-account note 501 left untouched');

    console.log('\ntime_card /approve-leave + /reject-leave');
    as(74); ok((await R().put('/tc/approve-leave/601')).status === 404, 'approve-leave: cross-account → 404 (not in your account)');
    as(74); ok((await R().put('/tc/approve-leave/600')).status === 200, 'approve-leave: manager of account → 200');
    as(74); ok((await R().put('/tc/reject-leave/601')).status === 404, 'reject-leave: cross-account → 404');
    const [[lr601]] = await conn.query("SELECT status FROM leave_request WHERE id=601");
    ok(lr601.status === 'pending', 'cross-account leave 601 left pending (untouched)');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally {
    try { if (server) server.close(); } catch {}
    try { if (conn) conn.release(); } catch {}
    try { if (pool && pool.end) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
})();
