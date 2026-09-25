/* EDIT EMPLOYEE PERMISSION SWITCHES PERSIST — via the REAL main save/load paths.
 *
 * §0 map (proven empirically below, not reasoned from query text):
 *
 *   switch                     SAVE path                       LOAD path
 *   ────────────────────────── ─────────────────────────────── ──────────────────────────
 *   view all company contacts  PUT /employee/:id (user column) GET /employee/:id
 *                              (can_view_all_contacts)          emp.can_view_all_contacts
 *   Project Manager            POST /set-level (applyToggles)  GET /employee/:id
 *   (project_manager right)    role_right_permission            emp.has_project_manager
 *   Can create Notepads        POST /set-level (applyToggles)  GET /employee/:id
 *   (checklist right)          role_right_permission            emp.has_notepad_create
 *
 * The FE Edit Employee dialog calls PUT /employee/:id (name/…/can_view) and then
 * setUserLevel -> POST /set-level (level preset + the two toggles). This test drives
 * that exact pair and asserts each switch survives on->update->reopen and
 * off->update->reopen. It documents that persistence is CORRECT on main; the live
 * defect was the CONTACTS-PAGE scope (see contactsViewAllAuthority.test.js).
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x === undefined ? '' : x)}`); };

(async () => {
  let db, pool, conn;
  const EMP = 200, OWNER = 100, SUBCAT = 5;
  try {
    process.env.ACCESS_TOKEN = 'test_secret'; delete process.env.NODE_ENV; process.env.API_URL = '/api';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_empswitch_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1'; process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root'; process.env.DB_PASSWORD_DEV = ''; process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection'); conn = await pool.getConnection();
    const request = require('supertest'); const jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), mobile VARCHAR(40) NULL, image VARCHAR(190) NULL, business VARCHAR(120) NULL, organization_name VARCHAR(120) NULL, employment_type VARCHAR(40) NULL, rate VARCHAR(40) NULL, resignation_date DATE NULL, resignation_reason VARCHAR(190) NULL, exit_type VARCHAR(40) NULL, can_view_all_contacts TINYINT DEFAULT 0, level INT NULL, role INT NULL, category INT NULL, subcategory INT NULL, created_by INT NULL, created_at DATETIME NULL, status INT DEFAULT 1, token_version INT DEFAULT 0)");
    await conn.query("CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(80), category_id INT NULL)");
    await conn.query("CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(80))");
    await conn.query("CREATE TABLE role (id INT PRIMARY KEY, name VARCHAR(80))");
    await conn.query("CREATE TABLE employees_leaves (id INT PRIMARY KEY, leave_type VARCHAR(60), quota INT)");
    await conn.query("CREATE TABLE employee_leaves_quota (id INT PRIMARY KEY AUTO_INCREMENT, emp_id INT, leave_id INT, created_at DATETIME NULL, created_by INT NULL)");
    await conn.query("CREATE TABLE `right` (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(60), display_name VARCHAR(80) NULL, sub_heading INT NULL, admin_module INT NULL)");
    await conn.query("CREATE TABLE role_right_permission (id INT PRIMARY KEY AUTO_INCREMENT, role_id INT, user_id INT, right_id INT, `read` VARCHAR(5) NULL, `create` VARCHAR(5) NULL, `update` VARCHAR(5) NULL, `delete` VARCHAR(5) NULL)");
    await conn.query("INSERT INTO category VALUES (1,'Employee'),(2,'Contractor')");
    await conn.query("INSERT INTO subcategory VALUES (5,'Foreman',1)");
    await conn.query("INSERT INTO role VALUES (14,'Owner'),(5,'Employee'),(12,'Subcontractor')");
    // rights the level presets reference (sub_heading=0 so applyLevelRights sees them),
    // plus the two toggle rights.
    await conn.query("INSERT INTO `right` (name,display_name,sub_heading,admin_module) VALUES ('project_manager','Project Manager',0,0),('checklist','Notepad',0,0),('contact','Contacts',0,0),('dashboard','Dashboard',0,0),('user','Employee Management',0,0)");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by,can_view_all_contacts,level) VALUES (?,'Owner','o@x.com',14,2,NULL,NULL,0,NULL)", [OWNER]);
    await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by,can_view_all_contacts,level) VALUES (?,'Joshua','j@x.com',5,1,?,?,0,3)", [EMP, SUBCAT, OWNER]);

    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/user', require('../routes/users'));
    app.use('/api/user', require('../routes/invitations'));   // /set-level, /get-task-users mounts
    const tok = (id) => 'Bearer ' + jwt.sign({ id, tv: 0 }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
    const put = (body) => request(app).put('/api/user/employee/' + EMP).set('Authorization', tok(OWNER)).send(body);
    const get = () => request(app).get('/api/user/employee/' + EMP).set('Authorization', tok(OWNER));
    // The FE's exact Update pair: PUT (employee fields incl. can_view) then set-level
    // (level preset + the two standalone toggles).
    const setLevel = (level, pm, np) => request(app).post('/api/user/set-level').set('Authorization', tok(OWNER))
      .send({ user_id: EMP, level, project_manager: pm, notepad_create: np });
    const base = { name: 'Joshua', email: 'j@x.com', mobile: '5', category: '1', subcategory: SUBCAT, employment_type: 'full', rate: '20', created_by: OWNER, leave_ids: [] };

    // ── ALL THREE ON, update, reopen ─────────────────────────────────────────────
    let r = await put({ ...base, can_view_all_contacts: 1 });
    ok(r.status === 200, 'PUT can_view ON -> 200', r.status + ' ' + JSON.stringify(r.body).slice(0, 80));
    r = await setLevel(3, true, true);
    ok(r.status === 200, 'set-level L3 pm=1 np=1 -> 200', r.status + ' ' + JSON.stringify(r.body).slice(0, 80));
    let d = (await get()).body.data || {};
    ok(Number(d.can_view_all_contacts) === 1, 'ON reopen: can_view_all_contacts persisted', JSON.stringify(d.can_view_all_contacts));
    ok(Number(d.has_project_manager) === 1, 'ON reopen: project_manager persisted', JSON.stringify(d.has_project_manager));
    ok(Number(d.has_notepad_create) === 1, 'ON reopen: notepad_create persisted', JSON.stringify(d.has_notepad_create));

    // ── ALL THREE OFF, update, reopen ────────────────────────────────────────────
    await put({ ...base, can_view_all_contacts: 0 });
    await setLevel(3, false, false);
    d = (await get()).body.data || {};
    ok(Number(d.can_view_all_contacts) === 0, 'OFF reopen: can_view_all_contacts off', JSON.stringify(d.can_view_all_contacts));
    ok(Number(d.has_project_manager) === 0, 'OFF reopen: project_manager off', JSON.stringify(d.has_project_manager));
    ok(Number(d.has_notepad_create) === 0, 'OFF reopen: notepad_create off', JSON.stringify(d.has_notepad_create));

    // ── each INDEPENDENTLY (only project_manager on) ─────────────────────────────
    await put({ ...base, can_view_all_contacts: 0 });
    await setLevel(3, true, false);
    d = (await get()).body.data || {};
    ok(Number(d.has_project_manager) === 1 && Number(d.has_notepad_create) === 0 && Number(d.can_view_all_contacts) === 0,
      'INDEPENDENT: only project_manager on persists that one alone', JSON.stringify({ pm: d.has_project_manager, np: d.has_notepad_create, cv: d.can_view_all_contacts }));

    // ══ §2 — the authority also widens the Assign-To picker (get-task-users) ═════
    await conn.query("CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT, request_to INT, status VARCHAR(20) NULL, request_user1 INT NULL, request_user2 INT NULL)");
    await conn.query("CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(80), team_color VARCHAR(20) NULL, created_by INT NULL)");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by) VALUES (300,'A Sub Owner-added','as1@x.com',12,2,NULL,100),(301,'A Sub Emp-added','as2@x.com',12,2,NULL,100)");
    await conn.query("INSERT INTO contact (request_by,request_to,status) VALUES (100,300,'Accept'),(200,301,'Accept')");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by) VALUES (400,'B Owner','bo@x.com',14,2,NULL,NULL),(600,'B Sub','bs@x.com',12,2,NULL,400)");
    await conn.query("INSERT INTO contact (request_by,request_to,status) VALUES (400,600,'Accept')");

    const etok = (id, workingId) => 'Bearer ' + jwt.sign({ id, working_id: workingId, tv: 0 }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
    const taskUsers = (id, workingId) => request(app).get('/api/user/get-task-users').set('Authorization', etok(id, workingId));
    const idset = (res) => new Set((Array.isArray(res.body) ? res.body : (res.body && res.body.data) || []).map((u) => Number(u.id)));

    const ownerSet = idset(await taskUsers(100, 100));
    ok(ownerSet.has(300) && ownerSet.has(301), 'picker: owner sees both company-A contacts', [...ownerSet].join());
    await put({ ...base, can_view_all_contacts: 0 });
    const offSet = idset(await taskUsers(200, 100));
    ok(offSet.has(301) && !offSet.has(300), 'picker flag OFF: employee sees only their own contact', [...offSet].join());
    await put({ ...base, can_view_all_contacts: 1 });
    const onSet = idset(await taskUsers(200, 100));
    ok(onSet.has(300) && onSet.has(301), 'picker flag ON: employee sees the whole company book', [...onSet].join());
    ok(!onSet.has(600), 'picker flag ON never crosses the account boundary (B 600 hidden)', [...onSet].join());
    ok(onSet.size === ownerSet.size, `picker flag ON: employee count (${onSet.size}) equals owner (${ownerSet.size})`, `on=${onSet.size} owner=${ownerSet.size}`);

    // ══ §3 — CARVE-OUT: the switches never grant Employees-CRUD over the owner ═══
    await put({ ...base, can_view_all_contacts: 1 });
    await setLevel(3, true, true);
    const [empRights] = await conn.query(
      "SELECT rt.name FROM role_right_permission rp JOIN `right` rt ON rt.id = rp.right_id WHERE rp.user_id = ? AND rt.name = 'user'", [EMP]);
    ok(empRights.length === 0,
      '§3 no switch (at L3 + toggles) grants the `user` Employees-CRUD right that could remove/replace the owner', JSON.stringify(empRights));
    const [[owner]] = await conn.query("SELECT role, created_by FROM `user` WHERE id = ?", [OWNER]);
    ok(Number(owner.role) === 14 && (owner.created_by === null || Number(owner.created_by) === 0),
      '§3 owner row unchanged — still role 14 owner, not demoted/reparented', JSON.stringify(owner));

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    conn.release(); if (pool.end) await pool.end(); if (db.stop) await db.stop();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log(rec.join('\n')); console.error('HARNESS ERROR:', e && e.stack || e.message);
    try { if (conn) conn.release(); if (pool && pool.end) await pool.end(); if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(1);
  }
})();
