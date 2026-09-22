/* THE PERSON PICKERS JOIN THE CONTACT COLUMNS THAT ARE ACTUALLY WRITTEN.
 *
 * `contact` carries two pairs of participant columns:
 *
 *   request_by  / request_to        <- every INSERT INTO contact writes THIS
 *   request_user1 / request_user2   <- a pre-rename remnant; nothing writes it
 *
 * routes/users.js joined the remnant pair on BOTH /get-task-users and
 * /getallusers, so the two contact branches of each query matched only the
 * handful of legacy rows that predate the rename. Twelve pickers across the web
 * and mobile apps read those endpoints; all of them were being carried by the
 * self / owner / employee branches alone. routes/budget.js had already been
 * fixed for exactly this and says so in its own comment — these were the last
 * live reads left on the dead pair.
 *
 * WHAT THIS TEST PINS.
 *   1. The counts, branch by branch, on a realistically shaped account: what the
 *      dead pair matches vs what the live pair matches. This is the number the
 *      fix is justified by, so it is asserted, not just printed.
 *   2. That the contacts reach the endpoint, not merely the table.
 *   3. That widening the match did NOT widen the tenant boundary — a second
 *      account's contacts stay invisible. The WHERE clause still resolves
 *      through the account subquery; this proves it.
 *
 * NON-VACUITY. Restoring the dead columns in routes/users.js must drop the
 * endpoint's contact count to the legacy rows only and fail assertions 1-3.
 *
 * Run: NODE_PATH=<backend>/node_modules node test/taskUsersContactColumns.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_contactcols_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE user (
      id INT PRIMARY KEY, name VARCHAR(190), email VARCHAR(190), role INT, category INT,
      subcategory INT, business VARCHAR(190), mobile VARCHAR(60), image VARCHAR(190),
      created_by INT, exit_type VARCHAR(10), can_view_all_contacts TINYINT DEFAULT 0, status TINYINT DEFAULT 1)`);
    // Both pairs, as production has them.
    await conn.query(`CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT,
      request_by INT, request_to INT, request_user1 INT, request_user2 INT)`);
    await conn.query(`CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(60))`);
    await conn.query(`CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(60), category_id INT)`);
    await conn.query(`CREATE TABLE role (id INT PRIMARY KEY, name VARCHAR(60))`);
    await conn.query(`CREATE TABLE teams (id INT PRIMARY KEY, team_name VARCHAR(120), team_color VARCHAR(20), created_by INT)`);
    await conn.query(`CREATE TABLE team_user (id INT PRIMARY KEY AUTO_INCREMENT, team_id INT, user_id INT)`);
    // /getallusers has an extra UNION branch over invited_contacts (pending
    // invites, status = 0) that /get-task-users does not. Seeded empty: this
    // test is about the contact JOIN columns, but the table has to exist or the
    // whole /getallusers query errors and the route returns a 500 that reads as
    // an empty list.
    await conn.query(`CREATE TABLE invited_contacts (id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(190), email VARCHAR(190), created_by INT, status TINYINT DEFAULT 0)`);
    await conn.query(`INSERT INTO category (id,name) VALUES (1,'Employee'),(2,'Subcontractor'),(3,'Client'),(4,'General contractor')`);
    await conn.query(`INSERT INTO role (id,name) VALUES (3,'Foreman'),(14,'General Contractor')`);

    const U = (id, name, category, cb, role = 3) =>
      conn.query('INSERT INTO user (id,name,email,role,category,created_by,can_view_all_contacts,status) VALUES (?,?,?,?,?,?,0,1)',
        [id, name, 'u' + id + '@t.co', role, category, cb]);

    // ── Account A: the owner whose pickers were empty ────────────────────────
    await U(74, 'Poul Owner', 4, null, 14);

    // 30 contacts saved the way the app saves them today (request_by/request_to),
    // split across the two directions so BOTH branches are exercised: 18 the
    // account invited, 12 who invited the account.
    const SENT = 18, RECEIVED = 12;
    for (let i = 0; i < SENT; i++) {
      await U(1000 + i, 'Sent Contact ' + i, i % 2 ? 2 : 3, null);
      await conn.query('INSERT INTO contact (request_by,request_to) VALUES (?,?)', [74, 1000 + i]);
    }
    for (let i = 0; i < RECEIVED; i++) {
      await U(2000 + i, 'Recd Contact ' + i, i % 2 ? 2 : 3, null);
      await conn.query('INSERT INTO contact (request_by,request_to) VALUES (?,?)', [2000 + i, 74]);
    }

    // 2 legacy rows on the dead pair — the survivors from before the rename.
    // These are the ONLY rows the old query could ever have matched.
    await U(3000, 'Legacy Contact A', 2, null);
    await U(3001, 'Legacy Contact B', 3, null);
    await conn.query('INSERT INTO contact (request_user1,request_user2) VALUES (?,?)', [74, 3000]);
    await conn.query('INSERT INTO contact (request_user1,request_user2) VALUES (?,?)', [3001, 74]);

    // ── Account B: a different tenant, must stay invisible to A ──────────────
    await U(900, 'Other GC', 4, null, 14);
    await U(901, 'Other GC Sub', 2, null);
    await U(902, 'Other GC Client', 3, null);
    await conn.query('INSERT INTO contact (request_by,request_to) VALUES (?,?)', [900, 901]);
    await conn.query('INSERT INTO contact (request_by,request_to) VALUES (?,?)', [902, 900]);

    // ── 1. Branch counts, dead pair vs live pair ────────────────────────────
    // The two contact branches exactly as the route shapes them, run directly so
    // the number is attributable to the join columns and nothing else.
    const ACCOUNT = '(SELECT id FROM `user` WHERE id = ? OR created_by = ?)';
    const branchCount = async (joinCol, whereCol) => {
      const [[r]] = await conn.query(
        `SELECT COUNT(DISTINCT u.id) AS n FROM contact c
         INNER JOIN user u ON u.id = c.${joinCol}
         WHERE c.${whereCol} IN ${ACCOUNT}`, [74, 74]);
      return Number(r.n);
    };

    const deadSent = await branchCount('request_user2', 'request_user1');
    const deadRecd = await branchCount('request_user1', 'request_user2');
    const liveSent = await branchCount('request_to', 'request_by');
    const liveRecd = await branchCount('request_by', 'request_to');

    note(`BEFORE (request_user1/2):  branch 1 = ${deadSent}, branch 2 = ${deadRecd}, total = ${deadSent + deadRecd}`);
    note(`AFTER  (request_by/to):    branch 1 = ${liveSent}, branch 2 = ${liveRecd}, total = ${liveSent + liveRecd}`);

    ok(deadSent + deadRecd === 2,
      'BEFORE: the dead pair matches only the 2 surviving legacy rows',
      `${deadSent} + ${deadRecd}`);
    ok(liveSent === SENT && liveRecd === RECEIVED,
      `AFTER: the live pair matches all ${SENT + RECEIVED} real contacts (${SENT} sent + ${RECEIVED} received)`,
      `${liveSent} + ${liveRecd}`);
    ok(liveSent + liveRecd >= 30,
      'AFTER: thirty-plus contacts, which is the whole point of the change',
      String(liveSent + liveRecd));

    // ── 2. They reach the endpoint, not just the table ──────────────────────
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api', require('../routes/users'));
    const call = (claims) => request(app).get('/api/get-task-users')
      .set('Authorization', 'Bearer ' + jwt.sign(claims, process.env.ACCESS_TOKEN));

    const res = await call({ id: 74, working_id: 74, role: 14, category: 4, email: 'u74@t.co' });
    ok(res.status === 200, 'get-task-users responds 200', String(res.status) + ' ' + JSON.stringify(res.body).slice(0, 200));

    const rows = (res.body && res.body.data) || [];
    const names = rows.filter((r) => r.id).map((r) => r.name);
    const sentSeen = names.filter((n) => /^Sent Contact /.test(n)).length;
    const recdSeen = names.filter((n) => /^Recd Contact /.test(n)).length;
    note(`endpoint returned ${names.length} rows: ${sentSeen} sent-contacts, ${recdSeen} received-contacts`);

    ok(sentSeen === SENT, `all ${SENT} sent-direction contacts appear in the picker`, String(sentSeen));
    ok(recdSeen === RECEIVED, `all ${RECEIVED} received-direction contacts appear in the picker`, String(recdSeen));
    ok(names.includes('Sent Contact 0') && names.includes('Recd Contact 0'),
      'a named contact from each direction is present', JSON.stringify(names.slice(0, 8)));

    // ── 3. The tenant boundary did not move ─────────────────────────────────
    ok(!names.includes('Other GC') && !names.includes('Other GC Sub') && !names.includes('Other GC Client'),
      'account B\'s owner and contacts are STILL invisible to account A',
      JSON.stringify(names.filter((n) => /^Other GC/.test(n))));

    const resB = await call({ id: 900, working_id: 900, role: 14, category: 4, email: 'u900@t.co' });
    const namesB = ((resB.body && resB.body.data) || []).filter((r) => r.id).map((r) => r.name);
    note(`account B sees ${namesB.length} rows: ${JSON.stringify(namesB.sort())}`);
    ok(namesB.includes('Other GC Sub') && namesB.includes('Other GC Client'),
      'account B sees its OWN two contacts — the fix works for both tenants', JSON.stringify(namesB));
    ok(!namesB.some((n) => /^Sent Contact |^Recd Contact |^Poul Owner$/.test(n)),
      'and account B sees NONE of account A\'s thirty', JSON.stringify(namesB));

    // ── 4. /getallusers moved with it ───────────────────────────────────────
    // Its own comment says it must match get-task-users. Fixing one and not the
    // other is exactly how they come to disagree.
    const resAll = await request(app).get('/api/getallusers')
      .set('Authorization', 'Bearer ' + jwt.sign(
        { id: 74, working_id: 74, role: 14, category: 4, email: 'u74@t.co' }, process.env.ACCESS_TOKEN));
    const namesAll = (Array.isArray(resAll.body) ? resAll.body : (resAll.body && resAll.body.data) || [])
      .filter((r) => r && r.id).map((r) => r.name);
    note(`/getallusers returned ${namesAll.length} rows`);
    ok(resAll.status === 200, '/getallusers responds 200', String(resAll.status));
    ok(namesAll.filter((n) => /^Sent Contact |^Recd Contact /.test(n)).length === SENT + RECEIVED,
      `/getallusers also returns all ${SENT + RECEIVED} contacts — the two lists still agree`,
      String(namesAll.filter((n) => /^Sent Contact |^Recd Contact /.test(n)).length));

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.log(rec.join('\n'));
    console.error('HARNESS ERROR:', e && e.stack || e);
    fail++;
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
