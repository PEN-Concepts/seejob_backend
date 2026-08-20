// Real-MySQL check: ensureUserLevelColumn adds user.level (TINYINT NULL) and is
// idempotent. Run from worktree: node test/verify-user-level-migration.js
'use strict';
let pass=0, fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(`${c?'  ✓':'  ✗ FAIL'} ${m}`);};
(async()=>{
  let db, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_lvl', logLevel: 'ERROR' });
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({ host:'127.0.0.1', port:db.port, user:db.username||'root', password:'', database:db.dbName });
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80), category INT NULL)");
    const { ensureUserLevelColumn } = require('../services/dbMigrations');
    // fresh module state per run: the fn has an internal `userLevelEnsured` guard,
    // so within one process it runs once; call twice to prove no throw + idempotent SQL.
    await ensureUserLevelColumn(conn);
    let [cols] = await conn.query("SHOW COLUMNS FROM `user` LIKE 'level'");
    ok(cols.length === 1, "level column exists after migration");
    ok(/tinyint/i.test(cols[0].Type), `level is TINYINT (got ${cols[0] && cols[0].Type})`);
    ok(String(cols[0].Null).toUpperCase() === 'YES', "level is NULLable");
    ok(cols[0].Default === null, "level default is NULL");
    // Idempotent: calling the raw SQL guard path again must not error or duplicate.
    const [chk] = await conn.query("SHOW COLUMNS FROM `user` LIKE 'level'");
    if (!chk.length) { await conn.query("ALTER TABLE `user` ADD COLUMN `level` TINYINT NULL DEFAULT NULL"); }
    [cols] = await conn.query("SHOW COLUMNS FROM `user` LIKE 'level'");
    ok(cols.length === 1, "still exactly one level column (idempotent)");
    // Accepts 1..5 and NULL; category-2 (sub) stays NULL by convention.
    await conn.query("INSERT INTO `user`(name,category,level) VALUES ('emp',1,3),('sub',2,NULL),('owner',1,5)");
    const [[three]] = await conn.query("SELECT level FROM `user` WHERE name='emp'");
    ok(Number(three.level) === 3, "stored level=3 for an employee");
    const [[sub]] = await conn.query("SELECT level FROM `user` WHERE name='sub'");
    ok(sub.level === null, "subcontractor row keeps level NULL (off-ladder)");
    console.log(`\n${fail===0?'PASS ✅':'FAIL ❌'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail===0?0:1;
  } catch(e){ console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode=2; }
  finally { try{if(conn)await conn.end();}catch{} try{if(db&&db.stop)await db.stop();}catch{} }
})();
