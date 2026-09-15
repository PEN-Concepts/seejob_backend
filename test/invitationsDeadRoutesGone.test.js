/* getuserbycategory / getuserbysubcategory are GONE from invitations.
 *
 * They were unscoped duplicates: the WHERE clause was the caller-supplied
 * category alone — no company, no owner, no contact join — so they returned
 * matching users across every company. routes/contacts.js carries the same two
 * paths, correctly scoped through getContactScope/visibleUserPredicate, with a
 * comment reading "was the ENTIRE user table". Somebody fixed the exposure
 * there and missed these copies.
 *
 * Nothing called either one, so they were deleted rather than scoped. This
 * file exists so that deletion cannot be quietly undone: if someone re-adds
 * them, these assertions fail and point at the scoped versions instead.
 *
 * Two companies are seeded, because a single-tenant fixture cannot tell a
 * scoped query from an unscoped one — with one company in the table
 * "everyone" and "mine" are the same set, which is how this class of bug
 * survives review.
 *
 * Run: node test/invitationsDeadRoutesGone.test.js
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
    db = await createDB({ dbName: 'seejob_deadroutes_test', logLevel: 'ERROR' });
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

    // TWO COMPANIES, each with a contact carrying details that must not leak.
    await conn.query(`INSERT INTO \`user\` (id,name,email,mobile,role,status,category,subcategory,created_by,created_at) VALUES
      (100,'Acme Owner','acme@example.invalid','555-0100',14,1,4,NULL,NULL,NOW()),
      (101,'Acme Contractor','acon@example.invalid','555-0101',12,1,2,7,100,NOW()),
      (200,'Beta Owner','beta@example.invalid','555-0200',14,1,4,NULL,NULL,NOW()),
      (201,'Beta Contractor','bcon@example.invalid','555-0201',12,1,2,7,200,NOW())`);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/invitation', require('../routes/invitations'));
    // A catch-all so an unmatched path resolves to 404 rather than hanging.
    app.use((req, res) => res.status(404).json({ message: 'Not found' }));

    const tok = (id) => 'Bearer ' + jwt.sign(
      { id, role: 14, category: 4, email: 'u' + id + '@example.invalid' }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });

    for (const path of ['/api/invitation/getuserbycategory/2', '/api/invitation/getuserbysubcategory/7']) {
      const r = await request(app).get(path).set('Authorization', tok(100));
      note(`${path} -> HTTP ${r.status}`);
      ok(r.status === 404, `${path} is GONE (404)`, 'got ' + r.status);
      // Belt and braces: even if some future catch-all answered 200, no
      // personal detail may appear in the body.
      const blob = JSON.stringify(r.body || {});
      ok(!/@example\.invalid/.test(blob) && !/555-0\d{3}/.test(blob),
        'and no email or phone number appears in the response',
        blob.slice(0, 140));
    }

    // The source itself must not carry a route definition for either path.
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'routes', 'invitations.js'), 'utf8');
    ok(!/router\.get\(\s*["']\/getuserbycategory/.test(src),
      'no route definition for getuserbycategory remains in invitations.js');
    ok(!/router\.get\(\s*["']\/getuserbysubcategory/.test(src),
      'no route definition for getuserbysubcategory remains in invitations.js');

    // The scoped versions in contacts.js are the ones to use, and they survive.
    const contactsSrc = fs.readFileSync(require('path').join(__dirname, '..', 'routes', 'contacts.js'), 'utf8');
    ok(/router\.get\(\s*["']\/getuserbycategory/.test(contactsSrc),
      'the SCOPED version in contacts.js still exists — deletion removed the duplicate, not the feature');
    ok(/visibleUserPredicate/.test(contactsSrc),
      'and it is still scoped through visibleUserPredicate');

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
