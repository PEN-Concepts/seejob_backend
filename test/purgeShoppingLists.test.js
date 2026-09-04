/* purgeShoppingLists migration step (Shopping List removal).
 *
 * Proves against real MySQL (mysql-memory-server) that the boot step removes
 * every checklist_sections row with type='shopping' AND its check_list items,
 * leaves 'task' sections + their items untouched, reports accurate counts +
 * owner ids, leaves no orphaned items, and is idempotent (second run = 0).
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

    await conn.query("CREATE TABLE checklist_sections (id INT PRIMARY KEY, owner_user_id INT NULL, type VARCHAR(20) DEFAULT 'task', title VARCHAR(200) NULL)");
    await conn.query("CREATE TABLE check_list (id INT PRIMARY KEY, name VARCHAR(200), section_id INT NULL, created_by INT NULL, type VARCHAR(20) DEFAULT 'task')");

    // 2 shopping sections (owner 900) with 3 items; 1 task section with 2 items.
    await conn.query("INSERT INTO checklist_sections (id,owner_user_id,type,title) VALUES (1,900,'shopping','Shopping List'),(2,900,'shopping','Shopping List 2'),(3,900,'task','My Notepad')");
    await conn.query("INSERT INTO check_list (id,name,section_id,created_by) VALUES (10,'nails',1,900),(11,'screws',1,900),(12,'paint',2,900),(20,'call sub',3,900),(21,'order tile',3,900)");

    const before = await conn.query("SELECT (SELECT COUNT(*) FROM checklist_sections) s, (SELECT COUNT(*) FROM check_list) i");
    ok(before[0][0].s === 3 && before[0][0].i === 5, 'seed: 3 sections, 5 items', JSON.stringify(before[0][0]));

    // ---- run the purge ----
    const r = await purgeShoppingLists(conn);
    ok(r.sections === 2, 'purge removed 2 shopping sections', r.sections);
    ok(r.items === 3, 'purge removed 3 shopping items', r.items);
    ok(Array.isArray(r.owners) && r.owners.length === 1 && r.owners[0] === 900, 'reports owner_user_ids=[900]', JSON.stringify(r.owners));

    const [[secLeft]] = await conn.query("SELECT COUNT(*) c FROM checklist_sections");
    const [[shopLeft]] = await conn.query("SELECT COUNT(*) c FROM checklist_sections WHERE type='shopping'");
    const [[taskItems]] = await conn.query("SELECT COUNT(*) c FROM check_list WHERE section_id=3");
    const [[orphans]] = await conn.query("SELECT COUNT(*) c FROM check_list WHERE section_id NOT IN (SELECT id FROM checklist_sections) AND section_id IS NOT NULL");
    ok(secLeft.c === 1 && shopLeft.c === 0, 'only the task section remains; no shopping sections', `sections=${secLeft.c} shopping=${shopLeft.c}`);
    ok(taskItems.c === 2, 'task section items untouched (2)', taskItems.c);
    ok(orphans.c === 0, 'no orphaned items remain', orphans.c);

    // ---- idempotent second run ----
    const r2 = await purgeShoppingLists(conn);
    ok(r2.sections === 0 && r2.items === 0, 'second run is a no-op (0 sections, 0 items)', JSON.stringify(r2));

    // type column now single-valued?
    const [[distinct]] = await conn.query("SELECT COUNT(DISTINCT type) c FROM checklist_sections");
    ok(distinct.c === 1, "type column is now single-valued ('task') — droppable later", distinct.c);

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
