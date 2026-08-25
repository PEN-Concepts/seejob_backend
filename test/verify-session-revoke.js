/* Persistent mobile session + server-side revoke — exercises signSession and the
 * real authenticateToken against in-memory MySQL. Proves:
 *   - mobile token ≈ 365 days, web token ≈ 7 days; both carry plat + tv,
 *   - a valid token passes,
 *   - bumping user.token_version invalidates a live token (401 REVOKED),
 *   - status=0 invalidates a live token (401 REVOKED),
 *   - a mobile token within its last 180 days gets an X-Renewed-Token header,
 *   - the check is tolerant of a not-yet-migrated token_version column
 *     (status-only still enforces).
 * Run: node test/verify-session-revoke.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };
const DAY = 24 * 60 * 60;

(async () => {
  let db, pool, conn, server;
  try {
    process.env.NODE_ENV = 'test';
    process.env.ACCESS_TOKEN = 'test_secret';
    const jwt = require('jsonwebtoken');
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_session', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), status TINYINT DEFAULT 1, token_version INT NOT NULL DEFAULT 0)');
    await conn.query("INSERT INTO `user`(id,name,status,token_version) VALUES (7,'Joshua',1,0)");

    const authMod = require('../services/authentication');
    const { signSession, authenticateToken } = authMod;

    // --- signSession shape/expiry ---
    const mob = jwt.decode(signSession({ id: 7 }, { platform: 'mobile', tokenVersion: 0 }));
    const web = jwt.decode(signSession({ id: 7 }, { platform: 'web', tokenVersion: 0 }));
    const mobDays = Math.round((mob.exp - mob.iat) / DAY);
    const webDays = Math.round((web.exp - web.iat) / DAY);
    ok(mobDays === 365 && mob.plat === 'mobile' && mob.tv === 0, `mobile token ≈365d (${mobDays}d), plat=mobile, tv embedded`);
    ok(webDays === 7 && web.plat === 'web', `web token ≈7d (${webDays}d), plat=web`);

    // --- authenticateToken route ---
    const express = require('express');
    const request = require('supertest');
    const app = express();
    app.get('/protected', authenticateToken, (req, res) => res.json({ ok: true, id: req.user.id }));
    server = app.listen(0);
    const hit = (tok) => request(server).get('/protected').set('Authorization', `Bearer ${tok}`);

    // valid token → 200
    let r = await hit(signSession({ id: 7 }, { platform: 'mobile', tokenVersion: 0 }));
    ok(r.status === 200 && r.body.id === 7, 'valid token (tv matches, status=1) → 200');

    // bump token_version → old token invalid
    await conn.query('UPDATE `user` SET token_version = 5 WHERE id = 7');
    r = await hit(signSession({ id: 7 }, { platform: 'mobile', tokenVersion: 0 }));
    ok(r.status === 401 && r.body.code === 'REVOKED', 'stale token_version → 401 REVOKED (remote revoke works)');
    r = await hit(signSession({ id: 7 }, { platform: 'mobile', tokenVersion: 5 }));
    ok(r.status === 200, 'fresh token with current token_version → 200');

    // status=0 → invalid
    await conn.query('UPDATE `user` SET status = 0 WHERE id = 7');
    r = await hit(signSession({ id: 7 }, { platform: 'mobile', tokenVersion: 5 }));
    ok(r.status === 401 && r.body.code === 'REVOKED', 'status=0 (deactivated) → 401 REVOKED on a live token');
    await conn.query('UPDATE `user` SET status = 1 WHERE id = 7');

    // sliding renewal: a mobile token within its last 180 days → X-Renewed-Token
    const nearExp = jwt.sign({ id: 7, plat: 'mobile', tv: 5 }, process.env.ACCESS_TOKEN, { expiresIn: '100d' });
    r = await hit(nearExp);
    ok(r.status === 200 && !!r.headers['x-renewed-token'], 'mobile token <180d left → server returns a renewed token header');
    const renewed = jwt.decode(r.headers['x-renewed-token'] || '');
    ok(renewed && Math.round((renewed.exp - renewed.iat) / DAY) === 365, 'renewed token is a fresh ≈365d mobile token');

    // a web token far from expiry → no renewal header
    r = await hit(signSession({ id: 7 }, { platform: 'web', tokenVersion: 5 }));
    ok(r.status === 200 && !r.headers['x-renewed-token'], 'web token → no renewal header (renewal is mobile-only)');

    // tolerance: drop the token_version column → status-only check still enforces
    await conn.query('ALTER TABLE `user` DROP COLUMN token_version');
    r = await hit(jwt.sign({ id: 7, plat: 'web', tv: 0 }, process.env.ACCESS_TOKEN, { expiresIn: '7d' }));
    ok(r.status === 200, 'token_version column missing → still allows a valid, active user (deploy-safe)');
    await conn.query('UPDATE `user` SET status = 0 WHERE id = 7');
    r = await hit(jwt.sign({ id: 7, plat: 'web', tv: 0 }, process.env.ACCESS_TOKEN, { expiresIn: '7d' }));
    ok(r.status === 401 && r.body.code === 'REVOKED', 'token_version column missing → status=0 revoke STILL enforced');

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
