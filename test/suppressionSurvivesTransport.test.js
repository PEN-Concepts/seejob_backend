/* DOES THE SUPPRESSION CHECK SURVIVE THE TRANSPORT SWITCH?
 *
 * The guard was installed by wrapping transporter.sendMail on the transport
 * object that services/mailer.js builds at load. The SES cutover selects a
 * DIFFERENT transport. If the wrap is tied to the SMTP object specifically, the
 * protection disappears the moment we cut over — silently, with no test failing.
 * Suppression would look present and be absent.
 *
 * This loads the mailer fresh under each provider and asserts the guard is
 * installed and ACTUALLY BLOCKS, on both.
 *
 * Run: node test/suppressionSurvivesTransport.test.js
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
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';
    process.env.SMTP_USER = 'test@example.com';
    process.env.AWS_REGION = 'us-west-1';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_transport_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    const { ensureEmailSuppressionsTable } = require('../services/dbMigrations');
    await ensureEmailSuppressionsTable(conn);
    await conn.query(
      "INSERT INTO email_suppressions (email, reason, source) VALUES ('dead@example.com','hard_bounce','test')");

    /** Load services/mailer.js fresh under a given provider. */
    function loadMailerWith(provider) {
      for (const k of Object.keys(require.cache)) {
        if (/services[\\/](mailer|emailSuppression)\.js$/.test(k)) delete require.cache[k];
      }
      process.env.MAIL_PROVIDER = provider;
      return require('../services/mailer');
    }

    for (const provider of ['smtp', 'ses']) {
      head(`PROVIDER = ${provider.toUpperCase()}`);
      let mailer;
      try {
        mailer = loadMailerWith(provider);
      } catch (err) {
        ok(false, `mailer loads under ${provider}`, err.message);
        continue;
      }
      note(`transport reports PROVIDER=${mailer.PROVIDER}`);

      // 1. The guard is installed on whatever transport was chosen.
      ok(typeof mailer.transporter.sendMail === 'function',
        'the transport exposes sendMail');
      ok(mailer.transporter.sendMail.name === 'suppressionAwareSendMail',
        'AND IT IS THE SUPPRESSION-AWARE WRAPPER, not the raw transport method',
        mailer.transporter.sendMail.name);

      // 2. It does not merely exist — it blocks. This is the assertion that
      //    matters: a wrapper that is installed but inert is worse than none,
      //    because it looks like protection.
      let threw = null;
      try {
        await mailer.transporter.sendMail({ to: 'dead@example.com', subject: 'x', text: 'x' });
      } catch (e) { threw = e; }
      ok(threw && threw.code === 'EMAIL_SUPPRESSED',
        `a suppressed address is BLOCKED under the ${provider} transport`,
        threw ? (threw.code || threw.message) : 'no error thrown — the send was attempted');

      // 3. And the helper, which is the other way in.
      let threw2 = null;
      try {
        await mailer.sendMail({ to: 'dead@example.com', subject: 'x', text: 'x' });
      } catch (e) { threw2 = e; }
      ok(threw2 && threw2.code === 'EMAIL_SUPPRESSED',
        'so is a send through mailer.sendMail', threw2 && (threw2.code || threw2.message));
    }

    head('WHY THIS HOLDS');
    note('services/mailer.js chooses the transport BEFORE the wrap is applied:');
    note('  transporter = PROVIDER === \'ses\' ? buildSesTransport() : buildSmtpTransport();');
    note('  ...then transporter.sendMail = suppressionAwareSendMail');
    note('so the guard lands on whichever object the ternary produced.');
    note('IT IS ORDER-DEPENDENT, NOT STRUCTURAL: a future cutover that REASSIGNS');
    note('`transporter` after load, or builds a second transport, would bypass it.');
    note('This test is what turns that from a silent regression into a failure.');

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
