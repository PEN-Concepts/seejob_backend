/* getJobContacts cross-account guard — drives the REAL GET /user/getJobContacts/:id
 * route (mounted via express+supertest, auth + migration stubbed) against real
 * MySQL. Proves job_contacts can no longer be read across accounts by passing a
 * foreign job_id (was: no ownership check → 200 [] for a non-owned job, and a real
 * leak for a populated one).
 * Run: node test/verify-getjobcontacts-scope.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

(async () => {
  let db, pool, conn, server;
  try {
    process.env.NODE_ENV = 'test';
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_jc_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), email VARCHAR(120), image VARCHAR(255) NULL, subcategory INT NULL, category INT NULL, created_by INT NULL)');
    await conn.query('CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL)');
    await conn.query('CREATE TABLE leads (id INT PRIMARY KEY, user_id INT NULL)');
    await conn.query('CREATE TABLE job_contacts (id INT AUTO_INCREMENT PRIMARY KEY, job_id INT, contact_id INT, owner_type VARCHAR(10) DEFAULT \'job\')');
    await conn.query('CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(60))');

    // 74 owner; 86 employee-of-74 (category 1 → resolves to 74); 999 external GC.
    // 500/600 are the CONTACT people joined into the result.
    await conn.query(`INSERT INTO \`user\`(id,name,email,category,created_by) VALUES
      (74,'Owner Poul','poul@x.com',2,NULL),
      (86,'Joshua (employee)','josh@x.com',1,74),
      (999,'External GC','ext@x.com',2,NULL),
      (500,'Contact A','a@x.com',2,74),
      (600,'Contact B (external)','b@x.com',2,999)`);
    await conn.query("INSERT INTO job (id, created_by) VALUES (100, 74), (200, 999)");
    await conn.query("INSERT INTO job_contacts (job_id, contact_id, owner_type) VALUES (100, 500, 'job'), (200, 600, 'job')");

    // Mount the REAL route. Stub auth (inject actor) + the migration (not under test).
    let ACTOR = null;
    const authMod = require('../services/authentication');
    authMod.authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const mig = require('../services/dbMigrations');
    mig.ensureOwnerTypeColumns = async () => {};
    const express = require('express');
    const request = require('supertest');
    const usersRouter = require('../routes/users');
    const app = express();
    app.use(express.json());
    app.use('/user', usersRouter);
    server = app.listen(0);
    const get = (id) => request(server).get(`/user/getJobContacts/${id}`);

    // Case 1 — owner reads their own job's contacts → 200 + the contact.
    ACTOR = { id: 74, role: 14 };
    let r1 = await get(100);
    ok(r1.status === 200 && Array.isArray(r1.body.data) && r1.body.data.some((c) => Number(c.id) === 500),
       'owner → own job contacts: 200 with the contact');

    // Case 2 — CROSS-ACCOUNT: owner 74 requests external account 999's job → 403, no leak.
    ACTOR = { id: 74, role: 14 };
    let r2 = await get(200);
    ok(r2.status === 403 && (!r2.body.data || r2.body.data.length === 0),
       "cross-account job: 403, contacts NOT leaked (was 200 with the other account's contact)");

    // Case 3 — nonexistent job → 404 (consistent with the other job-scoped endpoints).
    ACTOR = { id: 74, role: 14 };
    let r3 = await get(999999);
    ok(r3.status === 404, 'nonexistent job: 404 (was 200 [])');

    // Case 4 — employee of the owner reads the account's job → 200 (same account).
    ACTOR = { id: 86, role: 5 };
    let r4 = await get(100);
    ok(r4.status === 200 && r4.body.data.some((c) => Number(c.id) === 500),
       'employee-of-owner → account job contacts: 200 (same account)');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally {
    try { if (server) server.close(); } catch {}
    try { if (conn) conn.release(); } catch {}
    try { if (pool && pool.end) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
})();
