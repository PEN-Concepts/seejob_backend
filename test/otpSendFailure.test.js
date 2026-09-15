/* OTP SEND FAILURE — the failure path, which is the whole point.
 *
 * Run against a DELIBERATELY BROKEN mail transport (an unreachable host), not
 * only a working one. A green run on the success path proves nothing about
 * what happens when the send dies, which is the case that cost an evening.
 *
 * The three claims:
 *
 *   1. A failed send is REPORTED. The route no longer says "OTP sent" when
 *      nothing was sent.
 *   2. The unknown-account response is BYTE FOR BYTE what it was before —
 *      status, body and the headers that carry meaning. Checked by capturing
 *      the pre-change behaviour as a literal, not by re-deriving it.
 *   3. No email address reaches any response body or any log line.
 *
 * Two companies are seeded so "this account" and "every account" cannot be
 * confused, consistent with the other auth tests here.
 *
 * Run: node test/otpSendFailure.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);
const head = (m) => rec.push('\n' + m);

(async () => {
  let db, pool, conn;
  const logLines = [];
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    // THE BROKEN MAIL CONFIG. A host that cannot be reached, with the
    // fail-fast timeouts the mailer already sets, so sendMail rejects rather
    // than hanging the suite.
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';          // nothing listens here
    process.env.SMTP_USER = 'test@example.invalid';
    process.env.SMTP_PASS = 'not-a-real-secret';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_otpsend_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');

    // Capture every log line so we can prove no address is written.
    const logger = require('../common/logger');
    for (const lvl of ['error', 'warn', 'info']) {
      const orig = logger[lvl] && logger[lvl].bind(logger);
      if (orig) logger[lvl] = (...a) => { logLines.push(a.map(String).join(' ')); };
    }

    await conn.query(`CREATE TABLE \`user\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120), email VARCHAR(190) UNIQUE, password VARCHAR(190),
      image VARCHAR(190) NULL, status INT DEFAULT 1, role INT NULL, category INT NULL,
      otp VARCHAR(10) NULL, otp_status INT DEFAULT 0, created_by INT NULL,
      must_change_password INT DEFAULT 0, pin_hash VARCHAR(190) NULL, pin_enabled INT DEFAULT 0,
      token_version INT NOT NULL DEFAULT 0,
      updated_at DATETIME NULL, updated_by INT NULL, created_at DATETIME NULL)`);
    await conn.query('CREATE TABLE role_right_permission (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, right_id INT, `read` INT DEFAULT 1, `create` INT DEFAULT 1, `update` INT DEFAULT 1, `delete` INT DEFAULT 1)');
    await conn.query(`CREATE TABLE user_devices (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, device_token VARCHAR(190), user_agent VARCHAR(255) NULL)`);

    const ACME = 'aemp@example.invalid', BETA = 'bemp@example.invalid';
    await conn.query(
      `INSERT INTO \`user\` (id,name,email,status,role,category,created_by,created_at) VALUES
       (100,'Acme Owner','acme@example.invalid',1,14,4,NULL,NOW()),
       (101,'Acme Employee',?,1,2,1,100,NOW()),
       (200,'Beta Owner','beta@example.invalid',1,14,4,NULL,NOW()),
       (201,'Beta Employee',?,1,2,1,200,NOW())`, [ACME, BETA]);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/user', require('../routes/users'));

    const otpReq = (email) => request(app).post('/api/user/login-otp-request').send({ email });

    // ================= 1. A FAILED SEND IS REPORTED =======================
    head('A FAILED SEND IS REPORTED (mail host unreachable)');
    const r = await otpReq(ACME);
    note(`response: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    ok(r.body.code !== '200',
      'the route NO LONGER claims "OTP sent" when nothing was sent', JSON.stringify(r.body));
    ok(/could not send/i.test(r.body.message || ''),
      'it tells the user the code could not be sent', r.body.message);

    // The message must not leak our infrastructure.
    const msg = String(r.body.message || '');
    ok(!/smtp|nodemailer|econnrefused|550|relay|timeout|127\.0\.0\.1|port/i.test(msg),
      'and names no SMTP detail, provider, host or bounce reason', msg);
    ok(!msg.includes(ACME) && !/@/.test(msg),
      'and carries no email address', msg);

    // ================= 2. NO ENUMERATION CHANGE ==========================
    head('THE UNKNOWN-ACCOUNT RESPONSE IS UNCHANGED, BYTE FOR BYTE');
    // The literal below is what this endpoint returned BEFORE this change for
    // an address with no account. Pinned as a literal on purpose: re-deriving
    // it from the code under test would pass no matter what the code did.
    const BASELINE_BODY = '{"code":"404","message":"Email does not exist","data":{}}';
    const BASELINE_STATUS = 200;

    const unknown = await otpReq('nobody-here-8fa2@example.invalid');
    note(`unknown account: HTTP ${unknown.status} ${JSON.stringify(unknown.body)}`);
    ok(unknown.status === BASELINE_STATUS,
      'status is unchanged', 'got ' + unknown.status);
    ok(JSON.stringify(unknown.body) === BASELINE_BODY,
      'body is byte-for-byte unchanged', JSON.stringify(unknown.body));
    ok(String(unknown.headers['content-type'] || '').includes('application/json'),
      'content-type still application/json', unknown.headers['content-type']);

    // ================= 3. NOTHING SIDEWAYS ===============================
    head('NO OTHER ACCOUNT IS AFFECTED');
    const [[beta]] = await conn.query('SELECT otp, otp_status FROM `user` WHERE id = 201');
    ok(beta.otp == null && Number(beta.otp_status) === 0,
      "Beta's row was never touched by Acme's request", JSON.stringify(beta));

    // ================= 4. NO ADDRESS IN THE LOG ==========================
    head('NO EMAIL ADDRESS REACHES THE LOG');
    const blob = logLines.join('\n');
    note(`${logLines.length} log lines captured`);
    ok(!blob.includes(ACME) && !blob.includes(BETA),
      'no address appears in any log line written during these requests',
      blob.split('\n').filter((l) => /@/.test(l)).join(' | ').slice(0, 160));
    ok(/user id 101/.test(blob),
      'the failure is attributed by USER ID instead, which is what makes it actionable',
      blob.slice(-200));
    ok(!/not-a-real-secret/.test(blob),
      'and no credential is written to the log');

    // ================= 5. THE ROW STILL GOT ITS CODE =====================
    head('CODE GENERATION AND STORAGE ARE UNCHANGED');
    const [[acme]] = await conn.query('SELECT otp, otp_status FROM `user` WHERE id = 101');
    ok(acme.otp != null && String(acme.otp).length > 0 && Number(acme.otp_status) === 1,
      'the code is still generated and stored exactly as before — only the REPORTING changed',
      JSON.stringify(acme));
    note('a failed send therefore leaves a live code on the row; unchanged behaviour, reported.');

    // ================= 6. SUCCESS PATH STILL WORKS =======================
    head('A SUCCESSFUL SEND STILL WORKS, UNCHANGED');
    // Swap the transport for one that resolves, without touching the route.
    const mailer = require('../services/mailer');
    const realSend = mailer.transporter.sendMail;
    mailer.transporter.sendMail = async () => ({ accepted: ['x'] });

    const good = await otpReq(BETA);
    ok(good.body.code === '200' && good.body.message === 'OTP sent',
      'a working transport still returns exactly "OTP sent"', JSON.stringify(good.body));
    const [[beta2]] = await conn.query('SELECT otp, otp_status FROM `user` WHERE id = 201');
    ok(beta2.otp != null && Number(beta2.otp_status) === 1,
      'AND THE STORED ROW carries the new code', JSON.stringify(beta2));

    // ================= 7. EXPIRED vs WRONG ===============================
    head('EXPIRED AND INCORRECT CODES READ DIFFERENTLY');
    const code = String(beta2.otp).padStart(4, '0');
    const verify = (email, otp) => request(app).post('/api/user/login-otp-verify').send({ email, otp });

    const wrong = await verify(BETA, code === '1111' ? '2222' : '1111');
    ok(/not correct/i.test(wrong.body.message || ''),
      'a WRONG code says the code is not correct', wrong.body.message);

    // Age the row past the 3-minute window. The code itself is untouched.
    await conn.query('UPDATE `user` SET updated_at = (NOW() - INTERVAL 10 MINUTE) WHERE id = 201');
    const stale = await verify(BETA, code);
    ok(/expired/i.test(stale.body.message || ''),
      'the SAME code, aged past 3 minutes, says expired', stale.body.message);
    ok(wrong.body.message !== stale.body.message,
      'and the two messages genuinely differ');

    // The expiry window itself must not have moved.
    await conn.query('UPDATE `user` SET updated_at = NOW() WHERE id = 201');
    const fresh = await verify(BETA, code);
    ok(fresh.body.code === '200',
      'a fresh code still verifies — the 3-minute window was not changed',
      JSON.stringify(fresh.body).slice(0, 120));

    mailer.transporter.sendMail = realSend;

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
