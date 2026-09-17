/* THE EMAIL ORACLE IS GONE, AND SIGNUP STILL WORKS.
 *
 * POST /check-email took an address and answered {"exists": true|false} with no
 * token and no rate limit, about 90ms a call. On this platform that is worse
 * than the usual enumeration hole, because logins here ARE subcontractors' and
 * clients' email addresses: it let anyone map which contractors are on the
 * platform and infer who works with whom.
 *
 * Only the signup form called it. This file exists so the deletion cannot be
 * quietly undone, and — just as important — so the thing signup now depends on
 * INSTEAD is actually proven to work. Deleting the oracle is worthless if
 * registration then fails silently, so the fresh-signup path is tested end to
 * end here, not assumed.
 *
 * Two companies are seeded, consistent with the other auth tests.
 *
 * Run: node test/emailOracleGone.test.js
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
    // Registration sends mail; point it nowhere so the suite never waits on SMTP.
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';
    process.env.SMTP_USER = 'test@example.com';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_oracle_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');

    // email UNIQUE is the constraint registration refuses on; mobile's UNIQUE
    // index was dropped by migration, which is why the new message keys off the
    // index MySQL actually names rather than assuming which field it was.
    await conn.query(`CREATE TABLE \`user\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120), first_name VARCHAR(120) NULL, last_name VARCHAR(120) NULL,
      email VARCHAR(190) UNIQUE, password VARCHAR(190), mobile VARCHAR(40) NULL,
      image VARCHAR(190) NULL, status INT DEFAULT 1, role INT NULL, category INT NULL,
      subcategory INT NULL, business VARCHAR(190) NULL, organization_name VARCHAR(190) NULL,
      trade VARCHAR(190) NULL, social_security VARCHAR(64) NULL,
      street VARCHAR(190) NULL, city VARCHAR(120) NULL, state VARCHAR(80) NULL,
      zipcode VARCHAR(32) NULL, contact_note TEXT NULL,
      otp VARCHAR(10) NULL, otp_status INT DEFAULT 0, created_by INT NULL,
      must_change_password INT DEFAULT 0, pin_hash VARCHAR(190) NULL, pin_enabled INT DEFAULT 0,
      employment_type VARCHAR(40) NULL, rate VARCHAR(40) NULL, level INT NULL,
      token_version INT NOT NULL DEFAULT 0,
      updated_at DATETIME NULL, updated_by INT NULL, created_at DATETIME NULL)`);
    await conn.query('CREATE TABLE role_right_permission (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, right_id INT, `read` INT DEFAULT 1, `create` INT DEFAULT 1, `update` INT DEFAULT 1, `delete` INT DEFAULT 1)');
    await conn.query('CREATE TABLE user_devices (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, device_token VARCHAR(190), user_agent VARCHAR(255) NULL)');

    const TAKEN = 'taken@example.com';
    await conn.query(
      `INSERT INTO \`user\` (id,name,email,status,role,category,created_by,created_at) VALUES
       (100,'Acme Owner',?,1,14,4,NULL,NOW()),
       (200,'Beta Owner','beta@example.com',1,14,4,NULL,NOW())`, [TAKEN]);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/user', require('../routes/users'));
    app.use((req, res) => res.status(404).json({ message: 'Not found' }));

    // ================= THE ORACLE IS GONE ================================
    head('THE ORACLE IS GONE');
    for (const email of [TAKEN, 'nobody-8fa2@example.com']) {
      const r = await request(app).post('/api/user/check-email').send({ email });
      ok(r.status === 404, `POST /check-email is GONE for ${email === TAKEN ? 'a REAL' : 'an unknown'} address (404)`,
        'got ' + r.status);
      // Belt and braces: even if some future catch-all answered, no boolean.
      const blob = JSON.stringify(r.body || {});
      ok(!/"exists"\s*:/.test(blob), 'and no exists boolean appears in the body', blob.slice(0, 120));
    }

    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'routes', 'users.js'), 'utf8');
    ok(!/router\.post\(\s*['"]\/check-email/.test(src),
      'no route definition for /check-email remains in the source');
    ok(/DELETED: POST \/check-email/.test(src),
      'and a tombstone comment records why, so it is not re-added by reflex');

    // The whole point: no OTHER endpoint answers the same question.
    ok(!/res\.json\(\{\s*exists/.test(src) && !/exists:\s*rows\.length/.test(src),
      'nothing else in users.js returns an account-exists boolean');

    // ================= SIGNUP STILL REFUSES A DUPLICATE ==================
    head('A TAKEN ADDRESS IS REFUSED, CLEARLY, BY /register ITSELF');
    const dupe = await request(app).post('/api/user/register').send({
      name: 'Dupe Person', email: TAKEN, password: 'Passw0rd!x',
      mobile: '(555) 010-2020', category: 4, subcategory: 14,
    });
    note(`duplicate signup -> HTTP ${dupe.status} ${JSON.stringify(dupe.body)}`);
    ok(dupe.status === 409 || dupe.body.code === '409',
      'registration refuses it', 'HTTP ' + dupe.status);
    ok(/already registered/i.test(dupe.body.message || ''),
      'with a message that says the address is already registered', dupe.body.message);
    ok(/sign in/i.test(dupe.body.message || ''),
      'AND tells the person what to do instead — the old text named two fields and offered no way out',
      dupe.body.message);
    ok(dupe.body.field === 'email',
      'and identifies WHICH field, so the form can mark the right control', String(dupe.body.field));

    // ================= A FRESH SIGNUP STILL WORKS ========================
    head('A FRESH SIGNUP STILL WORKS END TO END — this is how customers arrive');
    const FRESH = 'brand-new-7c31@example.com';
    const fresh = await request(app).post('/api/user/register').send({
      name: 'Fresh Person', email: FRESH, password: 'Passw0rd!x',
      mobile: '(555) 010-3030', category: 4, subcategory: 14,
    });
    note(`fresh signup -> HTTP ${fresh.status} ${JSON.stringify(fresh.body).slice(0, 140)}`);
    ok(String(fresh.body.code) === '201' || fresh.status === 201 || fresh.status === 200,
      'registration succeeds', 'HTTP ' + fresh.status + ' ' + JSON.stringify(fresh.body).slice(0, 120));

    // ASSERT THE STORED ROW, not the response: a 201 says what the handler
    // claimed, the row says whether the customer actually exists.
    const [[row]] = await conn.query('SELECT id, email, status FROM `user` WHERE email = ?', [FRESH]);
    ok(!!row, 'AND THE STORED ROW EXISTS — the account was really created', 'no row for ' + FRESH);
    ok(row && Number(row.status) === 1, 'and it is active', row && String(row.status));
    note('mail is deliberately misconfigured in this suite, so this also proves');
    note('a signup is not lost when the welcome/OTP mail cannot be sent.');

    // And a second fresh address, to be sure the first was not a fluke of ordering.
    const FRESH2 = 'brand-new-9d42@example.com';
    await request(app).post('/api/user/register').send({
      name: 'Second Person', email: FRESH2, password: 'Passw0rd!x',
      mobile: '(555) 010-4040', category: 4, subcategory: 14,
    });
    const [[row2]] = await conn.query('SELECT id FROM `user` WHERE email = ?', [FRESH2]);
    ok(!!row2, 'a second fresh signup also lands a row');

    // ================= NOTHING SIDEWAYS =================================
    head('NO OTHER ACCOUNT WAS AFFECTED');
    const [[beta]] = await conn.query('SELECT email, status FROM `user` WHERE id = 200');
    ok(beta.email === 'beta@example.com' && Number(beta.status) === 1,
      "the other company's owner row is untouched", JSON.stringify(beta));

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
