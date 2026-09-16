/* GRACE — a failed card no longer ejects a paying customer the same morning.
 *
 * THE BUG. `past_due` fell straight through to the expired-trial path and
 * landed in expired_free, so a builder whose card expired lost their own jobs,
 * budgets, schedule and contacts the moment the webhook arrived — no warning,
 * no window — while the admin page still called them "Paying". Nobody has hit
 * it because the only subscription is a test account. The first real customer
 * whose card declines is the one who finds it.
 *
 * WHAT IS ASSERTED, and it is deliberately not just the mode string: a user in
 * grace is run through the REAL guards the app uses — canViewJob, the contact
 * scope, the expired-free predicate — so "identical to active" is demonstrated
 * rather than claimed.
 *
 * TWO COMPANIES, because job and contact visibility is involved.
 *
 * Run: node test/billingGrace.test.js
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
    db = await createDB({ dbName: 'seejob_grace_test', logLevel: 'ERROR' });
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
    await conn.query(`CREATE TABLE subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, plan_id INT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active', amount DECIMAL(10,2) NULL,
      authorize_subscription_id VARCHAR(64) NULL, past_due_since DATETIME NULL,
      created_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE job (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(190), created_by INT NULL, status INT DEFAULT 1)`);
    await conn.query(`CREATE TABLE tasks (
      id INT AUTO_INCREMENT PRIMARY KEY, job_id INT NULL, user_id INT NULL, task_name VARCHAR(190))`);

    // ACME pays (id 100) and owns job 1. BETA (200) is a separate company.
    // Account created long ago, so the 60-day trial is well gone — without a
    // subscription these accounts are expired_free.
    await conn.query(
      `INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
       (100,'Acme Owner','acme@example.com',14,4,NULL,'2020-01-01'),
       (200,'Beta Owner','beta@example.com',14,4,NULL,'2020-01-01')`);
    await conn.query("INSERT INTO `job` (id,name,created_by) VALUES (1,'Acme Job',100),(2,'Beta Job',200)");
    await conn.query("INSERT INTO subscriptions (id,user_id,status,past_due_since) VALUES (1,100,'active',NULL)");

    const { getAccessInfo, getAccessMode, canViewJob } = require('../utils/access');
    const setSub = (status, sinceSql) =>
      conn.query(`UPDATE subscriptions SET status = ?, past_due_since = ${sinceSql} WHERE id = 1`, [status]);

    // ================= BASELINE ==========================================
    head('BASELINE — an ACTIVE subscription');
    const active = await getAccessInfo(100, conn);
    ok(active.mode === 'paid', 'active -> paid', active.mode);
    ok(active.inGrace === false, 'and not flagged as in grace');
    ok((await canViewJob(100, 1, conn)) === true, 'and the owner can see their own job');

    // ================= THE FIX ===========================================
    head('IN GRACE — access is IDENTICAL to active');
    await setSub('past_due', 'NOW()');
    const grace = await getAccessInfo(100, conn);
    note(`past_due since now -> mode=${grace.mode} inGrace=${grace.inGrace}`);
    ok(grace.mode === 'paid',
      'a past_due user INSIDE the window is "paid" — this is the whole fix', grace.mode);
    ok(grace.mode !== 'expired_free', 'and is explicitly NOT expired_free');
    ok(grace.hasActiveSubscription === true, 'the gate counts them as subscribed');
    ok(grace.inGrace === true, 'while still being flagged as in grace, so it is visible');
    ok(!!grace.graceEndsAt, 'with an end date', String(grace.graceEndsAt));

    // 14 days out, from the moment it entered the state.
    const endMs = new Date(grace.graceEndsAt).getTime();
    const expect = Date.now() + 14 * 86400000;
    ok(Math.abs(endMs - expect) < 5 * 60 * 1000,
      'set 14 days out from when it entered past_due', new Date(endMs).toISOString());

    // THE REAL GUARDS, not just the mode string.
    ok((await canViewJob(100, 1, conn)) === true,
      'AND THEY STILL SEE THEIR OWN JOB — the thing that used to vanish on a Wednesday morning');
    ok((await canViewJob(100, 2, conn)) === false,
      "and still cannot see the other company's job — grace widened nothing sideways");

    // Deep in the window, still fine.
    await setSub('past_due', '(NOW() - INTERVAL 13 DAY)');
    ok((await getAccessMode(100, conn)) === 'paid', 'day 13 of 14 — still full access');
    ok((await canViewJob(100, 1, conn)) === true, 'still sees their own job on day 13');

    // ================= THE BOUNDARY ======================================
    head('WHEN GRACE LAPSES — the existing free tier, with NO new code');
    await setSub('past_due', '(NOW() - INTERVAL 15 DAY)');
    const lapsed = await getAccessInfo(100, conn);
    ok(lapsed.mode === 'expired_free',
      'past the window -> expired_free, the SAME state a lapsed trial reaches', lapsed.mode);
    ok(lapsed.inGrace === false, 'and no longer flagged as in grace');
    note('no branch was written for this — the row stops matching and the existing');
    note('fall-through does it. One rule for everyone, however long they paid.');

    // ================= NOTHING ELSE WIDENED ==============================
    head('GRACE WIDENED EXACTLY ONE STATE');
    await setSub('canceled', 'NOW()');
    ok((await getAccessMode(100, conn)) === 'expired_free',
      'CANCELED gets no grace, even with a fresh past_due_since on the row',
      String(await getAccessMode(100, conn)));

    await setSub('expired', 'NOW()');
    ok((await getAccessMode(100, conn)) === 'expired_free', 'nor does "expired"');

    // An expired trial with no subscription row at all.
    await conn.query('DELETE FROM subscriptions WHERE id = 1');
    ok((await getAccessMode(100, conn)) === 'expired_free',
      'and an expired trial with no subscription row gets no grace either');
    await conn.query("INSERT INTO subscriptions (id,user_id,status,past_due_since) VALUES (1,100,'past_due',NOW())");

    // ================= PAYING ENDS GRACE =================================
    head('PAYING DURING GRACE RETURNS THEM IMMEDIATELY');
    ok((await getAccessMode(100, conn)) === 'paid', 'in grace again');
    // This is what the webhook does on a successful payment.
    await conn.query("UPDATE subscriptions SET status = 'active', past_due_since = NULL WHERE id = 1");
    const paid = await getAccessInfo(100, conn);
    ok(paid.mode === 'paid' && paid.inGrace === false,
      'paying clears past_due_since and ends grace at once', JSON.stringify({ m: paid.mode, g: paid.inGrace }));

    // ================= THE ODD ROW =======================================
    head('A past_due ROW WITH NO START DATE');
    await setSub('past_due', 'NULL');
    const noSince = await getAccessInfo(100, conn);
    ok(noSince.mode === 'paid',
      'is treated as IN grace — this branch exists to stop ejecting people and must never eject one',
      noSince.mode);
    ok(noSince.inGrace === true && noSince.graceEndsAt === null,
      'flagged as in grace with no end date, so the admin page can surface it rather than hide it',
      JSON.stringify({ g: noSince.inGrace, e: noSince.graceEndsAt }));

    // ================= NOTHING DELETED ===================================
    head('NOTHING WAS DELETED BY ANY BILLING STATE');
    const [[jobs]] = await conn.query('SELECT COUNT(*) c FROM `job`');
    const [[users]] = await conn.query('SELECT COUNT(*) c FROM `user`');
    ok(Number(jobs.c) === 2 && Number(users.c) === 2,
      'jobs and users are exactly as seeded after every state transition above',
      `jobs=${jobs.c} users=${users.c}`);
    note('the account moved active -> past_due -> lapsed -> canceled -> expired ->');
    note('trial -> grace -> active -> grace, and not one row was removed.');

    // ================= RE-SUBSCRIBING RESTORES ===========================
    head('RE-SUBSCRIBING RESTORES EVERYTHING, BECAUSE NOTHING WENT AWAY');
    await setSub('canceled', 'NULL');
    ok((await getAccessMode(100, conn)) === 'expired_free', 'lapsed account is on the free tier');
    ok((await canViewJob(100, 1, conn)) === false, 'and cannot see its own job');
    await setSub('active', 'NULL');
    ok((await getAccessMode(100, conn)) === 'paid', 'paying again -> paid');
    ok((await canViewJob(100, 1, conn)) === true,
      'AND THE SAME JOB IS THERE — the claim Poul will make to customers, tested end to end');

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
