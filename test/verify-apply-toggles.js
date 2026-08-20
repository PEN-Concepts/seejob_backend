'use strict';
// applyLevelRights + applyToggles: toggles overlay ON top of preset, OFF reverts.
let pass=0, fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(`${c?'  ✓':'  ✗ FAIL'} ${m}`);};
(async()=>{
  let db, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_toggles', logLevel: 'ERROR' });
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({ host:'127.0.0.1', port:db.port, user:db.username||'root', password:'', database:db.dbName });
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, `role` INT, `level` TINYINT NULL)");
    await conn.query("CREATE TABLE `right` (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(40), sub_heading INT DEFAULT 0)");
    await conn.query("CREATE TABLE role_right_permission (id INT PRIMARY KEY AUTO_INCREMENT, role_id INT, user_id INT NULL, right_id INT, `read` VARCHAR(4), `create` VARCHAR(4), `update` VARCHAR(4), `delete` VARCHAR(4))");
    for (const nm of ['dashboard','spartan','profile','support','subscription','invitation','job','contact','task','checklist','project_manager']) await conn.query("INSERT INTO `right`(name) VALUES (?)",[nm]);
    await conn.query("INSERT INTO `user`(id,role,level) VALUES (100,4,NULL)");
    const { applyLevelRights, applyToggles } = require('../services/permissionLevels');
    const get = async (name) => { const [r]=await conn.query("SELECT rrp.`read` rd, rrp.`create` cr FROM role_right_permission rrp JOIN `right` rt ON rt.id=rrp.right_id WHERE rrp.user_id=100 AND rt.name=?",[name]); return r[0]||null; };

    // L2 (no checklist, no PM in preset) + toggles ON
    let res = await applyLevelRights(conn, 100, 2);
    await applyToggles(conn, 100, res.roleId, { project_manager:true, notepad_create:true });
    let pm = await get('project_manager'), cl = await get('checklist');
    ok(pm && pm.cr==='yes', "toggle ON: project_manager granted on L2 (not in preset)");
    ok(cl && cl.rd==='yes' && cl.cr==='yes', "toggle ON: notepad-create adds checklist read+create on L2");

    // Re-apply L2 with toggles OFF → both revert to preset (absent for L2)
    res = await applyLevelRights(conn, 100, 2);
    await applyToggles(conn, 100, res.roleId, { project_manager:false, notepad_create:false });
    pm = await get('project_manager'), cl = await get('checklist');
    ok(!pm, "toggle OFF: project_manager removed (full reset to preset)");
    ok(!cl, "toggle OFF: checklist absent for L2 (preset)");

    // L3 (checklist VIEW in preset) + notepad OFF → keeps VIEW (read yes, create no)
    res = await applyLevelRights(conn, 100, 3);
    await applyToggles(conn, 100, res.roleId, { project_manager:false, notepad_create:false });
    cl = await get('checklist');
    ok(cl && cl.rd==='yes' && cl.cr==='no', "L3 notepad OFF: keeps checklist VIEW (recipient), no create");
    // L3 + notepad ON → upgrades to create
    res = await applyLevelRights(conn, 100, 3);
    await applyToggles(conn, 100, res.roleId, { notepad_create:true });
    cl = await get('checklist');
    ok(cl && cl.cr==='yes', "L3 notepad ON: checklist create granted");

    console.log(`\n${fail===0?'PASS ✅':'FAIL ❌'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail===0?0:1;
  } catch(e){ console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode=2; }
  finally { try{if(conn)await conn.end();}catch{} try{if(db&&db.stop)await db.stop();}catch{} }
})();
