/* purgeShoppingLists migration step (Shopping List removal) + no-users abort guard.
 *
 * Proves against real MySQL (mysql-memory-server):
 *  - all shopping sections owned by Poul's account (incl. an employee under Poul)
 *    -> purge removes sections + items, keeps 'task' data, no orphans, idempotent;
 *  - ANY shopping section owned by a FOREIGN account -> purge ABORTS, deletes
 *    NOTHING, and reports the foreign owner (the no-users guard).
 *
 * Run: NODE_PATH=<backend>/node_modules node test/purgeShoppingLists.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_purgeshop_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const { purgeShoppingLists } = require('../services/dbMigrations');
    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, email VARCHAR(190), category INT, created_by INT NULL)");
    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY, owner_user_id INT NULL, type VARCHAR(20) DEFAULT 'task', title VARCHAR(200) NULL)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY, name VARCHAR(200), section_id INT NULL, created_by INT NULL, type VARCHAR(20) DEFAULT 'task')");
    // 900 = Poul (exempt email, owner). 902 = Poul's employee (category 1, created_by 900).
    // 901 = FOREIGN owner (not exempt).
    await conn.query("INSERT INTO `user` (id,email,category,created_by) VALUES (900,'admin@oakcoast.net',2,NULL),(902,'crew@oakcoast.net',1,900),(901,'other@x.com',2,NULL)");

    // ===== Scenario A — all shopping sections belong to Poul's account =====
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title) VALUES (1,900,'shopping','Shopping List'),(2,902,'shopping','Crew Shopping'),(3,900,'task','My Notepad')");
    await conn.query("INSERT INTO check_list (id,name,section_id) VALUES (10,'nails',1),(11,'screws',1),(12,'paint',2),(20,'call sub',3),(21,'order tile',3)");

    const rA = await purgeShoppingLists(conn);
    ok(rA.aborted === false, 'A: not aborted (all owners are Poul, incl employee under 900)', JSON.stringify(rA));
    ok(rA.sections === 2 && rA.items === 3, 'A: removed 2 shopping sections + 3 items', JSON.stringify(rA));
    const [[shopLeft]] = await conn.query("SELECT COUNT(*) c FROM checklist_sections WHERE type='shopping'");
    const [[taskItems]] = await conn.query("SELECT COUNT(*) c FROM check_list WHERE section_id=3");
    const [[orphans]] = await conn.query("SELECT COUNT(*) c FROM check_list WHERE section_id IS NOT NULL AND section_id NOT IN (SELECT id FROM checklist_sections)");
    ok(shopLeft.c === 0, 'A: no shopping sections remain', shopLeft.c);
    ok(taskItems.c === 2, 'A: task section items untouched (2)', taskItems.c);
    ok(orphans.c === 0, 'A: no orphaned items', orphans.c);
    const rA2 = await purgeShoppingLists(conn);
    ok(rA2.sections === 0 && rA2.aborted === false, 'A: idempotent second run (0, not aborted)', JSON.stringify(rA2));

    // ===== Scenario B — a FOREIGN-owned shopping section is present =====
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title) VALUES (4,900,'shopping','Poul shop again'),(5,901,'shopping','FOREIGN shop')");
    await conn.query("INSERT INTO check_list (id,name,section_id) VALUES (30,'poul item',4),(31,'foreign item',5)");
    const rB = await purgeShoppingLists(conn);
    ok(rB.aborted === true, 'B: ABORTED because a foreign owner (901) is present', JSON.stringify(rB));
    ok(Array.isArray(rB.foreign) && rB.foreign.some((f) => f.owner_user_id === 901 && f.email === 'other@x.com'), 'B: reports the foreign owner 901/other@x.com', JSON.stringify(rB.foreign));
    const [[shopStill]] = await conn.query("SELECT COUNT(*) c FROM checklist_sections WHERE type='shopping'");
    const [[itemsStill]] = await conn.query("SELECT COUNT(*) c FROM check_list WHERE section_id IN (4,5)");
    ok(shopStill.c === 2 && itemsStill.c === 2, 'B: deleted NOTHING — both shopping sections + items still present', `sections=${shopStill.c} items=${itemsStill.c}`);

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
