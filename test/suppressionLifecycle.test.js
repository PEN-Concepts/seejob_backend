/* SUPPRESS → RELEASE → SEND → RE-SUPPRESS → BLOCKED.
 *
 * THE RISK BEING TESTED. email_suppressions has UNIQUE KEY on `email`. Mike's
 * address bounces and is suppressed; Poul releases it; six months later it dies
 * again. If that second bounce collides with the unique key and gets swallowed,
 * suppression has silently stopped working FOR EVERY ADDRESS EVER RELEASED —
 * and it would look fine, because the row is still there.
 *
 * Also covers the fail-open path: the guard is allowed to fail open, but it
 * must SAY SO at a level someone would see. A guard that silently stops
 * guarding is worse than no guard, because it is trusted.
 *
 * Run: node test/suppressionLifecycle.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);
const head = (m) => rec.push('\n' + m);

(async () => {
  let db, pool, conn;
  const logged = { error: [], warn: [] };
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';
    process.env.SMTP_USER = 'test@example.com';

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_supplife_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    const logger = require('../common/logger');
    for (const lvl of ['error', 'warn']) {
      const orig = logger[lvl] && logger[lvl].bind(logger);
      if (orig) logger[lvl] = (...a) => { logged[lvl].push(a.map(String).join(' ')); };
    }

    const { ensureEmailSuppressionsTable } = require('../services/dbMigrations');
    await ensureEmailSuppressionsTable(conn);

    const supp = require('../services/emailSuppression');
    const mailer = require('../services/mailer');
    const ADDR = 'mike@example.com';

    const sendIt = async () => {
      try {
        await mailer.sendMail({ to: ADDR, subject: 'Invitation', text: 'x' });
        return 'sent';
      } catch (e) {
        return e.code === 'EMAIL_SUPPRESSED' ? 'blocked' : 'other:' + (e.code || e.message);
      }
    };
    const rowFor = async () => {
      const [[r]] = await conn.query(
        'SELECT id, reason, detail, released_at, released_by FROM email_suppressions WHERE email = ?', [ADDR]);
      return r;
    };
    const countRows = async () => {
      const [[c]] = await conn.query('SELECT COUNT(*) n FROM email_suppressions WHERE email = ?', [ADDR]);
      return Number(c.n);
    };

    // ================= 1. FIRST BOUNCE ===================================
    head('1 — THE ADDRESS DIES AND IS SUPPRESSED');
    await supp.suppress(ADDR, 'hard_bounce', 'smtp; 550 5.1.1 user unknown', 'ses_sns', conn);
    const r1 = await rowFor();
    ok(!!r1, 'a row exists');
    ok(r1.released_at === null, 'and it is active (released_at IS NULL)');
    const firstId = r1.id;
    ok(await sendIt() === 'blocked', 'sending to it is BLOCKED');

    // ================= 2. RELEASE ========================================
    head('2 — MIKE FIXES HIS MAIL AND POUL RELEASES IT');
    ok(await supp.release(ADDR, 42, conn) === true, 'release reports success');
    const r2 = await rowFor();
    ok(r2 && r2.released_at !== null, 'released_at is set');
    ok(r2 && Number(r2.released_by) === 42, 'and released_by records who did it', r2 && String(r2.released_by));
    ok(Number(r2.id) === Number(firstId), 'THE SAME ROW — a release is a write, not a delete', `${r2.id} vs ${firstId}`);
    ok(await countRows() === 1, 'still exactly one row');

    // ================= 3. SENDING WORKS AGAIN ============================
    head('3 — SENDING TO IT WORKS AGAIN');
    const after = await sendIt();
    ok(after !== 'blocked',
      'the send is no longer blocked by suppression', after);
    note(`(the transport itself fails in this suite — result was "${after}" — which is`);
    note(' the point: it got PAST the guard and reached the transport.)');

    // ================= 4. IT DIES AGAIN ==================================
    head('4 — SIX MONTHS LATER IT DIES AGAIN');
    // THE CASE THAT MATTERS. If this collides with the unique key and is
    // swallowed, suppression has silently stopped working for every address
    // ever released.
    await supp.suppress(ADDR, 'complaint', 'abuse-report-2', 'ses_sns', conn);
    const r3 = await rowFor();
    ok(r3 && r3.released_at === null,
      'released_at is CLEARED — the re-suppression was not swallowed by the unique key');
    ok(r3 && r3.released_by === null, 'and released_by cleared with it');
    ok(r3 && r3.reason === 'complaint',
      'THE NEW REASON is written over the old one', r3 && r3.reason);
    ok(r3 && /abuse-report-2/.test(r3.detail || ''),
      'and the new detail too', r3 && String(r3.detail).slice(0, 30));
    ok(Number(r3.id) === Number(firstId),
      'still the same row — nothing was deleted and re-created', `${r3.id} vs ${firstId}`);
    ok(await countRows() === 1, 'and still exactly one row');

    // ================= 5. BLOCKED AGAIN ==================================
    head('5 — AND SENDING IS BLOCKED AGAIN');
    ok(await sendIt() === 'blocked',
      'the full cycle holds: suppress, release, send, re-suppress, blocked');

    // ================= 6. FAIL-OPEN SAYS SO ==============================
    head('6 — WHEN THE GUARD FAILS OPEN, IT SAYS SO LOUDLY');
    logged.error.length = 0;
    // Force a real database error on the check by pointing it at a connection
    // whose table is gone. The table is restored immediately afterwards.
    await conn.query('RENAME TABLE email_suppressions TO email_suppressions_hidden');
    const duringOutage = await supp.isSuppressed(ADDR, conn);
    await conn.query('RENAME TABLE email_suppressions_hidden TO email_suppressions');

    ok(duringOutage === false,
      'it FAILS OPEN — failing closed would stop every login code over a blip', String(duringOutage));
    const shout = logged.error.find((l) => /EMAIL SUPPRESSION GUARD FAILED OPEN/.test(l));
    ok(!!shout,
      'AND IT LOGS AT ERROR, with a greppable marker — a guard that silently stops guarding is worse than none',
      logged.error.slice(0, 2).join(' | ').slice(0, 120));
    ok(shout && /bounces and complaints are accumulating/.test(shout),
      'and the line says what it costs, not just that something failed');

    // and the guard works again once the table is back
    ok(await sendIt() === 'blocked', 'the guard resumes once the database recovers');

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
