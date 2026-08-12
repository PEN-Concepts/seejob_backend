/* The 5 secondary people-list routes must NOT leak the owner's whole contact
 * book / whole DB to sub-users. Mounts the REAL routers + real MySQL (supertest).
 * Covers the shared visibleUserPredicate (contacts/getuserbycategory + search,
 * invitations/get_contacts, users/getforemanusers) and the teams/all custom scope.
 * Run: NODE_PATH=<backend>/node_modules node test/secondaryRoutesVisibility.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_secondary_vis', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE user (
      id INT PRIMARY KEY, name VARCHAR(190), email VARCHAR(190), role INT, category INT, subcategory INT,
      business VARCHAR(190), mobile VARCHAR(60), image VARCHAR(190), organization_name VARCHAR(190),
      created_by INT, can_view_all_contacts TINYINT DEFAULT 0, status TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query(`CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_user1 INT, request_user2 INT)`);
    await conn.query(`CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(60))`);
    await conn.query(`CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(60), category_id INT)`);
    await conn.query(`CREATE TABLE role (id INT PRIMARY KEY, name VARCHAR(60))`);
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(120), client_id INT, address VARCHAR(190))`);
    await conn.query(`CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20), job_id INT, team_leader INT, start_date DATE NULL, end_date DATE NULL, created_by INT)`);
    await conn.query(`CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)`);
    await conn.query(`INSERT INTO category (id,name) VALUES (1,'Employee'),(2,'Subcontractor'),(3,'Client'),(4,'General contractor')`);
    await conn.query(`INSERT INTO subcategory (id,name,category_id) VALUES (7,'Framing',2),(11,'Client',3),(14,'GC',4)`);
    await conn.query(`INSERT INTO role (id,name) VALUES (3,'Foreman'),(14,'General Contractor')`);

    const U = (id, name, category, cb, cva = 0, role = 3) =>
      conn.query('INSERT INTO user (id,name,email,role,category,subcategory,created_by,can_view_all_contacts,status) VALUES (?,?,?,?,?,?,?,?,1)',
        [id, name, name.toLowerCase().replace(/ /g, '') + '@t.co', role, category, category === 2 ? 7 : (category === 3 ? 11 : 14), cb, cva]);
    await U(74, 'Poul Owner', 4, null, 0, 14);
    await U(86, 'Emp Default', 1, 74, 0, 3);
    await U(87, 'Emp Authority', 1, 74, 1, 3);
    await U(376, 'Joshua Client', 3, 74, 0, 3);
    await U(400, 'Sub Contractor', 2, 74, 0, 3);   // role 3 so getforemanusers can see them
    await U(500, 'Other Sub', 2, 74, 0, 3);
    await U(501, 'Other Client', 3, 74, 0, 3);
    await U(600, 'Joshua Own Contact', 2, 376, 0, 3);

    const link = (a, b) => conn.query('INSERT INTO contact (request_user1,request_user2) VALUES (?,?)', [a, b]);
    await link(74, 376); await link(74, 400); await link(74, 500); await link(74, 501); await link(376, 600);

    // Teams: A owned by owner (74); B owned by the sub (400). Sub is a member of A.
    await conn.query("INSERT INTO teams (id,team_name,team_color,job_id,team_leader,created_by) VALUES (1,'Owner Team','#111',NULL,74,74),(2,'Sub Own Team','#222',NULL,400,400)");
    await conn.query('INSERT INTO team_user (team_id,user_id) VALUES (1,400),(2,400)');

    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/contact', require('../routes/contacts'));
    app.use('/invitations', require('../routes/invitations'));
    app.use('/user', require('../routes/users'));
    app.use('/teams', require('../routes/teams'));

    const tok = (claims) => 'Bearer ' + jwt.sign(claims, process.env.ACCESS_TOKEN);
    const OWNER = { id: 74, working_id: 74, role: 14, category: 4, email: 'poul@t.co' };
    const CLIENT = { id: 376, working_id: 74, role: 3, category: 3, email: 'joshuaclient@t.co' };
    const SUB = { id: 400, working_id: 74, role: 3, category: 2, email: 'subcontractor@t.co' };
    const names = (arr) => (arr || []).map(r => r.name).filter(Boolean).sort();
    const LEAK = ['Other Sub', 'Other Client', 'Emp Default', 'Emp Authority'];

    // ---- contacts/getuserbycategory/2 (Subcontractors) ----
    const gbc = (who) => request(app).get('/contact/getuserbycategory/2').set('Authorization', tok(who)).then(r => names(r.body.data));
    const oSubs = await gbc(OWNER);
    ok(oSubs.includes('Sub Contractor') && oSubs.includes('Other Sub'), 'getuserbycategory: OWNER sees all account subs', JSON.stringify(oSubs));
    const cSubs = await gbc(CLIENT);
    ok(cSubs.includes('Joshua Own Contact') && !cSubs.includes('Other Sub') && !cSubs.includes('Sub Contractor'),
      'getuserbycategory: CLIENT sees only their own sub-contact, not the owner\'s subs', JSON.stringify(cSubs));
    const sSubs = await gbc(SUB);
    ok(sSubs.includes('Sub Contractor') && !sSubs.includes('Other Sub'),
      'getuserbycategory: SUB sees themselves, not the owner\'s other subs', JSON.stringify(sSubs));

    // ---- contacts/search ----
    const search = (who, key) => request(app).get('/contact/search/' + key).set('Authorization', tok(who)).then(r => names(r.body.data));
    const cSearch = await search(CLIENT, 'o'); // broad
    ok(!LEAK.some(n => cSearch.includes(n)), 'search: CLIENT search does not surface owner\'s other people', JSON.stringify(cSearch));

    // ---- invitations/get_contacts (was SELECT * FROM user) ----
    const gc = (who) => request(app).get('/invitations/get_contacts').set('Authorization', tok(who)).then(r => names(r.body));
    const cAll = await gc(CLIENT);
    ok(cAll.includes('Poul Owner') && cAll.includes('Joshua Client') && cAll.includes('Joshua Own Contact'),
      'get_contacts: CLIENT sees owner + self + own contact', JSON.stringify(cAll));
    ok(!LEAK.some(n => cAll.includes(n)) && !cAll.includes('Other Client'),
      'get_contacts: CLIENT does NOT see the whole DB', JSON.stringify(cAll));
    const oAll = await gc(OWNER);
    ok(['Other Sub', 'Other Client', 'Sub Contractor'].every(n => oAll.includes(n)), 'get_contacts: OWNER still sees the full account book', JSON.stringify(oAll));

    // ---- user/getforemanusers (role = 3) ----
    const fm = (who) => request(app).get('/user/getforemanusers').set('Authorization', tok(who)).then(r => names(r.body.data));
    const sFm = await fm(SUB);
    ok(!sFm.includes('Other Sub') && !sFm.includes('Emp Default'), 'getforemanusers: SUB does not see the owner\'s other role-3 users', JSON.stringify(sFm));

    // ---- teams/all ----
    const teams = (who) => request(app).get('/teams/all').set('Authorization', tok(who)).then(r => (r.body.data || []).map(t => t.team_name).sort());
    const oT = await teams(OWNER);
    ok(oT.includes('Owner Team') && oT.includes('Sub Own Team'), 'teams/all: OWNER sees every team in the account', JSON.stringify(oT));
    const cT = await teams(CLIENT);
    ok(cT.length === 0, 'teams/all: CLIENT (no teams, no membership) sees NONE of the owner\'s teams', JSON.stringify(cT));
    const sT = await teams(SUB);
    ok(sT.includes('Sub Own Team') && sT.includes('Owner Team') && !cT.includes('Owner Team'),
      'teams/all: SUB sees only teams they own or belong to', JSON.stringify(sT));
  } catch (e) {
    ok(false, 'harness error', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : String(e));
  } finally {
    rec.forEach((l) => console.log(l));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
