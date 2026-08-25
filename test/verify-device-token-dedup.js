/* Device-token registration dedup — drives the REAL POST /user/saveDeviceToken
 * against real MySQL. Proves the duplicate-push root cause is fixed at the source:
 *   - registering the same token twice never creates a 2nd row,
 *   - a pre-existing duplicate row (from the old race) collapses to one on next
 *     registration,
 *   - a token registered by a new user detaches from the old user (device handover),
 *   - a user with two DISTINCT tokens keeps both rows (multi-device supported).
 * Run: node test/verify-device-token-dedup.js   (exit 0 = pass)
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
    db = await createDB({ dbName: 'seejob_token_dedup', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), status TINYINT DEFAULT 1)');
    await conn.query('CREATE TABLE user_device_tokens (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, fcm_token VARCHAR(255) NULL, created_at DATETIME NULL, updated_at DATETIME NULL)');
    await conn.query("INSERT INTO `user`(id,name) VALUES (11,'Alice'),(22,'Bob')");

    let ACTOR = { id: 11 };
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const express = require('express');
    const request = require('supertest');
    const app = express(); app.use(express.json());
    app.use('/user', require('../routes/users'));
    server = app.listen(0);

    const rowsFor = async (uid) => (await conn.query('SELECT id, fcm_token FROM user_device_tokens WHERE user_id=? ORDER BY id', [uid]))[0];
    const save = (tok) => request(server).post('/user/saveDeviceToken').send({ fcm_token: tok });

    // 1) First registration → exactly one row.
    ACTOR = { id: 11 };
    await save('tokA');
    ok((await rowsFor(11)).length === 1, 'first register: 1 row for the user');

    // 2) Re-register the SAME token → still one row (idempotent, no duplicate).
    await save('tokA');
    ok((await rowsFor(11)).length === 1, 're-register same token: still 1 row (no duplicate)');

    // 3) Pre-existing duplicate (simulating the old race) collapses on next register.
    await conn.query("INSERT INTO user_device_tokens (user_id, fcm_token, created_at) VALUES (11,'tokA',NOW())");
    ok((await rowsFor(11)).length === 2, 'setup: a stray duplicate row exists');
    await save('tokA');
    ok((await rowsFor(11)).length === 1, 'register collapses the pre-existing duplicate back to 1 row');

    // 4) A user with a SECOND distinct token keeps BOTH (multi-device).
    await save('tokB');
    const alice = await rowsFor(11);
    ok(alice.length === 2 && alice.some((r) => r.fcm_token === 'tokA') && alice.some((r) => r.fcm_token === 'tokB'),
       'second distinct token: both rows kept (multi-device supported)');

    // 5) Device handover: Bob registers Alice's tokA → it detaches from Alice.
    ACTOR = { id: 22 };
    await save('tokA');
    ok((await rowsFor(22)).length === 1, 'handover: token now belongs to the new user (22)');
    ok(!(await rowsFor(11)).some((r) => r.fcm_token === 'tokA'), 'handover: token removed from the old user (11)');
    ok((await rowsFor(11)).some((r) => r.fcm_token === 'tokB'), 'handover: old user keeps their OTHER device token');

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
