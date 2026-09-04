/* Budget line ALLOWANCE flag — column migration + round-trip  (Billing Task 8).
 *
 * Proves against real MySQL (mysql-memory-server):
 *  1. ensureAllowanceColumn() adds is_allowance to a table that lacks it, and is
 *     idempotent (safe to run again).
 *  2. The column round-trips 1/0 through an INSERT + SELECT + UPDATE using the
 *     SAME column the budget route reads/writes.
 *  3. Default is 0 (a line is NOT an allowance unless explicitly flagged).
 *
 * Run: NODE_PATH=<backend>/node_modules node test/budgetAllowanceColumn.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_allowance_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const { ensureAllowanceColumn } = require('../services/dbMigrations');
    conn = await pool.getConnection();

    // Table WITHOUT is_allowance (as it exists before the migration).
    await conn.query(`CREATE TABLE division_lineitems (
      id INT PRIMARY KEY AUTO_INCREMENT, division_id INT, job_id INT, owner_type VARCHAR(8),
      csi_number VARCHAR(20) NULL, lineitem_description VARCHAR(255) NULL,
      amount DECIMAL(12,2) NULL, sub_cost DECIMAL(12,2) NULL, contingency DECIMAL(7,3) NULL,
      overhead_percent DECIMAL(7,3) NULL, gl_percent DECIMAL(7,3) NULL,
      subcontractor_id INT NULL, in_house TINYINT NOT NULL DEFAULT 0,
      foreman_percent DECIMAL(7,3) NULL, paid_amount DECIMAL(12,2) NULL,
      created_at DATETIME NULL, created_by INT NULL)`);

    const has = async () => {
      const [c] = await conn.query("SHOW COLUMNS FROM division_lineitems LIKE 'is_allowance'");
      return c.length > 0;
    };
    ok(!(await has()), 'is_allowance absent before migration', 'present unexpectedly');

    await ensureAllowanceColumn(conn);
    ok(await has(), 'ensureAllowanceColumn added the column', 'still absent');

    // Idempotent (mirrors the once-per-process guard; calling again is a no-op).
    await ensureAllowanceColumn(conn);
    ok(await has(), 'ensureAllowanceColumn idempotent (second call fine)', '');

    // Default is 0 when not supplied — a line is not an allowance unless flagged.
    await conn.query(
      `INSERT INTO division_lineitems (division_id, job_id, owner_type, lineitem_description, amount, sub_cost)
       VALUES (1, 100, 'job', 'Framing', 1000, 800)`
    );
    let [[r0]] = await conn.query("SELECT is_allowance FROM division_lineitems WHERE lineitem_description='Framing'");
    ok(Number(r0.is_allowance) === 0, 'default is_allowance = 0', r0.is_allowance);

    // INSERT an allowance line the way the route does (is_allowance = 1).
    await conn.query(
      `INSERT INTO division_lineitems (division_id, job_id, owner_type, lineitem_description, amount, sub_cost, in_house, is_allowance)
       VALUES (1, 100, 'job', 'Tile allowance', 5000, 0, 0, 1)`
    );
    let [[r1]] = await conn.query("SELECT is_allowance FROM division_lineitems WHERE lineitem_description='Tile allowance'");
    ok(Number(r1.is_allowance) === 1, 'INSERT persists is_allowance = 1', r1.is_allowance);

    // UPDATE it back off (unchecking the box) — the route's UPDATE path.
    await conn.query("UPDATE division_lineitems SET is_allowance = ? WHERE lineitem_description = 'Tile allowance'", [0]);
    [[r1]] = await conn.query("SELECT is_allowance FROM division_lineitems WHERE lineitem_description='Tile allowance'");
    ok(Number(r1.is_allowance) === 0, 'UPDATE persists is_allowance = 0 (unchecked)', r1.is_allowance);

    // The route's load SELECT (with is_allowance in the column list) is valid SQL.
    const [rows] = await conn.query(
      `SELECT id, division_id, lineitem_description, amount, sub_cost, csi_number, job_id,
              subcontractor_id, in_house, is_allowance, foreman_percent, paid_amount,
              contingency, overhead_percent, gl_percent
       FROM division_lineitems WHERE job_id = ? AND owner_type = ? ORDER BY id ASC`,
      [100, 'job']
    );
    ok(rows.length === 2 && rows.every((r) => 'is_allowance' in r), "load SELECT returns is_allowance for every row", JSON.stringify(rows.map((r) => r.is_allowance)));

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
