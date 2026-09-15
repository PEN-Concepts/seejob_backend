/* THE COUNTER MUST NEVER BE THE THING THAT BREAKS SIGN-IN.
 *
 * otp_attempts is added by a migration whose call site is wrapped in a try. If
 * that ALTER ever fails — permissions, a locked table, a database restored from
 * an older dump — every statement that writes otp_attempts would throw, and
 * "request a code" would become a 500 for EVERY user. That is an outage worse
 * than the hole the counter closes.
 *
 * So this runs the OTP paths against a database where the column CANNOT exist,
 * by stubbing the migration to a no-op before the routes are loaded, and
 * asserts that sign-in still works end to end. It deliberately never queries
 * otp_attempts itself — the whole point is what the ROUTES do without it.
 *
 * Run: node test/otpAttemptCapFallback.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';
    process.env.SMTP_USER = 'test@example.com';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_otpfallback_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');

    // THE MIGRATION IS STUBBED OUT *BEFORE* THE ROUTES ARE REQUIRED. The route
    // module destructures this function at import time, so patching the export
    // first is what makes the routes see a no-op. The column therefore never
    // appears, exactly as it would if the ALTER had failed in production.
    const migrations = require('../services/dbMigrations');
    migrations.ensureOtpAttemptsColumn = async () => {};

    await conn.query(`CREATE TABLE \`user\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120), email VARCHAR(190) UNIQUE, password VARCHAR(190),
      image VARCHAR(190) NULL, status INT DEFAULT 1, role INT NULL, category INT NULL,
      otp VARCHAR(10) NULL, otp_status INT DEFAULT 0, created_by INT NULL,
      must_change_password INT DEFAULT 0, pin_hash VARCHAR(190) NULL, pin_enabled INT DEFAULT 0,
      token_version INT NOT NULL DEFAULT 0,
      updated_at DATETIME NULL, updated_by INT NULL, created_at DATETIME NULL)`);
    await conn.query('CREATE TABLE role_right_permission (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, right_id INT, `read` INT DEFAULT 1, `create` INT DEFAULT 1, `update` INT DEFAULT 1, `delete` INT DEFAULT 1)');
    await conn.query('CREATE TABLE user_devices (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, device_token VARCHAR(190), user_agent VARCHAR(255) NULL)');

    const WHO = 'nocol@example.com';
    await conn.query(
      "INSERT INTO `user` (id,name,email,status,role,category,created_by,created_at) VALUES (101,'No Column',?,1,2,1,100,NOW())",
      [WHO]);

    // Confirm the premise: the column really is absent.
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'otp_attempts'`);
    ok(cols.length === 0, 'PREMISE: otp_attempts does not exist on this database');

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/user', require('../routes/users'));
    require('../services/mailer').transporter.sendMail = async () => ({ accepted: ['x'] });

    // ---- the two things that must not break ----
    const req1 = await request(app).post('/api/user/login-otp-request').send({ email: WHO });
    note(`request -> HTTP ${req1.status} ${JSON.stringify(req1.body)}`);
    ok(req1.body.code === '200',
      'REQUESTING A CODE STILL WORKS without the counter column — not a 500',
      JSON.stringify(req1.body));

    const [[row]] = await conn.query('SELECT otp, otp_status FROM `user` WHERE id = 101');
    ok(row.otp && Number(row.otp_status) === 1,
      'AND THE STORED ROW carries the code, so the fallback wrote it', JSON.stringify(row));

    const code = String(row.otp).padStart(4, '0');
    const wrong = code === '1111' ? '2222' : '1111';

    // A wrong guess must not 500 either, even though it cannot be counted.
    const bad = await request(app).post('/api/user/login-otp-verify').send({ email: WHO, otp: wrong });
    ok(bad.body.code === '400',
      'a wrong code is still refused cleanly, not a 500 — the cap simply cannot be enforced',
      JSON.stringify(bad.body));

    const good = await request(app).post('/api/user/login-otp-verify').send({ email: WHO, otp: code });
    note(`verify -> HTTP ${good.status} code=${good.body.code}`);
    ok(good.body.code === '200',
      'AND A CORRECT CODE STILL SIGNS THE PERSON IN — the safety feature never becomes the outage',
      JSON.stringify(good.body).slice(0, 140));

    const [[after]] = await conn.query('SELECT otp_status FROM `user` WHERE id = 101');
    ok(Number(after.otp_status) === 0,
      'and the used code was cleared, via the fallback on that write too', JSON.stringify(after));

    note('WITHOUT the column the cap cannot be enforced — that is expected and');
    note('is why the migration matters. What this proves is the DEGRADED mode is');
    note('a working sign-in, not a locked-out product.');

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
