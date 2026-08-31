/* Signed-document email — functional test (real local MySQL via mysql-memory-server).
 * Verifies services/signedDocPdf.sendSignedCopy: on signing, a real PDF is built and
 * emailed to the CLIENT with a CC to the SENDER, for both change orders and quotes.
 * mailer is stubbed to capture the outgoing message. Run: node test/signedDocEmail.functional.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  → ' + (x || '')}`); };

(async () => {
  let db, pool, conn;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_signeddoc_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;
    pool = require('../config/connection');
    conn = await pool.getConnection();

    // capture outgoing mail
    const mailer = require('../services/mailer');
    const sent = [];
    mailer.sendMail = async (opts) => { sent.push(opts); return { messageId: 'stub' }; };

    await conn.query('CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(150), email VARCHAR(190))');
    await conn.query("INSERT INTO `user` (id,name,email) VALUES (1,'Owner Olsen','owner@oakcoast.net')");
    await conn.query('CREATE TABLE change_order_items (id INT PRIMARY KEY AUTO_INCREMENT, change_order_id INT, sort_order INT, description TEXT, qty DECIMAL(10,2), unit_price DECIMAL(12,2), line_total_price DECIMAL(12,2))');
    await conn.query('CREATE TABLE quote_items (id INT PRIMARY KEY AUTO_INCREMENT, quote_id INT, sort_order INT, description TEXT, qty DECIMAL(10,2), unit_price DECIMAL(12,2), line_total_price DECIMAL(12,2))');
    await conn.query("INSERT INTO change_order_items (change_order_id,sort_order,description,qty,unit_price,line_total_price) VALUES (77,0,'Extra framing',2,100,200),(77,1,'Materials',1,50,50)");
    await conn.query("INSERT INTO quote_items (quote_id,sort_order,description,qty,unit_price,line_total_price) VALUES (88,0,'Design',1,500,500)");

    const { sendSignedCopy, buildSignedPdf } = require('../services/signedDocPdf');

    // ---- Change order: signed → emails client + cc sender, with a PDF ----
    const coRow = {
      id: 77, company_name: 'Oak Coast', company_address: '100 Main St', created_by_user_id: 1,
      client_name: 'Chris Client', client_email: 'chris@example.com', change_order_number: 5,
      change_order_date: '2026-08-31', grand_total_amount: 250, status: 'SIGNED',
      client_signed_name: 'Chris Client', client_signed_at: '2026-08-31 10:00:00', client_signature_data: '',
    };
    await sendSignedCopy(coRow, 'change_order');
    ok(sent.length === 1, 'change order: exactly one email sent', String(sent.length));
    const m = sent[0] || {};
    ok(m.to === 'chris@example.com', 'sent TO the client', m.to);
    ok(m.cc === 'owner@oakcoast.net', 'CC to the sender/creator', m.cc);
    ok(/Signed Change Order #5/.test(m.subject || ''), 'subject names the signed change order', m.subject);
    ok(Array.isArray(m.attachments) && m.attachments.length === 1, 'one attachment');
    const att = (m.attachments || [])[0] || {};
    ok(att.contentType === 'application/pdf' && Buffer.isBuffer(att.content) && att.content.slice(0, 5).toString() === '%PDF-', 'attachment is a real PDF', att.contentType);
    ok(/change-order-5-signed\.pdf/.test(att.filename || ''), 'PDF filename', att.filename);

    // ---- Quote variant ----
    sent.length = 0;
    const qRow = {
      id: 88, company_name: 'Oak Coast', created_by_user_id: 1, client_name: 'Chris Client',
      client_email: 'chris@example.com', quote_number: 12, quote_date: '2026-08-31',
      grand_total_amount: 500, status: 'SIGNED', client_signed_name: 'Chris Client', client_signed_at: '2026-08-31 11:00:00', client_signature_data: '',
    };
    await sendSignedCopy(qRow, 'quote');
    ok(sent.length === 1 && sent[0].to === 'chris@example.com' && sent[0].cc === 'owner@oakcoast.net', 'quote: emailed client + cc sender');
    ok(/Signed Quote #12/.test(sent[0].subject || ''), 'quote subject', sent[0].subject);

    // ---- No client email → falls back to sender only (no crash) ----
    sent.length = 0;
    await sendSignedCopy({ ...coRow, client_email: null }, 'change_order');
    ok(sent.length === 1 && sent[0].to === 'owner@oakcoast.net' && !sent[0].cc, 'no client email → sends to sender, no cc');

    // ---- PDF embeds a client signature image without throwing ----
    const onePxPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const buf = await buildSignedPdf({ ...coRow, client_signature_data: onePxPng }, [], 'change_order');
    ok(Buffer.isBuffer(buf) && buf.length > 800 && buf.slice(0, 5).toString() === '%PDF-', 'PDF builds with an embedded signature image');

  } catch (e) {
    fail++; rec.push('  ✗ EXCEPTION: ' + (e && e.stack || e));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }
  console.log('\n==== Signed-document email functional test ====');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
