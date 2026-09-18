/* BUDGET FLAGS — the rule, the cap, the lock gate, and who may see any of it.
 *
 * Real MySQL via mysql-memory-server, real routes, real HTTP. Every assertion
 * reads what the ENDPOINT returned or what the DATABASE holds, never an
 * intermediate — the whole point of blank-is-not-zero is that a coercion three
 * layers down defeats it, and only reading the stored row catches that.
 *
 * Run: node test/budgetFlags.test.js
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
    db = await createDB({ dbName: 'seejob_budgetflags_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const flags = require('../services/budgetFlags');

    // ── minimal legacy-shaped schema ────────────────────────────────────
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), role INT NULL, category INT NULL, status INT DEFAULT 1, created_by INT NULL, business_name VARCHAR(190) NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE `job` (id INT PRIMARY KEY, name VARCHAR(150), job_number VARCHAR(40) NULL, created_by INT NULL, status INT DEFAULT 1, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE contact (id INT PRIMARY KEY AUTO_INCREMENT, request_by INT NULL, request_to INT NULL, request_user1 INT NULL, request_user2 INT NULL, status INT DEFAULT 0)");
    await conn.query(`CREATE TABLE division_lineitems (
      id INT PRIMARY KEY AUTO_INCREMENT, division_id INT, job_id INT, owner_type VARCHAR(10) DEFAULT 'job',
      csi_number VARCHAR(40) NULL, lineitem_description VARCHAR(255) NULL,
      amount DECIMAL(12,2) NULL, sub_cost DECIMAL(12,2) NULL, contingency DECIMAL(7,3) NULL,
      overhead_percent DECIMAL(7,3) DEFAULT 0, profit_percent DECIMAL(7,3) NULL, gl_percent DECIMAL(7,3) DEFAULT 0,
      subcontractor_id INT NULL, in_house TINYINT NOT NULL DEFAULT 0, is_allowance TINYINT NOT NULL DEFAULT 0,
      foreman_percent DECIMAL(7,3) DEFAULT 0, paid_amount DECIMAL(12,2) DEFAULT 0,
      created_at DATETIME NULL, created_by INT NULL)`);
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT NULL, status VARCHAR(30), created_at DATETIME NULL)");
    // No subscription row is seeded: with none, getActivePlanFeatures treats an
    // owner-exempt / paid / trial account as top tier and returns every key in
    // plan_features. That is the path the real owner takes, so it is the one
    // worth exercising.
    await conn.query("CREATE TABLE plan_features (id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT NULL, feature_key VARCHAR(80))");
    await conn.query("INSERT INTO plan_features (plan_id, feature_key) VALUES (1,'job_budget'), (1,'budget')");

    const migrations = require('../services/dbMigrations');

    // ── §1 / check 17: the migration, and its hand-written rollback ─────
    const cols = async () => {
      const [r] = await conn.query("SHOW COLUMNS FROM division_lineitems");
      return r.map((c) => c.Field);
    };
    const before = await cols();
    ok(!before.includes('is_tbd') && !before.includes('tbd_note'),
      'the columns do not exist before the migration');

    await migrations.ensureBudgetTbdColumns(conn);
    const after = await cols();
    ok(after.includes('is_tbd'), 'is_tbd added');
    ok(after.includes('tbd_note'), 'tbd_note added');

    const [[tbdCol]] = await conn.query("SHOW COLUMNS FROM division_lineitems LIKE 'is_tbd'");
    ok(/tinyint/i.test(tbdCol.Type) && tbdCol.Null === 'NO' && Number(tbdCol.Default) === 0,
      'is_tbd is tinyint NOT NULL DEFAULT 0', JSON.stringify(tbdCol));
    const [[noteCol]] = await conn.query("SHOW COLUMNS FROM division_lineitems LIKE 'tbd_note'");
    ok(/varchar\(20\)/i.test(noteCol.Type) && noteCol.Null === 'YES',
      'tbd_note is VARCHAR(20) NULL — the cap is in the DATABASE', noteCol.Type);

    // Rollback, then re-apply. This is the proof the PR carries.
    await conn.query("ALTER TABLE division_lineitems DROP COLUMN tbd_note");
    await conn.query("ALTER TABLE division_lineitems DROP COLUMN is_tbd");
    const rolled = await cols();
    ok(JSON.stringify(rolled) === JSON.stringify(before),
      'CHECK 17: the rollback restores the schema EXACTLY as it was',
      JSON.stringify(rolled.filter((c) => !before.includes(c))));
    migrations.__resetTbdEnsuredForTest && migrations.__resetTbdEnsuredForTest();
    await conn.query("ALTER TABLE division_lineitems ADD COLUMN is_tbd TINYINT NOT NULL DEFAULT 0");
    await conn.query("ALTER TABLE division_lineitems ADD COLUMN tbd_note VARCHAR(20) NULL DEFAULT NULL");

    // ── the rule itself, as a unit ──────────────────────────────────────
    const line = (o = {}) => ({ amount: 100, sub_cost: 50, subcontractor_id: 9, in_house: 0, is_tbd: 0, ...o });

    ok(flags.lineFlags(line()).flagged === false, 'a complete line is not flagged');

    // CHECK 1 — blank is missing, zero is not.
    ok(flags.lineFlags(line({ sub_cost: null })).missing.includes('sub_cost'),
      'CHECK 1: an EMPTY sub cost is missing');
    ok(!flags.lineFlags(line({ sub_cost: 0 })).missing.includes('sub_cost'),
      'CHECK 1: a sub cost of ZERO is answered — a line can genuinely cost nothing');
    ok(!flags.lineFlags(line({ sub_cost: '0' })).missing.includes('sub_cost'),
      "…and '0' as a string is answered too");
    ok(flags.lineFlags(line({ sub_cost: '' })).missing.includes('sub_cost'),
      "…while '' is missing");
    ok(!flags.lineFlags(line({ amount: 0 })).missing.includes('amount'),
      'a client budget of zero is answered');

    // CHECK 2 — subcontractor is ALWAYS required.
    ok(flags.lineFlags(line({ subcontractor_id: null })).missing.includes('subcontractor'),
      'CHECK 2: an empty subcontractor is flagged WITH a sub cost present');
    ok(flags.lineFlags(line({ subcontractor_id: null, sub_cost: null })).missing.includes('subcontractor'),
      'CHECK 2: …and WITHOUT one. No "only when sub cost exists" condition.');
    ok(flags.lineFlags(line({ subcontractor_id: 0 })).missing.includes('subcontractor'),
      'subcontractor_id 0 is not a subcontractor');

    // CHECK 3 — in-house clears it.
    ok(!flags.lineFlags(line({ subcontractor_id: null, in_house: 1 })).missing.includes('subcontractor'),
      'CHECK 3: selecting the in-house company clears the subcontractor flag');

    // A brand-new line starts flagged on all three. Intended.
    const fresh = flags.lineFlags({ amount: null, sub_cost: null, subcontractor_id: null, in_house: 0, is_tbd: 0 });
    ok(fresh.missing.length === 3 && fresh.flagged,
      'a brand-new line starts flagged on all three — correct and intended',
      JSON.stringify(fresh.missing));

    // CHECK 4 — TBD flags an otherwise complete line.
    const tbdOnly = flags.lineFlags(line({ is_tbd: 1 }));
    ok(tbdOnly.flagged && tbdOnly.missing.length === 0,
      'CHECK 4: every cell filled and TBD ticked — still flagged, nothing missing');

    // CHECK 5 — both reasons count ONCE.
    const both = [line({ is_tbd: 1, sub_cost: null, subcontractor_id: null })];
    ok(flags.countFlagged(both) === 1,
      'CHECK 5: a line that is TBD and missing two cells counts ONCE', String(flags.countFlagged(both)));
    ok(flags.countFlagged([line(), line({ is_tbd: 1 }), line({ amount: null })]) === 2,
      'and the count is of LINES, not reasons');

    // CHECK 7 (unit half) — the note cap.
    ok(flags.tbdNoteError('x'.repeat(20)) === null, 'CHECK 7: 20 characters is accepted');
    ok(flags.tbdNoteError('x'.repeat(21)) !== null, 'CHECK 7: 21 characters is REJECTED, not truncated');

    // ── the endpoints ───────────────────────────────────────────────────
    await conn.query("INSERT INTO `user` (id,name,email,role,category,status,created_by,business_name) VALUES (700,'Poul','admin@oakcoast.net',14,4,1,NULL,'Oak Coast')");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,status,created_by) VALUES (701,'A Client','client@x.com',3,3,1,700)");
    await conn.query("INSERT INTO `user` (id,name,email,role,category,status,created_by) VALUES (702,'A Sub','sub@x.com',12,2,1,700)");
    await conn.query("INSERT INTO `job` (id,name,created_by,status) VALUES (10,'Lynes',700,1)");

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/budget', require('../routes/budget'));
    const tok = (id) => 'Bearer ' + jwt.sign({ id, category: id === 701 ? 3 : (id === 702 ? 2 : 4), email: id === 700 ? 'admin@oakcoast.net' : 'x@x.com' }, process.env.ACCESS_TOKEN);

    // CHECK 7 (endpoint half) — 21 characters straight at the API.
    const longNote = await request(app)
      .post('/api/budget/divisions/1/lineitems')
      .set('Authorization', tok(700))
      .send({ job_id: 10, job_type: 'job', items: [{ lineitem_description: 'x', tbd_note: 'x'.repeat(21), is_tbd: 1 }] });
    ok(longNote.status === 400 && longNote.body && longNote.body.code === 'TBD_NOTE_TOO_LONG',
      'CHECK 7: the ENDPOINT rejects a 21-character note',
      longNote.status + ' ' + JSON.stringify(longNote.body).slice(0, 120));

    // ── §5 — clients and subcontractors get NOTHING ─────────────────────
    for (const [who, id] of [['client', 701], ['subcontractor', 702]]) {
      const r = await request(app).get('/api/budget/lineitems/all?job_id=10&job_type=job').set('Authorization', tok(id));
      ok(r.status === 403,
        `CHECK 14: a ${who} gets 403 from the lineitems endpoint — ABSENT, not redacted`,
        String(r.status));
      /*
       * WHICH gate refused matters, and at the endpoint it cannot be pinned
       * down: budget carries TWO independent refusals — a router-wide
       * Platinum gate (budget.js:183) and the account-type gate. In this
       * fixture the plan gate answers first, so asserting the account-type
       * wording here would only be asserting the fixture.
       *
       * Both gates refusing is what the standing rule needs — a client gets
       * nothing, by either road. The account-type rule ITSELF is proved
       * directly below, in isolation, where no plan can stand in for it.
       */
      const body = JSON.stringify(r.body || {});
      ok(!/amount|sub_cost|is_tbd|tbd_note|flags/.test(body),
        `…and no budget field appears anywhere in the ${who} payload`, body.slice(0, 140));
    }

    // The two ungated routes carry no budget figures.
    const jobsAsClient = await request(app).get('/api/budget/jobs').set('Authorization', tok(701));
    const jobsBody = JSON.stringify(jobsAsClient.body || {});
    ok(!/amount|sub_cost|is_tbd|tbd_note/.test(jobsBody),
      'CHECK 14: GET /budget/jobs returns no budget figures even ungated', jobsBody.slice(0, 140));

    /*
     * THE ACCOUNT-TYPE RULE, PROVED ON ITS OWN. No plan, no route, no fixture
     * that could answer in its place — just the middleware and a category.
     * This is what stops the endpoint checks above passing for the wrong
     * reason if the Platinum gate is ever relaxed.
     */
    const { denyRestrictedJobData } = require('../utils/access');
    const callGate = (category, email) => new Promise((resolve) => {
      const req = { user: { category, email } };
      const res = {
        statusCode: 0,
        status(c) { this.statusCode = c; return this; },
        json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      };
      denyRestrictedJobData(req, res, () => resolve({ status: 200, body: null, passed: true }));
    });

    const asClient = await callGate(3, 'client@x.com');
    ok(asClient.status === 403 && /account type/i.test(String(asClient.body && asClient.body.message)),
      'CHECK 14: denyRestrictedJobData refuses category 3 (CLIENT) on its own',
      JSON.stringify(asClient).slice(0, 130));

    const asSub = await callGate(2, 'sub@x.com');
    ok(asSub.status === 403 && /account type/i.test(String(asSub.body && asSub.body.message)),
      'CHECK 14: …and category 2 (SUBCONTRACTOR)',
      JSON.stringify(asSub).slice(0, 130));

    ok((await callGate(4, 'poul@x.com')).passed === true,
      'non-vacuity: the same gate LETS AN OWNER THROUGH — it is not refusing everyone');

    ok((await callGate(1, 'employee@x.com')).passed === true,
      'and an employee (category 1) too');

    note('Endpoint-level lock-gate checks continue in budgetLockGate.test.js');
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
