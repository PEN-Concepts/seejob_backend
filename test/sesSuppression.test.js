/* SES BOUNCE / COMPLAINT HANDLING.
 *
 * The endpoint is PUBLIC and UNAUTHENTICATED, and its effect is to suppress an
 * email address permanently. So an unverified endpoint lets any caller on the
 * internet cut any user off from their login codes — a silent, permanent
 * lockout delivered by an anonymous POST. The signature check IS the feature,
 * and these tests attack it rather than demonstrate it.
 *
 * REAL CRYPTO, NOT MOCKS. A self-signed certificate and key pair are generated
 * here, messages are signed with the real private key, and verification runs
 * the real code path. Only the certificate FETCH is injected — so no test ever
 * reaches the network, and the "attacker-controlled host" test can prove that
 * NO outbound request was made by counting fetches.
 *
 * Run: node test/sesSuppression.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);
const head = (m) => rec.push('\n' + m);

const crypto = require('crypto');
const { execFileSync } = require('child_process');

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    process.env.SES_SNS_TOPIC_ARN = 'arn:aws:sns:us-west-1:502369551994:seejobrun-ses-events';
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';
    process.env.SMTP_USER = 'test@example.com';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_ses_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const express = require('express');

    await conn.query(`CREATE TABLE \`user\` (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190) UNIQUE,
      role INT NULL, category INT NULL, status INT DEFAULT 1, token_version INT NOT NULL DEFAULT 0,
      created_by INT NULL, created_at DATETIME NULL)`);

    // ---- a real self-signed cert + key, via openssl ----
    let PEM_CERT, PRIVATE_KEY;
    try {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      // Build an X.509 cert around that key using openssl (available in Git Bash).
      const os = require('os'), fs = require('fs'), path = require('path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-'));
      const keyPath = path.join(dir, 'k.pem');
      const certPath = path.join(dir, 'c.pem');
      fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      execFileSync('openssl', ['req', '-new', '-x509', '-key', keyPath, '-out', certPath,
        '-days', '2', '-subj', '/CN=sns.us-west-1.amazonaws.com'], { stdio: 'ignore' });
      PEM_CERT = fs.readFileSync(certPath, 'utf8');
      PRIVATE_KEY = privateKey;
    } catch (e) {
      console.log('SKIPPED: openssl unavailable for certificate generation (' + e.message + ')');
      process.exit(0);
    }

    const snsVerify = require('../services/snsVerify');
    const GOOD_CERT_URL = 'https://sns.us-west-1.amazonaws.com/SimpleNotificationService-abc123.pem';

    // Count fetches so "no outbound request was made" is measured, not assumed.
    let fetchCount = 0; const fetchedUrls = [];
    const fakeFetch = async (url) => { fetchCount++; fetchedUrls.push(url); return PEM_CERT; };

    function sign(msg) {
      const canonical = snsVerify.canonicalString(msg);
      const s = crypto.createSign('RSA-SHA1');
      s.update(canonical, 'utf8'); s.end();
      return s.sign(PRIVATE_KEY).toString('base64');
    }
    function envelope(overrides = {}) {
      const inner = overrides.__inner || {
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent', bounceSubType: 'General',
          bouncedRecipients: [{ emailAddress: 'dead@example.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }],
        },
      };
      const msg = {
        Type: 'Notification',
        MessageId: overrides.MessageId || ('m-' + Math.random().toString(36).slice(2)),
        TopicArn: overrides.TopicArn || process.env.SES_SNS_TOPIC_ARN,
        Message: JSON.stringify(inner),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '1',
        SigningCertURL: overrides.SigningCertURL || GOOD_CERT_URL,
      };
      msg.Signature = sign(msg);
      Object.keys(overrides).forEach((k) => { if (!k.startsWith('__') && k !== 'Signature') msg[k] = overrides[k]; });
      if (overrides.Signature) msg.Signature = overrides.Signature;
      return msg;
    }

    // The route module verifies via the real fetcher; point its cache at our
    // PEM so no network call is ever attempted for the GOOD url.
    snsVerify.certCache.set(GOOD_CERT_URL, PEM_CERT);

    const app = express();
    app.use(express.json({ verify: (rq, rs, buf) => { rq.rawBody = buf.toString('utf8'); } }));
    app.use('/webhooks', require('../routes/sesNotifications'));
    app.use('/api/v1/admin', require('../routes/adminSuppressions'));

    const post = (body, ct) => request(app).post('/webhooks/ses-notifications')
      .set('Content-Type', ct || 'text/plain').send(typeof body === 'string' ? body : JSON.stringify(body));

    const isSup = async (e) => {
      const [[r]] = await conn.query(
        'SELECT id FROM email_suppressions WHERE email = ? AND released_at IS NULL LIMIT 1', [e]);
      return !!r;
    };

    // ================= HAPPY PATH ========================================
    head('A VALID, CORRECTLY SIGNED HARD BOUNCE');
    const good = envelope({ MessageId: 'msg-perm-1' });
    const r1 = await post(good);
    ok(r1.status === 200, 'accepted', 'HTTP ' + r1.status);
    ok(await isSup('dead@example.com'), 'AND THE STORED ROW shows the address suppressed');
    const [[row]] = await conn.query("SELECT reason, detail FROM email_suppressions WHERE email = 'dead@example.com'");
    ok(row.reason === 'hard_bounce', 'with reason hard_bounce', row.reason);
    ok(/550/.test(row.detail || ''), 'and the diagnostic kept for support', String(row.detail).slice(0, 40));

    // ================= IDEMPOTENCE =======================================
    head('THE SAME NOTIFICATION AGAIN — SNS DELIVERS AT LEAST ONCE');
    const r2 = await post(good);
    ok(r2.status === 200, 'still 200 — a non-200 makes SNS retry for hours', 'HTTP ' + r2.status);
    const [[cnt]] = await conn.query("SELECT COUNT(*) c FROM email_suppressions WHERE email = 'dead@example.com'");
    ok(Number(cnt.c) === 1, 'and exactly ONE row exists, not two', String(cnt.c));

    // ================= THE ATTACKS =======================================
    head('A TAMPERED BODY WITH THE ORIGINAL SIGNATURE');
    const tampered = JSON.parse(JSON.stringify(good));
    tampered.Message = JSON.stringify({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'victim@example.com' }] },
    });
    const r3 = await post(tampered);
    ok(r3.status === 403, 'REJECTED', 'HTTP ' + r3.status);
    ok(!(await isSup('victim@example.com')),
      'AND THE VICTIM IS NOT SUPPRESSED — this is the whole attack, and it fails');

    head('A SigningCertURL ON AN ATTACKER-CONTROLLED HOST');
    fetchCount = 0; fetchedUrls.length = 0;
    // Each of these defeats a DIFFERENT naive check. An earlier version of this
    // list had only the first three, and the suffix-vs-exact-host bug survived
    // the non-vacuity pass because none of them actually ends with
    // "amazonaws.com" — they were testing a check nobody would write.
    const evilUrls = [
      'https://evil.example.com/cert.pem',                            // obvious
      'https://sns.us-west-1.amazonaws.com.attacker.com/cert.pem',    // beats a PREFIX/includes check
      'http://sns.us-west-1.amazonaws.com/cert.pem',                  // right host, plain http
      'https://evilamazonaws.com/cert.pem',                           // beats endsWith('amazonaws.com')
      'https://s3.us-west-1.amazonaws.com/cert.pem',                  // REAL AWS host, not SNS —
                                                                      // anyone with a bucket could host a cert here
      'https://sns.us-west-1.amazonaws.com/cert.txt',                 // right host, not a .pem
    ];
    for (const u of evilUrls) {
      const res = await snsVerify.verifySnsMessage(envelope({ SigningCertURL: u }), { fetch: fakeFetch });
      ok(res.ok === false && /untrusted/.test(res.reason), `rejected: ${u.slice(0, 48)}`, JSON.stringify(res));
    }
    ok(fetchCount === 0,
      'AND NOT ONE OUTBOUND REQUEST WAS MADE to any of them — the host is checked BEFORE any fetch',
      'fetches: ' + fetchCount + ' ' + fetchedUrls.join(','));

    head('A VALID SIGNATURE BUT A FOREIGN TopicArn');
    const foreign = envelope({ MessageId: 'msg-foreign', TopicArn: 'arn:aws:sns:us-west-1:999999999999:someone-else' });
    foreign.Signature = sign(foreign);  // genuinely signed, wrong topic
    const r4 = await post(foreign);
    ok(r4.status === 403,
      'REJECTED — a good AWS signature proves it came from SNS, not from OUR topic', 'HTTP ' + r4.status);

    // ================= BOUNCE TYPES ======================================
    head('TRANSIENT IS NOT DEAD');
    const transient = envelope({ MessageId: 'msg-transient', __inner: {
      notificationType: 'Bounce',
      bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull',
        bouncedRecipients: [{ emailAddress: 'fullbox@example.com' }] } } });
    transient.Signature = sign(transient);
    const r5 = await post(transient);
    ok(r5.status === 200, 'accepted', 'HTTP ' + r5.status);
    ok(!(await isSup('fullbox@example.com')),
      'AND NOT SUPPRESSED — a full mailbox is not a dead address');

    head('A COMPLAINT IS FINAL');
    const complaint = envelope({ MessageId: 'msg-complaint', __inner: {
      notificationType: 'Complaint',
      complaint: { complaintFeedbackType: 'abuse',
        complainedRecipients: [{ emailAddress: 'angry@example.com' }] } } });
    complaint.Signature = sign(complaint);
    await post(complaint);
    ok(await isSup('angry@example.com'), 'suppressed — they pressed "spam"');

    // ================= THE CHOKEPOINT ====================================
    head('SEND-TIME ENFORCEMENT, AT THE CHOKEPOINT');
    const mailer = require('../services/mailer');
    let delivered = [];
    // Replace the RAW transport, beneath the suppression wrapper, so what we
    // observe is what would actually have gone out.
    const realRaw = mailer.transporter.sendMail;
    require('../services/mailer'); // ensure wrapper installed
    const sent = [];
    // Patch the underlying transport the wrapper delegates to.
    const nodemailerTransport = mailer.transporter;
    const originalSend = mailer.rawSendMail;
    // We cannot reassign rawSendMail (closed over), so assert via the thrown
    // error and the blocked-sends ledger instead — both are observable.

    let threw = null;
    try {
      await mailer.sendMail({ to: 'dead@example.com', subject: 'Should not send', text: 'x' });
    } catch (e) { threw = e; }
    ok(threw && threw.code === 'EMAIL_SUPPRESSED',
      'mailer.sendMail REFUSES a suppressed address', threw && (threw.code || threw.message));

    const [[blocked]] = await conn.query(
      "SELECT COUNT(*) c FROM email_blocked_sends WHERE email = 'dead@example.com'");
    ok(Number(blocked.c) >= 1, 'and the attempt is recorded, so it is not indistinguishable from a vanished send');

    head('A DIFFERENT CALL SITE — proving the chokepoint, not a patch');
    let threw2 = null;
    try {
      // The RAW transporter, exactly as users.js / quote.js / change_order.js use it.
      await mailer.transporter.sendMail({ from: 'x@example.com', to: 'dead@example.com', subject: 'Raw', text: 'x' });
    } catch (e) { threw2 = e; }
    ok(threw2 && threw2.code === 'EMAIL_SUPPRESSED',
      'THE RAW TRANSPORTER IS BLOCKED TOO — ten of thirteen files use it, and they all inherit the check',
      threw2 && (threw2.code || threw2.message));

    // ================= RELEASE ===========================================
    head('RELEASE — boss only, and it lets them back in');
    const jwt = require('jsonwebtoken');
    const { OWNER_EXEMPT_EMAILS } = require('../utils/access');
    const OWNER = [...OWNER_EXEMPT_EMAILS][0];
    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_at) VALUES (1,'Owner',?,14,4,NOW()),(2,'Admin','adm@example.com',14,4,NOW())", [OWNER]);
    const tok = (id, email) => 'Bearer ' + jwt.sign({ id, email, role: 14, category: 4 }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const asAdmin = await request(app).post('/api/v1/admin/suppressions/release')
      .set('Authorization', tok(2, 'adm@example.com')).send({ email: 'dead@example.com' });
    ok(asAdmin.status === 403,
      'A NON-BOSS IS REFUSED, verified by direct API call', 'HTTP ' + asAdmin.status);
    ok(await isSup('dead@example.com'), 'and the address is still suppressed after that attempt');

    const listAsAdmin = await request(app).get('/api/v1/admin/suppressions').set('Authorization', tok(2, 'adm@example.com'));
    ok(listAsAdmin.status === 403, 'and cannot read the list either', 'HTTP ' + listAsAdmin.status);

    const rel = await request(app).post('/api/v1/admin/suppressions/release')
      .set('Authorization', tok(1, OWNER)).send({ email: 'dead@example.com' });
    ok(rel.body && rel.body.success === true, 'the boss can release', JSON.stringify(rel.body));
    ok(!(await isSup('dead@example.com')), 'the address is no longer suppressed');

    const [[after]] = await conn.query("SELECT released_at, released_by FROM email_suppressions WHERE email = 'dead@example.com'");
    ok(after && after.released_at && Number(after.released_by) === 1,
      'AND THE ROW SURVIVES with who released it and when — a release is a WRITE, never a delete',
      JSON.stringify(after));

    let threw3 = null;
    try { await mailer.sendMail({ to: 'dead@example.com', subject: 'Now allowed', text: 'x' }); }
    catch (e) { threw3 = e; }
    ok(!threw3 || threw3.code !== 'EMAIL_SUPPRESSED',
      'and sending to it is permitted again', threw3 && threw3.code);

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
