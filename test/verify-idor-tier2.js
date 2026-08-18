/* IDOR remediation — Tier 2 (financial/PII read-leaks), real local MySQL.
 * Part A: shared guards used by Tier 2 — requireSameAccountAsParam + requireOwnsJob
 *         (incl. fixedType:'lead').
 * Part B: real routers end-to-end where the guard is cleanly reachable —
 *         time_card /time-logs + /pending-logs, budget /divisions/:id/lineitems
 *         (incl. the omitted-job_id all-accounts leak → now 400), bids GET /:id,
 *         change-order /get_Jobcontacts/:jid.
 * The quote reads reuse the same requireOwnsJob/requireSameAccountAsParam (their
 * router carries a local requireQuoteAccess gate before the guard); wiring grep-verified.
 * Run: node test/verify-idor-tier2.js
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

(async () => {
  let db, pool, conn, serverA, serverB;
  try {
    process.env.NODE_ENV = 'test';
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_idor_t2', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), email VARCHAR(120), business VARCHAR(120) NULL, category INT NULL, created_by INT NULL)');
    await conn.query('CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(120) NULL)');
    await conn.query('CREATE TABLE leads (id INT PRIMARY KEY, user_id INT NULL, lead_name VARCHAR(120) NULL)');
    await conn.query('CREATE TABLE clockin (id INT PRIMARY KEY AUTO_INCREMENT, created_by INT NULL, job_id INT NULL, status VARCHAR(20) NULL, approval_status VARCHAR(20) NULL)');
    await conn.query('CREATE TABLE division_lineitems (id INT PRIMARY KEY AUTO_INCREMENT, division_id INT, job_id INT NULL, owner_type VARCHAR(10) NULL, lineitem_description VARCHAR(120) NULL, amount DECIMAL(12,2) NULL, sub_cost DECIMAL(12,2) NULL, csi_number VARCHAR(20) NULL, contingency DECIMAL(12,2) NULL, overhead_percent DECIMAL(6,2) NULL, gl_percent DECIMAL(6,2) NULL, subcontractor_id INT NULL, in_house TINYINT NULL, foreman_percent DECIMAL(6,2) NULL, paid_amount DECIMAL(12,2) NULL)');
    await conn.query('CREATE TABLE bid_requests (id INT PRIMARY KEY, gc_user_id INT NULL, job_id INT NULL, title VARCHAR(120) NULL, comments TEXT NULL, status VARCHAR(20) NULL, created_at DATETIME NULL)');
    await conn.query('CREATE TABLE bid_invites (id INT PRIMARY KEY AUTO_INCREMENT, bid_request_id INT NULL, contractor_user_id INT NULL, status VARCHAR(20) NULL)');
    await conn.query('CREATE TABLE bid_shared_docs (id INT PRIMARY KEY AUTO_INCREMENT, bid_request_id INT NULL, document_id INT NULL)');
    await conn.query('CREATE TABLE bid_submissions (id INT PRIMARY KEY AUTO_INCREMENT, bid_request_id INT NULL, contractor_user_id INT NULL, bid_total DECIMAL(12,2) NULL, scope_notes TEXT NULL, valid_until DATETIME NULL, pdf_path VARCHAR(255) NULL)');
    await conn.query('CREATE TABLE job_documents (id INT PRIMARY KEY, name VARCHAR(120) NULL, path VARCHAR(255) NULL, type VARCHAR(20) NULL)');

    // 74 owner, 86 employee-of-74, 999 external GC, 555 external contractor (a bid invitee)
    await conn.query(`INSERT INTO \`user\`(id,name,email,category,created_by) VALUES
      (74,'Owner','o@x.com',2,NULL),(86,'Emp','e@x.com',1,74),(999,'External','ext@x.com',2,NULL),(555,'Sub','sub@x.com',2,NULL)`);
    await conn.query('INSERT INTO job (id,created_by,name) VALUES (100,74,\'Mine\'),(200,999,\'Theirs\')');
    await conn.query('INSERT INTO leads (id,user_id,lead_name) VALUES (300,74,\'MyLead\'),(400,999,\'TheirLead\')');
    await conn.query('INSERT INTO clockin (created_by,job_id,status) VALUES (999,200,\'active\')');
    await conn.query("INSERT INTO division_lineitems (division_id,job_id,owner_type,amount) VALUES (9,100,'job',10),(9,200,'job',99)");
    await conn.query("INSERT INTO bid_requests (id,gc_user_id,job_id,title,status) VALUES (700,74,100,'Mine','open'),(701,999,200,'Theirs','open')");
    await conn.query("INSERT INTO bid_invites (bid_request_id,contractor_user_id,status) VALUES (701,555,'invited')");

    // ================= PART A — shared guards =================
    console.log('A) SHARED GUARDS (unit)');
    const express = require('express');
    const request = require('supertest');
    const { requireSameAccountAsParam, requireOwnsJob } = require('../utils/ownership');
    const appA = express();
    appA.use(express.json());
    appA.use((req, _res, next) => { req.user = { id: Number(req.headers['x-uid']) }; next(); });
    appA.get('/param/:userId', requireSameAccountAsParam({ idKey: 'userId' }), (_q, res) => res.json({ ok: 1 }));
    appA.get('/lead/:job_id', requireOwnsJob({ idFrom: 'params', idKey: 'job_id', fixedType: 'lead' }), (_q, res) => res.json({ ok: 1 }));
    serverA = appA.listen(0);
    const A = (p, uid) => request(serverA).get(p).set('x-uid', String(uid));

    ok((await A('/param/74', 74)).status === 200, 'requireSameAccountAsParam: self → allowed');
    ok((await A('/param/86', 74)).status === 200, 'requireSameAccountAsParam: same-account employee → allowed');
    ok((await A('/param/999', 74)).status === 403, 'requireSameAccountAsParam: cross-account → 403');
    ok((await A('/lead/300', 74)).status === 200, 'requireOwnsJob(lead): owner lead → allowed');
    ok((await A('/lead/400', 74)).status === 403, 'requireOwnsJob(lead): cross-account lead → 403');

    // ================= PART B — real routers =================
    console.log('\nB) REAL ROUTERS (end-to-end)');
    let ACTOR = null;
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const accessMod = require('../utils/access');
    accessMod.denyExpiredFreeWrites = (_req, _res, next) => next();
    accessMod.blockExpiredOwnJob = () => (_req, _res, next) => next();
    accessMod.blockExpiredOwnRecord = () => (_req, _res, next) => next();
    // budget.js applies requirePlan("platinum") at router level (before route
    // middleware); stub it so the test reaches the ownership guard (in prod a real
    // Platinum user passes it and then hits requireOwnsJob).
    accessMod.requirePlan = () => (_req, _res, next) => next();
    const appB = express();
    appB.use(express.json());
    appB.use('/tc', require('../routes/time_card'));
    appB.use('/budget', require('../routes/budget'));
    appB.use('/bids', require('../routes/bids'));
    appB.use('/co', require('../routes/change_order'));
    serverB = appB.listen(0);
    const B = (p) => request(serverB).get(p);
    const as = (u) => { ACTOR = { id: u, role: u === 86 ? 5 : 14, working_id: u === 86 ? 74 : undefined }; };

    as(74);  ok((await B('/tc/time-logs/999')).status === 403, 'GET /time-logs/:userId — cross-account → 403');
    as(74);  ok((await B('/tc/time-logs/86')).status !== 403, 'GET /time-logs/:userId — same-account employee → not 403');
    as(74);  ok((await B('/tc/pending-logs/999')).status === 403, 'GET /pending-logs/:userId — cross-account → 403');
    as(74);  ok((await B('/budget/divisions/9/lineitems?job_id=200&job_type=job')).status === 403, 'GET /divisions/:id/lineitems — cross-account job → 403');
    as(74);  ok((await B('/budget/divisions/9/lineitems')).status === 400, 'GET /divisions/:id/lineitems — omitted job_id → 400 (was all-accounts leak)');
    as(999); ok((await B('/bids/701')).status === 200, 'GET /bids/:id — GC owner → 200');
    as(74);  ok((await B('/bids/701')).status === 403, 'GET /bids/:id — cross-account → 403 (was leaking competitor bid_total)');
    as(555); ok((await B('/bids/701')).status === 200, 'GET /bids/:id — invited contractor → 200 (preserved)');
    as(74);  ok((await B('/co/get_Jobcontacts/200')).status === 403, 'GET /change-orders/get_Jobcontacts/:jid — cross-account → 403');
    as(74);  ok((await B('/co/get_Jobcontacts/100')).status !== 403, 'GET /change-orders/get_Jobcontacts/:jid — owner → not 403');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally {
    try { if (serverA) serverA.close(); } catch {}
    try { if (serverB) serverB.close(); } catch {}
    try { if (conn) conn.release(); } catch {}
    try { if (pool && pool.end) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
})();
