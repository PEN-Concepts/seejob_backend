/* Per-job Invoices — functional integration test (real local MySQL via
 * mysql-memory-server + supertest against the REAL routes/invoices.js router,
 * with auth / plan / cross-account / mail stubbed). Verifies P1 backend:
 *   - migration builds the document schema (columns + items table);
 *   - per-job numbering (job# + seq → 01001, 01002 …);
 *   - full-document GET returns live company (from) + client (bill-to) blocks;
 *   - save recomputes subtotal/tax/total server-side + replaces line items;
 *   - share-link mints a public token/url;
 *   - send → Draft→Sent + sent_at (email stubbed, PDF optional);
 *   - public view flips Sent→Viewed + stamps viewed_at (once), never past Paid;
 *   - mark-paid → Paid+paid_at; mark-unpaid → reverts to Viewed/Sent/Draft;
 *   - tracking PATCH edits status + timestamps.
 * Run: node test/invoices.functional.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  → ' + (x || '')}`); };

(async () => {
  let db, pool, conn, server;
  try {
    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_invoices_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    // ---- stub auth / plan / cross-account / owner-resolve / mail BEFORE requiring the router ----
    const authn = require('../services/authentication');
    authn.authenticateToken = (req, res, next) => { req.user = { id: 1 }; res.locals.id = 1; next(); };
    const access = require('../utils/access');
    access.requirePlan = () => (req, res, next) => next();
    access.blockExpiredOwnRecord = () => (req, res, next) => next();
    access.isSameAccount = async () => true;
    access.resolveOwnerId = async (id) => Number(id); // owner = job creator in this test
    const mailer = require('../services/mailer');
    let lastMail = null;
    mailer.sendMail = async (opts) => { lastMail = opts; return { messageId: 'stub' }; };

    // ---- schema (representative subset) ----
    await conn.query(`CREATE TABLE \`user\` (id INT PRIMARY KEY, name VARCHAR(150), business VARCHAR(190) NULL, organization_name VARCHAR(190) NULL, street VARCHAR(190) NULL, city VARCHAR(120) NULL, state VARCHAR(60) NULL, zipcode VARCHAR(20) NULL, mobile VARCHAR(40) NULL, email VARCHAR(190) NULL, website_link VARCHAR(190) NULL, created_by INT NULL, category INT NULL)`);
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(190), created_by INT NULL, client_id INT NULL, job_number INT NULL, additional_client_name VARCHAR(190) NULL, additional_client_email VARCHAR(190) NULL, additional_client_mobile VARCHAR(40) NULL, address VARCHAR(190) NULL, city VARCHAR(120) NULL, state VARCHAR(60) NULL, created_at DATETIME NULL)`);
    // 1 = account owner/company; 2 = the job's client (bill-to)
    await conn.query(`INSERT INTO \`user\` (id,name,business,street,city,state,zipcode,mobile,email,website_link,created_by,category) VALUES
      (1,'Owner Olsen','Oak Coast Construction','100 Main St','Santa Rosa','CA','95401','707-555-0100','billing@oakcoast.net','oakcoast.net',NULL,14),
      (2,'Client Chris',NULL,'22 Elm Ave','Petaluma','CA','94952','707-555-0222',NULL,'client@example.com',NULL,3)`);
    // client email lives on user 2? put it on email col:
    await conn.query(`UPDATE \`user\` SET email='client@example.com' WHERE id=2`);
    await conn.query(`INSERT INTO job (id,name,created_by,client_id,job_number,created_at) VALUES (10,'145 Office/Shop',1,2,1,NOW())`);

    const request = require('supertest');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/invoices', require('../routes/invoices'));
    server = app.listen(0);
    const api = request(server);

    // ---- 1. migration via first list call ----
    let r = await api.get('/invoices/10');
    ok(r.status === 200 && r.body.job_number === 1, 'GET list works + job_number=1 (migration ran)', JSON.stringify(r.body).slice(0, 120));
    const [[col]] = await conn.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='job_invoices' AND COLUMN_NAME='public_token'`);
    ok(!!col, 'migration added invoice document columns (public_token present)');
    const [[itbl]] = await conn.query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='job_invoice_items'`);
    ok(!!itbl, 'migration created job_invoice_items table');

    // ---- 2. create → per-job numbering ----
    r = await api.post('/invoices/10').send({});
    ok(r.status === 201 && r.body.display_number === '01001', 'invoice #1 → display 01001', r.body.display_number);
    const invId = r.body.id;

    // ---- 3. full document GET: company + bill-to blocks ----
    r = await api.get(`/invoices/10/${invId}`);
    ok(r.status === 200 && r.body.company && r.body.company.name === 'Oak Coast Construction', 'company (from) block auto-filled from owner profile', r.body.company && r.body.company.name);
    ok(r.body.company.address.includes('100 Main St') && r.body.company.address.includes('95401'), 'company address assembled', r.body.company.address);
    ok(r.body.bill_to && r.body.bill_to.client_name === 'Client Chris' && r.body.bill_to.client_email === 'client@example.com', 'bill-to block from job client', JSON.stringify(r.body.bill_to));
    ok(r.body.invoice.status === 'Draft' && r.body.invoice.display_number === '01001', 'new invoice is Draft');

    // ---- 4. save: server recomputes totals + stores items ----
    r = await api.put(`/invoices/10/${invId}`).send({
      tax_rate: 10,
      due_date: '2026-09-15',
      notes: 'Net 30.',
      payment_instructions: 'ACH: routing 000, acct 111',
      items: [
        { description: 'Framing labor', qty: 2, rate: 50 },
        { description: 'Materials', qty: 1, rate: 25 },
      ],
    });
    ok(r.status === 200 && r.body.subtotal === 125 && r.body.tax_amount === 12.5 && r.body.total === 137.5, 'save recomputed subtotal=125 tax=12.5 total=137.5', JSON.stringify(r.body));
    const [items] = await conn.query('SELECT * FROM job_invoice_items WHERE invoice_id=? ORDER BY sort', [invId]);
    ok(items.length === 2 && Number(items[0].amount) === 100 && Number(items[1].amount) === 25, 'line items stored with computed amounts', JSON.stringify(items.map(i => i.amount)));

    // re-save with fewer items → replaced, totals update
    r = await api.put(`/invoices/10/${invId}`).send({ tax_rate: 0, items: [{ description: 'Flat fee', qty: 1, rate: 200 }] });
    ok(r.body.total === 200, 're-save replaces items + recomputes (total=200, tax 0)', String(r.body.total));
    // restore the richer invoice for the rest of the flow
    await api.put(`/invoices/10/${invId}`).send({ tax_rate: 10, items: [{ description: 'Framing labor', qty: 2, rate: 50 }, { description: 'Materials', qty: 1, rate: 25 }] });

    // ---- 5. share-link ----
    r = await api.post(`/invoices/10/${invId}/share-link`).send({});
    ok(r.status === 200 && r.body.token && r.body.url.includes('/invoice-preview/'), 'share-link mints token + url', r.body.url);
    const token = r.body.token;

    // ---- 6. send → Draft→Sent + sent_at (email stubbed) ----
    r = await api.post(`/invoices/10/${invId}/send`).send();
    ok(r.status === 200 && r.body.sent_to === 'client@example.com', 'send emailed the job client', JSON.stringify(r.body));
    ok(lastMail && /Invoice #01001/.test(lastMail.subject) && lastMail.html.includes(token), 'email has invoice # + view link', lastMail && lastMail.subject);
    let [[inv]] = await conn.query('SELECT status, sent_at, viewed_at, paid_at FROM job_invoices WHERE id=?', [invId]);
    ok(inv.status === 'Sent' && inv.sent_at, 'status → Sent + sent_at stamped', JSON.stringify(inv));

    // ---- 7. public view flips Sent→Viewed (once) ----
    r = await api.get(`/invoices/public/${token}`);
    ok(r.status === 200 && r.body.invoice.total === 137.5, 'public view returns the document', JSON.stringify(r.body.invoice).slice(0, 100));
    ok(r.body.invoice.status === 'Viewed', 'public view flipped status → Viewed');
    [[inv]] = await conn.query('SELECT status, viewed_at, sent_at FROM job_invoices WHERE id=?', [invId]);
    ok(inv.status === 'Viewed' && inv.viewed_at, 'viewed_at stamped in DB');
    const firstViewed = inv.viewed_at;
    // second open does not re-stamp / downgrade
    await new Promise((res) => setTimeout(res, 1100));
    await api.get(`/invoices/public/${token}`);
    [[inv]] = await conn.query('SELECT viewed_at FROM job_invoices WHERE id=?', [invId]);
    ok(String(inv.viewed_at) === String(firstViewed), 'second open keeps original viewed_at (no re-stamp)', `${firstViewed} vs ${inv.viewed_at}`);

    // ---- 8. mark-paid / never downgraded by a later view / mark-unpaid ----
    r = await api.post(`/invoices/10/${invId}/mark-paid`).send();
    ok(r.status === 200 && r.body.status === 'Paid', 'mark-paid → Paid');
    [[inv]] = await conn.query('SELECT status, paid_at FROM job_invoices WHERE id=?', [invId]);
    ok(inv.status === 'Paid' && inv.paid_at, 'paid_at stamped');
    r = await api.get(`/invoices/public/${token}`);
    ok(r.body.invoice.status === 'Paid', 'a view after Paid does NOT downgrade to Viewed');
    r = await api.post(`/invoices/10/${invId}/mark-unpaid`).send();
    ok(r.status === 200 && r.body.status === 'Viewed', 'mark-unpaid reverts to Viewed (viewed_at present)', r.body.status);
    [[inv]] = await conn.query('SELECT status, paid_at FROM job_invoices WHERE id=?', [invId]);
    ok(inv.status === 'Viewed' && inv.paid_at === null, 'paid_at cleared on unpaid');

    // ---- 9. tracking PATCH edits status + timestamp ----
    r = await api.patch(`/invoices/10/${invId}/tracking`).send({ status: 'Paid', sent_at: '2026-08-01 09:00:00' });
    ok(r.status === 200, 'tracking PATCH ok');
    [[inv]] = await conn.query('SELECT status, sent_at, paid_at FROM job_invoices WHERE id=?', [invId]);
    ok(inv.status === 'Paid' && String(inv.sent_at).startsWith('2026-08-01') && inv.paid_at, 'tracking edit applied status + sent_at + auto paid_at', JSON.stringify(inv));

    // ---- 10. second invoice → seq 2 → 01002; list carries status/tracking ----
    r = await api.post('/invoices/10').send({});
    ok(r.body.display_number === '01002', 'invoice #2 → 01002 (per-job sequence)', r.body.display_number);
    r = await api.get('/invoices/10');
    ok(r.body.invoices.length === 2, 'list returns both invoices');
    const first = r.body.invoices.find((x) => x.display_number === '01001');
    ok(first && first.status === 'Paid' && first.total === 137.5 && first.has_link === true, 'list row carries status/total/link flag', JSON.stringify(first));

  } catch (e) {
    fail++; rec.push('  ✗ EXCEPTION: ' + (e && e.stack || e));
  } finally {
    try { if (server) server.close(); } catch {}
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db && db.stop) await db.stop(); } catch {}
  }

  console.log('\n==== Per-job Invoices functional test ====');
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
