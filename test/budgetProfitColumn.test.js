/* Budget profit_percent column — migration + round-trip (Overhead/Profit split).
 *
 * Proves against real MySQL (mysql-memory-server):
 *  1. ensureBudgetPercentColumns() adds profit_percent as NULLABLE (default NULL),
 *     leaving existing overhead_percent/gl_percent untouched — idempotent.
 *  2. A legacy row (predating the split) keeps its combined value in
 *     overhead_percent and reads profit_percent = NULL (never-split marker), so no
 *     value is silently divided and the contract total is preserved.
 *  3. profit_percent round-trips: explicit 0 and a positive value both persist and
 *     stay distinct from NULL.
 *
 * Run: NODE_PATH=<backend>/node_modules node test/budgetProfitColumn.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_profit_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const { ensureBudgetPercentColumns } = require('../services/dbMigrations');
    conn = await pool.getConnection();

    // Table as it exists BEFORE the split — has overhead_percent + gl_percent, no profit_percent.
    await conn.query(`CREATE TABLE division_lineitems (
      id INT PRIMARY KEY AUTO_INCREMENT, division_id INT, job_id INT, owner_type VARCHAR(8),
      lineitem_description VARCHAR(255) NULL, amount DECIMAL(12,2) NULL,
      contingency DECIMAL(7,3) NOT NULL DEFAULT 0,
      overhead_percent DECIMAL(7,3) NOT NULL DEFAULT 0,
      gl_percent DECIMAL(7,3) NOT NULL DEFAULT 0)`);

    // A LEGACY row whose overhead_percent holds the old combined "Overhead & profit" = 15%.
    await conn.query("INSERT INTO division_lineitems (division_id, job_id, owner_type, lineitem_description, amount, overhead_percent, gl_percent) VALUES (1, 100, 'job', 'Framing', 1000, 15, 2)");

    const col = async () => {
      const [c] = await conn.query("SHOW COLUMNS FROM division_lineitems LIKE 'profit_percent'");
      return c[0] || null;
    };
    ok(!(await col()), 'profit_percent absent before migration', 'present unexpectedly');

    await ensureBudgetPercentColumns(conn);
    const c = await col();
    ok(!!c, 'ensureBudgetPercentColumns added profit_percent', 'still absent');
    ok(c && /YES/i.test(String(c.Null)), 'profit_percent is NULLABLE (legacy vs explicit-0)', c && c.Null);
    await ensureBudgetPercentColumns(conn); // idempotent
    ok(!!(await col()), 'idempotent (second call fine)', '');

    // Legacy row: overhead untouched, profit NULL, gl untouched — nothing split.
    let [[r]] = await conn.query("SELECT overhead_percent, profit_percent, gl_percent FROM division_lineitems WHERE lineitem_description='Framing'");
    ok(Number(r.overhead_percent) === 15, 'legacy overhead_percent untouched (15, combined value preserved)', r.overhead_percent);
    ok(r.profit_percent === null, 'legacy profit_percent = NULL (never-split marker; no silent divide)', String(r.profit_percent));
    ok(Number(r.gl_percent) === 2, 'legacy gl_percent untouched (2)', r.gl_percent);

    // Owner splits: overhead 10 + profit 5 (was combined 15).
    await conn.query("UPDATE division_lineitems SET overhead_percent = 10, profit_percent = 5 WHERE lineitem_description='Framing'");
    [[r]] = await conn.query("SELECT overhead_percent, profit_percent FROM division_lineitems WHERE lineitem_description='Framing'");
    ok(Number(r.overhead_percent) === 10 && Number(r.profit_percent) === 5, 'split persists (overhead 10, profit 5)', r.overhead_percent + '/' + r.profit_percent);

    // Explicit 0 profit persists and stays distinct from NULL.
    await conn.query("INSERT INTO division_lineitems (division_id, job_id, owner_type, lineitem_description, amount, overhead_percent, profit_percent, gl_percent) VALUES (1, 100, 'job', 'FreeWork', 500, 8, 0, 1)");
    [[r]] = await conn.query("SELECT profit_percent FROM division_lineitems WHERE lineitem_description='FreeWork'");
    ok(r.profit_percent !== null && Number(r.profit_percent) === 0, 'explicit profit 0 persists (distinct from NULL) — this is what the warning keys on', String(r.profit_percent));

    // The load SELECT (with profit_percent in the list) is valid SQL.
    const [rows] = await conn.query(
      `SELECT id, division_id, lineitem_description, amount, contingency, overhead_percent, profit_percent, gl_percent
       FROM division_lineitems WHERE job_id = ? AND owner_type = ? ORDER BY id ASC`, [100, 'job']);
    ok(rows.length === 2 && rows.every((x) => 'profit_percent' in x), 'load SELECT returns profit_percent for every row', JSON.stringify(rows.map((x) => x.profit_percent)));

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
