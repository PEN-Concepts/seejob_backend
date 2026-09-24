/* WHO THE BUDGET PICKER RETURNS.
 *
 * It returned 13 of Poul's 37 people and rendered owner names instead of
 * companies. Two separate faults in one query:
 *
 *   SCOPE    `c.request_by = ?` — the CALLER personally — while every other
 *            picker scopes to the ACCOUNT. Any contact an employee typed in was
 *            invisible here. PROVEN in budgetSubcontractorScopeProof.test.js:
 *            dropping the category filter recovered 3 rows, changing the scope
 *            recovered 14.
 *   DISPLAY  the query selected only id/name/email. No company column existed to
 *            render, so the picker had nothing but owner names to show.
 *
 * This file pins the fixed behaviour end to end, through the real route.
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
    db = await createDB({ dbName: 'seejob_budgetpicker_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(150), email VARCHAR(190), role INT NULL, category INT NULL, subcategory INT NULL, created_by INT NULL, business VARCHAR(190) NULL, trade VARCHAR(120) NULL, can_view_all_contacts TINYINT DEFAULT 0)");
    await conn.query("CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT NULL, request_to INT NULL)");
    await conn.query("CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(80))");
    await conn.query("CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(80), category_id INT NULL)");
    await conn.query("INSERT INTO category VALUES (1,'Employee'),(2,'Contractor'),(3,'Client')");
    await conn.query("INSERT INTO subcategory VALUES (11,'Client',3),(12,'Subcontractor',2)");
    // The budget router is behind requirePlan('platinum') + a job_budget feature
    // check, so the fixture needs a real Platinum subscription for the caller.
    await conn.query("CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(80), amount DECIMAL(10,2), `interval` VARCHAR(20), is_active TINYINT DEFAULT 1, level INT NULL)");
    await conn.query("CREATE TABLE plan_features (id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT, feature_key VARCHAR(80))");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT, amount DECIMAL(10,2), billing_interval VARCHAR(20), status VARCHAR(30), next_billing_at DATETIME NULL, authorize_subscription_id VARCHAR(60) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await conn.query("INSERT INTO plans (id,name,amount,`interval`,is_active,level) VALUES (5,'Platinum',250.00,'monthly',1,5)");
    await conn.query("INSERT INTO subscriptions (user_id,plan_id,amount,billing_interval,status,next_billing_at) VALUES (100,5,250.00,'monthly','active', NOW() + INTERVAL 20 DAY)");
    await conn.query("INSERT INTO plan_features (plan_id,feature_key) VALUES (5,'job_budget'),(5,'budget'),(5,'job'),(5,'task')");

    const POUL = 100, EMP = 101;
    const add = (id, name, email, role, cat, createdBy, biz, sub, trade) =>
      conn.query("INSERT INTO `user` (id,name,email,role,category,created_by,business,subcategory,trade) VALUES (?,?,?,?,?,?,?,?,?)",
        [id, name, email, role, cat, createdBy, biz, sub ?? null, trade ?? null]);
    const link = (by, to) => conn.query("INSERT INTO contact (request_by, request_to) VALUES (?, ?)", [by, to]);

    await add(POUL, 'Poul Norholm', 'poul@oakcoast.net', 14, 2, null, 'OAK COAST CONSTRUCTION INC'); // owner-exempt: clears the Platinum gate
    await add(EMP, 'Employee One', 'e1@x.com', 5, 1, POUL, null);
    await link(POUL, EMP);

    /* Contacts added by the EMPLOYEE — the ones the old scope hid. */
    await add(300, 'Rolando Torres', 'rt@x.com', 12, 2, POUL, 'C & R TILE & STONE', null, 'Tile & Stone');
    await link(EMP, 300);
    await add(301, 'Steve Anderson', 'sa@x.com', 12, 2, POUL, 'MORRO BAY CABINETS INC');
    await link(EMP, 301);
    await add(302, 'Hidden By Scope', 'hbs@x.com', 12, 2, POUL, 'BE RIGHT THERE HEATING & AIR CONDITIONING INC');
    await link(EMP, 302);

    /* Added by Poul himself. */
    await add(310, 'Matt Petronella', 'mp@x.com', 12, 2, POUL, null);          // no company
    await link(POUL, 310);
    await add(311, 'GC Person', 'gc@x.com', 14, 2, POUL, 'BIG GC INC');        // a GC: category 2 too
    await link(POUL, 311);
    await add(312, 'Filed By Subcategory', 'fbs@x.com', 9, 3, POUL, 'SUBCAT CO', 12); // cat 3 BUT subcat 12 -> contractor
    await link(POUL, 312);
    await add(320, 'Family Employee', 'fam@x.com', 5, 1, POUL, null);
    await link(POUL, 320);

    /* Must NEVER appear. */
    await add(330, 'A Real Client', 'client@x.com', 3, 3, POUL, 'CLIENT HOMES LLC');
    await link(POUL, 330);
    await add(340, 'Unknown Category', 'weird@x.com', 77, 88, POUL, 'WEIRD CO');  // category the code has never seen
    await link(POUL, 340);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/budget', require('../routes/budget'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const res = await request(app).get('/api/budget/subcontractors').set('Authorization', tok(POUL));
    ok(res.status === 200, 'the picker responds 200', String(res.status) + ' ' + JSON.stringify(res.body).slice(0, 160));
    const rows = Array.isArray(res.body) ? res.body : [];
    /* GUARD AGAINST A VACUOUS PASS. Every "never appears" assertion below is
     * trivially true of an EMPTY list — which is exactly what a 403 returns. So
     * the list must be non-empty before any of them means anything. */
    ok(rows.length >= 8, 'the picker returned a populated list — otherwise every absence below is vacuous', String(rows.length));
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const names = rows.map((r) => String(r.business || r.name));
    note('returned: ' + JSON.stringify(names));

    // ══ 3. everyone who can do work appears ═══════════════════════════════
    ok(byId.has(300) && byId.has(301) && byId.has(302),
      'contacts added by an EMPLOYEE now appear — the scope fix', JSON.stringify([...byId.keys()]));
    ok(byId.has(311), 'the general contractor appears');
    ok(byId.has(310), 'a contractor with no company appears');
    ok(byId.has(320) && byId.has(EMP), 'employees appear, including family');
    ok(byId.has(312), 'a contact filed under a SUBCATEGORY is classified by its parent category');

    // ══ 4/5. who must not ═════════════════════════════════════════════════
    ok(!byId.has(330), 'a CLIENT never appears', 'client present');
    ok(!byId.has(340), 'an UNKNOWN category never appears — the allowlist is positive', 'unknown present');
    ok(!byId.has(POUL), 'the CALLER does not appear in his own subcontractor list', 'caller present');

    // ══ 6/7. the company is available to render ═══════════════════════════
    ok(byId.get(300) && byId.get(300).business === 'C & R TILE & STONE',
      'the company name is returned, not just the owner', byId.get(300) && JSON.stringify(byId.get(300)));
    ok(byId.get(300) && byId.get(300).name === 'Rolando Torres',
      'and the owner name comes with it, for the second line');
    ok(byId.get(310) && !byId.get(310).business,
      'a contact with no company returns none — the row renders one line');

    // ══ 11. the SEARCH has all three fields to match on ═══════════════════
    // The search itself is client-side; what the route owes it is the data.
    ok(byId.get(300) && byId.get(300).trade === 'Tile & Stone',
      'the TRADE is returned so search can match it — company, owner AND trade',
      byId.get(300) && JSON.stringify(byId.get(300)));
    ok(byId.get(312) && byId.get(312).subcategory_name === 'Subcontractor',
      'the picked subcategory name comes too, for contacts with no free-text trade',
      byId.get(312) && JSON.stringify(byId.get(312)));

    // ══ 9. sorted by the DISPLAYED name ═══════════════════════════════════
    const displayed = rows.map((r) => String(r.business || r.name || '').toLowerCase());
    const sorted = [...displayed].sort((a, b) => a.localeCompare(b));
    ok(JSON.stringify(displayed) === JSON.stringify(sorted),
      'rows are sorted by the DISPLAYED name (company where there is one)',
      JSON.stringify(displayed));

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
