/* "View all company contacts" AUTHORITY must actually widen the CONTACTS PAGE.
 *
 * The Contacts page is fed by GET /accepted-contacts. It scoped by
 * res.locals.working_id — which authenticateToken never sets — so it always fell
 * back to req.user.id and IGNORED the can_view_all_contacts authority. A Level-5
 * employee with the authority ON still saw only their own contacts (e.g. 22 of 37
 * subs, no GC, no leads). The fix routes it through getContactScope, the same
 * flag-aware, account-bounded resolver the Assign-To picker already uses.
 *
 * This proves: OWNER sees the whole book; a flagged employee's count EQUALS the
 * owner's; an unflagged employee sees only their own; and neither ever crosses the
 * account boundary.
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x === undefined ? '' : x)}`); };

(async () => {
  let db, pool, conn;
  const OWNER = 100, EMP = 200;
  try {
    process.env.ACCESS_TOKEN = 'test_secret'; delete process.env.NODE_ENV; process.env.API_URL = '/api';
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_contacts_authority', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1'; process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root'; process.env.DB_PASSWORD_DEV = ''; process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection'); conn = await pool.getConnection();
    const request = require('supertest'); const jwt = require('jsonwebtoken');

    // Base user columns; ensureCslbColumns adds license_/cslb_/spouse_/*_name at call time.
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), image VARCHAR(190) NULL, mobile VARCHAR(40) NULL, business VARCHAR(120) NULL, organization_name VARCHAR(120) NULL, can_view_all_contacts TINYINT DEFAULT 0, role INT NULL, category INT NULL, subcategory INT NULL, created_by INT NULL, created_at DATETIME NULL, status INT DEFAULT 1)");
    await conn.query("CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(80), category_id INT NULL)");
    await conn.query("CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(80))");
    await conn.query("CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT, request_to INT, status VARCHAR(20) NULL, updated_at DATETIME NULL)");
    await conn.query("INSERT INTO category VALUES (1,'Employee'),(2,'Contractor')");
    await conn.query("INSERT INTO subcategory VALUES (5,'Foreman',1)");
    // Company A: owner 100, employee 200 (created_by 100), two contacts.
    await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by,can_view_all_contacts) VALUES (100,'Owner','o@x.com',14,2,NULL,NULL,0)");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by,can_view_all_contacts) VALUES (200,'Joshua','j@x.com',5,1,5,100,0)");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by) VALUES (300,'A Sub Owner-added','as1@x.com',12,2,NULL,100),(301,'A Sub Emp-added','as2@x.com',12,2,NULL,100)");
    // Contacts: 300 linked to the OWNER, 301 linked to the EMPLOYEE.
    await conn.query("INSERT INTO contact (request_by,request_to,status,updated_at) VALUES (100,300,'Accept',NOW()),(200,301,'Accept',NOW())");
    // Company B: owner 400 + its contact 600 — must NEVER appear for A.
    await conn.query("INSERT INTO `user` (id,name,email,role,category,subcategory,created_by) VALUES (400,'B Owner','bo@x.com',14,2,NULL,NULL),(600,'B Sub','bs@x.com',12,2,NULL,400)");
    await conn.query("INSERT INTO contact (request_by,request_to,status,updated_at) VALUES (400,600,'Accept',NOW())");

    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/user', require('../routes/invitations'));
    const tok = (id, workingId, email) => 'Bearer ' + jwt.sign({ id, working_id: workingId, email, tv: 0 }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
    const accepted = (id, workingId, email) => request(app).get('/api/user/accepted-contacts').set('Authorization', tok(id, workingId, email));
    const idset = (res) => new Set((Array.isArray(res.body) ? res.body : []).map((u) => Number(u.id)));
    const setFlag = (v) => conn.query("UPDATE `user` SET can_view_all_contacts = ? WHERE id = ?", [v, EMP]);

    // Owner sees the whole company book.
    const ownerSet = idset(await accepted(OWNER, OWNER, 'o@x.com'));
    ok(ownerSet.has(300) && ownerSet.has(301), 'owner sees both company-A contacts', [...ownerSet].join());
    ok(!ownerSet.has(600), 'owner never sees company B\'s contact', [...ownerSet].join());

    // Employee, authority OFF → only their own linked contact (301), not the owner's 300.
    await setFlag(0);
    const offSet = idset(await accepted(EMP, OWNER, 'j@x.com'));
    ok(offSet.has(301) && !offSet.has(300), 'authority OFF: employee sees only their own contact', [...offSet].join());

    // Employee, authority ON → the WHOLE company book, same size as the owner's.
    await setFlag(1);
    const onSet = idset(await accepted(EMP, OWNER, 'j@x.com'));
    ok(onSet.has(300) && onSet.has(301), 'authority ON: employee now sees the whole company book (incl. owner-added 300)', [...onSet].join());
    ok(onSet.size === ownerSet.size, `authority ON: employee count (${onSet.size}) equals owner count (${ownerSet.size})`, `on=${onSet.size} owner=${ownerSet.size}`);
    ok(offSet.size < onSet.size, `authority OFF is a strict subset of ON (${offSet.size} < ${onSet.size})`, `off=${offSet.size} on=${onSet.size}`);
    ok(!onSet.has(600), 'authority ON never crosses the account boundary — B\'s contact (600) hidden', [...onSet].join());
    console.log(`\n[COUNTS] owner=${ownerSet.size}  employee-ON=${onSet.size}  employee-OFF=${offSet.size}`);

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    conn.release(); if (pool.end) await pool.end(); if (db.stop) await db.stop();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log(rec.join('\n')); console.error('HARNESS ERROR:', e && e.stack || e.message);
    try { if (conn) conn.release(); if (pool && pool.end) await pool.end(); if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(1);
  }
})();
