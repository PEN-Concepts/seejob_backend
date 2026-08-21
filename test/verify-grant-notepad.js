'use strict';
// Real-MySQL: grantNotepadCreate upserts the `checklist` right (full CRUD) for a
// paid subscriber, is additive (doesn't disturb other rights), is idempotent,
// and SKIPS role-12 subcontractors. node test/verify-grant-notepad.js
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };
(async () => {
  let db, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_grantnp', logLevel: 'ERROR' });
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({ host: '127.0.0.1', port: db.port, user: db.username || 'root', password: '', database: db.dbName });
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, `role` INT)");
    await conn.query("CREATE TABLE `right` (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(40), sub_heading INT DEFAULT 0)");
    await conn.query("CREATE TABLE role_right_permission (id INT PRIMARY KEY AUTO_INCREMENT, role_id INT, user_id INT NULL, right_id INT, `read` VARCHAR(4), `create` VARCHAR(4), `update` VARCHAR(4), `delete` VARCHAR(4))");
    await conn.query("INSERT INTO `right`(name,sub_heading) VALUES ('checklist',0),('job',0)");
    const [[cl]] = await conn.query("SELECT id FROM `right` WHERE name='checklist'");
    const [[jb]] = await conn.query("SELECT id FROM `right` WHERE name='job'");
    // owner/GC subscriber (role 14) with a pre-existing job right (must survive)
    await conn.query("INSERT INTO `user`(id,role) VALUES (200,14),(201,12),(202,4)");
    await conn.query("INSERT INTO role_right_permission(role_id,user_id,right_id,`read`,`create`,`update`,`delete`) VALUES (14,200,?, 'yes','yes','yes','yes')", [jb.id]);

    const { grantNotepadCreate } = require('../services/permissionLevels');
    const clRow = async (uid) => (await conn.query("SELECT `read` r,`create` c,`update` u,`delete` d, role_id FROM role_right_permission WHERE user_id=? AND right_id=?", [uid, cl.id]))[0][0];

    // GC subscriber gets checklist full CRUD, keyed by their role
    let res = await grantNotepadCreate(conn, 200);
    ok(res.granted === true, 'role-14 subscriber: granted');
    let r = await clRow(200);
    ok(r && r.c === 'yes' && r.r === 'yes' && r.u === 'yes' && r.d === 'yes', 'checklist full CRUD written');
    ok(r && Number(r.role_id) === 14, 'keyed by user.role (14)');
    const [[jobStill]] = await conn.query("SELECT `create` c FROM role_right_permission WHERE user_id=200 AND right_id=?", [jb.id]);
    ok(jobStill && jobStill.c === 'yes', 'pre-existing job right untouched (additive)');

    // idempotent — no duplicate rows
    await grantNotepadCreate(conn, 200);
    const [[cnt]] = await conn.query("SELECT COUNT(*) n FROM role_right_permission WHERE user_id=200 AND right_id=?", [cl.id]);
    ok(Number(cnt.n) === 1, 're-grant is idempotent (single checklist row)');

    // role 12 (subcontractor) is SKIPPED
    res = await grantNotepadCreate(conn, 201);
    ok(res.granted === false && res.reason === 'role-12', 'role-12 skipped (not granted)');
    const [[c12]] = await conn.query("SELECT COUNT(*) n FROM role_right_permission WHERE user_id=201", []);
    ok(Number(c12.n) === 0, 'role-12 got no checklist row');

    // office-manager style (role 4) also gets it
    res = await grantNotepadCreate(conn, 202);
    const r202 = await clRow(202);
    ok(res.granted === true && r202 && r202.c === 'yes', 'role-4 subscriber: granted');

    // missing user → fail-safe
    res = await grantNotepadCreate(conn, 999999);
    ok(res.granted === false && res.reason === 'no-user', 'missing user → no-op (fail-safe)');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally { try { if (conn) await conn.end(); } catch {} try { if (db && db.stop) await db.stop(); } catch {} }
})();
