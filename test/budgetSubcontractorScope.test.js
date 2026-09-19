/* GET /budget/subcontractors — tenant isolation.
 *
 * The query used to open with an UNSCOPED branch:
 *
 *     SELECT id, name, email FROM user WHERE role = 12 AND status = 1
 *
 * No company, no user, no ownership clause. It returned every role-12 user in
 * the database, so any user who could open a Budget page saw every other
 * company's subcontractors — and theirs saw ours.
 *
 * Two companies are seeded here, each with its own subcontractors, because a
 * single-tenant fixture cannot tell a scoped query from an unscoped one: with
 * only one company in the table, "everyone" and "my contacts" are the same
 * set and the leak passes silently. That is the trap this file exists to
 * avoid.
 *
 * Run: node test/budgetSubcontractorScope.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_subscope_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, status INT DEFAULT 1, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT, request_to INT, request_user1 INT NULL, request_user2 INT NULL, status VARCHAR(20) NULL, created_at DATETIME NULL, updated_at DATETIME NULL)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT NULL, status VARCHAR(30), created_at DATETIME NULL)");
    await conn.query("CREATE TABLE plan_features (id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT NULL, feature_key VARCHAR(60))");
    // Both owners are paying customers so the budget feature gate lets them in;
    // the gate is not what this file is testing.
    await conn.query("CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(80), amount DECIMAL(10,2) DEFAULT 0)");
    await conn.query("INSERT INTO plans (id,name) VALUES (1,'Basic'),(5,'Platinum')");
    await conn.query("INSERT INTO plan_features (plan_id, feature_key) VALUES (5,'budget'),(5,'job_budget')");

    // TWO COMPANIES. Acme and Beta each own subcontractors the other must
    // never see.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,status,category,created_by,created_at) VALUES
      (100,'Acme Owner','acme@example.invalid',14,1,4,NULL,NOW()),
      (101,'Acme Sub One','asub1@example.invalid',12,1,2,NULL,NOW()),
      (102,'Acme Sub Two','asub2@example.invalid',12,1,2,NULL,NOW()),
      (200,'Beta Owner','beta@example.invalid',14,1,4,NULL,NOW()),
      (201,'Beta Sub One','bsub1@example.invalid',12,1,2,NULL,NOW()),
      (202,'Beta Sub Two','bsub2@example.invalid',12,1,2,NULL,NOW()),
      (300,'Unconnected Sub','orphan@example.invalid',12,1,2,NULL,NOW())`);
    await conn.query("INSERT INTO subscriptions (user_id, plan_id, status, created_at) VALUES (100,5,'active',NOW()),(200,5,'active',NOW())");

    // Contact links. Acme owns 101 and 102; Beta owns 201 and 202. 300 belongs
    // to nobody — it must appear for nobody.
    // RE-POINTED to the LIVE columns. This seeded request_user1/request_user2,
    // which NOTHING in the app writes — every INSERT INTO contact uses
    // request_by/request_to. So the suite was proving isolation against a
    // query that matched almost nothing in production, which is precisely how
    // the six-of-fifty-one bug survived. What it ASSERTS is unchanged: Acme
    // sees only Acme's, Beta only Beta's, and an unlinked user appears for
    // nobody.
    await conn.query(`INSERT INTO contact (request_by, request_to, created_at) VALUES
      (100,101,NOW()), (102,100,NOW()),
      (200,201,NOW()), (202,200,NOW())`);

    // plans.level is derived from the plan NAME by this helper; without it
    // requirePlan cannot resolve a tier and fails closed.
    try {
      const { ensurePlanLevelColumn } = require('../utils/access');
      if (ensurePlanLevelColumn) await ensurePlanLevelColumn(pool);
    } catch (e) { note('ensurePlanLevelColumn: ' + e.message); }

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/budget', require('../routes/budget'));
    const tok = (id, role, category) => 'Bearer ' + jwt.sign(
      { id, role, category, email: 'u' + id + '@example.invalid' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const listFor = async (id) => {
      const r = await request(app).get('/api/budget/subcontractors').set('Authorization', tok(id, 14, 4));
      if (r.status !== 200) { note(`HTTP ${r.status} for user ${id}: ${JSON.stringify(r.body).slice(0, 140)}`); return null; }
      return (Array.isArray(r.body) ? r.body : []).map((x) => x.name).sort();
    };

    const acme = await listFor(100);
    const beta = await listFor(200);
    ok(acme !== null && beta !== null, 'both companies can call the endpoint', JSON.stringify({ acme, beta }));
    note('Acme sees: ' + JSON.stringify(acme));
    note('Beta sees: ' + JSON.stringify(beta));

    // ── Own contacts still returned (the stop condition: if this fails,
    //    branches 2 and 3 are not what they appear to be) ─────────────────
    ok(acme && acme.includes('Acme Sub One') && acme.includes('Acme Sub Two'),
      'Acme still sees BOTH of its own subcontractors — the scoped branches work',
      JSON.stringify(acme));
    ok(beta && beta.includes('Beta Sub One') && beta.includes('Beta Sub Two'),
      'Beta still sees both of its own', JSON.stringify(beta));

    // ── The leak is closed, in both directions ──────────────────────────
    ok(acme && !acme.some((n) => n.startsWith('Beta')),
      'Acme sees NONE of Beta subcontractors', JSON.stringify(acme));
    ok(beta && !beta.some((n) => n.startsWith('Acme')),
      'Beta sees NONE of Acme subcontractors — the reverse direction too',
      JSON.stringify(beta));

    // ── A subcontractor belonging to nobody belongs to nobody ───────────
    ok(acme && !acme.includes('Unconnected Sub') && beta && !beta.includes('Unconnected Sub'),
      'a role-12 user with no contact link appears for NOBODY',
      JSON.stringify({ acme, beta }));

    ok(acme && acme.length === 2, 'Acme list is exactly 2, not the whole platform', String(acme && acme.length));
    ok(beta && beta.length === 2, 'Beta list is exactly 2', String(beta && beta.length));

    // ── Nothing was written ─────────────────────────────────────────────
    const [[uc]] = await conn.query('SELECT COUNT(*) AS n FROM `user`');
    const [[cc]] = await conn.query('SELECT COUNT(*) AS n FROM contact');
    ok(Number(uc.n) === 7 && Number(cc.n) === 4,
      'reading the dropdown wrote nothing — user and contact rows unchanged',
      JSON.stringify({ users: uc.n, contacts: cc.n }));

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
