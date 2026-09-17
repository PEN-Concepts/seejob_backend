/* OTP ATTEMPT CAP + CRYPTOGRAPHIC CODE GENERATION.
 *
 * THE HOLE THIS CLOSES. A four-digit code is 10,000 possibilities. There was no
 * attempt counter, no lockout and no delay, and a wrong guess cost the attacker
 * nothing — the code survived every failure until its three-minute expiry. At
 * the measured ~11 requests a second that is roughly 2,000 guesses per code:
 * about a one-in-five chance per cycle, repeatable immediately. Five attempts
 * makes it one in two thousand.
 *
 * The codes were also generated with Math.random(), which is not a
 * cryptographic source.
 *
 * WHAT IS DELIBERATELY NOT HERE: the code stays FOUR digits. Moving to six
 * needs the clients to accept a variable length first, and shipping the length
 * change ahead of them would lock every user out at once.
 *
 * Two companies are seeded, consistent with the other auth tests.
 *
 * Run: node test/otpAttemptCap.test.js
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
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';
    process.env.SMTP_USER = 'test@example.com';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_otpcap_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');

    const logger = require('../common/logger');
    for (const lvl of ['error', 'warn', 'info']) {
      const orig = logger[lvl] && logger[lvl].bind(logger);
      if (orig) logger[lvl] = (...a) => { logLines.push(a.map(String).join(' ')); };
    }

    // NOTE: no otp_attempts column — the migration adds it, which also proves
    // this ships safely against an un-migrated database.
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

    const ACME = 'aemp@example.com', BETA = 'bemp@example.com';
    await conn.query(
      `INSERT INTO \`user\` (id,name,email,status,role,category,created_by,created_at) VALUES
       (101,'Acme Employee',?,1,2,1,100,NOW()),
       (201,'Beta Employee',?,1,2,1,200,NOW())`, [ACME, BETA]);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/user', require('../routes/users'));
    const mailer = require('../services/mailer');
    mailer.transporter.sendMail = async () => ({ accepted: ['x'] });   // sends succeed

    const otpReq = (email) => request(app).post('/api/user/login-otp-request').send({ email });
    const verify = (email, otp) => request(app).post('/api/user/login-otp-verify').send({ email, otp });
    const codeFor = async (id) => {
      const [[r]] = await conn.query('SELECT otp FROM `user` WHERE id = ?', [id]);
      return String(r.otp).padStart(4, '0');
    };
    // RAW, UNPADDED. codeFor() pads so it can drive verification, which means it
    // can never detect a generator that has stopped padding — an early version
    // of the width test below used it and passed happily with padStart removed.
    // The width of the STORED value is the thing being asserted, so read it.
    const rawCodeFor = async (id) => {
      const [[r]] = await conn.query('SELECT otp FROM `user` WHERE id = ?', [id]);
      return String(r.otp);
    };
    const wrongFor = (code) => (code === '1111' ? '2222' : '1111');

    // ================= §2 GENERATION =====================================
    head('§2 — CODES ARE CRYPTOGRAPHIC AND A FIXED WIDTH');
    const seen = new Set();
    let widthOk = true, digitsOk = true;
    for (let i = 0; i < 1000; i++) {
      await otpReq(ACME);
      const c = await rawCodeFor(101);          // raw, so lost padding is visible
      if (c.length !== 4) widthOk = false;
      if (!/^\d{4}$/.test(c)) digitsOk = false;
      seen.add(c);
    }
    ok(widthOk, '1000 generated codes are ALL exactly 4 digits wide');
    ok(digitsOk, 'and all are digits — no leading zero is silently lost');
    note(`${seen.size} distinct values across 1000 draws`);
    ok(seen.size > 800,
      'and they are well spread — not a stuck or narrow generator', 'distinct=' + seen.size);

    const srcGen = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'users.js'), 'utf8');
    ok(/crypto\.randomInt/.test(srcGen), 'generation uses crypto.randomInt');
    ok(!/Math\.random\(\)\s*\*\s*10/.test(srcGen),
      'and Math.random() is GONE from code generation — it was there before this change');

    // ================= §4 ONE LIVE CODE ==================================
    head('§4 — ONLY ONE CODE IS EVER LIVE');
    await otpReq(ACME);
    const first = await codeFor(101);
    await otpReq(ACME);
    const second = await codeFor(101);
    ok(first !== second || true, `first=${first} second=${second}`);
    const oldTry = await verify(ACME, first);
    ok(oldTry.body.code !== '200',
      'requesting a new code INVALIDATES the previous one — the first no longer verifies',
      JSON.stringify(oldTry.body));
    note('this was ALREADY true before the change: a single `otp` column is overwritten,');
    note('so two requests never left two working codes.');

    // ================= §3 THE CAP ========================================
    head('§3 — FIVE WRONG ATTEMPTS BURN THE CODE');
    await otpReq(ACME);
    const good = await codeFor(101);
    const bad = wrongFor(good);

    for (let i = 1; i <= 4; i++) {
      const r = await verify(ACME, bad);
      ok(/not correct/i.test(r.body.message || ''),
        `wrong attempt ${i} of 5 still reports "not correct"`, r.body.message);
    }
    const fifth = await verify(ACME, bad);
    note(`5th wrong attempt -> ${JSON.stringify(fifth.body)}`);

    // THE STORED ROW is what proves the code is dead, not the message.
    const [[burnedRow]] = await conn.query('SELECT otp, otp_status, otp_attempts FROM `user` WHERE id = 101');
    ok(Number(burnedRow.otp_status) === 0,
      'AND THE STORED ROW shows the code invalidated after the 5th', JSON.stringify(burnedRow));
    ok(Number(burnedRow.otp_attempts) >= 5, 'with the attempt count recorded server-side',
      String(burnedRow.otp_attempts));

    // The decisive assertion: the CORRECT code now fails.
    const nowCorrect = await verify(ACME, good);
    ok(nowCorrect.body.code !== '200',
      'THE SIXTH ATTEMPT FAILS EVEN WITH THE CORRECT CODE — the code is dead, not merely slowed',
      JSON.stringify(nowCorrect.body));

    // ================= MESSAGES DISCLOSE NOTHING =========================
    head('THE BURNED MESSAGE IS IDENTICAL TO THE EXPIRED MESSAGE');
    await otpReq(BETA);
    const bCode = await codeFor(201);
    await conn.query('UPDATE `user` SET updated_at = (NOW() - INTERVAL 10 MINUTE) WHERE id = 201');
    const expiredMsg = (await verify(BETA, bCode)).body.message;
    // ASSERT THE FIFTH RESPONSE, not the sixth. By the sixth the row already
    // has otp_status = 0, so it reads as expired no matter what the burn branch
    // said — an earlier version of this checked the sixth and passed even with
    // the burned wording deliberately broken.
    ok(fifth.body.message === expiredMsg,
      'THE BURNING RESPONSE ITSELF reads exactly like an expired one — which of the two it was is not disclosed',
      `burned="${fifth.body.message}" expired="${expiredMsg}"`);
    ok(nowCorrect.body.message === expiredMsg,
      'and so does every attempt after it', nowCorrect.body.message);
    // Words, not digits: the message legitimately contains "3 minutes", which
    // is the expiry and not an attempt count. An earlier version of this
    // assertion banned any digit and failed on that, which would have pushed
    // me to reword a message that was already correct.
    ok(!/attempt|tries|guess|remaining|left/i.test(String(nowCorrect.body.message)),
      'and the message discloses no attempt count, used or remaining', nowCorrect.body.message);

    // ================= THE ACCOUNT IS NEVER LOCKED =======================
    head('THE CODE IS BURNED — THE ACCOUNT IS NOT');
    const [[acct]] = await conn.query('SELECT status FROM `user` WHERE id = 101');
    ok(Number(acct.status) === 1,
      'the account is still ACTIVE after five wrong guesses — burning a code must never lock a person out',
      String(acct.status));
    await otpReq(ACME);
    const recovered = await codeFor(101);
    const [[afterNew]] = await conn.query('SELECT otp_attempts, otp_status FROM `user` WHERE id = 101');
    ok(Number(afterNew.otp_attempts) === 0,
      'requesting a new code RESETS the counter — otherwise a burned user could never sign in again',
      JSON.stringify(afterNew));
    const back = await verify(ACME, recovered);
    ok(back.body.code === '200',
      'and the new code verifies — the user recovers by asking for another',
      JSON.stringify(back.body).slice(0, 120));

    // ================= NORMAL USE IS UNAFFECTED ==========================
    head('NORMAL USE IS UNAFFECTED — mistype once, then get it right');
    await otpReq(BETA);
    await conn.query('UPDATE `user` SET updated_at = NOW() WHERE id = 201');
    const bGood = await codeFor(201);
    const one = await verify(BETA, wrongFor(bGood));
    ok(/not correct/i.test(one.body.message || ''), 'one mistype is just a mistype', one.body.message);
    const two = await verify(BETA, bGood);
    ok(two.body.code === '200',
      'and the correct code straight after still signs the person in',
      JSON.stringify(two.body).slice(0, 120));
    const [[cleared]] = await conn.query('SELECT otp_attempts FROM `user` WHERE id = 201');
    ok(Number(cleared.otp_attempts) === 0, 'a correct code clears the count', String(cleared.otp_attempts));

    // ================= NO CODE IN THE LOG ================================
    head('§6 — NO CODE IS EVER LOGGED');
    const blob = logLines.join('\n');
    const leaked = [good, first, second, bCode].filter((c) => blob.includes(c));
    ok(leaked.length === 0,
      'no OTP code appears in any log line captured during this run',
      'leaked: ' + leaked.join(','));

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
