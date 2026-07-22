/* "Free Account" badge for PURE collaborators on the admin overview.
 * A Contractor/Client with NO subscription record who has never created a job
 * of their own is an invited-and-accepted collaborator (never billed) → flagged
 * free_collaborator (frontend shows "Free Account", not "Paying"). An account
 * that owns >=1 job is self-employed → its real trial/paid/expired status stands.
 * Real MySQL (mysql-memory-server) + supertest. Run: NODE_PATH=<be>/node_modules node test/freeAccountBadge.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_freeacct_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE role (id INT PRIMARY KEY, name VARCHAR(80))`);
    await conn.query(`CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(80))`);
    await conn.query(`CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(80))`);
    await conn.query(`CREATE TABLE \`user\` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT, category INT, subcategory INT NULL, created_by INT NULL, created_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(80), level INT NULL, amount DECIMAL(10,2), \`interval\` VARCHAR(20), is_active TINYINT DEFAULT 1)`);
    await conn.query(`CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT NULL, amount DECIMAL(10,2), billing_interval VARCHAR(20), status VARCHAR(30), next_billing_at DATETIME NULL, authorize_subscription_id VARCHAR(60) NULL, needs_reverification TINYINT DEFAULT 0, reverification_due_at DATETIME NULL)`);
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL)`);
    await conn.query(`INSERT INTO category VALUES (1,'Employee'),(2,'Contractor'),(3,'Client')`);
    await conn.query(`INSERT INTO plans (id,name,level,amount,\`interval\`,is_active) VALUES (4,'Gold',4,99.00,'monthly',1)`);

    // 300 pure collaborator (Contractor, no sub, 0 jobs, null created_at -> would read 'paid'/"Paying")
    // 301 self-employed contractor (Contractor, no sub, OWNS 1 job, trial window)
    // 302 owner-exempt
    // 303 real paying (Contractor + active Gold sub)
    // 304 former payer (Contractor, canceled sub on file, 0 jobs) — has a sub RECORD
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_at) VALUES
      (300,'Collab Sub','collab@x.com',2,2,NULL),
      (301,'Self Employed','selfemp@x.com',2,2, NOW() - INTERVAL 10 DAY),
      (302,'Owner','poul@oakcoast.net',14,2,NULL),
      (303,'Paying Contractor','payer@x.com',2,2, NOW() - INTERVAL 200 DAY),
      (304,'Former Payer','former@x.com',2,2, NOW() - INTERVAL 200 DAY)`);
    await conn.query(`INSERT INTO job (id,created_by) VALUES (900,301)`); // only 301 owns a job
    await conn.query(`INSERT INTO subscriptions (user_id,plan_id,amount,billing_interval,status,authorize_subscription_id) VALUES
      (303,4,99.00,'monthly','active','ARBPAY'),
      (304,4,99.00,'monthly','canceled','ARBOLD')`);

    app = require('express')();
    app.use(require('express').json());
    app.use('/api/payments', require('../routes/payments'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);

    const res = await request(app).get('/api/payments/admin/subscriptions-overview').set('Authorization', tok(246));
    ok(res.status === 200 && Array.isArray(res.body.users), 'overview: 200 + users[]', String(res.status));
    const byId = new Map((res.body.users || []).map((u) => [u.id, u]));

    const c = byId.get(300);
    ok(c && c.free_collaborator === true, 'pure collaborator (no sub, 0 jobs) -> free_collaborator=true ("Free Account")', JSON.stringify(c));
    ok(c && c.is_paying === false, 'pure collaborator -> is_paying=false (not counted as paying)', c && c.is_paying);

    const se = byId.get(301);
    ok(se && se.free_collaborator === false, 'self-employed contractor (owns 1 job) -> free_collaborator=false', JSON.stringify(se));
    ok(se && se.access_mode === 'trial_active', 'self-employed contractor -> shows real status (trial_active), NOT relabeled', se && se.access_mode);

    const ex = byId.get(302);
    ok(ex && ex.owner_exempt === true && ex.free_collaborator === false && ex.access_mode === 'paid', 'owner-exempt account unaffected (not free_collaborator)', JSON.stringify(ex));

    const pay = byId.get(303);
    ok(pay && pay.is_paying === true && pay.free_collaborator === false && pay.access_mode === 'paid', 'real paying account unaffected (is_paying, not free_collaborator)', JSON.stringify(pay));

    const former = byId.get(304);
    ok(former && former.free_collaborator === false, 'former payer (canceled sub on file, 0 jobs) -> NOT free_collaborator (has a subscription record)', JSON.stringify(former));

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
