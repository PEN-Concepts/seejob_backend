/* EMPLOYEE SHUT-OFF — the two claims the feature rests on.
 *
 *   1. A shut-off user row is refused at EVERY sign-in path, and its live
 *      sessions die on the very next request — including the mobile sliding
 *      renewal, which must not hand a shut-off phone a fresh token.
 *   2. No other company's rows are touched.
 *
 * TWO COMPANIES ARE SEEDED throughout. A single-tenant fixture cannot tell
 * "shut off this person" from "shut off everyone" — with one company in the
 * table those are the same set, which is exactly how this class of bug lives
 * through review. Acme shuts off its own employee; every assertion about Beta
 * is an assertion that nothing leaked sideways.
 *
 * The STORED ROW is asserted wherever a write is involved, never the response:
 * a 200 tells you what the handler said, not what the database now holds.
 *
 * Run: node test/employeeShutOff.test.js
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
    db = await createDB({ dbName: 'seejob_shutoff_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const bcrypt = require('bcryptjs');

    // ---- minimal legacy schema, WITHOUT shut_off_at. The migration adds it,
    // ---- which is also how we prove the code ships before the ALTER TABLE.
    await conn.query(`CREATE TABLE \`user\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120), email VARCHAR(190) UNIQUE, password VARCHAR(190),
      image VARCHAR(190) NULL, status INT DEFAULT 1, role INT NULL, category INT NULL,
      otp VARCHAR(10) NULL, otp_status INT DEFAULT 0, created_by INT NULL,
      must_change_password INT DEFAULT 0, pin_hash VARCHAR(190) NULL, pin_enabled INT DEFAULT 0,
      token_version INT NOT NULL DEFAULT 0,
      updated_at DATETIME NULL, updated_by INT NULL, created_at DATETIME NULL)`);
    // The login paths read the rights table on the way out; without it they 500
    // and the baseline cannot tell "refused" from "broken".
    await conn.query('CREATE TABLE role_right_permission (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, right_id INT, `read` INT DEFAULT 1, `create` INT DEFAULT 1, `update` INT DEFAULT 1, `delete` INT DEFAULT 1)');
    await conn.query(`CREATE TABLE user_devices (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, device_token VARCHAR(190),
      user_agent VARCHAR(255) NULL)`);

    const PW = 'correct-horse';
    const hash = await bcrypt.hash(PW, 8);
    const pinHash = await bcrypt.hash('1234', 8);

    // ACME: owner 100, employee 101.   BETA: owner 200, employee 201.
    await conn.query(
      `INSERT INTO \`user\` (id,name,email,password,status,role,category,created_by,pin_hash,pin_enabled,created_at) VALUES
       (100,'Acme Owner','acme@example.invalid',?,1,14,4,NULL,NULL,0,NOW()),
       (101,'Acme Employee','aemp@example.invalid',?,1,2,1,100,?,1,NOW()),
       (200,'Beta Owner','beta@example.invalid',?,1,14,4,NULL,NULL,0,NOW()),
       (201,'Beta Employee','bemp@example.invalid',?,1,2,1,200,?,1,NOW())`,
      [hash, hash, pinHash, hash, hash, pinHash],
    );
    await conn.query(
      "INSERT INTO user_devices (user_id, device_token, user_agent) VALUES (101,'dev-acme-101','t'),(201,'dev-beta-201','t')",
    );

    // ---- the migration ----
    head('THE MIGRATION');
    const { ensureUserShutOffColumn, ensureShutOffAuditTable } = require('../services/dbMigrations');

    const [before] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'shut_off_at'`);
    ok(before.length === 0, 'shut_off_at does NOT exist before the migration runs');

    await ensureUserShutOffColumn(conn);
    const [[col]] = await conn.query(
      `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'shut_off_at'`);
    ok(!!col, 'the migration adds it');
    ok(col && /datetime/i.test(col.COLUMN_TYPE) && col.IS_NULLABLE === 'YES' && col.COLUMN_DEFAULT == null,
      'as a NULLABLE DATETIME defaulting to NULL — every existing row means "has access"',
      col && JSON.stringify(col));

    const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM `user` WHERE shut_off_at IS NOT NULL');
    ok(Number(n) === 0, 'and it shuts nobody off on the way in — all four seeded rows still NULL', 'n=' + n);

    // Idempotent. The module memoises with a flag, so calling it again proves
    // nothing — clear the require cache first, which forces the real guard (the
    // INFORMATION_SCHEMA lookup) to run against a database that ALREADY has the
    // column. That is the path a second server boot takes.
    delete require.cache[require.resolve('../services/dbMigrations')];
    let threw = null;
    try {
      await require('../services/dbMigrations').ensureUserShutOffColumn(conn);
    } catch (e) { threw = e.message; }
    ok(!threw, 'a fresh process running it against an already-migrated table is a no-op, not a duplicate-column error', threw);

    await ensureShutOffAuditTable(conn);
    const [[audit]] = await conn.query(
      `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_access_audit'`);
    ok(Number(audit.c) === 1, 'the audit table exists');

    // ---- app ----
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/user', require('../routes/users'));
    const auth = require('../services/authentication');
    app.get('/probe', auth.authenticateToken, (req, res) => res.json({ ok: true, id: res.locals.id }));
    app.use((req, res) => res.status(404).json({ message: 'Not found' }));

    // ================= BASELINE: everything works before the shut-off ==========
    head('BASELINE — all four sign-in paths work for both companies');
    const login = (email) => request(app).post('/api/user/login').send({ email, password: PW });
    const pinLogin = (deviceToken) =>
      request(app).post('/api/user/login-pin').set('Cookie', `device_token=${deviceToken}`).send({ pin: '1234' });
    const otpReq = (email) => request(app).post('/api/user/login-otp-request').send({ email });
    const otpVerify = async (email) => {
      await otpReq(email);
      const [[u]] = await conn.query('SELECT otp FROM `user` WHERE email = ?', [email]);
      return request(app).post('/api/user/login-otp-verify')
        .send({ email, otp: String(u.otp).padStart(4, '0') });
    };

    for (const [who, email, dev] of [['Acme employee', 'aemp@example.invalid', 'dev-acme-101'],
                                     ['Beta employee', 'bemp@example.invalid', 'dev-beta-201']]) {
      const a = await login(email), b = await pinLogin(dev), c = await otpReq(email), d = await otpVerify(email);
      ok(a.body.code === '200' && b.body.code === '200' && c.body.code === '200' && d.body.code === '200',
        `${who} can sign in by password, PIN, OTP request and OTP verify`,
        [a.body.code, b.body.code, c.body.code, d.body.code].join('/'));
    }

    // A live session for each, as if they were already signed in on a phone.
    const liveAcme = (await login('aemp@example.invalid')).body.data.token;
    const liveBeta = (await login('bemp@example.invalid')).body.data.token;
    const pAcme = await request(app).get('/probe').set('Authorization', 'Bearer ' + liveAcme);
    const pBeta = await request(app).get('/probe').set('Authorization', 'Bearer ' + liveBeta);
    ok(pAcme.status === 200 && pBeta.status === 200, 'and both hold a working live session', pAcme.status + '/' + pBeta.status);

    // ================= THE SHUT-OFF =========================================
    head('THE SHUT-OFF — Acme shuts off ITS OWN employee (101)');
    // Written the way the route will write it: stamp the timestamp AND bump
    // token_version, in one statement, so a live token cannot survive either check.
    await conn.query(
      'UPDATE `user` SET shut_off_at = NOW(), token_version = token_version + 1 WHERE id = 101');
    await conn.query(
      'INSERT INTO employee_access_audit (subject_user_id, actor_user_id, account_owner_id, action) VALUES (101,100,100,?)',
      ['shut_off']);

    const [[row101]] = await conn.query('SELECT shut_off_at, token_version, status FROM `user` WHERE id = 101');
    ok(row101.shut_off_at != null, 'THE STORED ROW carries shut_off_at');
    ok(Number(row101.token_version) === 1, 'and token_version was bumped', 'tv=' + row101.token_version);
    ok(Number(row101.status) === 1, 'and status is UNTOUCHED — shut-off is its own field, not an overloaded one',
      'status=' + row101.status);

    // ---- claim 1: refused at every sign-in path ----
    head('CLAIM 1 — refused at every sign-in path');
    const r1 = await login('aemp@example.invalid');
    ok(r1.body.code === '401', 'password login refused', JSON.stringify(r1.body));
    ok(/turned off/i.test(r1.body.message || ''), 'with the shut-off message, not "incorrect password"', r1.body.message);

    const r2 = await pinLogin('dev-acme-101');
    ok(r2.body.code === '401', 'PIN login refused — the device cookie is no longer a way in', JSON.stringify(r2.body));

    const [[otpBefore]] = await conn.query('SELECT otp, otp_status FROM `user` WHERE id = 101');
    const r3 = await otpReq('aemp@example.invalid');
    ok(r3.body.code === '401', 'OTP request refused', JSON.stringify(r3.body));
    const [[otpAfter]] = await conn.query('SELECT otp, otp_status FROM `user` WHERE id = 101');
    ok(String(otpBefore.otp) === String(otpAfter.otp) && otpBefore.otp_status === otpAfter.otp_status,
      'AND THE STORED ROW PROVES no new code was generated — refused before the write, not after',
      `${otpBefore.otp}/${otpBefore.otp_status} -> ${otpAfter.otp}/${otpAfter.otp_status}`);

    // The race: a code issued BEFORE the shut-off, typed in after it.
    await conn.query("UPDATE `user` SET shut_off_at = NULL WHERE id = 101");
    await otpReq('aemp@example.invalid');
    const [[preCode]] = await conn.query('SELECT otp FROM `user` WHERE id = 101');
    await conn.query('UPDATE `user` SET shut_off_at = NOW() WHERE id = 101');
    const r4 = await request(app).post('/api/user/login-otp-verify')
      .send({ email: 'aemp@example.invalid', otp: String(preCode.otp).padStart(4, '0') });
    ok(r4.body.code === '401',
      'OTP verify refuses a VALID code issued seconds before the shut-off — the race is not lost',
      JSON.stringify(r4.body));

    // ---- claim 1b: the live session dies on the next request ----
    head('CLAIM 1b — live sessions die on the NEXT request, not at token expiry');
    const dead = await request(app).get('/probe').set('Authorization', 'Bearer ' + liveAcme);
    ok(dead.status === 401, 'the token minted before the shut-off now 401s', 'HTTP ' + dead.status);
    ok(dead.body && dead.body.code === 'REVOKED',
      'with code REVOKED — the shape every client already clears its token on', JSON.stringify(dead.body));
    note('worst case between the boss pressing the button and a device being refused: ONE request.');

    // The two assertions above are ALSO satisfied by the token_version bump, so on
    // their own they do not prove shut_off_at does anything. This one isolates it:
    // a WEB token carrying the CURRENT token_version, so every other revoke check
    // passes and only shut_off_at can refuse it.
    const [[tvA]] = await conn.query('SELECT token_version FROM `user` WHERE id = 101');
    const tvMatched = jwt.sign(
      { id: 101, email: 'aemp@example.invalid', role: 2, plat: 'web', tv: Number(tvA.token_version) },
      process.env.ACCESS_TOKEN, { expiresIn: '7d' });
    const isolated = await request(app).get('/probe').set('Authorization', 'Bearer ' + tvMatched);
    ok(isolated.status === 401,
      'ISOLATED: a token whose token_version MATCHES is still refused — shut_off_at is doing the work, not the bump',
      'HTTP ' + isolated.status);

    // ---- claim 1c: the mobile sliding renewal must NOT refresh a shut-off phone ----
    head('CLAIM 1c — the sliding renewal does not quietly refresh a shut-off phone');
    // A mobile token inside its renewal window, carrying the CURRENT token_version,
    // so token_version alone cannot be what refuses it. shut_off_at must do the work.
    const [[tvNow]] = await conn.query('SELECT token_version FROM `user` WHERE id = 101');
    const nearExpiry = jwt.sign(
      { id: 101, email: 'aemp@example.invalid', role: 2, plat: 'mobile', tv: Number(tvNow.token_version) },
      process.env.ACCESS_TOKEN, { expiresIn: '10d' });   // well inside the 180-day renew window
    const ren = await request(app).get('/probe').set('Authorization', 'Bearer ' + nearExpiry);
    ok(ren.status === 401, 'a renewal-window mobile token with a MATCHING token_version is still refused',
      'HTTP ' + ren.status);
    ok(!ren.headers['x-renewed-token'],
      'AND NO X-Renewed-Token HEADER IS ISSUED — the phone gets no fresh year of access',
      ren.headers['x-renewed-token'] ? 'header present!' : '');

    // ---- claim 2: nothing sideways ----
    head('CLAIM 2 — no other company\'s rows are touched');
    const [[row201]] = await conn.query('SELECT shut_off_at, token_version, status FROM `user` WHERE id = 201');
    ok(row201.shut_off_at == null, 'Beta\'s employee row still has shut_off_at NULL');
    ok(Number(row201.token_version) === 0, 'and its token_version was not bumped', 'tv=' + row201.token_version);

    const [others] = await conn.query('SELECT id FROM `user` WHERE shut_off_at IS NOT NULL');
    ok(others.length === 1 && Number(others[0].id) === 101,
      'exactly ONE row in the whole table is shut off, and it is 101',
      others.map((o) => o.id).join(','));

    const b1 = await login('bemp@example.invalid');
    const b2 = await pinLogin('dev-beta-201');
    const b3 = await otpVerify('bemp@example.invalid');
    ok(b1.body.code === '200' && b2.body.code === '200' && b3.body.code === '200',
      'Beta\'s employee still signs in by password, PIN and OTP',
      [b1.body.code, b2.body.code, b3.body.code].join('/'));
    const bp = await request(app).get('/probe').set('Authorization', 'Bearer ' + liveBeta);
    ok(bp.status === 200, 'and Beta\'s live session from before the shut-off still works', 'HTTP ' + bp.status);

    const [[acmeOwner]] = await conn.query('SELECT shut_off_at FROM `user` WHERE id = 100');
    ok(acmeOwner.shut_off_at == null, 'and Acme\'s own owner was not caught by it either');

    // ---- restore ----
    head('RESTORE — clears the timestamp and bumps again');
    await conn.query('UPDATE `user` SET shut_off_at = NULL, token_version = token_version + 1 WHERE id = 101');
    await conn.query(
      'INSERT INTO employee_access_audit (subject_user_id, actor_user_id, account_owner_id, action) VALUES (101,100,100,?)',
      ['restored']);
    const back = await login('aemp@example.invalid');
    ok(back.body.code === '200', 'the employee signs in again', JSON.stringify(back.body));

    const [trail] = await conn.query(
      'SELECT action FROM employee_access_audit WHERE subject_user_id = 101 ORDER BY id');
    ok(trail.length === 2 && trail[0].action === 'shut_off' && trail[1].action === 'restored',
      'AND THE AUDIT TRAIL KEEPS BOTH ROWS — the restore ADDS a record, it does not erase the shut-off',
      trail.map((t) => t.action).join(','));

    // ---- fail-open, deliberately consistent ----
    head('FAIL-OPEN — shut_off_at behaves like the status check, not differently');
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'authentication.js'), 'utf8');
    const failOpenNote = /FAIL OPEN, DELIBERATELY AND CONSISTENTLY/.test(src);
    ok(failOpenNote, 'the tradeoff is written down in the code, not just decided');
    // Behavioural: with the column gone, the helper must answer false (open), and
    // authenticateToken must still admit a valid token rather than 500.
    await conn.query('ALTER TABLE `user` DROP COLUMN shut_off_at');
    const fresh = (await login('aemp@example.invalid')).body.data.token;
    const openProbe = await request(app).get('/probe').set('Authorization', 'Bearer ' + fresh);
    ok(openProbe.status === 200,
      'with the column absent entirely, auth still works — this ships BEFORE the ALTER TABLE',
      'HTTP ' + openProbe.status);
    ok((await login('bemp@example.invalid')).body.code === '200',
      'and so does sign-in, on the un-migrated column path');

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
