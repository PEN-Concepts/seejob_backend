/* Suggested-items reference library — validates the new schema + seed + the
 * serving-endpoint filter logic against REAL MySQL (mysql-memory-server):
 *   - ensureSuggestedItemsTable creates the table and auto-seeds all 270 items;
 *   - every row links to a division (division_id === code numeric prefix);
 *   - the endpoint's job_type filter is correct (residential = R+B, commercial
 *     = C+B, none = all) on Division 02;
 *   - seedSuggestedItems is idempotent (re-run keeps 270, no dup codes).
 * Run: cd <worktree> && NODE_PATH=<backend>/node_modules node test/suggestedItems.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_suggested_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const { ensureSuggestedItemsTable, seedSuggestedItems } = require('../services/dbMigrations');
    const { ROWS } = require('../data/suggestedItems');
    conn = await pool.getConnection();

    // Minimal divisions reference (proves the code-prefix -> division_id linkage).
    await conn.query('CREATE TABLE divisions (id INT PRIMARY KEY, division_number INT, name VARCHAR(120))');
    for (let i = 1; i <= 16; i++) await conn.query('INSERT INTO divisions (id,division_number,name) VALUES (?,?,?)', [i, i, 'DIVISION ' + i]);

    // ---- create + auto-seed ----
    await ensureSuggestedItemsTable(conn);
    const [[{ c }]] = await conn.query('SELECT COUNT(*) AS c FROM suggested_items');
    ok(Number(c) === ROWS.length && Number(c) === 270, `auto-seed inserted all ${ROWS.length} items`, String(c));

    // ---- span + per-division ----
    const [byDiv] = await conn.query('SELECT division_id, COUNT(*) c FROM suggested_items GROUP BY division_id ORDER BY division_id');
    ok(byDiv.length === 16, 'items span exactly 16 divisions', String(byDiv.length));
    const d2 = byDiv.find((r) => Number(r.division_id) === 2);
    ok(d2 && Number(d2.c) === 49, 'Division 02 has 49 items', d2 && String(d2.c));

    // ---- every row links to a real division by code prefix ----
    const [[link]] = await conn.query('SELECT COUNT(*) c FROM suggested_items WHERE division_id <> CAST(SUBSTRING(code,1,2) AS UNSIGNED)');
    ok(Number(link.c) === 0, 'division_id matches the code prefix for every row', JSON.stringify(link));
    const [[orphan]] = await conn.query('SELECT COUNT(*) c FROM suggested_items s LEFT JOIN divisions d ON d.id = s.division_id WHERE d.id IS NULL');
    ok(Number(orphan.c) === 0, 'every item links to an existing division (1-16)', JSON.stringify(orphan));

    // ---- serving endpoint filter logic (Division 02) ----
    const q = (extra) => conn.query(`SELECT code,name,applicability FROM suggested_items WHERE division_id=2 ${extra} ORDER BY sort_order`);
    const [resi] = await q("AND applicability IN ('R','B')");
    const [comm] = await q("AND applicability IN ('C','B')");
    const [all] = await q('');
    const has = (rows, code) => rows.some((r) => r.code === code);
    ok(all.length === 49, 'no job_type -> all 49 Division-02 items', String(all.length));
    ok(has(resi, '02-110') && has(resi, '02-100') && !has(resi, '02-170'),
      'residential filter: R (02-110) + B (02-100) IN, C (02-170) OUT');
    ok(resi.every((r) => r.applicability === 'R' || r.applicability === 'B'),
      'residential filter returns only R or B rows');
    ok(has(comm, '02-170') && has(comm, '02-100') && !has(comm, '02-110'),
      'commercial filter: C (02-170) + B (02-100) IN, R (02-110) OUT');
    ok(comm.every((r) => r.applicability === 'C' || r.applicability === 'B'),
      'commercial filter returns only C or B rows');

    // ---- idempotent re-seed (owner endpoint path) ----
    const n = await seedSuggestedItems(conn);
    const [[{ c2 }]] = await conn.query('SELECT COUNT(*) AS c2 FROM suggested_items');
    ok(n === 270 && Number(c2) === 270, 're-seed is idempotent (still 270 rows, no duplication)', String(c2));
    const [[dup]] = await conn.query('SELECT COUNT(*) c FROM (SELECT code FROM suggested_items GROUP BY code HAVING COUNT(*)>1) t');
    ok(Number(dup.c) === 0, 'no duplicate codes after re-seed', JSON.stringify(dup));

    // ---- tag distribution sanity ----
    const [tags] = await conn.query("SELECT applicability, COUNT(*) c FROM suggested_items GROUP BY applicability");
    const tagMap = Object.fromEntries(tags.map((t) => [t.applicability, Number(t.c)]));
    ok(tagMap.B === 121 && tagMap.R === 74 && tagMap.C === 75, 'tag split B=121 R=74 C=75', JSON.stringify(tagMap));
  } catch (e) {
    ok(false, 'test harness error', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    rec.forEach((l) => console.log(l));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
