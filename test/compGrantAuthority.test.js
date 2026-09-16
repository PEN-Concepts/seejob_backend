/* WHO MAY GRANT FREE ACCESS.
 *
 * Granting a comp means an account pays nothing, forever. That is the account
 * owner's decision and nobody else's — so the check is on the REQUEST, not on
 * whether a control is visible. Hiding a button is not a permission.
 *
 * The case that matters, and the one the checklist names: an ADMIN token must
 * be refused. Admin is not owner. Verified by direct API call.
 *
 * Two companies are seeded: granting must also never reach sideways.
 *
 * Run: node test/compGrantAuthority.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);
const head = (m) => rec.push('\n' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_compauth_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    await conn.query(`CREATE TABLE \`user\` (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190) UNIQUE,
      role INT NULL, category INT NULL, status INT DEFAULT 1, token_version INT NOT NULL DEFAULT 0,
      created_by INT NULL, created_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, plan_id INT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active', amount DECIMAL(10,2) NULL,
      authorize_subscription_id VARCHAR(64) NULL, past_due_since DATETIME NULL,
      created_at DATETIME NULL)`);

    const { OWNER_EXEMPT_EMAILS } = require('../utils/access');
    const OWNER_EMAIL = [...OWNER_EXEMPT_EMAILS][0];
    note(`owner-exempt set holds ${OWNER_EXEMPT_EMAILS.size} address(es)`);

    await conn.query(
      `INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
       (1,'Backend Owner',?,14,4,NULL,'2020-01-01'),
       (2,'Plain Admin','admin-not-owner@example.com',14,4,NULL,'2020-01-01'),
       (3,'Acme Friend','friend@example.com',14,4,NULL,'2020-01-01'),
       (4,'Beta Person','beta@example.com',14,4,NULL,'2020-01-01')`, [OWNER_EMAIL]);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/payments', require('../routes/payments'));

    const tok = (id, email, role) => 'Bearer ' + jwt.sign(
      { id, email, role: role || 14, category: 4 }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const grant = (auth, userId, reason) =>
      request(app).post(`/api/payments/admin/comp/${userId}`).set('Authorization', auth).send({ reason });
    const revoke = (auth, userId) =>
      request(app).delete(`/api/payments/admin/comp/${userId}`).set('Authorization', auth);

    // ================= REFUSED FOR EVERYONE BUT THE OWNER ===============
    head('ONLY THE ACCOUNT OWNER MAY GRANT');
    const asAdmin = await grant(tok(2, 'admin-not-owner@example.com', 14), 3, 'family');
    note(`admin token -> HTTP ${asAdmin.status} ${JSON.stringify(asAdmin.body)}`);
    ok(asAdmin.status === 403,
      'AN ADMIN TOKEN IS REFUSED — admin is not owner, and this is checked on the request',
      'HTTP ' + asAdmin.status);

    const asStranger = await grant(tok(4, 'beta@example.com', 2), 3, 'cheeky');
    ok(asStranger.status === 403, 'so is an ordinary user', 'HTTP ' + asStranger.status);

    const [noRows] = await conn.query("SELECT id FROM subscriptions WHERE status = 'comped'");
    ok(noRows.length === 0,
      'AND THE STORED ROWS PROVE nothing was comped by either refused call', String(noRows.length));

    // ================= THE OWNER MAY ====================================
    head('THE OWNER MAY, AND IT IS RECORDED');
    const noReason = await grant(tok(1, OWNER_EMAIL, 14), 3, '');
    ok(noReason.status === 400,
      'a grant with NO REASON is refused — in two years the reason is the only explanation',
      'HTTP ' + noReason.status);

    const good = await grant(tok(1, OWNER_EMAIL, 14), 3, 'Poul\'s brother-in-law, permanent');
    note(`owner grant -> HTTP ${good.status} ${JSON.stringify(good.body)}`);
    ok(good.body && good.body.success === true, 'the owner\'s grant succeeds', JSON.stringify(good.body));

    const [[sub]] = await conn.query('SELECT status FROM subscriptions WHERE user_id = 3');
    ok(sub && sub.status === 'comped', 'AND THE STORED ROW says comped', sub && sub.status);

    const [[audit]] = await conn.query(
      'SELECT actor_user_id, action, reason FROM subscription_comp_audit WHERE subject_user_id = 3 ORDER BY id DESC LIMIT 1');
    ok(!!audit, 'an audit row exists');
    ok(audit && Number(audit.actor_user_id) === 1, 'recording WHO granted it', audit && String(audit.actor_user_id));
    ok(audit && /brother-in-law/.test(audit.reason || ''), 'and WHY', audit && audit.reason);

    // ================= REVOKE ===========================================
    head('REVOKING RESTORES, AND DELETES NOTHING');
    const asAdminRevoke = await revoke(tok(2, 'admin-not-owner@example.com', 14), 3);
    ok(asAdminRevoke.status === 403, 'an admin cannot revoke either', 'HTTP ' + asAdminRevoke.status);

    const rev = await revoke(tok(1, OWNER_EMAIL, 14), 3);
    ok(rev.body && rev.body.success === true, 'the owner can revoke', JSON.stringify(rev.body));
    const [[after]] = await conn.query('SELECT status FROM subscriptions WHERE user_id = 3');
    ok(after && after.status !== 'comped', 'the row is no longer comped', after && after.status);

    const [trail] = await conn.query(
      'SELECT action FROM subscription_comp_audit WHERE subject_user_id = 3 ORDER BY id');
    ok(trail.length === 2 && trail[0].action === 'comped' && trail[1].action === 'revoked',
      'AND BOTH ROWS SURVIVE — revoking ADDS a record, it does not erase the grant',
      trail.map((t) => t.action).join(','));

    // ================= NOTHING SIDEWAYS =================================
    head('NO OTHER ACCOUNT WAS TOUCHED');
    const [others] = await conn.query('SELECT user_id FROM subscriptions WHERE user_id <> 3');
    ok(others.length === 0, 'no subscription row was created for anyone else', JSON.stringify(others));

  } catch (err) {
    fail++; rec.push('  ✗ threw: ' + (err && err.stack || err));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
