/* WHO MAY DELETE A TASK — ruled 2026-09-11.
 *
 *   FULL ACCESS (account owner, or granted Manage access) may delete ANY task
 *   on the account. Everyone else may delete only tasks they created.
 *
 * Before this, DELETE /jobtask/delete/:id used
 * requireOwnsRecord({ ownerCol: 'created_by' }), which checks only
 * isSameAccount — so ANY user on the account could delete ANY task, including
 * the owner's. My Tasks hid the button behind an is_mine check in the
 * component, but a hidden button is not a permission and a direct DELETE walked
 * straight past it.
 *
 * Every case here calls the API DIRECTLY and then RE-READS THE ROW. Asserting
 * the response alone has produced false passes three times in this project —
 * a handler that echoes its input proves nothing about what was stored.
 *
 * Run: node test/taskDeleteAuthority.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_taskdel_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    request = require('supertest');
    jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, created_by INT NULL)");
    await conn.query(`CREATE TABLE tasks (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, task_type VARCHAR(20) NULL,
      user_id INT NULL, team_id INT NULL, created_by INT NULL, task_name VARCHAR(190) NULL,
      status INT DEFAULT 0, starred_at DATETIME NULL, archived_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY AUTO_INCREMENT, section_id INT NULL, name VARCHAR(255), calendar_task_id INT NULL, appointment_id INT NULL, delegated_task_id INT NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT NULL, title VARCHAR(190), type VARCHAR(20) NULL, sort_order INT DEFAULT 0, job_id INT NULL)");
    await conn.query("CREATE TABLE task_assignees (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT)");
    await conn.query("CREATE TABLE tasks_images (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, filename VARCHAR(190))");
    await conn.query("CREATE TABLE task_notes (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT, user_id INT, body TEXT)");
    await conn.query("CREATE TABLE appointments (id INT PRIMARY KEY AUTO_INCREMENT, task_id INT NULL, doa DATE NULL, subject VARCHAR(190) NULL)");
    await conn.query("CREATE TABLE notepad_access (id INT PRIMARY KEY AUTO_INCREMENT, owner_user_id INT, user_id INT, granted_by INT NULL, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

    // 900 owner. 910 an employee of 900, NOT on the allowlist. 920 an employee
    // WITH Manage access. 930 another account entirely.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by) VALUES
      (900,'Owner Olly','olly@x.com',14,4,NULL),
      (910,'Plain Pat','pat@x.com',2,1,900),
      (920,'Granted Gina','gina@x.com',2,1,900),
      (930,'Foreign Fred','fred@x.com',14,4,NULL)`);
    await conn.query('INSERT INTO notepad_access (owner_user_id,user_id,granted_by) VALUES (900,920,900)');

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/jobtask', require('../routes/tasks'));

    const tok = (id) => 'Bearer ' + jwt.sign(
      { id, working_id: id, role: id === 900 || id === 930 ? 14 : 2, category: id === 900 || id === 930 ? 4 : 1, email: id + '@x.com' },
      process.env.ACCESS_TOKEN);

    const mkTask = async (id, createdBy, name) => {
      await conn.query('INSERT INTO tasks (id,created_by,user_id,task_name) VALUES (?,?,?,?)', [id, createdBy, createdBy, name]);
      return id;
    };
    const stillThere = async (id) => {
      const [[r]] = await conn.query('SELECT id FROM tasks WHERE id = ? LIMIT 1', [id]);
      return !!r;
    };
    const del = (id, who) => request(app).delete('/api/jobtask/delete/' + id).set('Authorization', tok(who));

    // 1. A plain employee CANNOT delete the owner's task.
    await mkTask(1001, 900, "Owner's task");
    const r1 = await del(1001, 910);
    ok(r1.status === 403, 'a non-full-access employee is REFUSED on the owner\'s task', String(r1.status) + ' ' + JSON.stringify(r1.body));
    ok(await stillThere(1001),
      'THE POINT: and the row is still in the table — the old guard let this through',
      'task 1001 was deleted');

    // 2. ...but CAN delete one they created themselves.
    await mkTask(1002, 910, 'Pat\'s own task');
    const r2 = await del(1002, 910);
    ok(r2.status === 200 || r2.status === 204, 'the same employee CAN delete their own task', String(r2.status));
    ok(!(await stillThere(1002)), 'and the row is really gone', 'task 1002 survived');

    // 3. The account owner may delete anyone's.
    await mkTask(1003, 910, 'Pat\'s task, owner deletes');
    const r3 = await del(1003, 900);
    ok(r3.status === 200 || r3.status === 204, 'the ACCOUNT OWNER may delete a task he did not create', String(r3.status));
    ok(!(await stillThere(1003)), 'and it is really gone', 'task 1003 survived');

    // 4. So may someone granted Manage access.
    await mkTask(1004, 910, 'Pat\'s task, granted user deletes');
    const r4 = await del(1004, 920);
    ok(r4.status === 200 || r4.status === 204,
      'a user GRANTED full access may delete a task he did not create', String(r4.status) + ' ' + JSON.stringify(r4.body));
    ok(!(await stillThere(1004)), 'and it is really gone', 'task 1004 survived');

    // 5. Revoking Manage access takes the power away again.
    await conn.query('DELETE FROM notepad_access WHERE owner_user_id = 900 AND user_id = 920');
    await mkTask(1005, 910, 'after revoke');
    const r5 = await del(1005, 920);
    ok(r5.status === 403, 'once revoked, that user is refused again', String(r5.status));
    ok(await stillThere(1005), 'and the row survives the refusal', 'task 1005 was deleted');

    // 6. Cross-account is refused whatever your level — the outer bound.
    await mkTask(1006, 900, 'owner task, foreign deleter');
    const r6 = await del(1006, 930);
    ok(r6.status === 403, 'a user from ANOTHER account is refused, full access or not', String(r6.status));
    ok(await stillThere(1006), 'and that row survives too', 'task 1006 was deleted');

  } catch (err) {
    ok(false, 'suite threw', String(err && err.stack ? err.stack.split('\n').slice(0, 6).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
