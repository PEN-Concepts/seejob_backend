/* End-to-end Add Employee for the LINKED-LOGIN owner topology that broke in prod:
 * the owner logs in via an admin login (id 86, role 3, category 1, created_by 74)
 * whose JWT working_id = 74 (the real owner account, role 14). Runs the ACTUAL
 * flow the mobile form does: POST /register (users) then POST /set-level
 * (invitations). Proves created_by is keyed to the OWNER account (74) so
 * set-level's isSameAccount passes and Level is applied.
 * Run: NODE_PATH=<be>/node_modules node test/verify-add-employee-e2e.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_addemp_e2e', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE user (
      id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(190), email VARCHAR(190),
      password VARCHAR(190) NOT NULL, role INT, mobile VARCHAR(60), category INT, subcategory INT,
      business VARCHAR(190), trade VARCHAR(190), social_security VARCHAR(60) NOT NULL DEFAULT '',
      street VARCHAR(190) NOT NULL DEFAULT '', city VARCHAR(120) NOT NULL DEFAULT '',
      state VARCHAR(120) NOT NULL DEFAULT '', zipcode VARCHAR(20) NOT NULL DEFAULT '',
      contact_note VARCHAR(255) NOT NULL DEFAULT '', otp VARCHAR(10), otp_status TINYINT,
      employment_type VARCHAR(40) NULL, rate DECIMAL(10,2) NULL,
      created_at VARCHAR(40), created_by INT NULL, level TINYINT NULL, must_change_password TINYINT DEFAULT 0, status TINYINT NOT NULL DEFAULT 1)`);
    await conn.query("CREATE TABLE `right` (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(40), sub_heading INT DEFAULT 0)");
    await conn.query("CREATE TABLE role_right_permission (id INT PRIMARY KEY AUTO_INCREMENT, role_id INT, user_id INT NULL, right_id INT, `read` VARCHAR(4), `create` VARCHAR(4), `update` VARCHAR(4), `delete` VARCHAR(4))");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, status VARCHAR(20))");
    const names = ['dashboard','spartan','profile','support','subscription','invitation','job','contact','task','timecard','calendar','dailysheet','jobanalysis','equipment','appointment','checklist','lead','quote','changeorder','team','bid-requests','user','project_manager'];
    for (const nm of names) await conn.query("INSERT INTO `right`(name,sub_heading) VALUES (?,0)", [nm]);

    // Real prod topology: owner account 74 (role 14), linked admin login 86
    // (role 3, category 1, level 5, created_by 74). Force ids with explicit inserts.
    await conn.query("INSERT INTO user (id,name,email,password,role,mobile,category,subcategory,created_at,created_by,level,status) VALUES (74,'Owner GC','owner@acct.test','x',14,'5550000074',4,14,'2026-01-01',NULL,NULL,1)");
    await conn.query("INSERT INTO user (id,name,email,password,role,mobile,category,subcategory,created_at,created_by,level,status) VALUES (86,'Admin Login','admin@oakcoast.net','x',3,'5550000086',1,14,'2026-01-01',74,5,1)");
    await conn.query("INSERT INTO subscriptions (user_id,status) VALUES (74,'active')"); // owner account is paid

    const app = require('express')(); app.use(require('express').json());
    app.use('/api', require('../routes/users'));
    app.use('/api', require('../routes/invitations'));

    // The owner's phone token: id=86 login, working_id=74 owner account.
    const token = jwt.sign({ id: 86, working_id: 74, role: 3, category: 1, email: 'admin@oakcoast.net' }, process.env.ACCESS_TOKEN);
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);

    // STEP 1 — register the employee exactly like the mobile form.
    const regRes = await auth(request(app).post('/api/register')).send({
      name: 'Family Friend', email: 'ff_new@example.com', password: 'temp1234', mobile: '5550001234',
      category: '1', subcategory: 20, trade: '', business_name: '', created_by: 999999, leave_ids: [],
      employment_type: 'permanent', rate: 100,
    });
    ok(regRes.status === 201 && regRes.body.code === '201', 'register employee returns 201', `status=${regRes.status} body=${JSON.stringify(regRes.body)}`);
    const newId = regRes.body && regRes.body.data && regRes.body.data.userId;
    ok(!!newId, 'register returned a userId', JSON.stringify(regRes.body));
    const [[empRow]] = await conn.query('SELECT created_by, category FROM user WHERE id = ?', [newId]);
    ok(empRow && Number(empRow.created_by) === 74, 'employee.created_by keyed to OWNER account 74 (not login 86)', JSON.stringify(empRow));

    // STEP 2 — set the level (the follow-up call that was failing in prod).
    const slRes = await auth(request(app).post('/api/set-level')).send({ user_id: newId, level: 1, project_manager: false, notepad_create: false });
    ok(slRes.status === 200, 'set-level Level 1 returns 200 (isSameAccount passes)', `status=${slRes.status} body=${JSON.stringify(slRes.body)}`);
    const [[lvlRow]] = await conn.query('SELECT level FROM user WHERE id = ?', [newId]);
    ok(lvlRow && Number(lvlRow.level) === 1, 'employee.level persisted = 1', JSON.stringify(lvlRow));

    // Regression guard: prove the OLD behavior (created_by = login 86) would 403.
    await conn.query("INSERT INTO user (id,name,email,password,role,mobile,category,subcategory,created_at,created_by,level,status) VALUES (500,'Bad Owned','bad@acct.test','x',20,'5550000500',1,20,'2026-08-20',86,NULL,1)");
    const badRes = await auth(request(app).post('/api/set-level')).send({ user_id: 500, level: 1 });
    ok(badRes.status === 403, 'employee owned by login-86 (old bug) → set-level 403 (confirms the fix target)', `status=${badRes.status} body=${JSON.stringify(badRes.body)}`);
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
