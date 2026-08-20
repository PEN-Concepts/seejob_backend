'use strict';
// Real-MySQL: applyLevelRights writes correct per-user role_right_permission rows
// (right CRUD flags, keyed by role_id=user.role + user_id), full-resets on re-apply,
// and fails closed for off-ladder levels. node test/verify-apply-level.js
let pass=0, fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(`${c?'  ✓':'  ✗ FAIL'} ${m}`);};
(async()=>{
  let db, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_applylvl', logLevel: 'ERROR' });
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection({ host:'127.0.0.1', port:db.port, user:db.username||'root', password:'', database:db.dbName });
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, `role` INT, `level` TINYINT NULL)");
    await conn.query("CREATE TABLE `right` (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(40), sub_heading INT DEFAULT 0)");
    await conn.query("CREATE TABLE role_right_permission (id INT PRIMARY KEY AUTO_INCREMENT, role_id INT, user_id INT NULL, right_id INT, `read` VARCHAR(4), `create` VARCHAR(4), `update` VARCHAR(4), `delete` VARCHAR(4))");
    const names = ['dashboard','spartan','profile','support','subscription','invitation','job','contact','task','timecard','calendar','dailysheet','jobanalysis','equipment','appointment','checklist','lead','quote','changeorder','team','bid-requests','user'];
    for (const nm of names) await conn.query("INSERT INTO `right`(name,sub_heading) VALUES (?,0)", [nm]);
    await conn.query("INSERT INTO `right`(name,sub_heading) VALUES ('some_heading',1)"); // must be ignored
    await conn.query("INSERT INTO `user`(id,role,level) VALUES (100,4,NULL)");
    const { applyLevelRights } = require('../services/permissionLevels');

    const rowsFor = async () => {
      const [r] = await conn.query("SELECT rt.name, rrp.role_id, rrp.user_id, rrp.`read` rd, rrp.`create` cr, rrp.`update` up, rrp.`delete` dl FROM role_right_permission rrp JOIN `right` rt ON rt.id=rrp.right_id WHERE rrp.user_id=100");
      const m = {}; for (const x of r) m[x.name]=x; return m;
    };

    // ---- apply L2 ----
    let res = await applyLevelRights(conn, 100, 2);
    ok(res.applied && res.roleId===4, `L2 applied, keyed by role_id=user.role (4) [got ${res.roleId}]`);
    let m = await rowsFor();
    ok(m.dashboard && m.dashboard.role_id===4 && m.dashboard.user_id===100, "rows keyed (role_id=4, user_id=100) so /my-rights finds them");
    ok(m.job && m.job.rd==='yes' && m.job.cr==='no', "L2 job = view (read yes, create no)");
    ok(m.contact && m.contact.rd==='yes' && m.contact.cr==='no', "L2 contact = view-only");
    ok(m.task && m.task.rd==='yes' && m.task.up==='yes' && m.task.cr==='no', "L2 task = check-off (update, no create)");
    ok(!m.calendar && !m.quote && !m.lead && !m.user, "L2 has no calendar/quote/lead/employees");
    ok(!m.some_heading, "sub_heading!=0 rows never granted");

    // ---- re-apply L4 (full reset) ----
    res = await applyLevelRights(conn, 100, 4);
    m = await rowsFor();
    ok(m.job && m.job.cr==='yes' && m.job.up==='yes' && m.job.dl==='yes', "L4 job = manage (full CRUD)");
    ok(m.lead && m.lead.cr==='yes' && m.quote && m.quote.cr==='yes' && m.team, "L4 adds lead/quote/team");
    ok(m.contact && m.contact.dl==='yes', "L4 contact = full (delete yes)");
    ok(m.equipment && m.equipment.cr==='yes', "L4 equipment = inventory (create yes)");
    ok(!m.user, "L4 still NOT employees");
    const [[cnt]] = await conn.query("SELECT COUNT(*) c FROM role_right_permission WHERE user_id=100");
    ok(Number(cnt.c) === Object.keys(m).length, "full reset — no stale L2 rows left over");

    // ---- L5 ----
    await applyLevelRights(conn, 100, 5); m = await rowsFor();
    ok(m.user && m.user.cr==='yes' && m.subscription && m.subscription.up==='yes', "L5 = employees + manage billing");

    // ---- fail closed ----
    const before = (await conn.query("SELECT COUNT(*) c FROM role_right_permission WHERE user_id=100"))[0][0].c;
    res = await applyLevelRights(conn, 100, 99);
    const after = (await conn.query("SELECT COUNT(*) c FROM role_right_permission WHERE user_id=100"))[0][0].c;
    ok(res.applied===false && Number(before)===Number(after), "invalid level → not applied, rows untouched (fail closed)");

    console.log(`\n${fail===0?'PASS ✅':'FAIL ❌'}: ${pass} passed, ${fail} failed`);
    process.exitCode = fail===0?0:1;
  } catch(e){ console.error('ERROR:', e && e.stack ? e.stack : e); process.exitCode=2; }
  finally { try{if(conn)await conn.end();}catch{} try{if(db&&db.stop)await db.stop();}catch{} }
})();
