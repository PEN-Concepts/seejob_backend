/* Plan & Payment Status v2 — exclude non-app-user artifacts, four-state status,
 * Total Received ledger. Real local MySQL via mysql-memory-server + supertest.
 *   - migrations add account_source / first_login_at / subscription payment cols /
 *     payment_receipts, and backfill account_source + first_login_at correctly;
 *   - overview EXCLUDES CSLB + placeholder-client artifacts (row + counts), but
 *     KEEPS + FLAGS an artifact that has a real subscription (never hide money);
 *   - four-state status: invited / trial / free / paying (+ past-due under paying);
 *   - total_received per customer + grand_total_received from the ledger;
 *   - the $175 seed lands; the webhook authcapture branch writes a ledger row.
 * Run: node test/billingOverviewV2.test.js   (exit 0 = pass, 1 = fail)
 */
'use strict';
const crypto = require('crypto');
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

(async () => {
  let db, pool, conn, app, request, jwt;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    process.env.AUTHORIZE_SIGNATURE_KEY = 'test_sig_key';
    delete process.env.AUTHORIZE_API_LOGIN_ID;
    delete process.env.AUTHORIZE_TRANSACTION_KEY;
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_billv2_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    // --- Minimal legacy schema (user table intentionally WITHOUT the new columns
    //     so the migrations add + backfill them). ---
    await conn.query(`CREATE TABLE role (id INT PRIMARY KEY, name VARCHAR(80))`);
    await conn.query(`CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(80))`);
    await conn.query(`CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(80))`);
    await conn.query(`CREATE TABLE \`user\` (
      id INT PRIMARY KEY, name VARCHAR(150), email VARCHAR(190), password VARCHAR(200) NULL,
      role INT, category INT, subcategory INT NULL, created_by INT NULL, created_at DATETIME NULL
    ) ENGINE=InnoDB`);
    await conn.query(`CREATE TABLE user_devices (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, device_token VARCHAR(80), user_agent VARCHAR(200))`);
    await conn.query(`CREATE TABLE job (id INT PRIMARY KEY AUTO_INCREMENT, created_by INT NULL)`);
    await conn.query(`CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(80), amount DECIMAL(10,2), \`interval\` VARCHAR(20), is_active TINYINT DEFAULT 1, level INT NULL)`);
    await conn.query(`CREATE TABLE subscriptions (
      id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT, amount DECIMAL(10,2),
      billing_interval VARCHAR(20), status VARCHAR(30), next_billing_at DATETIME NULL,
      authorize_subscription_id VARCHAR(60) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await conn.query(`INSERT INTO role VALUES (14,'General Contractor'),(12,'Subcontractor'),(3,'Foreman')`);
    await conn.query(`INSERT INTO category VALUES (1,'Employee'),(2,'Contractor'),(3,'Client')`);
    await conn.query(`INSERT INTO subcategory VALUES (11,'Client'),(12,'Subcontractor')`);
    await conn.query(`INSERT INTO plans (id,name,amount,\`interval\`,is_active,level) VALUES (4,'Gold',99.00,'monthly',1,4)`);

    // Users (BEFORE migrations, so the backfill classifies them):
    //  300 CSLB artifact (excluded)         301 placeholder client (excluded)
    //  302 real invited, never logged in    303 trial (logged in 5d ago)
    //  304 free (logged in 90d ago)         305 paying (active Gold)
    //  306 past-due (past_due Gold)          307 CSLB artifact WITH a sub (anomaly)
    //  308 seed-owner (ARB 73729730)
    await conn.query(`INSERT INTO \`user\` (id,name,email,password,role,category,subcategory,created_by,created_at) VALUES
      (300,'AV Dirtworks LLC','lic-1148867@no-email.invalid','',12,2,12,100, NOW() - INTERVAL 10 DAY),
      (301,'Placeholder Client','client-acme-1@no-email.invalid','',3,3,11,100, NOW() - INTERVAL 10 DAY),
      (302,'Invited Never','invited@x.com','',14,2,NULL,NULL, NOW() - INTERVAL 3 DAY),
      (303,'Trial User','trialu@x.com','$2a$hash',14,2,NULL,NULL, NOW() - INTERVAL 5 DAY),
      (304,'Free User','freeu@x.com','$2a$hash',14,2,NULL,NULL, NOW() - INTERVAL 90 DAY),
      (305,'Paying GC','payer@x.com','$2a$hash',14,2,NULL,NULL, NOW() - INTERVAL 200 DAY),
      (306,'PastDue GC','pastdue@x.com','$2a$hash',14,2,NULL,NULL, NOW() - INTERVAL 200 DAY),
      (307,'CSLB With Sub','lic-999@no-email.invalid','',12,2,12,100, NOW() - INTERVAL 10 DAY),
      (308,'Seed Owner','seedowner@x.com','$2a$hash',14,2,NULL,NULL, NOW() - INTERVAL 200 DAY),
      (310,'Emp Of Payer','emp-payer@x.com','$2a$hash',5,1,NULL,305, NOW() - INTERVAL 3 DAY),
      (311,'Emp Of Trial','emp-trial@x.com','$2a$hash',5,1,NULL,303, NOW() - INTERVAL 2 DAY)`);
    // Logins (user_devices row => has logged in). 301/302/307 never logged in.
    // 300 gets a STRAY device row (contaminated first_login) to prove an artifact is
    // STILL excluded by account_source regardless of a noisy login signal.
    await conn.query(`INSERT INTO user_devices (user_id,device_token,user_agent) VALUES
      (300,'t0','ua'),(303,'t1','ua'),(304,'t2','ua'),(305,'t3','ua'),(306,'t4','ua'),(308,'t5','ua'),(310,'t6','ua'),(311,'t7','ua')`);
    await conn.query(`INSERT INTO subscriptions (user_id,plan_id,amount,billing_interval,status,next_billing_at,authorize_subscription_id,created_at) VALUES
      (305,4,175.00,'monthly','active', NOW() + INTERVAL 20 DAY, 'ARBPAY', NOW() - INTERVAL 60 DAY),
      (306,4,99.00,'monthly','past_due', NOW() + INTERVAL 5 DAY, 'ARBPD', NOW() - INTERVAL 40 DAY),
      (307,4,99.00,'monthly','active', NOW() + INTERVAL 20 DAY, 'ARBANOM', NOW() - INTERVAL 5 DAY),
      (308,4,175.00,'monthly','active', NOW() + INTERVAL 20 DAY, '73729730', NOW() - INTERVAL 30 DAY)`);

    // --- Run the new migrations (adds + backfills) ---
    const mig = require('../services/dbMigrations');
    await mig.ensureSubscriptionReverifyColumn(conn); // prod already has this (earlier deploy)
    await mig.ensureUserAccountSourceColumn(conn);
    await mig.ensureUserFirstLoginColumn(conn);
    await mig.ensureSubscriptionPaymentColumns(conn);
    await mig.ensurePaymentReceiptsTable(conn);

    // Migration column/table assertions
    const has = async (tbl, col) => (await conn.query(`SHOW COLUMNS FROM \`${tbl}\` LIKE '${col}'`))[0].length === 1;
    ok(await has('user', 'account_source'), 'migration: user.account_source added');
    ok(await has('user', 'first_login_at'), 'migration: user.first_login_at added');
    ok(await has('subscriptions', 'paid_count'), 'migration: subscriptions.paid_count added');
    const [prTbl] = await conn.query("SHOW TABLES LIKE 'payment_receipts'");
    ok(prTbl.length === 1, 'migration: payment_receipts table created');

    // Backfill assertions
    const src = async (id) => (await conn.query('SELECT account_source FROM `user` WHERE id=?', [id]))[0][0].account_source;
    ok(await src(300) === 'cslb_lookup', 'backfill: lic-@no-email.invalid -> cslb_lookup', await src(300));
    ok(await src(301) === 'placeholder_client', 'backfill: client-@no-email.invalid -> placeholder_client', await src(301));
    ok(await src(303) === 'signup', 'backfill: has password -> signup', await src(303));
    ok(await src(302) === 'invite', 'backfill: real email, no password -> invite', await src(302));
    const fl = async (id) => (await conn.query('SELECT first_login_at FROM `user` WHERE id=?', [id]))[0][0].first_login_at;
    ok(!!(await fl(303)), 'backfill: logged-in user got first_login_at');
    ok(!(await fl(302)), 'backfill: never-logged-in user has NULL first_login_at');

    // Seed of the one historical $175 charge
    const [[seedRow]] = await conn.query("SELECT amount, user_id FROM payment_receipts WHERE transaction_id='121727692015'");
    ok(seedRow && Number(seedRow.amount) === 175 && seedRow.user_id === 308, 'seed: $175 charge (txn 121727692015) inserted for the ARB 73729730 owner', JSON.stringify(seedRow));

    // Extra ledger rows for 305 (2 payments = 198.00 total)
    await conn.query(`INSERT INTO payment_receipts (user_id,subscription_id,authorize_subscription_id,amount,transaction_id,source,settled_at)
      VALUES (305,1,'ARBPAY',175.00,'TX-A','webhook',NOW()), (305,1,'ARBPAY',175.00,'TX-B','webhook',NOW())`);

    // --- App ---
    const express = require('express');
    request = require('supertest');
    jwt = require('jsonwebtoken');
    const payments = require('../routes/payments');
    app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf && buf.length ? buf.toString('utf8') : ''; } }));
    app.use('/api/payments', payments);
    const tok = (id) => 'Bearer ' + jwt.sign({ id }, process.env.ACCESS_TOKEN);

    const r = await request(app).get('/api/payments/admin/subscriptions-overview').set('Authorization', tok(246));
    ok(r.status === 200, "overview: 200", JSON.stringify(r.body).slice(0,300));
    const users = (r.body && r.body.users) || [];
    const byId = new Map(users.map((u) => [u.id, u]));

    // Part 1: exclusion
    ok(!byId.has(300), 'EXCLUDE: CSLB artifact (300) excluded even WITH a stray login/first_login');
    ok(!byId.has(301), 'EXCLUDE: placeholder client (301) not in list');
    ok(byId.has(302) && byId.has(303) && byId.has(305), 'KEEP: real invited/trial/paying present');
    // Part 1.3: artifact WITH a subscription is kept + flagged (money never hidden)
    ok(byId.has(307), 'ANOMALY: CSLB artifact WITH a subscription is NOT excluded (307 present)');
    ok(byId.get(307) && byId.get(307).artifact_with_payment === true, 'ANOMALY: 307 flagged artifact_with_payment', JSON.stringify(byId.get(307) && byId.get(307).artifact_with_payment));

    // Part 3: four-state
    ok(byId.get(302) && byId.get(302).status4 === 'invited', 'STATUS: never-logged-in -> invited', byId.get(302) && byId.get(302).status4);
    ok(byId.get(303) && byId.get(303).status4 === 'trial', 'STATUS: logged in 5d ago -> trial', byId.get(303) && byId.get(303).status4);
    ok(byId.get(304) && byId.get(304).status4 === 'free', 'STATUS: logged in 90d ago -> free', byId.get(304) && byId.get(304).status4);
    ok(byId.get(305) && byId.get(305).status4 === 'paying', 'STATUS: active sub -> paying', byId.get(305) && byId.get(305).status4);
    ok(byId.get(306) && byId.get(306).status4 === 'paying' && byId.get(306).past_due === true, 'STATUS: past_due sub -> paying + past_due flag', JSON.stringify(byId.get(306) && [byId.get(306).status4, byId.get(306).past_due]));
    // Paying shows plan + start date
    ok(byId.get(305) && byId.get(305).plan && byId.get(305).plan.name === 'Gold' && !!byId.get(305).plan.started_at, 'PAYING: shows plan name + started_at', JSON.stringify(byId.get(305) && byId.get(305).plan));

    // Employee status MIRRORS the owner, but is NOT counted as a payer.
    ok(byId.get(310) && byId.get(310).status4 === 'paying' && byId.get(310).status_inherited === true && byId.get(310).own_sub_status == null,
      'EMPLOYEE: emp of a paying owner MIRRORS paying + inherited flag + no own sub', JSON.stringify(byId.get(310) && [byId.get(310).status4, byId.get(310).status_inherited, byId.get(310).own_sub_status]));
    ok(byId.get(311) && byId.get(311).status4 === 'trial' && byId.get(311).own_sub_status == null,
      'EMPLOYEE: emp of a trial owner MIRRORS trial (own clock not used)', JSON.stringify(byId.get(311) && [byId.get(311).status4, byId.get(311).own_sub_status]));
    // Counters keyed to own subscriptions: payers = 305(active),306(past_due),307(active),308(active) = 4; NOT the 2 employees.
    const ownPayers = users.filter((u) => u.own_sub_status === 'active' || u.own_sub_status === 'past_due');
    ok(ownPayers.length === 4, 'COUNT: paying counter keyed to own subs = 4 (employees NOT counted)', 'got ' + ownPayers.length + ' -> ' + ownPayers.map(u => u.id).join(','));
    ok(byId.get(305) && byId.get(305).own_sub_status === 'active' && byId.get(306) && byId.get(306).own_sub_status === 'past_due', 'COUNT: own_sub_status active/past_due set on real payers');

    // Part 2: Total Received per customer + grand total
    ok(byId.get(305) && Number(byId.get(305).total_received) === 350, 'TOTAL: 305 total_received = 350 (2x175)', String(byId.get(305) && byId.get(305).total_received));
    ok(byId.get(303) && Number(byId.get(303).total_received) === 0, 'TOTAL: non-payer total_received = 0', String(byId.get(303) && byId.get(303).total_received));
    const grand = Number(r.body.grand_total_received);
    ok(grand === 525, 'GRAND TOTAL: 350 (305) + 175 (seed 308) = 525', String(grand));

    // Part 2: webhook authcapture writes a ledger row (amount from payload.authAmount)
    const sign = (b) => 'sha512=' + crypto.createHmac('sha512', 'test_sig_key').update(b, 'utf8').digest('hex').toUpperCase();
    const capBody = JSON.stringify({
      eventType: 'net.authorize.payment.authcapture.created',
      notificationId: 'notif-cap-1',
      payload: { id: 'TXN-NEW-1', authAmount: 175.00, subscription: { id: 'ARBPAY', payNum: 3 } },
    });
    const capRes = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('X-ANET-Signature', sign(capBody)).send(capBody);
    ok(capRes.status === 200, 'webhook: authcapture accepted (200)', String(capRes.status));
    const [[ledger]] = await conn.query("SELECT amount, user_id FROM payment_receipts WHERE transaction_id='TXN-NEW-1'");
    ok(ledger && Number(ledger.amount) === 175 && ledger.user_id === 305, 'webhook: ledger row written with settled amount', JSON.stringify(ledger));
    const [[pc]] = await conn.query("SELECT paid_count FROM subscriptions WHERE authorize_subscription_id='ARBPAY'");
    ok(pc && Number(pc.paid_count) === 3, 'webhook: paid_count bumped to payNum (3)', JSON.stringify(pc));
    // Idempotent: same authcapture redelivered does NOT double the ledger
    await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('X-ANET-Signature', sign(capBody)).send(capBody);
    const [[cnt]] = await conn.query("SELECT COUNT(*) AS c FROM payment_receipts WHERE transaction_id='TXN-NEW-1'");
    ok(cnt && Number(cnt.c) === 1, 'webhook: redelivery is idempotent (one ledger row)', JSON.stringify(cnt));

  } catch (e) {
    ok(false, 'unexpected error', e && e.stack || String(e));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    try { if (db && db.stop) await db.stop(); } catch (e) {}
  }
  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
