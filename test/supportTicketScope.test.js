/* Support tickets must be scoped to the calling account. Previously GET returned
 * every ticket in the DB to any caller. Real MySQL + supertest.
 * Run: NODE_PATH=<backend>/node_modules node test/supportTicketScope.test.js
 */
'use strict';
process.env.ACCESS_TOKEN = 'test_secret';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_support_scope', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    const jwt = require('jsonwebtoken');
    const request = require('supertest');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE support_ticket (
      id INT PRIMARY KEY AUTO_INCREMENT, client_email VARCHAR(90), client_contact VARCHAR(90),
      subject VARCHAR(190), status_id INT DEFAULT 1, message TEXT, attachment VARCHAR(190),
      created_at DATETIME, created_by INT)`);
    // 4 tickets belong to the owner (74); the new sub (382) has NONE.
    for (let i = 0; i < 4; i++) await conn.query(
      "INSERT INTO support_ticket (client_email, subject, message, created_at, created_by) VALUES ('poul@oakcoast.net','glitch','m', NOW(), 74)");
    // A third user (500) has 1 of their own.
    await conn.query("INSERT INTO support_ticket (client_email, subject, message, created_at, created_by) VALUES ('other@x.co','mine','m', NOW(), 500)");

    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/support_ticket', require('../routes/support_ticket'));

    const asUser = (id) => request(app).get('/support_ticket/ticket')
      .set('Authorization', 'Bearer ' + jwt.sign({ id, role: 3, category: 2 }, process.env.ACCESS_TOKEN));

    const sub = await asUser(382);
    ok(sub.status === 200 && Array.isArray(sub.body) && sub.body.length === 0,
      'SUB (uid 382) sees ZERO tickets (created none)', `status=${sub.status} body=${JSON.stringify(sub.body)}`);

    const owner = await asUser(74);
    ok(owner.status === 200 && owner.body.length === 4 && owner.body.every(t => t.created_by === 74),
      'OWNER (uid 74) sees their OWN 4 tickets, nothing else', `len=${owner.body.length}`);

    const other = await asUser(500);
    ok(other.status === 200 && other.body.length === 1 && other.body[0].created_by === 500,
      'THIRD user (uid 500) sees only their own 1 ticket', `len=${other.body.length}`);

    const noTok = await request(app).get('/support_ticket/ticket');
    ok(noTok.status === 401 || noTok.status === 403, 'Unauthenticated request is rejected (no ticket leak)', `status=${noTok.status}`);
  } catch (e) {
    ok(false, 'harness error', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e));
  } finally {
    rec.forEach((l) => console.log(l));
    console.log(`\n${pass} passed, ${fail} failed`);
    try { if (conn) conn.release(); } catch (_) {}
    try { if (pool && pool.end) await pool.end(); } catch (_) {}
    try { if (db && db.stop) await db.stop(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
