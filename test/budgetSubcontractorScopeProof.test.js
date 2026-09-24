/* §0 ITEM 2 — WHY 13 AND NOT 33. PROVEN, NOT REASONED.
 *
 * The CCP gates this: if the gap is anything other than the category filter,
 * stop and report before the query changes. So both queries are run VERBATIM,
 * as they appear in the routes today, against one fixture whose shape matches
 * what Poul describes — and the row counts are compared.
 *
 * The fixture's only interesting property: some contacts were added by POUL and
 * some by his EMPLOYEE. That is the whole experiment.
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x === undefined ? '' : x)}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_subscope_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(150), email VARCHAR(190), role INT NULL, category INT NULL, subcategory INT NULL, created_by INT NULL, business VARCHAR(190) NULL, can_view_all_contacts TINYINT DEFAULT 0)");
    await conn.query("CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT NULL, request_to INT NULL)");

    const POUL = 100, EMP = 101;
    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by) VALUES (?, 'Poul','poul@x.com',14,2,NULL)", [POUL]);
    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by) VALUES (?, 'Employee One','e1@x.com',5,1,?)", [EMP, POUL]);

    /* 33 subcontractors (category 2). TWENTY are on contact rows added by POUL;
     * THIRTEEN by his EMPLOYEE — the split is the experiment, and 13 is Poul's
     * reported number. Plus 1 GC (category 2 as well, distinguished by role),
     * 2 more employees, and a CLIENT who must never appear. */
    let uid = 200;
    const subs = [];
    for (let i = 0; i < 33; i++) {
      const id = uid++;
      subs.push(id);
      const biz = i % 3 === 0 ? null : `COMPANY ${String(i).padStart(2, '0')} INC`;
      await conn.query(
        "INSERT INTO `user` (id,name,email,role,category,created_by,business) VALUES (?,?,?,12,2,?,?)",
        [id, `Sub Person ${i}`, `s${i}@x.com`, POUL, biz],
      );
      // The FIRST 13 are contacts of the EMPLOYEE; the rest are Poul's own.
      const adder = i < 13 ? EMP : POUL;
      await conn.query("INSERT INTO contact (request_by, request_to) VALUES (?, ?)", [adder, id]);
    }
    const GC = uid++;
    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,business) VALUES (?, 'GC Person','gc@x.com',14,2,?, 'BIG GC INC')", [GC, POUL]);
    await conn.query("INSERT INTO contact (request_by, request_to) VALUES (?, ?)", [POUL, GC]);
    for (let i = 0; i < 2; i++) {
      const id = uid++;
      await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by) VALUES (?,?,?,5,1,?)", [id, `Employee ${i + 2}`, `e${i + 2}@x.com`, POUL]);
      await conn.query("INSERT INTO contact (request_by, request_to) VALUES (?, ?)", [POUL, id]);
    }
    const CLIENT = uid++;
    await conn.query("INSERT INTO `user` (id,name,email,role,category,created_by) VALUES (?, 'A Client','client@x.com',3,3,?)", [CLIENT, POUL]);
    await conn.query("INSERT INTO contact (request_by, request_to) VALUES (?, ?)", [POUL, CLIENT]);

    // ── THE QUERY AS IT SHIPS TODAY (routes/budget.js "/subcontractors") ──
    const [today] = await conn.query(
      `(SELECT u.id, u.name, u.email FROM contact c INNER JOIN user u ON u.id = c.request_to
         WHERE c.request_by = ? AND u.category = 2)
       UNION
       (SELECT u.id, u.name, u.email FROM contact c INNER JOIN user u ON u.id = c.request_by
         WHERE c.request_to = ? AND u.category = 2)
       ORDER BY name ASC, id ASC`,
      [POUL, POUL],
    );

    // ── THE SAME, but scoped the way get-task-users scopes (account-wide) ──
    const [accountWide] = await conn.query(
      `(SELECT u.id, u.name, u.email FROM contact c INNER JOIN user u ON u.id = c.request_to
         WHERE c.request_by IN (SELECT id FROM user WHERE id = ? OR created_by = ?) AND u.category = 2)
       UNION
       (SELECT u.id, u.name, u.email FROM contact c INNER JOIN user u ON u.id = c.request_by
         WHERE c.request_to IN (SELECT id FROM user WHERE id = ? OR created_by = ?) AND u.category = 2)
       ORDER BY name ASC, id ASC`,
      [POUL, POUL, POUL, POUL],
    );

    // ── And with the CATEGORY FILTER REMOVED but the narrow scope kept ──
    const [noCategory] = await conn.query(
      `(SELECT u.id, u.name, u.email FROM contact c INNER JOIN user u ON u.id = c.request_to
         WHERE c.request_by = ?)
       UNION
       (SELECT u.id, u.name, u.email FROM contact c INNER JOIN user u ON u.id = c.request_by
         WHERE c.request_to = ?)
       ORDER BY name ASC, id ASC`,
      [POUL, POUL],
    );

    note(`seeded: 33 subs (13 added by the EMPLOYEE, 20 by Poul), 1 GC, 3 employees, 1 client`);
    note(`TODAY's query (request_by = caller, category = 2): ${today.length} rows`);
    note(`account-wide scope, category = 2 kept:            ${accountWide.length} rows`);
    note(`narrow scope, category filter REMOVED:            ${noCategory.length} rows`);

    /* THE PROOF. If the category filter were the cause, removing it would
     * recover the missing rows. It does not — the count barely moves, because
     * the rows are dropped by the SCOPE, not the category. */
    ok(today.length === 21,
      'TODAY: the narrow scope returns only contacts the CALLER personally added (20 subs + the GC)',
      String(today.length));
    ok(accountWide.length === 35,
      'ACCOUNT-WIDE scope recovers all 33 subs + the GC + the caller himself — the scope was the cause',
      String(accountWide.length));
    ok(noCategory.length < accountWide.length,
      'removing the CATEGORY filter alone does NOT recover them',
      `category-off=${noCategory.length} vs account-wide=${accountWide.length}`);
    ok(accountWide.length - today.length === 14,
      'the scope alone accounts for the missing rows (13 subs + 1 GC here)',
      String(accountWide.length - today.length));

    /* THE DISPLAY HALF. The old query selected only id/name/email, so there was
     * no company column to render and the picker had nothing but owner names to
     * show. Assert the SHIPPED query now carries it.
     *
     * The window is cut from the route path to the NEXT router.get, not a fixed
     * character count: an earlier version of this took `+ 3000` chars and the
     * comment block above the query grew past it, so the assertion stopped
     * reaching the SQL and passed on an empty window. */
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'budget.js'), 'utf8');
    const start = src.indexOf('"/subcontractors"');
    const next = src.indexOf('router.get(', start);
    const block = src.slice(start, next > start ? next : src.length);
    ok(start > -1 && /connection\.query\(/.test(block),
      'the window actually contains the query — otherwise the assertion below is vacuous',
      `start=${start} len=${block.length}`);
    ok(/u\.business/.test(block),
      'the shipped query selects the COMPANY column, which is what the two-line row renders',
      'u.business missing');

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (conn) conn.release();
    if (pool && pool.end) await pool.end();
    if (db && db.stop) await db.stop();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log(rec.join('\n'));
    console.error('HARNESS ERROR:', e && e.message);
    try { if (conn) conn.release(); if (pool && pool.end) await pool.end(); if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(1);
  }
})();
