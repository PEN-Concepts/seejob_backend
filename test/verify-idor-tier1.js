/* IDOR remediation — Tier 1 regression proof, on real local MySQL.
 *
 * Part A: unit-tests the SHARED guards (requireOwnsRecord, requireOwnsJob, ownsJob)
 *         that every Tier-1 endpoint relies on — owner passes, cross-account 403,
 *         nonexistent 404.
 * Part B: drives the REAL routers end-to-end for the cleanly-reachable endpoints
 *         (tasks DELETE, teams update+delete, equipments update, change-order
 *         download+email) — cross-account 403, owner not-403.
 *
 * The plan-gated endpoints (jobs /upload-files, quote /download + /email-quote)
 * use the SAME requireOwnsJob/ownsJob proven in Part A; their wiring is asserted
 * by grep in the sibling check. Run: node test/verify-idor-tier1.js
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
    db = await createDB({ dbName: 'seejob_idor_t1', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    // ---- schema ----
    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80), email VARCHAR(120), mobile VARCHAR(20) NULL, category INT NULL, subcategory INT NULL, created_by INT NULL)');
    await conn.query('CREATE TABLE job (id INT PRIMARY KEY, created_by INT NULL, name VARCHAR(120) NULL)');
    await conn.query('CREATE TABLE leads (id INT PRIMARY KEY, user_id INT NULL)');
    await conn.query('CREATE TABLE tasks (id INT PRIMARY KEY, created_by INT NULL, user_id INT NULL)');
    await conn.query('CREATE TABLE appointments (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT NULL)');
    await conn.query('CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, calendar_task_id INT NULL, appointment_id INT NULL)');
    await conn.query('CREATE TABLE teams (id INT PRIMARY KEY, created_by INT NULL, team_name VARCHAR(80) NULL, updated_by INT NULL, color VARCHAR(20) NULL, team_leader INT NULL, job_id INT NULL)');
    await conn.query('CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT NULL, user_id INT NULL)');
    await conn.query('CREATE TABLE equipments (id INT PRIMARY KEY, created_by INT NULL, equipment_name VARCHAR(80) NULL, year VARCHAR(10) NULL, is_assigned TINYINT NULL, updated_at DATETIME NULL, updated_by INT NULL, image VARCHAR(255) NULL)');
    await conn.query('CREATE TABLE change_order (id INT PRIMARY KEY, job_id INT NULL, status VARCHAR(20) NULL, completed TINYINT NULL, chnage_order_from INT NULL, change_order_with INT NULL)');
    await conn.query('CREATE TABLE change_order_list (id INT PRIMARY KEY, change_order_id INT NULL, description VARCHAR(120) NULL, amount DECIMAL(12,2) NULL)');
    await conn.query('CREATE TABLE change_order_emp (id INT PRIMARY KEY AUTO_INCREMENT, change_order_id INT NULL, emp_id INT NULL)');
    await conn.query('CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(40) NULL)');
    await conn.query('CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(40) NULL)');

    // ---- data: 74 owner, 86 employee-of-74, 999 external ----
    await conn.query(`INSERT INTO \`user\`(id,name,email,category,created_by) VALUES
      (74,'Owner','o@x.com',2,NULL),(86,'Emp','e@x.com',1,74),(999,'External','ext@x.com',2,NULL)`);
    await conn.query('INSERT INTO job (id,created_by,name) VALUES (100,74,\'Mine\'),(200,999,\'Theirs\')');
    await conn.query('INSERT INTO tasks (id,created_by,user_id) VALUES (500,74,74),(501,999,999)');
    await conn.query('INSERT INTO teams (id,created_by,team_name) VALUES (600,74,\'MyTeam\'),(601,999,\'TheirTeam\')');
    await conn.query('INSERT INTO equipments (id,created_by,equipment_name) VALUES (700,74,\'MyRig\'),(701,999,\'TheirRig\')');
    await conn.query('INSERT INTO change_order (id,job_id,status,completed) VALUES (800,100,\'pending\',0),(801,200,\'pending\',0)');
    await conn.query('INSERT INTO change_order_list (id,change_order_id,description,amount) VALUES (8000,800,\'x\',10),(8001,801,\'y\',20)');

    // ================= PART A — shared guards (unit) =================
    console.log('A) SHARED GUARDS (unit)');
    const express = require('express');
    const request = require('supertest');
    const { requireOwnsRecord, requireOwnsJob, ownsJob } = require('../utils/ownership');
    const appA = express();
    appA.use(express.json());
    appA.use((req, _res, next) => { req.user = { id: Number(req.headers['x-uid']) }; next(); });
    appA.delete('/rec/:id', requireOwnsRecord({ table: 'tasks', ownerCol: 'created_by' }), (_req, res) => res.json({ ok: 1 }));
    appA.post('/job', requireOwnsJob({ idFrom: 'body', idKey: 'job_id' }), (_req, res) => res.json({ ok: 1 }));
    serverA = appA.listen(0);
    const A = (m, p, uid, body) => request(serverA)[m](p).set('x-uid', String(uid)).send(body || {});

    ok((await A('delete', '/rec/500', 74)).status === 200, 'requireOwnsRecord: owner → allowed');
    ok((await A('delete', '/rec/501', 74)).status === 403, 'requireOwnsRecord: cross-account → 403');
    ok((await A('delete', '/rec/999999', 74)).status === 404, 'requireOwnsRecord: nonexistent → 404');
    ok((await A('post', '/job', 74, { job_id: 100 })).status === 200, 'requireOwnsJob: owner → allowed');
    ok((await A('post', '/job', 74, { job_id: 200 })).status === 403, 'requireOwnsJob: cross-account → 403');
    ok((await A('post', '/job', 74, { job_id: 999999 })).status === 404, 'requireOwnsJob: nonexistent → 404');
    ok((await ownsJob(74, 100, conn)) === true, 'ownsJob: owner → true');
    ok((await ownsJob(74, 200, conn)) === false, 'ownsJob: cross-account → false');
    ok((await ownsJob(74, 999999, conn)) === false, 'ownsJob: nonexistent → false');

    // ================= PART B — real routers (end-to-end) =================
    console.log('\nB) REAL ROUTERS (end-to-end)');
    let ACTOR = null;
    require('../services/authentication').authenticateToken = (req, _res, next) => { req.user = ACTOR; next(); };
    const accessMod = require('../utils/access');
    accessMod.denyExpiredFreeWrites = (_req, _res, next) => next();
    const appB = express();
    appB.use(express.json());
    appB.use('/tasks', require('../routes/tasks'));
    appB.use('/teams', require('../routes/teams'));
    appB.use('/equipments', require('../routes/equipments'));
    appB.use('/co', require('../routes/change_order'));
    serverB = appB.listen(0);
    const B = (m, p, body) => request(serverB)[m](p).send(body || {});
    const as = (u) => { ACTOR = { id: u, role: u === 999 ? 14 : (u === 86 ? 5 : 14) }; };

    as(999); ok((await B('delete', '/tasks/delete/500')).status === 403, 'DELETE /tasks/delete/:id — cross-account → 403');
    as(74);  ok((await B('delete', '/tasks/delete/500')).status !== 403, 'DELETE /tasks/delete/:id — owner → not 403');
    as(999); ok((await B('put', '/teams/update/600', { team_name: 'hax' })).status === 403, 'PUT /teams/update/:id — cross-account → 403');
    as(74);  ok((await B('put', '/teams/update/600', { team_name: 'ok' })).status !== 403, 'PUT /teams/update/:id — owner → not 403');
    as(999); ok((await B('delete', '/teams/teams/600')).status === 403, 'DELETE /teams/:id — cross-account → 403');
    as(74);  ok((await B('delete', '/teams/teams/601')).status === 403, 'DELETE /teams/:id — (74 vs 999 team) cross → 403');
    as(999); ok((await B('put', '/equipments/update/700', { equipment_name: 'hax' })).status === 403, 'PUT /equipments/update/:id — cross-account → 403');
    as(74);  ok((await B('put', '/equipments/update/700', { equipment_name: 'ok' })).status !== 403, 'PUT /equipments/update/:id — owner → not 403');
    // change_order download + email: cross-account (74 requesting 999's CO 801) → 403 (guard fires after fetch, before PDF/email)
    as(74);  ok((await B('get', '/co/download/801')).status === 403, 'GET /change-orders/download/:id — cross-account → 403');
    as(74);  ok((await B('post', '/co/email-change-order/801', { contacts: ['a@b.com'] })).status === 403, 'POST /email-change-order/:id — cross-account → 403');

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
