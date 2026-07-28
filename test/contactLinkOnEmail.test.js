/* "Link, don't duplicate" — update-contact-info on an email that already belongs
 * to another user must NOT error (and must NOT create a duplicate email, so
 * email+OTP login stays unambiguous). Instead it links this account to that
 * existing person, fills in their blanks additively, and drops the old
 * placeholder link. Real MySQL (mysql-memory-server) + supertest.
 * Run: NODE_PATH=<backend>/node_modules node test/contactLinkOnEmail.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_link_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    // Minimal schema with the SAME email UNIQUE constraint prod has (the
    // constraint the fix must NOT violate). All columns the update path writes
    // are declared up front so ensureCslbColumns is a no-op.
    await conn.query(`CREATE TABLE user (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(190) NULL, email VARCHAR(190) NULL UNIQUE, password VARCHAR(190) NULL,
      role INT NULL, mobile VARCHAR(60) NULL, category INT NULL, subcategory INT NULL,
      business VARCHAR(190) NULL, organization_name VARCHAR(190) NULL, trade VARCHAR(190) NULL,
      first_name VARCHAR(150) NULL, last_name VARCHAR(150) NULL,
      license_number VARCHAR(100) NULL, license_state VARCHAR(30) NULL, address TEXT NULL,
      cslb_status VARCHAR(50) NULL, cslb_checked_at DATETIME NULL, cslb_classification VARCHAR(255) NULL,
      cslb_address VARCHAR(255) NULL, cslb_phone VARCHAR(50) NULL,
      spouse_name VARCHAR(150) NULL, spouse_last_name VARCHAR(150) NULL,
      spouse_email VARCHAR(150) NULL, spouse_phone VARCHAR(50) NULL,
      otp VARCHAR(60) NULL, otp_status INT NULL, created_at DATETIME NULL,
      created_by INT NULL, must_change_password TINYINT DEFAULT 0, status TINYINT DEFAULT 1)`);
    await conn.query(`CREATE TABLE contact (
      id INT PRIMARY KEY AUTO_INCREMENT, request_by INT NULL, request_to INT NULL,
      status VARCHAR(20) NULL, created_at DATETIME NULL, updated_at DATETIME NULL)`);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api', require('../routes/invitations'));
    const OWNER = 700;
    const tok = 'Bearer ' + jwt.sign({ id: OWNER, role: 1 }, process.env.ACCESS_TOKEN);
    const edit = (body) => request(app).post('/api/update-contact-info').set('Authorization', tok).send(body);

    // Seed: the owner row (needed so the ACCOUNT subquery resolves), owner's
    // placeholder "company" contact P (license email), plus a separate existing
    // "person" U who already holds the real email (no link to the owner yet).
    await conn.query(`INSERT INTO user (id, name, email, category, created_by, status)
                      VALUES (700,'Owner','owner@x.com',1,NULL,1)`);
    await conn.query(`INSERT INTO user (id, name, email, business, license_number, address, category, subcategory, created_by, status)
                      VALUES (354,'ING BUILDERS','lic-1080613@no-email.invalid','ING BUILDERS','1080613','389 VINELAND DR',2,12,700,1)`);
    await conn.query(`INSERT INTO user (id, name, email, business, category, subcategory, status)
                      VALUES (286,'Ivan Lopez','ivanngeovanni@gmail.com',NULL,2,12,1)`);
    await conn.query(`INSERT INTO contact (request_by, request_to, status, created_at, updated_at)
                      VALUES (700,354,'Saved',NOW(),NOW())`); // owner <-> placeholder

    // ── Scenario A — edit ING BUILDERS (354) to Ivan's existing email ──
    const a = await edit({ contact_user_id: 354, name: 'ING BUILDERS', first_name: null, last_name: null,
      email: 'ivanngeovanni@gmail.com', business_name: 'ING BUILDERS', license_number: '1080613',
      license_state: 'CA', address: '389 VINELAND DR', mobile: '(805) 406-1409' });
    ok(a.status === 200, 'A: request succeeds (200, no error)', a.status + ' ' + JSON.stringify(a.body));
    ok(a.body.merged === true, 'A: response says merged (not a dead-end error)', JSON.stringify(a.body));
    ok(Number(a.body.linked_user_id) === 286, 'A: linked to the existing person (286)', JSON.stringify(a.body));

    const [[ivan]] = await conn.query('SELECT name, email, business, license_number, address FROM user WHERE id = 286');
    ok(ivan.email === 'ivanngeovanni@gmail.com', 'A: existing person keeps their (unique) email', JSON.stringify(ivan));
    ok(ivan.name === 'Ivan Lopez', 'A: existing person NAME not overwritten (additive only)', JSON.stringify(ivan));
    ok(ivan.business === 'ING BUILDERS', 'A: company name filled onto the blank field', JSON.stringify(ivan));
    ok(ivan.license_number === '1080613', 'A: license filled onto the blank field', JSON.stringify(ivan));

    const [[edgeToIvan]] = await conn.query('SELECT id FROM contact WHERE request_by=700 AND request_to=286 LIMIT 1');
    ok(!!edgeToIvan, 'A: owner is now linked to the existing person', JSON.stringify(edgeToIvan));
    const [oldEdges] = await conn.query('SELECT id FROM contact WHERE (request_by=700 AND request_to=354) OR (request_by=354 AND request_to=700)');
    ok(oldEdges.length === 0, 'A: the old placeholder link was removed (no duplicate in the list)', JSON.stringify(oldEdges));

    // ── Email uniqueness is preserved (login-by-email stays unambiguous) ──
    const [dupes] = await conn.query("SELECT email, COUNT(*) c FROM user WHERE email IS NOT NULL AND email <> '' GROUP BY email HAVING c > 1");
    ok(dupes.length === 0, 'no two users share an email after the merge (OTP login safe)', JSON.stringify(dupes));

    // ── Scenario B — normal edit to a brand-new email is unchanged behaviour ──
    await conn.query(`INSERT INTO user (id, name, email, category, subcategory, status) VALUES (355,'P&C PLASTERING','lic-897944@no-email.invalid',2,12,1)`);
    await conn.query(`INSERT INTO contact (request_by, request_to, status, created_at, updated_at) VALUES (700,355,'Saved',NOW(),NOW())`);
    const b = await edit({ contact_user_id: 355, name: 'P&C PLASTERING', email: 'pcplastering@example.com', business_name: 'P&C PLASTERING' });
    ok(b.status === 200 && !b.body.merged, 'B: editing to a NEW unused email is a normal update (not a merge)', JSON.stringify(b.body));
    const [[pc]] = await conn.query('SELECT email FROM user WHERE id = 355');
    ok(pc.email === 'pcplastering@example.com', 'B: the new email was saved onto the row', JSON.stringify(pc));

    // ── Scenario C — same email as self (no-op collision) still updates fine ──
    const c = await edit({ contact_user_id: 355, name: 'P&C PLASTERING', email: 'pcplastering@example.com', address: '1 Main St' });
    ok(c.status === 200 && !c.body.merged, 'C: re-saving a row with its OWN email is not treated as a conflict', JSON.stringify(c.body));

    console.log('\nLINK-ON-EMAIL CONTACT SAVE\n' + rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('HARNESS ERROR:', e && e.stack || e);
    fail++;
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
    process.exit(fail ? 1 : 0);
  }
})();
