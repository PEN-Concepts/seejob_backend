/* Materials new columns — functional test (real MySQL via mysql-memory-server).
 * Verifies ensureMaterialsExtraColumns adds category/location/finish to a table that
 * started with only the original 6 fields (idempotent), and that a row can be saved
 * with all 9 fields OR with every field blank (all optional) and read back.
 * Run: node test/materialsColumns.functional.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  → ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_materials_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection');
    conn = await pool.getConnection();

    // Original materials shape (pre-redesign): only the 6 user fields + owner_type.
    await conn.query(`CREATE TABLE materials (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT, owner_type VARCHAR(8) DEFAULT 'job',
      item_type VARCHAR(45) NULL, room VARCHAR(45) NULL, material VARCHAR(45) NULL, manufacturer VARCHAR(45) NULL, size VARCHAR(45) NULL, color VARCHAR(45) NULL)`);

    const { ensureMaterialsExtraColumns } = require('../services/dbMigrations');
    await ensureMaterialsExtraColumns(conn);
    for (const col of ['category', 'location', 'finish']) {
      const [[c]] = await conn.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='materials' AND COLUMN_NAME=?`, [col]);
      ok(!!c, `migration added materials.${col}`);
    }
    // idempotent second run
    await ensureMaterialsExtraColumns(conn);
    ok(true, 'migration is idempotent (second run no-op)');

    // Save a fully-populated material (Paint / Kitchen / Walls sample from the CCP)
    await conn.query(
      `INSERT INTO materials (job_id, owner_type, category, room, location, item_type, material, manufacturer, finish, size, color)
       VALUES (10,'job','Paint','Kitchen','Walls','Eggshell Interior Paint','Swiss Coffee','Sherwin-Williams','Eggshell',NULL,'SW 7511')`
    );
    // Save a material with EVERY field blank (all optional)
    await conn.query(`INSERT INTO materials (job_id, owner_type) VALUES (10,'job')`);

    const [rows] = await conn.query('SELECT * FROM materials WHERE job_id = 10 ORDER BY id');
    ok(rows.length === 2, 'both rows saved (full + all-blank)', String(rows.length));
    const full = rows[0];
    ok(full.category === 'Paint' && full.room === 'Kitchen' && full.location === 'Walls', 'full row: category/room/location persisted');
    ok(full.item_type === 'Eggshell Interior Paint' && full.material === 'Swiss Coffee' && full.finish === 'Eggshell' && full.color === 'SW 7511',
      'full row: Material/Type + Color + Finish + Model/Code# persisted', JSON.stringify({ t: full.item_type, c: full.material, f: full.finish, m: full.color }));
    const blank = rows[1];
    ok([blank.category, blank.room, blank.location, blank.item_type, blank.material, blank.manufacturer, blank.finish, blank.size, blank.color].every((v) => v == null),
      'all-blank row saved with every field NULL (all optional)');

  } catch (e) {
    fail++; rec.push('  ✗ EXCEPTION: ' + (e && e.stack || e));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
  console.log('\n==== Materials columns functional test ====');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
