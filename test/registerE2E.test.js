/* Public sign-up (/register) end-to-end against the REAL router + a prod-like
 * `user` table (address columns + password NOT NULL). Proves: GC/Client/Sub all
 * create a working row; password is never null; Admin(5)/Employee(1) are rejected
 * server-side. Run: NODE_PATH=<backend>/node_modules node test/registerE2E.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_register_e2e', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const request = require('supertest');
    conn = await pool.getConnection();

    // Prod-like `user`: password + address columns NOT NULL (the columns that
    // were breaking the old insert). Extra prod columns given safe defaults.
    await conn.query(`CREATE TABLE user (
      id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(190), email VARCHAR(190) UNIQUE,
      password VARCHAR(190) NOT NULL, role INT, mobile VARCHAR(60) UNIQUE, category INT, subcategory INT,
      business VARCHAR(190), trade VARCHAR(190), social_security VARCHAR(60) NOT NULL DEFAULT '',
      street VARCHAR(190) NOT NULL, city VARCHAR(120) NOT NULL, state VARCHAR(120) NOT NULL,
      zipcode VARCHAR(20) NOT NULL, contact_note VARCHAR(255) NOT NULL,
      otp VARCHAR(10), otp_status TINYINT, created_at VARCHAR(40), created_by INT NULL,
      must_change_password TINYINT, status TINYINT NOT NULL DEFAULT 1, level TINYINT NULL)`);
    await conn.query(`CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(60))`);
    await conn.query(`INSERT INTO category (id,name) VALUES (1,'Employee'),(2,'Subcontractor'),(3,'Client'),(4,'General contractor'),(5,'Admin')`);

    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api', require('../routes/users'));

    const reg = (payload) => request(app).post('/api/register').send(payload);

    // EXACT shape the public signup form (submitForm) posts.
    const roles = [
      { label: 'General Contractor', category: 4, subcategory: '14', mobile: '(555) 010-1001', email: 'e2e_gc@example.com', name: 'GC Tester', business_name: 'GC Biz', trade: 'Other' },
      { label: 'Client',             category: 3, subcategory: '11', mobile: '(555) 010-1002', email: 'e2e_client@example.com', name: 'Client Tester', business_name: '', trade: '' },
      { label: 'Subcontractor',      category: 2, subcategory: '7',  mobile: '(555) 010-1003', email: 'e2e_sub@example.com', name: 'Sub Tester', business_name: 'Sub Biz', trade: 'Framing' },
    ];

    for (const role of roles) {
      const res = await reg({
        name: role.name, email: role.email, password: '', mobile: role.mobile,
        category: role.category, subcategory: role.subcategory,
        business_name: role.business_name, trade: role.trade,
      });
      ok(res.status === 201 && res.body.code === '201', `${role.label}: sign-up returns 201`, `status=${res.status} body=${JSON.stringify(res.body)}`);
      const [[row]] = await conn.query('SELECT * FROM user WHERE email = ?', [role.email]);
      ok(!!row, `${role.label}: row created`, JSON.stringify(res.body));
      if (row) {
        ok(Number(row.category) === role.category, `${role.label}: category stored = ${role.category}`, String(row.category));
        ok(String(row.role) === String(role.subcategory), `${role.label}: role = subcategory (${role.subcategory})`, String(row.role));
        ok(row.password != null && row.password !== '', `${role.label}: password hash is non-null / non-empty`, JSON.stringify(row.password));
        ok(Number(row.must_change_password) === 1, `${role.label}: must_change_password = 1`, String(row.must_change_password));
        ok(Number(row.otp_status) === 1 && !!row.otp, `${role.label}: OTP issued (otp_status=1)`, JSON.stringify({ otp: row.otp, s: row.otp_status }));
      }
    }

    // Privilege-escalation guard: Admin(5) and Employee(1) rejected for a PUBLIC
    // (unauthenticated) caller, no row.
    for (const bad of [{ c: 5, label: 'Admin' }, { c: 1, label: 'Employee' }]) {
      const res = await reg({
        name: `${bad.label} Escalation`, email: `e2e_bad_${bad.c}@example.com`, password: '',
        mobile: `(555) 010-20${bad.c}0`, category: bad.c, subcategory: '14', business_name: 'X', trade: '',
      });
      ok(res.status === 403, `${bad.label}(${bad.c}): public sign-up REJECTED (403)`, `status=${res.status} body=${JSON.stringify(res.body)}`);
      const [[row]] = await conn.query('SELECT id FROM user WHERE email = ?', [`e2e_bad_${bad.c}@example.com`]);
      ok(!row, `${bad.label}(${bad.c}): no account row created`, row ? `id=${row.id}` : '');
    }

    // OWNER-CONTEXT: an authenticated account owner (role 14) adding an EMPLOYEE
    // (category 1) via the same /register route must SUCCEED — this is the web +
    // mobile "Add Employee" path. The public 403 above must NOT apply to them.
    const jwt = require('jsonwebtoken');
    const [ownerIns] = await conn.query(
      `INSERT INTO user (name,email,password,role,mobile,category,subcategory,street,city,state,zipcode,contact_note,created_at,must_change_password)
       VALUES ('Owner Boss','owner_boss@example.com','x',14,'(555) 010-9000',4,14,'','','','','','2026-01-01',0)`
    );
    const ownerId = ownerIns.insertId;
    const ownerToken = jwt.sign({ id: ownerId, role: 14 }, process.env.ACCESS_TOKEN);
    const regAuth = (payload, token) =>
      request(app).post('/api/register').set('Authorization', `Bearer ${token}`).send(payload);

    // Employee across two different Role/Employment combos — proves it's the
    // category that gates, not a specific subcategory value.
    const empCases = [
      { label: 'Employee (Family/Friend-style role)', email: 'e2e_emp_a@example.com', mobile: '(555) 010-3001', subcategory: '2' },
      { label: 'Employee (Foreman-style role)',       email: 'e2e_emp_b@example.com', mobile: '(555) 010-3002', subcategory: '3' },
    ];
    for (const ec of empCases) {
      const res = await regAuth({
        name: ec.label, email: ec.email, password: 'temp1234', mobile: ec.mobile,
        category: 1, subcategory: ec.subcategory, business_name: '', trade: '',
        employment_type: 'permanent', rate: 100, created_by: 999999, leave_ids: [],
      }, ownerToken);
      ok(res.status === 201 && res.body.code === '201', `${ec.label}: owner-authed create returns 201`, `status=${res.status} body=${JSON.stringify(res.body)}`);
      const [[row]] = await conn.query('SELECT * FROM user WHERE email = ?', [ec.email]);
      ok(!!row && Number(row.category) === 1, `${ec.label}: category-1 row created`, JSON.stringify(res.body));
      // created_by is forced to the token owner, not the spoofed 999999.
      if (row) ok(Number(row.created_by) === Number(ownerId), `${ec.label}: created_by forced to owner (${ownerId})`, String(row.created_by));
    }

    // Even an authenticated owner may NOT create an Admin(5) here.
    const adminRes = await regAuth({
      name: 'Owner Makes Admin', email: 'e2e_owner_admin@example.com', password: 'temp1234',
      mobile: '(555) 010-4000', category: 5, subcategory: '14', business_name: '', trade: '',
    }, ownerToken);
    ok(adminRes.status === 403, `Admin(5): owner-authed create still REJECTED (403)`, `status=${adminRes.status} body=${JSON.stringify(adminRes.body)}`);
    const [[adminRow]] = await conn.query('SELECT id FROM user WHERE email = ?', ['e2e_owner_admin@example.com']);
    ok(!adminRow, `Admin(5): no account row created even for owner`, adminRow ? `id=${adminRow.id}` : '');
  } catch (e) {
    ok(false, 'harness error', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e));
  } finally {
    rec.forEach((l) => console.log(l));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
