/* COMPED ACCOUNTS + RECONCILIATION.
 *
 * The two claims that matter, and they are the same claim from two sides:
 *
 *   1. A comped account is skipped BECAUSE ITS STATUS SAYS SO — never because
 *      no processor record was found. A comped account and a broken one look
 *      identical from the processor's side, so skipping on "no record" would
 *      turn every data problem into silent free access. Proved by giving a
 *      NON-comped subscription no processor reference and confirming it is
 *      REPORTED rather than skipped.
 *
 *   2. Reconciliation NEVER restricts on absence of evidence. A timeout, a
 *      throw, a malformed answer and an unrecognised status all produce no
 *      recommendation. Restriction follows only a positive processor answer.
 *
 * Two companies are seeded, since this touches who may grant free access.
 *
 * Run: node test/billingCompedReconcile.test.js
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
    db = await createDB({ dbName: 'seejob_comped_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE \`user\` (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190) UNIQUE,
      role INT NULL, category INT NULL, status INT DEFAULT 1, created_by INT NULL,
      created_at DATETIME NULL)`);
    // status as ENUM WITHOUT 'comped' — the hostile case, so the migration has
    // something real to widen. If it is a VARCHAR in production the migration
    // is a no-op, which is also correct.
    await conn.query(`CREATE TABLE subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, plan_id INT NULL,
      status ENUM('active','past_due','canceled','expired') NOT NULL DEFAULT 'active',
      amount DECIMAL(10,2) NULL, authorize_subscription_id VARCHAR(64) NULL,
      past_due_since DATETIME NULL, created_at DATETIME NULL)`);

    const { ensureCompedSubscriptionStatus, ensureCompAuditTable } = require('../services/dbMigrations');

    // ================= THE MIGRATION ====================================
    head('THE MIGRATION WIDENS AN ENUM RATHER THAN ASSUMING A VARCHAR');
    let threw = null;
    try {
      await conn.query("INSERT INTO subscriptions (user_id, status) VALUES (1, 'comped')");
    } catch (e) { threw = e.code; }
    ok(!!threw, "'comped' is REJECTED before the migration — the enum did not know it", String(threw));

    await ensureCompedSubscriptionStatus(conn);
    await ensureCompAuditTable(conn);
    const [[col]] = await conn.query(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'status'`);
    ok(/'comped'/.test(String(col.COLUMN_TYPE)), 'the migration adds it to the enum', String(col.COLUMN_TYPE));
    ok(/'active'/.test(String(col.COLUMN_TYPE)) && /'past_due'/.test(String(col.COLUMN_TYPE))
       && /'canceled'/.test(String(col.COLUMN_TYPE)),
      'AND KEEPS every value that was already there — it extends, it does not redefine',
      String(col.COLUMN_TYPE));

    // ================= FIXTURES =========================================
    await conn.query(
      `INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
       (100,'Acme Owner','acme@example.com',14,4,NULL,'2020-01-01'),
       (101,'Comped Friend','friend@example.com',14,4,NULL,'2020-01-01'),
       (200,'Beta Owner','beta@example.com',14,4,NULL,'2020-01-01')`);

    await conn.query(
      `INSERT INTO subscriptions (id,user_id,status,authorize_subscription_id) VALUES
       (1, 100, 'active',  'REMOTE-A'),
       (2, 101, 'comped',  NULL),
       (3, 200, 'active',  NULL)`);
    note('sub 1 = paying with a processor id; sub 2 = COMPED, no processor id;');
    note('sub 3 = NOT comped and ALSO has no processor id — the trap case.');

    const { reconcile, classifyDivergence } = require('../services/billingReconcile');

    // ================= CLAIM 1 ==========================================
    head('CLAIM 1 — COMPED IS SKIPPED BY STATUS; "NO RECORD" IS NOT A FREE PASS');
    const everythingFine = async () => ({ ok: true, status: 'active' });
    const r1 = await reconcile(conn, everythingFine);

    ok(r1.compedSkipped === 1, 'the comped subscription was skipped', String(r1.compedSkipped));
    ok(r1.unverifiable === 1,
      'and the NON-comped subscription with no processor id was NOT skipped', String(r1.unverifiable));

    const trap = r1.divergences.find((d) => d.subscription_id === 3);
    ok(!!trap,
      'IT IS REPORTED AS A DIVERGENCE — an unverifiable subscription must never read as "free on purpose"',
      JSON.stringify(r1.divergences));
    ok(trap && trap.action === 'none',
      'and still recommends no action, because there is no positive processor answer',
      trap && trap.action);
    const comped = r1.divergences.find((d) => d.subscription_id === 2);
    ok(!comped, 'while the comped one produces no divergence at all');

    // ================= CLAIM 2 ==========================================
    head('CLAIM 2 — NEVER RESTRICT ON ABSENCE OF EVIDENCE');
    const local = { id: 1, user_id: 100, status: 'active' };
    const absences = [
      ['processor unreachable', { ok: false, reason: 'ETIMEDOUT' }],
      ['processor threw',       { ok: false, reason: 'threw: socket hang up' }],
      ['empty response',        { ok: false }],
      ['null response',         null],
      ['undefined response',    undefined],
      ['ok but no status',      { ok: true, status: '' }],
      ['unrecognised status',   { ok: true, status: 'something-new' }],
    ];
    for (const [label, remote] of absences) {
      const v = classifyDivergence(local, remote);
      ok(v.action === 'none', `${label} -> no action`, v.action + ' / ' + v.why);
    }

    // And the same through the whole job, end to end.
    const alwaysDown = async () => { throw new Error('ECONNREFUSED'); };
    const r2 = await reconcile(conn, alwaysDown);
    ok(r2.unreachable >= 1, 'a totally unreachable processor is counted', String(r2.unreachable));
    ok(r2.wouldRestrict === 0,
      'AND NOTHING IS RECOMMENDED FOR RESTRICTION when the processor cannot be reached',
      String(r2.wouldRestrict));
    ok(r2.actedOn === 0 && r2.reportOnly === true, 'the job reports and does not act');

    // ================= IT DOES CATCH THE REAL THING =====================
    head('BUT IT DOES CATCH WHAT IT IS FOR');
    const saysEnded = async () => ({ ok: true, status: 'canceled' });
    const r3 = await reconcile(conn, saysEnded);
    const caught = r3.divergences.find((d) => d.subscription_id === 1);
    ok(caught && caught.action === 'would_restrict',
      'local "active" + processor "canceled" IS flagged — this is the free-for-life case',
      JSON.stringify(caught));
    ok(r3.wouldRestrict === 1, 'exactly one would-restrict', String(r3.wouldRestrict));

    const saysLive = async () => ({ ok: true, status: 'active' });
    const cancelledLocally = classifyDivergence({ id: 9, user_id: 9, status: 'canceled' }, { ok: true, status: 'active' });
    ok(cancelledLocally.action === 'would_reactivate',
      'and the kind direction too: locally cancelled, processor says ACTIVE — a payer locked out',
      cancelledLocally.action);

    // ================= NOTHING WAS MODIFIED =============================
    head('NO SUBSCRIPTION RECORD WAS MODIFIED');
    const [after] = await conn.query('SELECT id, status FROM subscriptions ORDER BY id');
    const shape = after.map((r) => `${r.id}:${r.status}`).join(',');
    ok(shape === '1:active,2:comped,3:active',
      'every row is exactly as it was before three reconciliation runs', shape);

    // ================= COMPED HAS ACCESS ================================
    head('A COMPED ACCOUNT HAS FULL ACCESS AND IGNORES TRIAL EXPIRY');
    const { getAccessMode } = require('../utils/access');
    // Account created in 2020 — its 60-day trial expired years ago, so without
    // the comp it would be expired_free.
    const compedMode = await getAccessMode(101, conn);
    ok(compedMode === 'paid',
      'comped -> "paid", despite a trial that ended years ago', String(compedMode));

    await conn.query("UPDATE subscriptions SET status = 'canceled' WHERE id = 2");
    const revokedMode = await getAccessMode(101, conn);
    ok(revokedMode === 'expired_free',
      'and the moment it is no longer comped, the same account is restricted again',
      String(revokedMode));
    await conn.query("UPDATE subscriptions SET status = 'comped' WHERE id = 2");

    // past_due is NOT access — the asymmetry with the badge, asserted.
    await conn.query("UPDATE subscriptions SET status = 'past_due' WHERE id = 1");
    const pastDueMode = await getAccessMode(100, conn);
    ok(pastDueMode === 'expired_free',
      'PAST_DUE IS ALREADY RESTRICTED BY THE GATE TODAY — while the badge called it "Paying"',
      String(pastDueMode));
    await conn.query("UPDATE subscriptions SET status = 'active' WHERE id = 1");

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
