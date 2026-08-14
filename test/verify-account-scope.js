/* Proves the get-task-users contact-branch fix: a contact created by ONE account
 * member (sub-login 86) must be visible to ANOTHER member (owner 74). Real local
 * MySQL via mysql-memory-server. Run: node test/verify-account-scope.js */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

// The two contact branches, OLD (IN caller,owner) vs NEW (account-wide subquery).
const OLD = `
(SELECT u.id FROM contact c INNER JOIN user u ON u.id=c.request_user2 WHERE c.request_user1 IN (?, ?))
UNION
(SELECT u.id FROM contact c INNER JOIN user u ON u.id=c.request_user1 WHERE c.request_user2 IN (?, ?))`;
const NEW = `
(SELECT u.id FROM contact c INNER JOIN user u ON u.id=c.request_user2 WHERE c.request_user1 IN (SELECT id FROM user WHERE id=? OR created_by=?))
UNION
(SELECT u.id FROM contact c INNER JOIN user u ON u.id=c.request_user1 WHERE c.request_user2 IN (SELECT id FROM user WHERE id=? OR created_by=?))`;

(async () => {
  let db, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_scope_test', logLevel: 'ERROR' });
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({ host: '127.0.0.1', port: db.port, user: db.username || 'root', password: '', database: db.dbName });
    await conn.query(`CREATE TABLE user (id INT PRIMARY KEY, name VARCHAR(80), created_by INT NULL)`);
    await conn.query(`CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT, request_to INT, request_user1 INT, request_user2 INT, status VARCHAR(20))`);
    // Account owner 74; sub-login 86 (created_by 74); contractor contacts 200,201.
    await conn.query(`INSERT INTO user(id,name,created_by) VALUES (74,'Owner Poul',NULL),(86,'Admin login',74),(200,'Sub A',NULL),(201,'Sub B',NULL)`);
    // Contact created by the SUB-LOGIN 86 (request_by/user1 = 86), and one by owner 74.
    await conn.query(`INSERT INTO contact(request_by,request_to,request_user1,request_user2,status) VALUES
      (86,200,86,200,'Saved'),
      (74,201,74,201,'Saved')`);

    // Owner (74) opens a picker: user_id=74, working_id=74.
    const [oldRows] = await conn.query(OLD, [74, 74, 74, 74]);
    const [newRows] = await conn.query(NEW, [74, 74, 74, 74]);
    const oldIds = oldRows.map(r => r.id).sort();
    const newIds = newRows.map(r => r.id).sort();
    console.log('OWNER (74) view — OLD scope ids:', JSON.stringify(oldIds), '| NEW scope ids:', JSON.stringify(newIds));
    ok(!oldIds.includes(200), 'OLD: owner does NOT see the sub-login-created contact (the bug)');
    ok(newIds.includes(200), 'NEW: owner DOES see the sub-login-created contact (200)');
    ok(newIds.includes(201), 'NEW: owner still sees their own contact (201)');
    ok(newIds.length === 2, `NEW: owner sees BOTH contacts (got ${newIds.length})`);

    // Sub-login (86) view: already saw both under OLD (86 in scope) — must still see both.
    const [subNew] = await conn.query(NEW, [74, 74, 74, 74]);
    ok(subNew.length === 2, 'NEW is account-wide: any member sees the same full list');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e.message); process.exitCode = 2; }
  finally { try { if (conn) await conn.end(); } catch {} try { if (db && db.stop) await db.stop(); } catch {} }
})();
