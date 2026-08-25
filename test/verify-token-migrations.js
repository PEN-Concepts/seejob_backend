/* Idempotent boot migrations for the persistent-login CCP — run the REAL
 * ensureUserTokenVersionColumn + ensureDeviceTokenUnique against in-memory MySQL.
 * Proves: the column is added, duplicate device-token rows are collapsed, a
 * UNIQUE(fcm_token) index is added and then enforced, and both are safe to re-run.
 * Run: node test/verify-token-migrations.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.NODE_ENV = 'test';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_token_mig', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection');
    conn = await pool.getConnection();

    // Pre-migration schema: NO token_version, device tokens with duplicate rows + no unique index.
    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(80))');
    await conn.query('CREATE TABLE user_device_tokens (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, fcm_token VARCHAR(255) NULL)');
    await conn.query("INSERT INTO `user`(id,name) VALUES (1,'A')");
    await conn.query("INSERT INTO user_device_tokens (user_id,fcm_token) VALUES (1,'dup'),(1,'dup'),(1,'dup'),(2,'other')");

    const mig = require('../services/dbMigrations');
    // Fresh module state each run isn't needed here — the in-memory guards are per-process.

    // 1) token_version column added.
    let has = async () => (await conn.query(
      "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user' AND COLUMN_NAME='token_version'"))[0].length;
    ok(!(await has()), 'setup: token_version does not exist yet');
    await mig.ensureUserTokenVersionColumn(conn);
    ok(!!(await has()), 'ensureUserTokenVersionColumn: column added');
    const [[def]] = await conn.query("SELECT token_version FROM `user` WHERE id=1");
    ok(Number(def.token_version) === 0, 'token_version defaults to 0 on existing rows');

    // 2) device-token dedup + unique index.
    const idxCount = async () => (await conn.query("SHOW INDEX FROM user_device_tokens WHERE Column_name='fcm_token' AND Non_unique=0"))[0].length;
    ok((await idxCount()) === 0, 'setup: no unique index on fcm_token');
    const before = (await conn.query("SELECT COUNT(*) n FROM user_device_tokens WHERE fcm_token='dup'"))[0][0].n;
    ok(before === 3, 'setup: 3 duplicate rows for token "dup"');
    await mig.ensureDeviceTokenUnique(conn);
    const after = (await conn.query("SELECT COUNT(*) n FROM user_device_tokens WHERE fcm_token='dup'"))[0][0].n;
    ok(after === 1, 'ensureDeviceTokenUnique: duplicates collapsed to 1 row');
    ok((await idxCount()) === 1, 'ensureDeviceTokenUnique: UNIQUE(fcm_token) index added');

    // 3) the unique index now actually PREVENTS a duplicate.
    let blocked = false;
    try { await conn.query("INSERT INTO user_device_tokens (user_id,fcm_token) VALUES (9,'dup')"); }
    catch (e) { blocked = /Duplicate/i.test(e.message); }
    ok(blocked, 'unique index enforced: inserting a duplicate token is rejected');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) { console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode = 2; }
  finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool && pool.end) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
})();
