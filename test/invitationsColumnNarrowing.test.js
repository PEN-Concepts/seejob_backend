/* getuserbycategory / getuserbysubcategory — no email, no phone number.
 *
 * Both endpoints filter on the caller-supplied category ALONE — no company, no
 * owner, no contact join — so they return matching users across every company.
 * Email and mobile were removed from the SELECT. That changes no WHERE clause,
 * so the ROWS are unchanged by design; this file proves both halves of that:
 * the same rows come back, and the personal columns are gone.
 *
 * TWO COMPANIES are seeded. A single-tenant fixture cannot tell a scoped query
 * from an unscoped one — with one company in the table "everyone" and "mine"
 * are the same set — which is how the budget leak survived as long as it did.
 * Here the second company also PROVES the row breadth is unchanged, which is
 * what makes this a safe, column-only change.
 *
 * Run: node test/invitationsColumnNarrowing.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_invcols_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), mobile VARCHAR(40), role INT NULL, status INT DEFAULT 1, category INT NULL, subcategory INT NULL, created_by INT NULL, created_at DATETIME NULL)");

    // TWO COMPANIES, each with a category-2 contact carrying a real-looking
    // email and phone — exactly what must not come back.
    await conn.query(`INSERT INTO \`user\` (id,name,email,mobile,role,status,category,subcategory,created_by,created_at) VALUES
      (100,'Acme Owner','acme@example.invalid','555-0100',14,1,4,NULL,NULL,NOW()),
      (101,'Acme Contractor','acon@example.invalid','555-0101',12,1,2,7,100,NOW()),
      (200,'Beta Owner','beta@example.invalid','555-0200',14,1,4,NULL,NULL,NOW()),
      (201,'Beta Contractor','bcon@example.invalid','555-0201',12,1,2,7,200,NOW())`);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/invitation', require('../routes/invitations'));
    const tok = (id) => 'Bearer ' + jwt.sign(
      { id, role: 14, category: 4, email: 'u' + id + '@example.invalid' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    const call = async (url, who) => {
      const r = await request(app).get(url).set('Authorization', tok(who));
      if (r.status !== 200) { note(`HTTP ${r.status} ${url}: ${JSON.stringify(r.body).slice(0, 120)}`); return null; }
      return (r.body && r.body.data) || [];
    };

    const byCat = await call('/api/invitation/getuserbycategory/2', 100);
    const bySub = await call('/api/invitation/getuserbysubcategory/7', 100);
    ok(byCat !== null && bySub !== null, 'both endpoints respond 200', JSON.stringify({ byCat, bySub }));

    // ── ROWS UNCHANGED. Removing columns must not change which rows return.
    //    Both companies' contractors still come back — the breadth is a
    //    separate, still-open question and this change did not touch it.
    ok(byCat && byCat.length === 2,
      'getuserbycategory returns the SAME 2 rows as before (breadth unchanged)',
      JSON.stringify(byCat));
    ok(bySub && bySub.length === 2,
      'getuserbysubcategory returns the same 2 rows', JSON.stringify(bySub));
    ok(byCat && byCat.some((u) => u.name === 'Acme Contractor') && byCat.some((u) => u.name === 'Beta Contractor'),
      'still returns BOTH companies — this was a column change, not a scope change',
      JSON.stringify(byCat.map((u) => u.name)));

    // ── NO PERSONAL COLUMNS, verified on the response, not in the source.
    const leakedFields = [];
    for (const list of [byCat || [], bySub || []]) {
      for (const u of list) {
        for (const k of Object.keys(u)) {
          if (/email|mobile|phone/i.test(k)) leakedFields.push(k);
        }
      }
    }
    ok(leakedFields.length === 0,
      'NO email, mobile or phone field on any returned row',
      JSON.stringify([...new Set(leakedFields)]));

    // And no value that merely looks like one, in case a column is renamed.
    const blob = JSON.stringify({ byCat, bySub });
    ok(!/@example\.invalid/.test(blob),
      'no email ADDRESS appears anywhere in either payload', blob.slice(0, 160));
    ok(!/555-0\d{3}/.test(blob),
      'no phone NUMBER appears anywhere in either payload', blob.slice(0, 160));

    note('returned shape: ' + JSON.stringify((byCat || [])[0] || {}));

  } catch (err) {
    fail++; rec.push('  ✗ threw: ' + (err && err.stack || err));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
