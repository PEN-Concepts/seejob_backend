'use strict';
// Real-MySQL: hasLevelAtLeast — owner(role 14) bypasses; subs/clients denied;
// employees checked by level; missing/NULL fail closed. node test/verify-level-check.js
let pass=0, fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(`${c?'  ✓':'  ✗ FAIL'} ${m}`);};
(async()=>{
  let db;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_lvlchk', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV='127.0.0.1'; process.env.DB_PORT_DEV=String(db.port); process.env.DB_USER_DEV=db.username||'root'; process.env.DB_PASSWORD_DEV=''; process.env.DB_NAME_DEV=db.dbName;
    const pool = require('../config/connection');
    const conn = await pool.getConnection();
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, `role` INT, `level` TINYINT NULL, category INT)");
    await conn.query("INSERT INTO `user`(id,role,level,category) VALUES (1,14,NULL,0)");   // owner (GC)
    await conn.query("INSERT INTO `user`(id,role,level,category) VALUES (2,12,NULL,2)");   // subcontractor
    await conn.query("INSERT INTO `user`(id,role,level,category) VALUES (3,3,NULL,3)");    // client
    await conn.query("INSERT INTO `user`(id,role,level,category) VALUES (4,4,4,1)");       // employee L4
    await conn.query("INSERT INTO `user`(id,role,level,category) VALUES (5,4,2,1)");       // employee L2
    await conn.query("INSERT INTO `user`(id,role,level,category) VALUES (6,4,NULL,1)");    // employee, no level yet
    const { hasLevelAtLeast } = require('../utils/access');

    ok(await hasLevelAtLeast(1,4,conn)===true,  "owner (role 14, level NULL) passes L4");
    ok(await hasLevelAtLeast(1,5,conn)===true,  "owner passes even L5 (top authority)");
    ok(await hasLevelAtLeast(2,4,conn)===false, "subcontractor (role 12) DENIED L4");
    ok(await hasLevelAtLeast(3,4,conn)===false, "client (role 3) DENIED L4");
    ok(await hasLevelAtLeast(4,4,conn)===true,  "employee L4 passes L4");
    ok(await hasLevelAtLeast(4,5,conn)===false, "employee L4 DENIED L5");
    ok(await hasLevelAtLeast(5,4,conn)===false, "employee L2 DENIED L4");
    ok(await hasLevelAtLeast(6,4,conn)===false, "employee with NULL level DENIED (fail closed)");
    ok(await hasLevelAtLeast(999,4,conn)===false, "missing user DENIED (fail closed)");
    ok(await hasLevelAtLeast(null,4,conn)===false, "null userId DENIED");

    conn.release(); if(pool.end) await pool.end();
    console.log(`\n${fail===0?'PASS ✅':'FAIL ❌'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail===0?0:1;
  } catch(e){ console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode=2; }
  finally { try{if(db&&db.stop)await db.stop();}catch{} }
})();
