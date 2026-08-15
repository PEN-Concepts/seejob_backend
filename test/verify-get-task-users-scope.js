/* Proves the get-task-users contact scope fix on REAL MySQL: the account OWNER
 * (74) must now see a contact created by a SUB-LOGIN (admin 86) — the "13 vs 34"
 * bug. OLD scope IN(scope_id,user_id) hid it; NEW account-wide subquery shows it.
 * Run: node test/verify-get-task-users-scope.js */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

// The two contact UNION branches, exactly as in get-task-users.
const branches = (scope) => `
(SELECT u.id FROM contact c INNER JOIN user u ON u.id=c.request_user2 WHERE c.request_user1 IN (${scope}))
UNION
(SELECT u.id FROM contact c INNER JOIN user u ON u.id=c.request_user1 WHERE c.request_user2 IN (${scope}))`;
const OLD = branches('?, ?');                                            // params: scope_id, user_id
const NEW = branches('SELECT id FROM user WHERE id = ? OR created_by = ?'); // params: scope_id, scope_id

(async () => {
  let db, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_gtu_test', logLevel: 'ERROR' });
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({ host: '127.0.0.1', port: db.port, user: db.username || 'root', password: '', database: db.dbName });
    await conn.query('CREATE TABLE user (id INT PRIMARY KEY, name VARCHAR(80), created_by INT NULL)');
    await conn.query('CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_user1 INT, request_user2 INT)');
    // Owner 74; admin sub-login 86 (created_by 74); contractors 200,201.
    await conn.query("INSERT INTO user(id,name,created_by) VALUES (74,'Owner Poul',NULL),(86,'Admin login',74),(200,'Sub A',NULL),(201,'Sub B',NULL)");
    // MOST contacts were saved by the admin sub-login (request_user1=86) — the real setup.
    await conn.query('INSERT INTO contact(request_user1,request_user2) VALUES (86,200),(74,201)');

    // Owner opens a Task Manager picker: canViewAll → scope_id = working_id = 74, user_id = 74.
    // 2 UNION branches × 2 placeholders each = 4 params per query.
    const [oldRows] = await conn.query(OLD, [74, 74, 74, 74]);  // OLD: (scope_id,user_id) ×2 branches
    const [newRows] = await conn.query(NEW, [74, 74, 74, 74]);  // NEW: (scope_id,scope_id) ×2 branches
    const oldIds = oldRows.map(r => r.id).sort();
    const newIds = newRows.map(r => r.id).sort();
    console.log('OWNER (74) — OLD scope ids:', JSON.stringify(oldIds), '| NEW scope ids:', JSON.stringify(newIds));
    ok(!oldIds.includes(200), 'OLD get-task-users: owner does NOT see the admin-created contact (the "13" bug)');
    ok(newIds.includes(200), 'NEW get-task-users: owner DOES see the admin-created contact (200)');
    ok(newIds.includes(201), 'NEW: owner still sees their own contact (201)');
    ok(newIds.length === 2, `NEW: owner sees the FULL account book (got ${newIds.length})`);

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e.message); process.exitCode = 2; }
  finally { try { if (conn) await conn.end(); } catch {} try { if (db && db.stop) await db.stop(); } catch {} }
})();
