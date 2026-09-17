/* THE OTP EMAIL ITSELF.
 *
 * Gmail's stated reason for binning these was "similar to messages identified
 * as spam in the past" — content and reputation, NOT authentication. So this
 * asserts the CONTENT, by capturing what nodemailer is actually handed rather
 * than by reading the source.
 *
 * The four faults being fixed:
 *   1. The logo was hotlinked over http://, and the host answers NOTHING on
 *      plain HTTP, so it failed outright and every client fell back to alt
 *      text. A broken image at the top of a transactional email is a textbook
 *      spam signal.
 *   2. A SIGN-IN code said "Thank you for registering with SeeJobRun."
 *   3. The plain-text part was one line that matched neither the subject nor
 *      the HTML.
 *   4. A #4CAF50 banner and a second green panel — a colour that appears
 *      nowhere in the product.
 *
 * Run: node test/otpEmailContent.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);
const head = (m) => rec.push('\n' + m);

(async () => {
  let db, pool, conn;
  const sent = [];
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';
    process.env.SMTP_USER = 'test@example.com';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_otpmail_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');

    await conn.query(`CREATE TABLE \`user\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120), email VARCHAR(190) UNIQUE, password VARCHAR(190),
      image VARCHAR(190) NULL, status INT DEFAULT 1, role INT NULL, category INT NULL,
      otp VARCHAR(10) NULL, otp_status INT DEFAULT 0, created_by INT NULL,
      must_change_password INT DEFAULT 0, pin_hash VARCHAR(190) NULL, pin_enabled INT DEFAULT 0,
      token_version INT NOT NULL DEFAULT 0, otp_attempts INT NOT NULL DEFAULT 0,
      updated_at DATETIME NULL, updated_by INT NULL, created_at DATETIME NULL)`);
    await conn.query('CREATE TABLE role_right_permission (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, right_id INT, `read` INT DEFAULT 1, `create` INT DEFAULT 1, `update` INT DEFAULT 1, `delete` INT DEFAULT 1)');
    await conn.query('CREATE TABLE user_devices (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, device_token VARCHAR(190), user_agent VARCHAR(255) NULL)');

    const WHO = 'signer@example.com';
    await conn.query(
      "INSERT INTO `user` (id,name,email,status,role,category,created_by,created_at) VALUES (101,'Sign In Person',?,1,2,1,100,NOW())",
      [WHO]);

    // CAPTURE WHAT NODEMAILER IS HANDED. Asserting the real mailOptions, not
    // the source text — the source could say anything and still send nothing.
    const mailer = require('../services/mailer');
    mailer.transporter.sendMail = async (opts) => { sent.push(opts); return { accepted: [opts.to] }; };

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/user', require('../routes/users'));

    await request(app).post('/api/user/login-otp-request').send({ email: WHO });
    ok(sent.length === 1, 'a sign-in request produced exactly one email', String(sent.length));
    const m = sent[0] || {};
    const html = String(m.html || '');
    const text = String(m.text || '');

    // ---- 1. the logo ----
    head('1 — THE LOGO LOADS');
    const imgs = html.match(/<img[^>]+src="([^"]+)"/g) || [];
    const srcs = (html.match(/<img[^>]+src="([^"]+)"/g) || []).map((t) => (t.match(/src="([^"]+)"/) || [])[1]);
    note('image sources: ' + JSON.stringify(srcs));
    ok(srcs.length === 1, 'exactly one image in the message', String(srcs.length));
    ok(srcs.every((s) => s.startsWith('https://')),
      'and it is https — it was http://, which the host answers NOTHING on, so it always failed',
      JSON.stringify(srcs));
    ok(!/http:\/\//.test(html) && !/http:\/\//.test(text),
      'no plain-http URL anywhere in the message, link or image');

    // ---- 2. the copy says what it is for ----
    head('2 — THE COPY MATCHES THE PURPOSE');
    ok(!/thank you for registering/i.test(html) && !/thank you for registering/i.test(text),
      'a SIGN-IN email no longer thanks the reader for registering');
    ok(/sign[- ]?in/i.test(String(m.subject)),
      'the subject says it is a sign-in code', String(m.subject));
    note('subject: ' + JSON.stringify(m.subject));

    // Each purpose must differ from the others — otherwise "purpose-aware" is
    // a claim rather than a behaviour.
    sent.length = 0;
    const usersRoute = require('../routes/users');
    const subjects = {};
    for (const purpose of ['signin', 'register', 'recover']) {
      sent.length = 0;
      // drive through the real function via a direct require of the module's
      // exported router is not possible, so exercise the three call paths'
      // purpose strings through the same helper the routes use.
      const fn = require('../routes/users').__sendOTPEmailForTest;
      if (fn) { await fn('x@example.com', '1234', purpose); subjects[purpose] = sent[0] && sent[0].subject; }
    }
    if (Object.keys(subjects).length === 3) {
      const uniq = new Set(Object.values(subjects));
      ok(uniq.size === 3, 'all three purposes produce DIFFERENT subjects', JSON.stringify(subjects));
    } else {
      note('per-purpose subjects checked via source, helper not exported:');
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'users.js'), 'utf8');
      const block = (src.match(/const OTP_PURPOSE = \{[\s\S]*?\n\};/) || [''])[0];
      const subs = (block.match(/subject: '[^']+'/g) || []);
      note(subs.join(' | '));
      ok(subs.length === 3 && new Set(subs).size === 3,
        'all three purposes declare DIFFERENT subjects', subs.join(' | '));
      ok(/sendOTPEmail\(r\.email, otp, 'register'\)/.test(src)
        && /sendOTPEmail\(normalizedEmail, otp, 'signin'\)/.test(src)
        && /sendOTPEmail\(signedin_useremail, otp, 'recover'\)/.test(src),
        'and each of the three callers passes its own purpose');
    }

    // ---- 3. the plain-text part ----
    head('3 — A REAL PLAIN-TEXT ALTERNATIVE');
    note('text part is ' + text.length + ' chars, ' + text.split('\n').length + ' lines');
    ok(text.length > 120, 'the text part is a real message, not one line', String(text.length));
    ok(text.includes('3 minutes'), 'it carries the expiry, like the HTML does');
    ok(/sign in/i.test(text), 'and it says what the code is for');

    // ---- 4. house style ----
    head('4 — HOUSE STYLE, AND MOSTLY TEXT');
    ok(!/4CAF50/i.test(html) && !/e8f5e9/i.test(html),
      'the bright green that appears nowhere in the product is gone');
    ok(/f0ad2b|c99a22/i.test(html), 'gold is present');
    ok(/f1e9d5/i.test(html), 'cream is present');
    ok(/3a342c|2a2419/i.test(html), 'the dark ink is present');

    // ---- 5. image-to-text ratio ----
    head('5 — IMAGE-TO-TEXT RATIO');
    const visible = html.replace(/<style[\s\S]*?<\/style>/gi, '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/&[a-z]+;/gi, ' ')
                        .replace(/\s+/g, ' ').trim();
    note(`visible words: ${visible.split(' ').length}, images: ${srcs.length}`);
    note('one 132px-wide logo against ~' + visible.split(' ').length + ' words of text');
    ok(srcs.length <= 1 && visible.split(' ').length > 40,
      'one image, well over forty words — weighted to text, as transactional mail should be',
      `${srcs.length} images / ${visible.split(' ').length} words`);

    ok(!/unsubscribe|special offer|act now|click here|limited time|free trial/i.test(html),
      'and nothing in it reads as promotional');

    // ---- the code is still correct ----
    head('THE MESSAGE STILL CARRIES THE RIGHT CODE');
    const [[row]] = await conn.query('SELECT otp FROM `user` WHERE id = 101');
    const stored = String(row.otp).padStart(4, '0');
    ok(html.includes(stored) && text.includes(stored),
      'the stored code appears in BOTH the HTML and the text part', stored.replace(/./g, '*'));

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
