/* get-task-users VISIBILITY MODEL — the Assign-To/person-picker data source must
 * NOT leak the account owner's whole contact book to sub-users. Owner + authority
 * employees see everyone; clients, subs, and non-authority employees see only their
 * OWN contacts + themselves + the account owner. Real MySQL + supertest.
 * Run: NODE_PATH=<backend>/node_modules node test/taskUsersVisibility.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_taskusers_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    // Schema get-task-users touches.
    await conn.query(`CREATE TABLE user (
      id INT PRIMARY KEY, name VARCHAR(190), email VARCHAR(190), role INT, category INT,
      subcategory INT, business VARCHAR(190), mobile VARCHAR(60), image VARCHAR(190),
      created_by INT, exit_type VARCHAR(10), can_view_all_contacts TINYINT DEFAULT 0, status TINYINT DEFAULT 1)`);
    await conn.query(`CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_user1 INT, request_user2 INT)`);
    await conn.query(`CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(60))`);
    await conn.query(`CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(60), category_id INT)`);
    await conn.query(`CREATE TABLE role (id INT PRIMARY KEY, name VARCHAR(60))`);
    await conn.query(`CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20), created_by INT)`);
    await conn.query(`CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)`);
    await conn.query(`INSERT INTO category (id,name) VALUES (1,'Employee'),(2,'Subcontractor'),(3,'Client'),(4,'General contractor')`);
    await conn.query(`INSERT INTO role (id,name) VALUES (3,'Foreman'),(14,'General Contractor')`);

    // Users. cb=created_by, cva=can_view_all_contacts.
    const U = (id, name, category, cb, cva = 0, role = 3) =>
      conn.query('INSERT INTO user (id,name,email,role,category,created_by,can_view_all_contacts,status) VALUES (?,?,?,?,?,?,?,1)',
        [id, name, name.toLowerCase().replace(/ /g, '') + '@t.co', role, category, cb, cva]);
    await U(74, 'Poul Owner', 4, null, 0, 14);   // GC owner
    await U(86, 'Emp Default', 1, 74, 0);         // employee, no authority
    await U(87, 'Emp Authority', 1, 74, 1);       // employee WITH authority
    await U(376, 'Joshua Client', 3, 74, 0);      // client
    await U(400, 'Sub Contractor', 2, 74, 0);     // subcontractor
    await U(500, 'Other Sub', 2, 74, 0);          // owner's OTHER sub
    await U(501, 'Other Client', 3, 74, 0);       // owner's OTHER client
    await U(600, 'Joshua Own Contact', 2, 376, 0);// a contact Joshua himself added

    // Contact rows: owner (74) is connected to all his people; Joshua (376) to his own (600).
    const link = (a, b) => conn.query('INSERT INTO contact (request_user1,request_user2) VALUES (?,?)', [a, b]);
    await link(74, 376); await link(74, 400); await link(74, 500); await link(74, 501);
    await link(376, 600);

    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api', require('../routes/users'));

    const call = (claims) => request(app).get('/api/get-task-users')
      .set('Authorization', 'Bearer ' + jwt.sign(claims, process.env.ACCESS_TOKEN));
    const names = (res) => ((res.body && res.body.data) || []).filter((r) => r.id).map((r) => r.name).sort();

    // working_id: sub-users (role 3) resolve to the owner (74); the owner is 74.
    const ownerRes = await call({ id: 74, working_id: 74, role: 14, category: 4 });
    const authRes  = await call({ id: 87, working_id: 74, role: 3, category: 1 });
    const empRes   = await call({ id: 86, working_id: 74, role: 3, category: 1 });
    const cliRes   = await call({ id: 376, working_id: 74, role: 3, category: 3 });
    const subRes   = await call({ id: 400, working_id: 74, role: 3, category: 2 });

    const OWNER_FULL = ['Emp Authority', 'Emp Default', 'Joshua Client', 'Other Client', 'Other Sub', 'Poul Owner', 'Sub Contractor'];
    const oN = names(ownerRes);
    ok(OWNER_FULL.every((n) => oN.includes(n)), 'OWNER sees the whole account book', JSON.stringify(oN));
    ok(OWNER_FULL.every((n) => names(authRes).includes(n)), 'AUTHORITY employee sees the whole account book', JSON.stringify(names(authRes)));

    // Restricted: only self + owner (+ own contacts); NEVER the owner's other people.
    const leak = ['Other Sub', 'Other Client', 'Sub Contractor', 'Emp Default', 'Emp Authority'];
    const cN = names(cliRes);
    ok(cN.includes('Poul Owner'), 'CLIENT sees the owner (Poul)', JSON.stringify(cN));
    ok(cN.includes('Joshua Client'), 'CLIENT sees themselves', JSON.stringify(cN));
    ok(cN.includes('Joshua Own Contact'), 'CLIENT sees their OWN added contact', JSON.stringify(cN));
    ok(!leak.some((n) => cN.includes(n)), 'CLIENT does NOT see the owner\'s other subs/clients/employees', JSON.stringify(cN));

    const sN = names(subRes);
    ok(sN.includes('Poul Owner') && sN.includes('Sub Contractor'), 'SUB sees owner + self', JSON.stringify(sN));
    ok(!['Other Sub', 'Other Client', 'Joshua Client', 'Emp Default'].some((n) => sN.includes(n)), 'SUB does NOT see other account contacts', JSON.stringify(sN));

    const eN = names(empRes);
    ok(eN.includes('Poul Owner') && eN.includes('Emp Default'), 'DEFAULT employee sees owner + self', JSON.stringify(eN));
    ok(!['Other Sub', 'Other Client', 'Joshua Client', 'Sub Contractor'].some((n) => eN.includes(n)), 'DEFAULT employee does NOT see account contacts', JSON.stringify(eN));
  } catch (e) {
    ok(false, 'harness error', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  } finally {
    rec.forEach((l) => console.log(l));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
