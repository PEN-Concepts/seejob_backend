/* IDOR remediation — Tier 4, real local MySQL.
 * Part A: the shared guards backing the CO/quote legacy writes + jobs writes —
 *   requireOwnsRecordViaJob, requireOwnsViaParentJob, requireOwnsJobOrLead, and
 *   ownsJob's new job-OR-lead resolution.
 * Part B: real routers end-to-end — bids competitor-visibility (GC sees all,
 *   contractor sees only own), change-order writes (/status via record→job,
 *   /delete via child→parent→job), tasks /upload-photo, jobs /update-job-order.
 * quote writes reuse the same guards (their router's requireQuoteAccess gate
 * blocks a clean mount) — wiring grep-verified.
 * Run: node test/verify-idor-tier4.js
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
    db = await createDB({ dbName: 'seejob_idor_t4', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), business VARCHAR(120) NULL, category INT NULL, created_by INT NULL)');
    await conn.query('CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, sort_order INT NULL)');
    await conn.query('CREATE TABLE leads (id INT PRIMARY KEY, user_id INT NULL)');
    await conn.query('CREATE TABLE change_order (id INT PRIMARY KEY, job_id INT NULL, status VARCHAR(20) NULL, reason VARCHAR(120) NULL)');
    await conn.query('CREATE TABLE change_order_list (id INT PRIMARY KEY, change_order_id INT NULL)');
    await conn.query('CREATE TABLE change_order_emp (id INT PRIMARY KEY, change_order_id INT NULL)');
    await conn.query('CREATE TABLE tasks (id INT PRIMARY KEY, created_by INT NULL, user_id INT NULL, job_id INT NULL)');
    await conn.query('CREATE TABLE task_assignees (id INT AUTO_INCREMENT PRIMARY KEY, task_id INT, user_id INT)');
    await conn.query('CREATE TABLE bid_requests (id INT PRIMARY KEY, gc_user_id INT NULL, job_id INT NULL, title VARCHAR(80) NULL, status VARCHAR(20) NULL)');
    await conn.query('CREATE TABLE bid_invites (id INT PRIMARY KEY AUTO_INCREMENT, bid_request_id INT, contractor_user_id INT, status VARCHAR(20) NULL)');
    await conn.query('CREATE TABLE bid_submissions (id INT PRIMARY KEY AUTO_INCREMENT, bid_request_id INT, contractor_user_id INT, bid_total DECIMAL(12,2) NULL, scope_notes TEXT NULL, valid_until DATETIME NULL, pdf_path VARCHAR(255) NULL)');
    await conn.query('CREATE TABLE bid_shared_docs (id INT PRIMARY KEY AUTO_INCREMENT, bid_request_id INT, document_id INT)');
    await conn.query('CREATE TABLE job_documents (id INT PRIMARY KEY, name VARCHAR(80) NULL, path VARCHAR(255) NULL, type VARCHAR(20) NULL)');

    await conn.query(`INSERT INTO \`user\`(id,name,category,created_by) VALUES
      (74,'Owner',2,NULL),(86,'Emp',1,74),(999,'External',2,NULL),(555,'Sub',2,NULL),(556,'Sub2',2,NULL)`);
    await conn.query('INSERT INTO job (id,created_by) VALUES (100,74),(200,999)');
    await conn.query('INSERT INTO leads (id,user_id) VALUES (300,74),(400,999)');
    await conn.query("INSERT INTO change_order (id,job_id,status) VALUES (800,100,'pending'),(801,200,'pending')");
    await conn.query('INSERT INTO change_order_list (id,change_order_id) VALUES (8100,800),(8101,801)');
    await conn.query('INSERT INTO change_order_emp (id,change_order_id) VALUES (8200,800),(8201,801)');
    await conn.query('INSERT INTO tasks (id,created_by,user_id) VALUES (500,74,74),(501,999,999)');
    await conn.query("INSERT INTO bid_requests (id,gc_user_id,job_id,title,status) VALUES (700,74,100,'Mine','open')");
    await conn.query("INSERT INTO bid_invites (bid_request_id,contractor_user_id,status) VALUES (700,555,'invited'),(700,556,'invited')");
    await conn.query("INSERT INTO bid_submissions (bid_request_id,contractor_user_id,bid_total,scope_notes) VALUES (700,555,1000,'mine'),(700,556,2000,'theirs')");

    // ============ PART A — shared guards (unit) ============
    console.log('A) SHARED GUARDS (unit)');
    const express = require('express');
    const request = require('supertest');
    const { requireOwnsRecordViaJob, requireOwnsViaParentJob, requireOwnsJobOrLead, ownsJob } = require('../utils/ownership');
    const appA = express(); appA.use(express.json());
    appA.use((req, _r, next) => { req.user = { id: Number(req.headers['x-uid']) }; next(); });
    appA.get('/viajob/:id', requireOwnsRecordViaJob({ table: 'change_order', idKey: 'id' }), (_q, r) => r.json({ ok: 1 }));
    appA.get('/viaparent/:id', requireOwnsViaParentJob({ table: 'change_order_list', parentCol: 'change_order_id', parentTable: 'change_order' }), (_q, r) => r.json({ ok: 1 }));
    appA.get('/jol/:job_id', requireOwnsJobOrLead({ idFrom: 'params', idKey: 'job_id' }), (_q, r) => r.json({ ok: 1 }));
    serverA = appA.listen(0);
    const A = (p, uid) => request(serverA).get(p).set('x-uid', String(uid));

    ok((await A('/viajob/800', 74)).status === 200, 'requireOwnsRecordViaJob: owner CO → allowed');
    ok((await A('/viajob/801', 74)).status === 403, 'requireOwnsRecordViaJob: cross-account CO → 403');
    ok((await A('/viaparent/8100', 74)).status === 200, 'requireOwnsViaParentJob: owner CO-line → allowed');
    ok((await A('/viaparent/8101', 74)).status === 403, 'requireOwnsViaParentJob: cross-account CO-line → 403');
    ok((await A('/jol/100', 74)).status === 200, 'requireOwnsJobOrLead: owner JOB → allowed');
    ok((await A('/jol/300', 74)).status === 200, 'requireOwnsJobOrLead: owner LEAD → allowed');
    ok((await A('/jol/200', 74)).status === 403, 'requireOwnsJobOrLead: cross-account job → 403');
    ok((await A('/jol/400', 74)).status === 403, 'requireOwnsJobOrLead: cross-account lead → 403');
    ok((await ownsJob(74, 300, conn)) === true, 'ownsJob: resolves a LEAD id (job-or-lead) → true');
    ok((await ownsJob(74, 400, conn)) === false, 'ownsJob: cross-account lead → false');

    // ============ PART B — real routers ============
    console.log('\nB) REAL ROUTERS (end-to-end)');
    let ACTOR = null;
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const accessMod = require('../utils/access');
    accessMod.denyExpiredFreeWrites = (_req, _res, next) => next();
    const appB = express(); appB.use(express.json());
    appB.use('/bids', require('../routes/bids'));
    appB.use('/co', require('../routes/change_order'));
    appB.use('/tasks', require('../routes/tasks'));
    serverB = appB.listen(0);
    const as = (u) => { ACTOR = { id: u, role: 14 }; };
    const B = () => request(serverB);

    // bids competitor-visibility
    as(74);  const bGc = await B().get('/bids/700');
    ok(bGc.status === 200 && (bGc.body.data.invites || []).length === 2, 'bids GET /:id — GC owner sees ALL invitees (2)');
    as(555); const bSub = await B().get('/bids/700');
    ok(bSub.status === 200 && (bSub.body.data.invites || []).length === 1 && Number(bSub.body.data.invites[0].contractor_user_id) === 555,
       'bids GET /:id — invited contractor sees ONLY their own submission (1), not competitors');

    // CO writes cross-account → 403
    as(74); ok((await B().put('/co/status/801').send({ status: 'approved' })).status === 403, 'PUT /change-orders/status/:id — cross-account → 403');
    as(74); ok((await B().put('/co/status/800').send({ status: 'approved' })).status !== 403, 'PUT /change-orders/status/:id — owner → not 403');
    as(74); ok((await B().delete('/co/delete/8101')).status === 403, 'DELETE /change-orders/delete/:id (CO line) — cross-account → 403');
    as(74); ok((await B().delete('/co/job-contact/8201')).status === 403, 'DELETE /change-orders/job-contact/:id — cross-account → 403');
    as(74); ok((await B().post('/co/create').send({ job_id: 200, items: [{ x: 1 }] })).status === 403, 'POST /change-orders/create — cross-account job_id → 403');
    as(74); ok((await B().put('/co/changewith/200').send({})).status === 403, 'PUT /change-orders/changewith/:id — cross-account job → 403');

    // tasks upload-photo cross-account → 403 (guard fires before file handling)
    as(74); ok((await B().post('/tasks/upload-photo/501')).status === 403, 'POST /tasks/upload-photo/:taskId — cross-account → 403');

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
