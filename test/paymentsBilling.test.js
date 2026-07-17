/* Verifies the Authorize.Net webhook sync fix + admin Plan & Payment Status API.
 *
 *   A) Source assertions (no DB): WEBHOOK_SIGNATURE_KEY is declared; webhook no
 *      longer returns 200 on a processing failure.
 *   B) Integration (real local MySQL via mysql-memory-server + supertest):
 *      - webhook REJECTS a missing/invalid signature (401) and does NOT mutate;
 *      - webhook ACCEPTS a correctly HMAC-SHA512-signed body and updates
 *        subscriptions.status (cancelled -> canceled, created -> active);
 *      - admin gate: id 246 OK, owner-exempt email OK, everyone else 403;
 *      - overview endpoint computes access_mode (paid/trial_active/expired_free),
 *        owner-exempt, employee-inherited, plan+price correctly;
 *      - live-status endpoint degrades gracefully when Authorize.Net isn't
 *        configured (checked:false) instead of failing the page.
 * Run: node test/paymentsBilling.test.js   (exit 0 = pass, 1 = fail)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

// ---- A) Source assertions ----
const paySrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payments.js'), 'utf8');
ok(/const\s+WEBHOOK_SIGNATURE_KEY\s*=/.test(paySrc), 'source: WEBHOOK_SIGNATURE_KEY is now declared');
ok(/AUTHORIZE_SIGNATURE_KEY/.test(paySrc), 'source: reads AUTHORIZE_SIGNATURE_KEY from env');
ok(/return res\.status\(500\)\.send\("Processing failed"\)/.test(paySrc), 'source: webhook returns 500 (not 200) on a DB failure');
ok(/timingSafeEqual/.test(paySrc), 'source: signature comparison is timing-safe');

// ---- B) Integration ----
(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    process.env.AUTHORIZE_SIGNATURE_KEY = 'test_sig_key';
    // Deliberately DO NOT set AUTHORIZE_API_LOGIN_ID / TRANSACTION_KEY so the live
    // ARB branch reports "not configured" instead of calling out.
    delete process.env.AUTHORIZE_API_LOGIN_ID;
    delete process.env.AUTHORIZE_TRANSACTION_KEY;
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_billing_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE role (id INT PRIMARY KEY, name VARCHAR(80))`);
    await conn.query(`CREATE TABLE \`user\` (
      id INT PRIMARY KEY, name VARCHAR(150), email VARCHAR(190),
      role INT, category INT, created_by INT NULL, created_at DATETIME NULL
    ) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE plans (
      id INT PRIMARY KEY, name VARCHAR(80), amount DECIMAL(10,2), \`interval\` VARCHAR(20),
      is_active TINYINT DEFAULT 1, description VARCHAR(255) NULL, level INT NULL
    ) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE subscriptions (
      id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT, amount DECIMAL(10,2),
      billing_interval VARCHAR(20), status VARCHAR(30), next_billing_at DATETIME NULL,
      authorize_subscription_id VARCHAR(60) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

    await conn.query(`CREATE TABLE user_payment_methods (
      id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, customer_profile_id VARCHAR(60),
      payment_profile_id VARCHAR(60), card_brand VARCHAR(40), card_last4 VARCHAR(8),
      is_default TINYINT DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE plan_features (
      id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT, feature_key VARCHAR(80)
    ) ENGINE=InnoDB`);
    await conn.query(`INSERT INTO plan_features (plan_id, feature_key) VALUES (4,'job'),(4,'task')`);
    await conn.query(`INSERT INTO role VALUES (14,'General Contractor'),(12,'Subcontractor')`);
    await conn.query(`INSERT INTO plans (id,name,amount,\`interval\`,is_active,level) VALUES
      (1,'Basic',29.00,'monthly',1,1),
      (4,'Gold',99.00,'monthly',1,4),
      (5,'Platinum',250.00,'monthly',1,5),
      (6,'Bid Pro',19.00,'monthly',1,NULL),
      (7,'Legacy Off',10.00,'monthly',0,NULL)`);

    // Users: 100 owner-exempt (no sub), 101 trial (new), 102 expired (old, no sub),
    // 103 paying Gold, 104 employee of 103, 105 for webhook cancel test.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (100,'Owner Exempt','admin@oakcoast.net',14,2,NULL, NOW() - INTERVAL 400 DAY),
      (101,'Trial User','trial@x.com',14,2,NULL, NOW() - INTERVAL 5 DAY),
      (102,'Expired User','expired@x.com',14,2,NULL, NOW() - INTERVAL 90 DAY),
      (103,'Paying GC','paying@x.com',14,2,NULL, NOW() - INTERVAL 200 DAY),
      (104,'Employee','emp@x.com',5,1,103, NOW() - INTERVAL 3 DAY),
      (105,'Webhook GC','webhook@x.com',14,2,NULL, NOW() - INTERVAL 10 DAY),
      (107,'NoRemote GC','noremote@x.com',14,2,NULL, NOW() - INTERVAL 10 DAY),
      (246,'gc gc','gcgc@x.com',14,2,NULL, NOW() - INTERVAL 10 DAY)`);

    await conn.query(`INSERT INTO subscriptions (user_id,plan_id,amount,billing_interval,status,next_billing_at,authorize_subscription_id) VALUES
      (103,4,99.00,'monthly','active', NOW() + INTERVAL 20 DAY, 'ARBGOLD'),
      (105,4,99.00,'monthly','active', NOW() + INTERVAL 20 DAY, 'ARB123')`);
    // A local-only active sub with no ARB id (tests the live-check no-remote branch).
    await conn.query(`INSERT INTO subscriptions (user_id,plan_id,amount,billing_interval,status,authorize_subscription_id) VALUES
      (107,4,99.00,'monthly','active', NULL)`);

    // Migration: adds needs_reverification (table above intentionally omits it).
    const { ensureSubscriptionReverifyColumn } = require('../services/dbMigrations');
    await ensureSubscriptionReverifyColumn(conn);
    const [revCols] = await conn.query("SHOW COLUMNS FROM subscriptions LIKE 'needs_reverification'");
    ok(revCols.length === 1, 'migration: subscriptions.needs_reverification column added', String(revCols.length));
    const [dueCols] = await conn.query("SHOW COLUMNS FROM subscriptions LIKE 'reverification_due_at'");
    ok(dueCols.length === 1, 'migration: subscriptions.reverification_due_at column added', String(dueCols.length));
    const { ensureReverifyEmailLogTable } = require('../services/dbMigrations');
    await ensureReverifyEmailLogTable(conn);
    const [logTbl] = await conn.query("SHOW TABLES LIKE 'reverification_email_log'");
    ok(logTbl.length === 1, 'migration: reverification_email_log table created', String(logTbl.length));

    const express = require('express');
    request = require('supertest');
    jwt = require('jsonwebtoken');
    const payments = require('../routes/payments');
    app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf && buf.length ? buf.toString('utf8') : ''; } }));
    app.use('/api/payments', payments);

    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);

    // --- Webhook: invalid signature is rejected, no mutation ---
    const cancelBody = JSON.stringify({ eventType: 'net.authorize.customer.subscription.cancelled', payload: { id: 'ARB123' } });
    const badRes = await request(app).post('/api/payments/webhook')
      .set('Content-Type', 'application/json').set('X-ANET-Signature', 'sha512=deadbeef').send(cancelBody);
    ok(badRes.status === 401, 'webhook: invalid signature -> 401', String(badRes.status));
    const [afterBad] = await conn.query("SELECT status FROM subscriptions WHERE authorize_subscription_id='ARB123'");
    ok(afterBad[0] && afterBad[0].status === 'active', 'webhook: invalid signature did NOT mutate the record', afterBad[0] && afterBad[0].status);

    // --- Webhook: missing signature is rejected ---
    const missRes = await request(app).post('/api/payments/webhook')
      .set('Content-Type', 'application/json').send(cancelBody);
    ok(missRes.status === 401, 'webhook: missing signature -> 401', String(missRes.status));

    // --- Webhook: valid signature applies the cancellation ---
    const sign = (body) => 'sha512=' + crypto.createHmac('sha512', 'test_sig_key').update(body, 'utf8').digest('hex').toUpperCase();
    const goodRes = await request(app).post('/api/payments/webhook')
      .set('Content-Type', 'application/json').set('X-ANET-Signature', sign(cancelBody)).send(cancelBody);
    ok(goodRes.status === 200, 'webhook: valid signature -> 200', String(goodRes.status));
    const [afterGood] = await conn.query("SELECT status FROM subscriptions WHERE authorize_subscription_id='ARB123'");
    ok(afterGood[0] && afterGood[0].status === 'canceled', 'webhook: cancelled event set local status -> canceled', afterGood[0] && afterGood[0].status);

    // --- Webhook: created/renewed re-activates ---
    const createBody = JSON.stringify({ eventType: 'net.authorize.customer.subscription.created', payload: { id: 'ARB123' } });
    await request(app).post('/api/payments/webhook')
      .set('Content-Type', 'application/json').set('X-ANET-Signature', sign(createBody)).send(createBody);
    const [afterCreate] = await conn.query("SELECT status FROM subscriptions WHERE authorize_subscription_id='ARB123'");
    ok(afterCreate[0] && afterCreate[0].status === 'active', 'webhook: created event set local status -> active', afterCreate[0] && afterCreate[0].status);

    // --- Admin gate ---
    const r246 = await request(app).get('/api/payments/admin/subscriptions-overview').set('Authorization', tok(246));
    ok(r246.status === 200, 'gate: super-admin id 246 allowed (200)', String(r246.status));
    const rOwner = await request(app).get('/api/payments/admin/subscriptions-overview').set('Authorization', tok(100));
    ok(rOwner.status === 200, 'gate: owner-exempt email allowed (200)', String(rOwner.status));
    const rReg = await request(app).get('/api/payments/admin/subscriptions-overview').set('Authorization', tok(101));
    ok(rReg.status === 403, 'gate: regular user forbidden (403)', String(rReg.status));
    const rAnon = await request(app).get('/api/payments/admin/subscriptions-overview');
    ok(rAnon.status === 401, 'gate: no token -> 401', String(rAnon.status));

    // --- Overview correctness ---
    const users = (r246.body && r246.body.users) || [];
    const byId = new Map(users.map((u) => [u.id, u]));
    ok(byId.get(100) && byId.get(100).access_mode === 'paid' && byId.get(100).owner_exempt === true, 'overview: owner-exempt -> paid + flagged', JSON.stringify(byId.get(100)));
    ok(byId.get(101) && byId.get(101).access_mode === 'trial_active', 'overview: new user -> trial_active', byId.get(101) && byId.get(101).access_mode);
    ok(byId.get(102) && byId.get(102).access_mode === 'expired_free', 'overview: old no-sub user -> expired_free', byId.get(102) && byId.get(102).access_mode);
    const p = byId.get(103);
    ok(p && p.access_mode === 'paid' && p.plan && p.plan.name === 'Gold' && Number(p.plan.amount) === 99, 'overview: paying user -> paid + Gold @ 99', JSON.stringify(p && p.plan));
    const e = byId.get(104);
    ok(e && e.is_employee === true && e.inherits_from && e.inherits_from.id === 103 && e.access_mode === 'paid', 'overview: employee inherits owner (paid)', JSON.stringify(e && e.inherits_from));

    // --- Live-status graceful degradation (Authorize.Net not configured) ---
    const [goldSub] = await conn.query("SELECT id FROM subscriptions WHERE authorize_subscription_id='ARBGOLD'");
    const liveRes = await request(app).get(`/api/payments/admin/subscription-live/${goldSub[0].id}`).set('Authorization', tok(246));
    ok(liveRes.status === 200 && liveRes.body.checked === false && liveRes.body.reason === 'authnet_not_configured', 'live: degrades to checked:false when Authorize.Net not configured', JSON.stringify(liveRes.body));
    const [noRemote] = await conn.query("SELECT id FROM subscriptions WHERE user_id=107 AND authorize_subscription_id IS NULL");
    const liveNoRemote = await request(app).get(`/api/payments/admin/subscription-live/${noRemote[0].id}`).set('Authorization', tok(246));
    ok(liveNoRemote.body && liveNoRemote.body.reason === 'no_authorize_subscription_id', 'live: sub with no ARB id -> no_authorize_subscription_id', JSON.stringify(liveNoRemote.body));

    // --- accept-config: sandbox env returns the sandbox script + fallback keys ---
    const cfg = await request(app).get('/api/payments/accept-config').set('Authorization', tok(103));
    ok(cfg.status === 200 && /jstest\.authorize\.net/.test(cfg.body.acceptUiUrl) && cfg.body.env === 'sandbox', 'accept-config: sandbox url + env', JSON.stringify(cfg.body));
    ok(cfg.body.apiLoginId && cfg.body.clientKey && cfg.body.configured === true, 'accept-config: sandbox fallback keys present + configured', JSON.stringify({ a: !!cfg.body.apiLoginId, c: !!cfg.body.clientKey }));

    // --- GET /payments/plans (public catalog: active-only, Platinum excluded, price asc) ---
    const plansRes = await request(app).get('/api/payments/plans').set('Authorization', tok(103));
    const plans = (plansRes.body && plansRes.body.plans) || [];
    const names = plans.map((p) => p.name);
    ok(plansRes.status === 200 && Array.isArray(plans), 'plans: endpoint returns a list', String(plansRes.status));
    ok(!names.includes('Platinum'), 'plans: Platinum excluded from public catalog', JSON.stringify(names));
    ok(!names.includes('Legacy Off'), 'plans: inactive plan (is_active=0) excluded', JSON.stringify(names));
    ok(names.includes('Bid Pro') && names.includes('Basic') && names.includes('Gold'), 'plans: active public plans present (Bid Pro/Basic/Gold)', JSON.stringify(names));
    const p0 = plans[0] || {};
    ok(p0.id != null && p0.name && p0.amount != null && p0.interval && p0.is_active != null, 'plans: rows include id/name/amount/interval/is_active', JSON.stringify(p0));
    const amts = plans.map((p) => Number(p.amount));
    ok(amts.every((a, i) => i === 0 || a >= amts[i - 1]), 'plans: ordered by amount ascending', JSON.stringify(amts));

    // --- go-live reverify endpoint flags all active subs (canceled + flagged) ---
    const [activeBefore] = await conn.query("SELECT COUNT(*) AS c FROM subscriptions WHERE status='active'");
    // Dry-run first: previews the count WITHOUT flagging anything.
    const dryRev = await request(app).post('/api/payments/admin/reverify-sandbox-subscriptions').set('Authorization', tok(246)).send({ dryRun: true });
    ok(dryRev.status === 200 && dryRev.body.dryRun === true && dryRev.body.active_count === Number(activeBefore[0].c), 'reverify dryRun: previews active count', JSON.stringify(dryRev.body));
    const [afterDry] = await conn.query("SELECT COUNT(*) AS c FROM subscriptions WHERE status='active'");
    ok(Number(afterDry[0].c) === Number(activeBefore[0].c), 'reverify dryRun: does NOT mutate (subs still active)', `${activeBefore[0].c} -> ${afterDry[0].c}`);
    const rev = await request(app).post('/api/payments/admin/reverify-sandbox-subscriptions').set('Authorization', tok(246));
    ok(rev.status === 200 && rev.body.flagged === Number(activeBefore[0].c), 'reverify: flagged == active-before count', JSON.stringify(rev.body));
    const [stillActive] = await conn.query("SELECT COUNT(*) AS c FROM subscriptions WHERE status='active'");
    ok(Number(stillActive[0].c) === 0, 'reverify: no active subs remain', String(stillActive[0].c));
    const [flaggedGold] = await conn.query("SELECT status, needs_reverification, reverification_due_at FROM subscriptions WHERE authorize_subscription_id='ARBGOLD'");
    ok(flaggedGold[0] && flaggedGold[0].status === 'canceled' && Number(flaggedGold[0].needs_reverification) === 1, 'reverify: Gold sub -> canceled + needs_reverification=1', JSON.stringify(flaggedGold[0]));
    ok(flaggedGold[0] && flaggedGold[0].reverification_due_at && new Date(flaggedGold[0].reverification_due_at) > new Date(), 'reverify: sets a future grace deadline', String(flaggedGold[0] && flaggedGold[0].reverification_due_at));

    // --- grace window: flagged >60-day user keeps full access until the deadline ---
    const access = require('../utils/access');
    const giGrace = await access.getAccessInfo(103, conn);
    ok(giGrace.mode === 'paid' && !!giGrace.reverifyGraceUntil, 'grace: flagged >60d user reads as paid during the grace window', JSON.stringify({ mode: giGrace.mode, until: giGrace.reverifyGraceUntil }));
    await conn.query("UPDATE subscriptions SET reverification_due_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE user_id = 103 AND needs_reverification = 1");
    const giExpired = await access.getAccessInfo(103, conn);
    ok(giExpired.mode === 'expired_free', 'grace: after the deadline, flagged >60d user falls back to expired_free', JSON.stringify({ mode: giExpired.mode }));
    // restore a future deadline for the billing/status assertion below
    await conn.query("UPDATE subscriptions SET reverification_due_at = DATE_ADD(NOW(), INTERVAL 14 DAY) WHERE user_id = 103 AND needs_reverification = 1");

    // --- billing/status surfaces needs_reverification for a flagged non-owner ---
    const bs103 = await request(app).get('/api/payments/billing/status').set('Authorization', tok(103));
    ok(bs103.body && bs103.body.needs_reverification === true, 'billing/status: flagged user (103) -> needs_reverification true', JSON.stringify({ nr: bs103.body && bs103.body.needs_reverification, has: bs103.body && bs103.body.hasActiveSubscription }));
    ok(bs103.body && !!bs103.body.reverification_due_at, 'billing/status: returns the grace deadline for the banner', String(bs103.body && bs103.body.reverification_due_at));
    // Owner-exempt (100): flag it, but they must NOT be prompted.
    await conn.query("UPDATE subscriptions SET user_id=100, needs_reverification=1, status='canceled' WHERE authorize_subscription_id='ARBGOLD'");
    const bs100 = await request(app).get('/api/payments/billing/status').set('Authorization', tok(100));
    ok(bs100.body && bs100.body.needs_reverification === false, 'billing/status: owner-exempt never prompted for re-verification', JSON.stringify(bs100.body && bs100.body.needs_reverification));

    // --- employee banner suppression: employee resolves to a flagged owner ---
    // Give owner 103 a fresh flagged sub; employee 104 (role 5, created_by 103) resolves to 103.
    await conn.query("INSERT INTO subscriptions (user_id,plan_id,amount,billing_interval,status,needs_reverification,reverification_due_at) VALUES (103,4,99.00,'monthly','canceled',1, DATE_ADD(NOW(), INTERVAL 14 DAY))");
    const bsOwner = await request(app).get('/api/payments/billing/status').set('Authorization', tok(103));
    ok(bsOwner.body && bsOwner.body.needs_reverification === true, 'suppression: account OWNER (103) still sees the banner', JSON.stringify(bsOwner.body && bsOwner.body.needs_reverification));
    const bsEmp = await request(app).get('/api/payments/billing/status').set('Authorization', tok(104));
    ok(bsEmp.body && bsEmp.body.needs_reverification === false, 'suppression: EMPLOYEE (104) does NOT see the banner', JSON.stringify(bsEmp.body && bsEmp.body.needs_reverification));

    // --- owner-triggered email send ---
    // Seed a clean flagged owner (valid email) + a flagged owner with NO email.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (200,'Owner Two','owner200@x.com',14,2,NULL, NOW() - INTERVAL 100 DAY),
      (201,'No Email Owner','',14,2,NULL, NOW() - INTERVAL 100 DAY)`);
    await conn.query(`INSERT INTO subscriptions (user_id,plan_id,amount,billing_interval,status,needs_reverification,reverification_due_at) VALUES
      (200,4,99.00,'monthly','canceled',1, DATE_ADD(NOW(), INTERVAL 14 DAY)),
      (201,4,99.00,'monthly','canceled',1, DATE_ADD(NOW(), INTERVAL 14 DAY))`);

    // Dry run (Email B) — recipient list, no send.
    const dry = await request(app).post('/api/payments/admin/send-reverification-email').set('Authorization', tok(246)).send({ emailType: 'B', dryRun: true });
    const dryEmails = ((dry.body && dry.body.recipients) || []).map((r) => r.email);
    const skipReasons = ((dry.body && dry.body.skipped) || []).reduce((m, s) => { m[s.id] = s.reason; return m; }, {});
    ok(dry.status === 200 && dry.body.dryRun === true, 'send B (dryRun): returns a recipient list without sending', String(dry.status));
    ok(dryEmails.includes('owner200@x.com'), 'send B: flagged owner with a valid email is a recipient', JSON.stringify(dryEmails));
    ok(!dryEmails.includes('admin@oakcoast.net'), 'send B: owner-exempt excluded from recipients');
    ok(skipReasons[201] === 'no valid email on file', 'send B: flagged owner with no email is skipped (visible)', JSON.stringify(skipReasons));

    // Re-send safety: an owner who already re-subscribed (has an active sub) drops
    // out of the Email B audience even though their old flagged row persists.
    await conn.query(`INSERT INTO \`user\` (id,name,email,role,category,created_by,created_at) VALUES
      (202,'Acted Owner','acted@x.com',14,2,NULL, NOW() - INTERVAL 100 DAY)`);
    await conn.query(`INSERT INTO subscriptions (user_id,plan_id,amount,billing_interval,status,needs_reverification,reverification_due_at) VALUES
      (202,4,99.00,'monthly','canceled',1, DATE_ADD(NOW(), INTERVAL 14 DAY)),
      (202,4,99.00,'monthly','active',0, NULL)`);
    const dry2 = await request(app).post('/api/payments/admin/send-reverification-email').set('Authorization', tok(246)).send({ emailType: 'B', dryRun: true });
    const dry2Emails = ((dry2.body && dry2.body.recipients) || []).map((r) => r.email);
    ok(!dry2Emails.includes('acted@x.com'), 'send B: an owner who already re-subscribed is NOT re-emailed', JSON.stringify(dry2Emails));

    // Email A requires a migration date to actually send.
    const aNoDate = await request(app).post('/api/payments/admin/send-reverification-email').set('Authorization', tok(246)).send({ emailType: 'A' });
    ok(aNoDate.status === 400, 'send A: requires migrationDate to send', String(aNoDate.status));

    // Real send (Email B) — no SMTP configured in test, so sends fail-soft, but the
    // send path runs and every recipient is LOGGED (AC8).
    const realB = await request(app).post('/api/payments/admin/send-reverification-email').set('Authorization', tok(246)).send({ emailType: 'B' });
    ok(realB.status === 200 && typeof realB.body.total === 'number', 'send B (real): returns a summary', JSON.stringify({ s: realB.status, total: realB.body && realB.body.total }));
    const [logRows] = await conn.query("SELECT COUNT(*) AS c FROM reverification_email_log WHERE email_type='B'");
    ok(Number(logRows[0].c) === Number(realB.body.total), 'send B: one audit-log row per recipient (recipient+type+timestamp)', `log=${logRows[0].c} total=${realB.body.total}`);

    // Non-admin cannot trigger a send.
    const forbid = await request(app).post('/api/payments/admin/send-reverification-email').set('Authorization', tok(101)).send({ emailType: 'B', dryRun: true });
    ok(forbid.status === 403, 'send: non-admin is forbidden (403)', String(forbid.status));

    // --- send history log endpoint ---
    // Dry-run must NOT write to the log (preview only).
    const [logBefore] = await conn.query("SELECT COUNT(*) AS c FROM reverification_email_log");
    await request(app).post('/api/payments/admin/send-reverification-email').set('Authorization', tok(246)).send({ emailType: 'B', dryRun: true });
    const [logAfter] = await conn.query("SELECT COUNT(*) AS c FROM reverification_email_log");
    ok(Number(logBefore[0].c) === Number(logAfter[0].c), 'history: a dry-run does NOT write a log row', `${logBefore[0].c} -> ${logAfter[0].c}`);

    const hist = await request(app).get('/api/payments/admin/reverification-email-log').set('Authorization', tok(246));
    ok(hist.status === 200 && Array.isArray(hist.body.entries) && hist.body.entries.length >= 1, 'history: endpoint returns log entries', JSON.stringify({ s: hist.status, n: hist.body && hist.body.entries && hist.body.entries.length }));
    ok(hist.body.entries[0].recipient_email && hist.body.entries[0].email_type && hist.body.entries[0].status, 'history: entries include recipient + type + status', JSON.stringify(hist.body.entries[0]));
    ok(hist.body.summary && typeof hist.body.summary === 'object', 'history: includes a status summary', JSON.stringify(hist.body.summary));
    const histForbid = await request(app).get('/api/payments/admin/reverification-email-log').set('Authorization', tok(101));
    ok(histForbid.status === 403, 'history: non-admin forbidden (403)', String(histForbid.status));
  } catch (err) {
    ok(false, 'integration threw', String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
