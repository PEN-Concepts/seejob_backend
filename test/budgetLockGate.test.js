/* THE LOCK GATE, AT THE ENDPOINT — checks 9, 10, 11, 13, 16, and the
 * amendment's three additions.
 *
 * A HIDDEN BUTTON IS NOT A RULE. Every assertion here calls the endpoint
 * directly, the way anything that bypasses the page would, and reads either
 * the response or the stored row. Check 11's non-vacuity is the point of the
 * file: the server gate is removed and the test must fail, because a UI-only
 * gate has to be unable to pass this.
 *
 * Run: node test/budgetLockGate.test.js
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
    db = await createDB({ dbName: 'seejob_lockgate_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');

    // `business`, `trade` and `subcategory` are read by the subcontractor
    // picker (CHECK 16): company first, owner underneath, trade searchable.
    // Without them the endpoint 500s and CHECK 16 measures nothing.
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, subcategory INT NULL, status INT DEFAULT 1, created_by INT NULL, business VARCHAR(190) NULL, trade VARCHAR(120) NULL, business_name VARCHAR(190) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE category (id INT PRIMARY KEY, name VARCHAR(80))");
    await conn.query("CREATE TABLE subcategory (id INT PRIMARY KEY, name VARCHAR(80), category_id INT NULL)");
    await conn.query("INSERT INTO category VALUES (1,'Employee'),(2,'Contractor'),(3,'Client')");
    await conn.query("INSERT INTO subcategory VALUES (12,'Subcontractor',2)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), job_number VARCHAR(40) NULL, created_by INT NULL, status INT DEFAULT 1, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT NULL, request_to INT NULL, request_user1 INT NULL, request_user2 INT NULL, status INT DEFAULT 0)");
    await conn.query(`CREATE TABLE division_lineitems (
      id INT PRIMARY KEY AUTO_INCREMENT, division_id INT, job_id INT, owner_type VARCHAR(10) DEFAULT 'job',
      csi_number VARCHAR(40) NULL, lineitem_description VARCHAR(255) NULL,
      amount DECIMAL(12,2) NULL, sub_cost DECIMAL(12,2) NULL, contingency DECIMAL(7,3) NULL,
      overhead_percent DECIMAL(7,3) DEFAULT 0, profit_percent DECIMAL(7,3) NULL, gl_percent DECIMAL(7,3) DEFAULT 0,
      subcontractor_id INT NULL, in_house TINYINT NOT NULL DEFAULT 0, is_allowance TINYINT NOT NULL DEFAULT 0,
      is_tbd TINYINT NOT NULL DEFAULT 0, tbd_note VARCHAR(20) NULL,
      foreman_percent DECIMAL(7,3) DEFAULT 0, paid_amount DECIMAL(12,2) DEFAULT 0,
      created_at DATETIME NULL, created_by INT NULL)`);
    /* ensureOwnerTypeColumns() ALTERs four tables and backfills against
       `leads`, so the save path needs all five present even though this file
       only asserts on division_lineitems. Without them the insert 500s and
       check 13 fails for a reason that has nothing to do with the gate. */
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(150) NULL, user_id INT NULL)");
    await conn.query("CREATE TABLE stages (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL)");
    await conn.query("CREATE TABLE materials (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL)");
    await conn.query("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT NULL, status VARCHAR(30), created_at DATETIME NULL)");
    await conn.query("CREATE TABLE plan_features (id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT NULL, feature_key VARCHAR(80))");
    await conn.query("INSERT INTO plan_features (plan_id, feature_key) VALUES (1,'job_budget'), (1,'budget')");

    // Owner-exempt email, so the router's Platinum gate admits the owner and
    // the endpoint under test is genuinely reached.
    await conn.query("INSERT INTO `user` (id,name,email,role,category,status,business_name) VALUES (700,'Poul','admin@oakcoast.net',14,4,1,'Oak Coast')");
    await conn.query("INSERT INTO `job` (id,name,created_by,status) VALUES (10,'Lynes',700,1)");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/budget', require('../routes/budget'));
    const tok = 'Bearer ' + jwt.sign({ id: 700, category: 4, email: 'admin@oakcoast.net' }, process.env.ACCESS_TOKEN);

    const setLines = async (rows) => {
      await conn.query('DELETE FROM division_lineitems');
      for (const r of rows) {
        await conn.query(
          `INSERT INTO division_lineitems
             (division_id, job_id, owner_type, lineitem_description, amount, sub_cost, subcontractor_id, in_house, is_tbd)
           VALUES (1, 10, 'job', ?, ?, ?, ?, ?, ?)`,
          [r.d || 'line', r.amount ?? null, r.sub ?? null, r.subId ?? null, r.inHouse ? 1 : 0, r.tbd ? 1 : 0]
        );
      }
    };
    const lock = () => request(app).post('/api/budget/lock').set('Authorization', tok)
      .send({ job_id: 10, job_type: 'job', snapshot: { total: 1 } });
    const unlock = () => request(app).post('/api/budget/unlock').set('Authorization', tok)
      .send({ job_id: 10, job_type: 'job' });
    const isLocked = async () => {
      const [[r]] = await conn.query("SELECT locked FROM budget_locks WHERE job_id = 10 AND owner_type = 'job'");
      return r ? Number(r.locked) === 1 : false;
    };

    const COMPLETE = { d: 'done', amount: 100, sub: 50, subId: 9 };

    // ── CHECK 9 ────────────────────────────────────────────────────────
    await setLines([COMPLETE, { d: 'blank sub cost', amount: 100, sub: null, subId: 9 }]);
    let r = await lock();
    ok(r.status === 409 && r.body.code === 'BUDGET_HAS_FLAGGED_LINES',
      'CHECK 9: the LOCK ENDPOINT refuses while a line is flagged',
      r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
    ok(r.body && Number(r.body.outstanding) === 1, 'and it says how many are outstanding', JSON.stringify(r.body.outstanding));
    ok((await isLocked()) === false, 'nothing was locked', String(await isLocked()));

    await setLines([COMPLETE, COMPLETE]);
    r = await lock();
    ok(r.status === 200, 'CHECK 9: …and ACCEPTS at zero', r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
    ok((await isLocked()) === true, 'the budget is locked');

    // ── locking still snapshots and still audits (amendment) ───────────
    const [[lockRow]] = await conn.query("SELECT snapshot, locked_by, locked_at FROM budget_locks WHERE job_id = 10 AND owner_type = 'job'");
    ok(lockRow && lockRow.snapshot && String(lockRow.snapshot).includes('total'),
      'ADDED: locking still stores the snapshot — unchanged by this work',
      String(lockRow && lockRow.snapshot).slice(0, 60));
    ok(lockRow && Number(lockRow.locked_by) === 700 && lockRow.locked_at,
      'and still records who and when');
    const [[audit]] = await conn.query("SELECT COUNT(*) AS c FROM budget_lock_audit WHERE job_id = 10 AND action = 'lock'");
    ok(Number(audit.c) === 1, 'ADDED: and still writes an audit row', String(audit.c));

    // ── unlock is NOT gated (amendment) ────────────────────────────────
    /* Unlocking is how you get back in to fix the flagged lines. A symmetric
       guard here would trap the owner out of his own budget. */
    await setLines([COMPLETE, { d: 'blank', amount: null, sub: null, subId: null }]);
    r = await unlock();
    ok(r.status === 200,
      'ADDED: UNLOCK succeeds while lines are flagged — it is the way back in',
      r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
    ok((await isLocked()) === false, 'and the budget is genuinely unlocked');

    // ── CHECK 10: TBD alone blocks ─────────────────────────────────────
    await setLines([{ d: 'all filled but held', amount: 100, sub: 50, subId: 9, tbd: true }]);
    r = await lock();
    ok(r.status === 409 && Number(r.body.outstanding) === 1,
      'CHECK 10: TBD ALONE blocks locking — every number present',
      r.status + ' ' + JSON.stringify(r.body).slice(0, 120));

    await conn.query('UPDATE division_lineitems SET is_tbd = 0');
    r = await lock();
    ok(r.status === 200, 'CHECK 10: untick it and the lock succeeds', String(r.status));
    await unlock();

    // ── in-house clears the subcontractor requirement ──────────────────
    await setLines([{ d: 'self performed', amount: 100, sub: 50, subId: null, inHouse: true }]);
    r = await lock();
    ok(r.status === 200, 'an in-house line does not block', r.status + ' ' + JSON.stringify(r.body).slice(0, 100));
    await unlock();

    /* ── §9: ZERO BLOCKS, at the gate ──────────────────────────────────
       REVERSED. This asserted that a line costing zero was answered and did
       not block. Poul ruled the other way: in a budget, a line worth nothing
       is a line nobody has got to yet. The consequence, accepted: a
       genuinely free line cannot be locked. */
    await setLines([{ d: 'costs nothing', amount: 0, sub: 0, subId: 9 }]);
    r = await lock();
    ok(r.status === 409 && Number(r.body.outstanding) === 1,
      '§9: a line costing ZERO is MISSING and blocks the lock',
      r.status + ' ' + JSON.stringify(r.body).slice(0, 120));

    await setLines([{ d: 'real money', amount: 100, sub: 50, subId: 9 }]);
    r = await lock();
    ok(r.status === 200,
      'non-vacuity: a line with real money on it still locks — zero is the trigger, not everything',
      String(r.status));
    await unlock();

    // ── CHECK 13: saving is never blocked ──────────────────────────────
    await setLines([{ d: 'blank', amount: null, sub: null, subId: null }]);
    const save = await request(app).post('/api/budget/divisions/1/lineitems').set('Authorization', tok)
      .send({ job_id: 10, job_type: 'job', items: [{ lineitem_description: 'added while flagged', amount: 5 }] });
    ok(save.status >= 200 && save.status < 300,
      'CHECK 13: SAVING still works with a flagged budget — only LOCKING is blocked',
      save.status + ' ' + JSON.stringify(save.body).slice(0, 120));

    // ── CHECK 16: the dropdown returns everyone ────────────────────────
    /* Seeded with MORE THAN SIX so "six of fifty-one" cannot pass by accident,
       and with status 0 on half of them because the old query filtered
       status = 1 and that is what hid most of the list. */
    for (let i = 1; i <= 9; i++) {
      await conn.query(
        "INSERT INTO `user` (id,name,email,role,category,status,created_by) VALUES (?,?,?,12,2,?,700)",
        [800 + i, 'Sub ' + i, 'sub' + i + '@x.com', i % 2 === 0 ? 0 : 1]
      );
      await conn.query("INSERT INTO contact (request_by, request_to, status) VALUES (700, ?, 0)", [800 + i]);
    }
    const drop = await request(app).get('/api/budget/subcontractors').set('Authorization', tok);
    ok(drop.status === 200, 'CHECK 16: the dropdown responds 200', String(drop.status));
    ok(Array.isArray(drop.body) && drop.body.length === 9,
      'CHECK 16: it returns ALL NINE, not six — status = 1 is dropped and the live columns are joined',
      'got ' + (drop.body || []).length);

    /* ── §8.7 UNTICKING CLEARS THE NOTE, in the COLUMN ─────────────────
       Asserted against the database and not the UI, because the note is the
       reason the line is held: with no hold there is no reason, and a stale
       note would mislead Poul next month. */
    await conn.query('DELETE FROM division_lineitems');
    const saveLine = (body) => request(app).post('/api/budget/divisions/1/lineitems')
      .set('Authorization', tok).send({ job_id: 10, job_type: 'job', items: [body] });

    await saveLine({ lineitem_description: 'held', amount: 100, sub_cost: 50, is_tbd: 1, tbd_note: 'WAITING ON BID' });
    let [[stored]] = await conn.query("SELECT id, is_tbd, tbd_note FROM division_lineitems WHERE lineitem_description = 'held'");
    ok(stored && Number(stored.is_tbd) === 1 && stored.tbd_note === 'WAITING ON BID',
      '§8: a ticked line stores its note in the column',
      JSON.stringify(stored));

    await saveLine({ id: stored.id, lineitem_description: 'held', amount: 100, sub_cost: 50, is_tbd: 0, tbd_note: 'WAITING ON BID' });
    [[stored]] = await conn.query("SELECT is_tbd, tbd_note FROM division_lineitems WHERE lineitem_description = 'held'");
    ok(stored && Number(stored.is_tbd) === 0 && stored.tbd_note === null,
      '§8.7: unticking CLEARS tbd_note in the database — even when the caller still sends one',
      JSON.stringify(stored));

    /* §8.6 TBD with no note is valid and is stored as such. */
    await saveLine({ lineitem_description: 'held, no reason', amount: 100, sub_cost: 50, is_tbd: 1 });
    const [[bare]] = await conn.query("SELECT is_tbd, tbd_note FROM division_lineitems WHERE lineitem_description = 'held, no reason'");
    ok(bare && Number(bare.is_tbd) === 1 && bare.tbd_note === null,
      '§8.6: TBD with NO note is accepted and stored — the tick is what flags the line',
      JSON.stringify(bare));

    note('Check 11 non-vacuity is run by budgetLockGate.novacuity.js, which');
    note('removes the server gate and expects THIS file to fail.');
  } catch (e) {
    fail++; rec.push('  ✗ threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e));
  } finally {
    try { if (conn) conn.release(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    try { if (db) await db.stop(); } catch {}
    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
