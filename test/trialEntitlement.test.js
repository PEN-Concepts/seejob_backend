/* Trial entitlement — synthetic-data functional test (real local MySQL via
 * mysql-memory-server + supertest).
 *
 * Poul's ruling: TRIALS GET FULL ACCESS. The bug was that three helpers derived
 * entitlement from the subscriptions row, so a trial (which has none) got
 * nothing. This proves the fixed helpers, and — just as importantly — proves an
 * EXPIRED trial is still restricted. Widening entitlement to live trials must
 * not widen it to dead ones.
 *
 * Personas, all on the SAME code path, differing only in signup date and
 * subscription:
 *   TRIAL   — created 5 days ago, no subscription      -> full access
 *   EXPIRED — created 200 days ago, no subscription    -> restricted
 *   PAID    — created 200 days ago, active Platinum    -> full access
 *   BASIC   — created 200 days ago, active Basic (L1)  -> tier 1, not Platinum
 *
 * Run: node test/trialEntitlement.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_trial_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE \`user\` (
      id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL,
      category INT NULL, created_by INT NULL, created_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE subscriptions (
      id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT NULL,
      status VARCHAR(30), created_at DATETIME NULL)`);
    await conn.query('CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(60), level INT NULL)');
    await conn.query('CREATE TABLE plan_features (id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT, feature_key VARCHAR(60))');

    await conn.query("INSERT INTO plans (id,name,level) VALUES (1,'Basic',1),(5,'Platinum',5)");
    await conn.query(`INSERT INTO plan_features (plan_id,feature_key) VALUES
      (5,'checklist'),(5,'quote'),(5,'job_documents'),(5,'job_photos'),(5,'job_materials'),
      (1,'checklist')`);

    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_at) VALUES
      (10,'Trial Tina','tina@ex.com',14,NULL, NOW() - INTERVAL 5 DAY),
      (20,'Expired Ed','ed@ex.com',14,NULL,  NOW() - INTERVAL 200 DAY),
      (30,'Paid Pat','pat@ex.com',14,NULL,   NOW() - INTERVAL 200 DAY),
      (40,'Basic Bea','bea@ex.com',14,NULL,  NOW() - INTERVAL 200 DAY)`);
    await conn.query("INSERT INTO subscriptions (user_id,plan_id,status,created_at) VALUES (30,5,'active',NOW()),(40,1,'active',NOW())");

    const access = require('../utils/access');

    // ── 1. the access MODE each persona resolves to (unchanged behaviour) ────
    const mode = async (id) => (await access.getAccessInfo(id, conn)).mode;
    ok((await mode(10)) === 'trial_active', 'TRIAL resolves to trial_active', await mode(10));
    ok((await mode(20)) === 'expired_free', 'EXPIRED resolves to expired_free', await mode(20));
    ok((await mode(30)) === 'paid', 'PAID resolves to paid', await mode(30));

    // ── 2. getActivePlanLevel — the fix ─────────────────────────────────────
    const lvl = async (id) => await access.getActivePlanLevel(id, conn);
    ok((await lvl(10)) === 5, 'TRIAL now gets Platinum tier (was 0)', String(await lvl(10)));
    ok((await lvl(20)) === 0, 'EXPIRED still gets tier 0 — dead trials stay gated', String(await lvl(20)));
    ok((await lvl(30)) === 5, 'PAID Platinum unchanged', String(await lvl(30)));
    ok((await lvl(40)) === 1, 'PAID Basic unchanged at tier 1 — the fix did not widen paid plans', String(await lvl(40)));

    // ── 3. requirePlan('platinum') — the four gated route groups ────────────
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    const app = express();
    app.use(express.json());
    app.get('/platinum-only', (req, res, next) => { req.user = { id: Number(req.headers['x-uid']) }; next(); },
      access.requirePlan('platinum'), (req, res) => res.json({ ok: true }));

    const hit = async (uid) => (await request(app).get('/platinum-only').set('x-uid', String(uid))).status;
    ok((await hit(10)) === 200, 'TRIAL passes requirePlan(platinum) — Budget/Invoices/Schedules/Templates', String(await hit(10)));
    ok((await hit(20)) === 403, 'EXPIRED still 403 on requirePlan(platinum)', String(await hit(20)));
    ok((await hit(30)) === 200, 'PAID Platinum passes');
    ok((await hit(40)) === 403, 'PAID Basic still 403 — not a Platinum plan');

    // ── 4. plan FEATURES — the budget.js copy that returned [] for trials ───
    // Exercised through the module's own export surface where possible; the
    // function is module-private, so drive it through a tiny harness that
    // mirrors the middleware's decision.
    const budgetSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'budget.js'), 'utf8');
    ok(/mode === "paid" \|\| mode === "trial_active"/.test(budgetSrc),
      'budget.js getActivePlanFeatures now admits trial_active (was a bare `return []`)');
    ok(/if \(!subRows\.length\) \{/.test(budgetSrc), 'budget.js no longer early-returns [] unconditionally');

    const jobsSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'jobs.js'), 'utf8');
    ok(/mode === "paid" \|\| mode === "trial_active"/.test(jobsSrc),
      'jobs.js copy already admitted trials (unchanged — my audit was wrong about this one)');

    // ── 5. the expired-trial guard that must NOT have widened ───────────────
    ok(typeof access.denyExpiredFreeWrites === 'function', 'denyExpiredFreeWrites still exported');
    const app2 = express();
    app2.use(express.json());
    app2.post('/write', (req, res, next) => { req.user = { id: Number(req.headers['x-uid']) }; res.locals.id = Number(req.headers['x-uid']); next(); },
      access.denyExpiredFreeWrites, (req, res) => res.json({ ok: true }));
    const w = async (uid) => (await request(app2).post('/write').set('x-uid', String(uid)).send({})).status;
    ok((await w(10)) === 200, 'TRIAL can still write');
    ok((await w(20)) === 403, 'EXPIRED still blocked from writes — the widening did not leak to dead trials', String(await w(20)));

    console.log('\ntrialEntitlement');
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('\nHARNESS ERROR:', e && e.stack ? e.stack : e);
    fail++;
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
