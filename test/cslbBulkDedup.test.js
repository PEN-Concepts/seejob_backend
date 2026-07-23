/* CSLB Quick Setup — bulk-create-from-licenses duplicate detection.
 *
 * Incident: adding a genuinely-new license (#1148867 AV DIRTWORKS LLC) was
 * reported "SKIPPED — ALREADY A CONTACT: SOCOM UNDERGROUND #1104010" because
 * the two share an office phone. Two bugs keyed dedup on phone, not license:
 *   1) the dedup SELECT matched on `OR mobile = ?`, and
 *   2) the INSERT wrote the shared phone into user.mobile (UNIQUE), so the 2nd
 *      license hit ER_DUP_ENTRY -> also reported "Already a contact".
 * Fix: dedup only on license_number / license-derived email; mobile left NULL
 * (phone kept in cslb_phone). Two different licenses at the same address/phone
 * must BOTH be created; the same license twice IS a duplicate.
 *
 * Real MySQL (mysql-memory-server) + supertest against routes/invitations.js.
 * Run: NODE_PATH=<backend>/node_modules node test/cslbBulkDedup.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_cslb_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    // Stub the external CSLB lookup BEFORE the route destructures it at load.
    const cslb = require('../services/cslbChecker');
    const DIR = { name: 'AV DIRTWORKS LLC', address: '500 Yard Rd, Fresno, CA', phone: '5591112222', status: 'Active', classification: 'A' };
    const SOC = { name: 'SOCOM UNDERGROUND', address: '500 Yard Rd, Fresno, CA', phone: '5591112222', status: 'Active', classification: 'A' };
    const LOOKUP = { '1148867': DIR, '1104010': SOC };
    cslb.checkLicense = async (num) => LOOKUP[num] || { status: 'Not Found' };

    pool = require('../config/connection');
    jwt = require('jsonwebtoken');
    request = require('supertest');
    conn = await pool.getConnection();

    // Minimal `user` schema with the SAME uniqueness the incident hinged on:
    // email UNIQUE + mobile UNIQUE. ensureCslbColumns() adds the cslb_*/license_*
    // columns at first request.
    await conn.query(`CREATE TABLE user (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(190) NULL, email VARCHAR(190) NULL UNIQUE, password VARCHAR(190) NULL,
      role INT NULL, mobile VARCHAR(60) NULL UNIQUE, category INT NULL, subcategory INT NULL,
      business VARCHAR(190) NULL, trade VARCHAR(190) NULL, otp VARCHAR(60) NULL, otp_status INT NULL,
      created_at DATETIME NULL, employment_type VARCHAR(60) NULL, rate INT NULL,
      social_security VARCHAR(60) NULL, created_by INT NULL, must_change_password TINYINT DEFAULT 0,
      status TINYINT DEFAULT 1)`);
    await conn.query(`CREATE TABLE contact (
      id INT PRIMARY KEY AUTO_INCREMENT, request_by INT NULL, request_to INT NULL,
      status VARCHAR(20) NULL, created_at DATETIME NULL, updated_at DATETIME NULL)`);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api', require('../routes/invitations'));
    const OWNER = 700;
    const tok = 'Bearer ' + jwt.sign({ id: OWNER, role: 1 }, process.env.ACCESS_TOKEN);
    const bulk = (nums) => request(app).post('/api/bulk-create-from-licenses')
      .set('Authorization', tok).send({ license_numbers: nums });

    // ── Scenario A — THE INCIDENT: an existing contact already holds the shared
    //    office phone in the UNIQUE `mobile` column; adding a NEW license with
    //    that same phone must be CREATED, not skipped. ──
    await conn.query(
      `INSERT INTO user (name, email, role, mobile, created_by, status)
       VALUES ('SOCOM UNDERGROUND (existing)', 'socom@example.com', 12, '5591112222', ?, 1)`,
      [OWNER]
    );
    const a = await bulk(['1148867']);
    ok(a.status === 200, 'incident: request succeeds (200)', a.status + ' ' + JSON.stringify(a.body));
    ok(a.body.created && a.body.created.length === 1, 'incident: NEW license sharing an existing contact’s phone is CREATED (not skipped)', JSON.stringify(a.body));
    ok((a.body.skipped || []).length === 0, 'incident: nothing wrongly reported "Already a contact"', JSON.stringify(a.body.skipped));
    const [[dir]] = await conn.query("SELECT license_number, mobile, cslb_phone FROM user WHERE license_number = '1148867'");
    ok(dir && dir.mobile === null, 'incident: created contact’s mobile is NULL (avoids UNIQUE collision)', JSON.stringify(dir));
    ok(dir && dir.cslb_phone === '5591112222', 'incident: phone is preserved in cslb_phone', JSON.stringify(dir));

    // ── Scenario B — two DIFFERENT licenses at the SAME address+phone (both new
    //    in one batch) are BOTH created, neither flagged as a duplicate. ──
    await conn.query('DELETE FROM contact'); await conn.query('DELETE FROM user');
    const b = await bulk(['1148867', '1104010']);
    ok(b.body.created && b.body.created.length === 2, 'two-different-licenses same address/phone: BOTH created', JSON.stringify(b.body));
    ok((b.body.skipped || []).length === 0, 'two-different-licenses: neither flagged duplicate', JSON.stringify(b.body.skipped));
    const [rows] = await conn.query("SELECT license_number FROM user WHERE license_number IN ('1148867','1104010') ORDER BY license_number");
    ok(rows.length === 2, 'two-different-licenses: two distinct rows persisted', JSON.stringify(rows));

    // ── Scenario C — the SAME license number added again IS a duplicate. ──
    const c = await bulk(['1148867']);
    ok((c.body.created || []).length === 0, 'same-license-again: not created a second time', JSON.stringify(c.body));
    ok(c.body.skipped && c.body.skipped.length === 1 && c.body.skipped[0].reason === 'Already a contact',
       'same-license-again: correctly flagged "Already a contact"', JSON.stringify(c.body.skipped));
    const [[dup]] = await conn.query("SELECT COUNT(*) AS n FROM user WHERE license_number = '1148867'");
    ok(Number(dup.n) === 1, 'same-license-again: still exactly ONE row for that license', JSON.stringify(dup));

  } catch (e) {
    fail++; rec.push('  ✗ harness error -> ' + (e && e.stack ? e.stack : e));
  } finally {
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
