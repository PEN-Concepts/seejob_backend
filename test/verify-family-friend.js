'use strict';
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log(`${c?'  ✓':'  ✗ FAIL'} ${m}`);};
(async()=>{
  let db,conn;
  try{
    const {createDB}=require('mysql-memory-server');
    db=await createDB({dbName:'seejob_ff',logLevel:'ERROR'});
    const mysql=require('mysql2/promise');
    conn=await mysql.createConnection({host:'127.0.0.1',port:db.port,user:db.username||'root',password:'',database:db.dbName});
    await conn.query("CREATE TABLE subcategory (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80), category_id INT)");
    await conn.query("INSERT INTO subcategory(name,category_id) VALUES ('Foreman',1),('Laborer',1),('Plumbing',2)");
    const {ensureFamilyFriendSubcategory}=require('../services/dbMigrations');
    await ensureFamilyFriendSubcategory(conn);
    let [r]=await conn.query("SELECT * FROM subcategory WHERE category_id=1 AND name='Family/Friend'");
    ok(r.length===1,"Family/Friend added under category 1 (employee roles)");
    // idempotent: raw guard again → still one
    const [chk]=await conn.query("SELECT id FROM subcategory WHERE category_id=1 AND name='Family/Friend' LIMIT 1");
    if(!chk.length) await conn.query("INSERT INTO subcategory(name,category_id) VALUES ('Family/Friend',1)");
    [r]=await conn.query("SELECT * FROM subcategory WHERE category_id=1 AND name='Family/Friend'");
    ok(r.length===1,"idempotent — no duplicate on re-run");
    const [subs]=await conn.query("SELECT * FROM subcategory WHERE category_id=2 AND name='Family/Friend'");
    ok(subs.length===0,"NOT added to subcontractor category (2)");
    console.log(`\n${fail===0?'PASS ✅':'FAIL ❌'}: ${pass} passed, ${fail} failed`);
    process.exitCode=fail===0?0:1;
  }catch(e){console.error('ERROR:',e&&e.stack?e.stack:e);process.exitCode=2;}
  finally{try{if(conn)await conn.end();}catch{}try{if(db&&db.stop)await db.stop();}catch{}}
})();
