/* GET /budget/export — the budget as a styled .xlsx workbook.
 *
 * WHAT THIS FILE IS FOR. A spreadsheet export is unusually easy to get wrong in
 * ways nobody notices: totals that are pasted values, money stored as text that
 * looks right and will not re-sum, a permission gate that returns a blanked file
 * instead of refusing. So every assertion below OPENS THE PRODUCED FILE and
 * inspects the actual cells — none of them trust the builder's own return value.
 *
 * The totals are diffed against numbers computed INDEPENDENTLY in this file from
 * the seeded rows, not against the service's own `totals` object. A test that
 * asks the code under test for the expected answer is not a test.
 *
 * Run: NODE_PATH=<backend>/node_modules node test/budgetExport.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);
const money = (n) => '$' + Number(n).toFixed(2);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    delete process.env.NODE_ENV;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_budgetexport_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const ExcelJS = require('exceljs');

    // ── schema ──────────────────────────────────────────────────────────────
    await conn.query("CREATE TABLE `user` (id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), business VARCHAR(190) NULL, role INT NULL, status INT DEFAULT 1, category INT NULL, created_by INT NULL, created_at DATETIME NULL)");
    await conn.query("CREATE TABLE job (id INT PRIMARY KEY, name VARCHAR(190), address VARCHAR(190) NULL, city VARCHAR(90) NULL, state VARCHAR(40) NULL, zipcode VARCHAR(20) NULL, job_address VARCHAR(190) NULL, job_city VARCHAR(90) NULL, job_state VARCHAR(40) NULL, job_zipcode VARCHAR(20) NULL, created_by INT, status INT DEFAULT 1)");
    await conn.query("CREATE TABLE leads (id INT PRIMARY KEY, lead_name VARCHAR(190), address VARCHAR(190) NULL, city VARCHAR(90) NULL, state VARCHAR(40) NULL, zipcode VARCHAR(20) NULL, user_id INT)");
    await conn.query("CREATE TABLE divisions (id INT PRIMARY KEY, division_number VARCHAR(10), name VARCHAR(120), description VARCHAR(255) NULL)");
    await conn.query(`CREATE TABLE division_lineitems (
      id INT PRIMARY KEY AUTO_INCREMENT, division_id INT, lineitem_description VARCHAR(255),
      amount DECIMAL(12,2) DEFAULT 0, sub_cost DECIMAL(12,2) DEFAULT 0, csi_number VARCHAR(40) NULL,
      job_id INT, owner_type VARCHAR(8) DEFAULT 'job', subcontractor_id INT NULL,
      in_house TINYINT DEFAULT 0, is_allowance TINYINT DEFAULT 0, is_tbd TINYINT DEFAULT 0,
      tbd_note VARCHAR(255) NULL, foreman_percent DECIMAL(6,2) NULL, paid_amount DECIMAL(12,2) DEFAULT 0,
      contingency DECIMAL(6,2) NULL, overhead_percent DECIMAL(6,2) NULL,
      profit_percent DECIMAL(6,2) NULL, gl_percent DECIMAL(6,2) NULL)`);
    await conn.query(`CREATE TABLE division_lineitem_payments (
      id INT PRIMARY KEY AUTO_INCREMENT, lineitem_id INT, method VARCHAR(30),
      check_number VARCHAR(60) NULL, payment_date DATE, amount DECIMAL(12,2),
      created_at DATETIME NULL, created_by INT NULL, updated_at DATETIME NULL, updated_by INT NULL)`);
    // The route runs the same schema guards the page's own reads run, and those
    // reach past the budget tables: ensureOwnerTypeColumns adds owner_type to
    // division_lineitems, stages, materials AND job_contacts, so all four have to
    // exist or the guard throws and the route 500s. Seeded bare — the export
    // reads none of them.
    await conn.query("CREATE TABLE stages (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, name VARCHAR(190) NULL)");
    await conn.query("CREATE TABLE materials (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, name VARCHAR(190) NULL)");
    await conn.query("CREATE TABLE job_contacts (id INT PRIMARY KEY AUTO_INCREMENT, job_id INT NULL, user_id INT NULL)");
    await conn.query("CREATE TABLE subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT, plan_id INT NULL, status VARCHAR(30), created_at DATETIME NULL)");
    await conn.query("CREATE TABLE plans (id INT PRIMARY KEY, name VARCHAR(80), amount DECIMAL(10,2) DEFAULT 0)");
    await conn.query("CREATE TABLE plan_features (id INT PRIMARY KEY AUTO_INCREMENT, plan_id INT NULL, feature_key VARCHAR(60))");
    await conn.query("INSERT INTO plans (id,name) VALUES (5,'Platinum')");
    await conn.query("INSERT INTO plan_features (plan_id, feature_key) VALUES (5,'budget'),(5,'job_budget')");

    // ── people ──────────────────────────────────────────────────────────────
    await conn.query(`INSERT INTO \`user\` (id,name,email,business,role,status,category,created_by,created_at) VALUES
      (100,'Poul Norholm','owner@example.invalid','Oak Coast Construction',14,1,4,NULL,NOW()),
      (101,'Guillermo Ruiz','guillermo@example.invalid','Ruiz Framing',12,1,2,100,NOW()),
      (102,'Dana Wire','dana@example.invalid','Wire Electric',12,1,2,100,NOW()),
      (103,'Ellen Client','client@example.invalid',NULL,3,1,3,100,NOW()),
      (104,'Ed Employee','emp@example.invalid',NULL,3,1,1,100,NOW())`);
    /* EVERY actor gets an active Platinum subscription, including the ones that
     * must be refused.
     *
     * WHY THAT MATTERS. requirePlan("platinum") is mounted on the whole budget
     * router, and getActivePlanLevel resolves through resolveOwnerId — which
     * promotes EMPLOYEES ONLY. A subcontractor or client therefore resolves to
     * themselves, finds no subscription, and is refused with
     * PLAN_UPGRADE_REQUIRED before the category gate is ever reached. A fixture
     * that leaves them unsubscribed "proves" they cannot export while testing
     * nothing about who is allowed to see cost data — the refusal would survive
     * deleting denyRestrictedJobData entirely.
     *
     * Subscribing them takes the plan gate out of the argument, so the 403 that
     * remains is about WHO THEY ARE. */
    await conn.query(`INSERT INTO subscriptions (user_id, plan_id, status, created_at) VALUES
      (100,5,'active',NOW()),(101,5,'active',NOW()),(103,5,'active',NOW()),(104,5,'active',NOW())`);

    // ── jobs ────────────────────────────────────────────────────────────────
    await conn.query(`INSERT INTO job (id,name,job_address,job_city,job_state,job_zipcode,created_by,status) VALUES
      (900,'Mann ADU','1420 Mann Road','Santa Rosa','CA','95401',100,1),
      (901,'Empty Job',NULL,NULL,NULL,NULL,100,1),
      (902,'Zero Pay Job','9 Quiet Lane','Napa','CA','94558',100,1),
      (903,'Rear Unit 1/2 — Phase 3','7 Slash Street','Sonoma','CA','95476',100,1)`);

    // ── the 17 divisions (1..16 CSI + 17 Construction Services) ─────────────
    const divNames = ['General Requirements','Site Construction','Concrete','Masonry','Metals',
      'Wood & Plastics','Thermal & Moisture','Doors & Windows','Finishes','Specialties',
      'Equipment','Furnishings','Special Construction','Conveying Systems','Mechanical',
      'Electrical','Construction Services'];
    for (let i = 1; i <= 17; i++) {
      await conn.query('INSERT INTO divisions (id,division_number,name,description) VALUES (?,?,?,?)',
        [i, String(i).padStart(2, '0'), divNames[i - 1], `Division ${i} description`]);
    }

    // ── Mann ADU line items ─────────────────────────────────────────────────
    // Percentages live on every row (the app denormalises them); seed them so
    // the summary block has something to read.
    const P = { contingency: 6, overhead: 10, profit: 8, gl: 2 };
    const L = [
      // div, desc, amount(client), sub_cost, csi, sub_id, allowance, paid
      [3,  'Foundation pour',        40000, 32000, '03 30 00', 101, 0, 12000],
      [3,  'Slab finish',            12000,  9000, '03 35 00', 101, 0,  9000],
      [6,  'Framing package',        85000, 70000, '06 10 00', 101, 0, 25000],
      [9,  'Tile allowance',         15000, 15000, '09 30 00', 102, 1,  6000],
      [16, 'Rough electrical',       28000, 22000, '16 10 00', 102, 0, 22000],
      [17, 'Supervision',            18000, 18000, '01 31 00', null, 0, 4000],
    ];
    for (const [div, desc, amount, cost, csi, subId, allw, paid] of L) {
      await conn.query(
        `INSERT INTO division_lineitems
          (division_id,lineitem_description,amount,sub_cost,csi_number,job_id,owner_type,
           subcontractor_id,in_house,is_allowance,paid_amount,contingency,overhead_percent,profit_percent,gl_percent)
         VALUES (?,?,?,?,?,?, 'job', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [div, desc, amount, cost, csi, 900, subId, subId ? 0 : 1, allw, paid,
         P.contingency, P.overhead, P.profit, P.gl],
      );
    }
    const [seeded] = await conn.query('SELECT id, division_id, lineitem_description, sub_cost, paid_amount, subcontractor_id, in_house FROM division_lineitems WHERE job_id = 900 ORDER BY id');

    // ── payments. Sum per item MUST equal that item's paid_amount, or Sheet 1
    //    (which sums payments) and the API (which reads the column) disagree. ──
    const PAYMENTS = [
      [seeded[0].id, 'check', '10421', '2026-03-04', 7000],
      [seeded[0].id, 'check', '10455', '2026-04-02', 5000],
      [seeded[1].id, 'cash',  null,    '2026-04-19', 9000],
      [seeded[2].id, 'check', '10502', '2026-05-08', 15000],
      [seeded[2].id, 'wire',  'W-7781','2026-06-01', 10000],
      [seeded[3].id, 'venmo', null,    '2026-06-14', 6000],
      [seeded[4].id, 'credit_card', '****4417', '2026-07-02', 22000],
      [seeded[5].id, 'check', '10610', '2026-07-30', 4000],
    ];
    for (const [itemId, method, ref, date, amt] of PAYMENTS) {
      await conn.query(
        'INSERT INTO division_lineitem_payments (lineitem_id,method,check_number,payment_date,amount,created_at,created_by) VALUES (?,?,?,?,?,NOW(),100)',
        [itemId, method, ref, date, amt],
      );
    }

    // Zero-pay job: lines but no payments at all.
    await conn.query(
      `INSERT INTO division_lineitems (division_id,lineitem_description,amount,sub_cost,csi_number,job_id,owner_type,subcontractor_id,paid_amount,contingency,overhead_percent,profit_percent,gl_percent)
       VALUES (5,'Steel posts',5000,4000,'05 12 00',902,'job',101,0,6,10,8,2)`);

    // ── app ─────────────────────────────────────────────────────────────────
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/budget', require('../routes/budget'));

    const tok = (id, role, category, email) =>
      'Bearer ' + jwt.sign({ id, role, category, email }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
    const OWNER = tok(100, 14, 4, 'owner@example.invalid');
    const SUBTOK = tok(101, 12, 2, 'guillermo@example.invalid');
    const CLIENTTOK = tok(103, 3, 3, 'client@example.invalid');
    const EMPTOK = tok(104, 3, 1, 'emp@example.invalid');

    const exportFor = (jobId, token) =>
      request(app).get(`/api/budget/export?job_id=${jobId}&job_type=job`).set('Authorization', token).buffer().parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    // ══ 1. it opens ═════════════════════════════════════════════════════════
    const res = await exportFor(900, OWNER);
    ok(res.status === 200, 'owner export responds 200', String(res.status));
    const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body || '');
    ok(buf.length > 0, 'a file came back', String(buf.length));
    note(`Mann ADU workbook: ${buf.length} bytes`);
    ok(buf.slice(0, 2).toString() === 'PK', 'it is a real zip container (xlsx), not CSV or JSON', buf.slice(0, 16).toString('hex'));

    const wb = new ExcelJS.Workbook();
    let opened = true;
    try { await wb.xlsx.load(buf); } catch (e) { opened = false; note('load error: ' + e.message); }
    ok(opened, 'ExcelJS re-opens the produced file without error — no repair prompt');

    const budget = wb.getWorksheet('Budget');
    const payments = wb.getWorksheet('Payments');
    ok(!!budget && !!payments, 'both sheets exist and are named Budget and Payments',
      wb.worksheets.map((w) => w.name).join(','));

    // ── helpers over the produced sheet ─────────────────────────────────────
    const cellsIn = (sheet, col) => {
      const out = [];
      sheet.eachRow({ includeEmpty: false }, (row, n) => out.push({ n, cell: row.getCell(col) }));
      return out;
    };
    const findRow = (sheet, col, text) => {
      let found = null;
      sheet.eachRow({ includeEmpty: false }, (row, n) => {
        const v = row.getCell(col).value;
        const s = v && typeof v === 'object' && 'richText' in v ? v.richText.map((t) => t.text).join('') : String(v ?? '');
        if (!found && s.trim() === text) found = { n, row };
      });
      return found;
    };

    // ══ 2. every total matches numbers computed INDEPENDENTLY here ══════════
    const rows = seeded.map((s, i) => ({ ...s, amount: L[i][2], sub_cost: L[i][3], div: L[i][0], allw: L[i][6], paid: L[i][7] }));
    const sum = (f, filter = () => true) => rows.filter(filter).reduce((a, r) => a + f(r), 0);
    const expClient = sum((r) => r.amount);
    const expCost = sum((r) => r.sub_cost);
    const expPaid = sum((r) => r.paid);
    const expRemaining = sum((r) => Math.max(0, r.sub_cost - r.paid));
    const expBuilding = sum((r) => r.amount, (r) => r.div >= 1 && r.div <= 16);
    const expServices = sum((r) => r.amount, (r) => r.div === 17);
    const expOverhead = expBuilding * P.overhead / 100;
    const expProfit = expBuilding * P.profit / 100;
    const expContingency = expBuilding * P.contingency / 100;
    const expGl = expClient * P.gl / 100;      // GL is off CLIENT budget, not building cost
    const expProjectTotal = expBuilding + expServices + expContingency + expOverhead + expProfit + expGl;

    const summaryVal = (label) => {
      const hit = findRow(budget, 2, label);
      return hit ? Number(hit.row.getCell(8).value) : null;
    };
    const diffs = [];
    const cmp = (label, got, want) => {
      const good = got != null && Math.abs(got - want) < 0.005;
      if (!good) diffs.push(`${label}: workbook ${got} vs expected ${want}`);
      return good;
    };
    const summaryChecks = [
      ['Building cost', summaryVal('Building cost'), expBuilding],
      ['Construction services', summaryVal('Construction services'), expServices],
      ['Overhead', summaryVal('Overhead'), expOverhead],
      ['Profit', summaryVal('Profit'), expProfit],
      ['General liability insurance', summaryVal('General liability insurance'), expGl],
      ["Builder's contingency", summaryVal("Builder's contingency"), expContingency],
      ['Project total', summaryVal('Project total'), expProjectTotal],
    ];
    summaryChecks.forEach(([l, g, w]) => cmp(l, g, w));
    ok(diffs.length === 0, 'every summary figure equals the independently computed total', diffs.join(' | '));
    note('summary: ' + summaryChecks.map(([l, g]) => `${l}=${money(g)}`).join(', '));

    // the four boxed totals sit on one row in columns A..D
    const boxRow = (() => {
      let f = null;
      budget.eachRow({ includeEmpty: false }, (row, n) => {
        if (!f && String(row.getCell(1).value ?? '') === 'CLIENT BUDGET') f = n + 1;
      });
      return f;
    })();
    const boxes = boxRow ? [1, 2, 3, 4].map((c) => Number(budget.getRow(boxRow).getCell(c).value)) : [];
    const boxDiffs = [];
    [['client', boxes[0], expClient], ['your cost', boxes[1], expCost],
     ['paid', boxes[2], expPaid], ['remaining', boxes[3], expRemaining]]
      .forEach(([l, g, w]) => { if (!(g != null && Math.abs(g - w) < 0.005)) boxDiffs.push(`${l}: ${g} vs ${w}`); });
    ok(boxDiffs.length === 0, 'the four boxed totals equal the independently computed figures', boxDiffs.join(' | '));
    note(`boxes: client=${money(boxes[0])} cost=${money(boxes[1])} paid=${money(boxes[2])} remaining=${money(boxes[3])}`);

    // ══ 3. money is numeric and subtotals are LIVE FORMULAS ═════════════════
    const itemRow = findRow(budget, 2, 'Foundation pour');
    ok(!!itemRow, 'a known line item is on the sheet');
    if (itemRow) {
      const clientCell = itemRow.row.getCell(5);
      ok(typeof clientCell.value === 'number', 'a line\'s Client budget is a NUMBER, not a formatted string',
        JSON.stringify(clientCell.value));
      ok(String(clientCell.numFmt || '').includes('$'), 'and it carries a currency format', String(clientCell.numFmt));
    }
    const subtotals = [];
    budget.eachRow({ includeEmpty: false }, (row) => {
      if (String(row.getCell(2).value ?? '') === 'Subtotal') subtotals.push(row);
    });
    ok(subtotals.length === 17, 'one subtotal row per division — all seventeen', String(subtotals.length));
    const allSubtotalsAreFormulas = subtotals.every((r) =>
      [5, 6, 7, 8].every((c) => r.getCell(c).value && typeof r.getCell(c).value === 'object' && 'formula' in r.getCell(c).value));
    ok(allSubtotalsAreFormulas, 'every division subtotal is a live SUM formula, not a pasted value');

    const grand = findRow(budget, 2, 'ALL DIVISIONS');
    ok(!!grand, 'the grand-total bar exists');
    const grandIsFormula = grand && [5, 6, 7, 8].every((c) => {
      const v = grand.row.getCell(c).value;
      return v && typeof v === 'object' && 'formula' in v;
    });
    ok(grandIsFormula, 'and both grand totals are formulas over the division subtotals');

    // ══ 4. Sheet 1 Paid is a CROSS-SHEET formula against Payments ═══════════
    const paidCell = itemRow && itemRow.row.getCell(7);
    const paidFormula = paidCell && paidCell.value && typeof paidCell.value === 'object' ? paidCell.value.formula : '';
    ok(/Payments!/.test(paidFormula || ''),
      'Sheet 1 Paid to date is a cross-sheet formula reading Payments — the two cannot disagree',
      String(paidFormula));
    note('paid formula: ' + paidFormula);

    // ══ 5. every division present, empty ones carry exactly one "No items" ══
    const bands = [];
    budget.eachRow({ includeEmpty: false }, (row) => {
      const v = String(row.getCell(1).value ?? '');
      if (/^\d{2}$/.test(v) && row.getCell(2).value) bands.push(v);
    });
    ok(bands.length === 17, 'all seventeen divisions appear, including the empty ones', bands.join(','));
    const noItems = cellsIn(budget, 2).filter((x) => String(x.cell.value ?? '') === 'No items');
    // seeded divisions are 3, 6, 9, 16, 17 -> 12 empty
    ok(noItems.length === 12, 'each of the twelve empty divisions carries exactly one "No items" row', String(noItems.length));

    // ══ 6. allowance tick + the page's own wording ══════════════════════════
    const allowRow = findRow(budget, 2, 'Tile allowance');
    const plainRow = findRow(budget, 2, 'Framing package');
    ok(allowRow && String(allowRow.row.getCell(3).value ?? '') === '✓', 'the allowance line shows a tick in Allw');
    ok(plainRow && !String(plainRow.row.getCell(3).value ?? '').trim(), 'a non-allowance line shows no tick');
    const allowFmt = allowRow ? String(allowRow.row.getCell(8).numFmt || '') : '';
    ok(/unspent/.test(allowFmt), 'the allowance Remaining reads "unspent" — as a number FORMAT, so it still re-sums', allowFmt);
    ok(!/unspent/.test(plainRow ? String(plainRow.row.getCell(8).numFmt || '') : 'x'),
      'and a non-allowance line does not');

    // ══ 7. the Payments tab lists every stored payment ═════════════════════
    const [storedPayments] = await conn.query(
      `SELECT p.amount, p.check_number, p.method FROM division_lineitem_payments p
         JOIN division_lineitems li ON li.id = p.lineitem_id
        WHERE li.job_id = 900 ORDER BY p.id`);
    const sheetAmounts = [];
    payments.eachRow({ includeEmpty: false }, (row, n) => {
      const a = row.getCell(8).value;
      const isHeaderish = String(row.getCell(5).value ?? '').startsWith('Total paid') || String(row.getCell(5).value ?? '') === 'All subcontractors';
      if (typeof a === 'number' && !isHeaderish && row.getCell(6).value) sheetAmounts.push(a);
    });
    const expAmounts = storedPayments.map((p) => Number(p.amount)).sort((a, b) => a - b);
    const gotAmounts = [...sheetAmounts].sort((a, b) => a - b);
    ok(JSON.stringify(expAmounts) === JSON.stringify(gotAmounts),
      `the Payments tab lists all ${expAmounts.length} stored payments`,
      `expected ${JSON.stringify(expAmounts)} got ${JSON.stringify(gotAmounts)}`);

    const emDash = cellsIn(payments, 7).filter((x) => String(x.cell.value ?? '') === '—');
    ok(emDash.length === 2, 'the two payments with no cheque number carry an em dash, not a blank', String(emDash.length));

    // ══ 8. By-subcontractor balances, computed independently ═══════════════
    const expBySub = new Map();
    for (const r of rows) {
      const it = seeded.find((s) => s.id === r.id);
      const key = it.in_house === 1 ? 'IN HOUSE'
        : (it.subcontractor_id === 101 ? 'Ruiz Framing' : it.subcontractor_id === 102 ? 'Wire Electric' : '(no subcontractor)');
      if (!expBySub.has(key)) expBySub.set(key, { cost: 0, paid: 0 });
      expBySub.get(key).cost += r.sub_cost;
      expBySub.get(key).paid += r.paid;
    }
    // The By-subcontractor block reuses columns E..H lower down the sheet, and a
    // sub's NAME also appears on every payment row in column E. Searching the
    // whole sheet therefore finds a payment row first and reads its cheque
    // number as "paid" — which is exactly what happened on the first run. Anchor
    // the search below the block's own header instead.
    const bySubHeaderRow = (() => {
      let f = null;
      payments.eachRow({ includeEmpty: false }, (row, n) => {
        if (String(row.getCell(5).value ?? '') === 'Subcontractor' && String(row.getCell(6).value ?? '') === 'Sub cost') f = n;
      });
      return f;
    })();
    ok(!!bySubHeaderRow, 'the By-subcontractor block has its own header row', String(bySubHeaderRow));
    const findBelow = (sheet, col, text, after) => {
      let found = null;
      sheet.eachRow({ includeEmpty: false }, (row, n) => {
        if (!found && n > after && String(row.getCell(col).value ?? '').trim() === text) found = { n, row };
      });
      return found;
    };

    const balDiffs = [];
    for (const [name, e] of expBySub) {
      const hit = bySubHeaderRow ? findBelow(payments, 5, name, bySubHeaderRow) : null;
      if (!hit) { balDiffs.push(`${name}: row missing`); continue; }
      const cost = Number(hit.row.getCell(6).value);
      const paid = Number(hit.row.getCell(7).value);
      if (Math.abs(cost - e.cost) > 0.005) balDiffs.push(`${name} cost ${cost} vs ${e.cost}`);
      if (Math.abs(paid - e.paid) > 0.005) balDiffs.push(`${name} paid ${paid} vs ${e.paid}`);
      const bal = hit.row.getCell(8).value;
      if (!(bal && typeof bal === 'object' && 'formula' in bal)) balDiffs.push(`${name} balance is not a formula`);
    }
    ok(balDiffs.length === 0, 'every By-subcontractor row matches an independently computed sub cost and paid, with a live balance', balDiffs.join(' | '));
    note('by sub: ' + [...expBySub.entries()].map(([n, e]) => `${n} ${money(e.cost)}/${money(e.paid)}`).join(', '));

    // ══ 9. a job with ZERO payments ════════════════════════════════════════
    const zero = await exportFor(902, OWNER);
    ok(zero.status === 200, 'a job with no payments still exports 200', String(zero.status));
    const zbuf = Buffer.isBuffer(zero.body) ? zero.body : Buffer.from(zero.body || '');
    const zwb = new ExcelJS.Workbook();
    let zok = true;
    try { await zwb.xlsx.load(zbuf); } catch { zok = false; }
    ok(zok, 'and the file opens');
    const zpay = zwb.getWorksheet('Payments');
    ok(!!zpay, 'the Payments tab still exists when there are none');
    const ztotal = zpay && findRow(zpay, 5, 'Total paid');
    ok(ztotal && Number(ztotal.row.getCell(8).value) === 0, 'and Total paid reads 0.00 rather than erroring',
      ztotal ? JSON.stringify(ztotal.row.getCell(8).value) : 'row missing');

    // ══ 10. a job with NO BUDGET LINES AT ALL ══════════════════════════════
    const empty = await exportFor(901, OWNER);
    ok(empty.status === 200, 'a job with no budget lines exports rather than throwing', String(empty.status));
    const ebuf = Buffer.isBuffer(empty.body) ? empty.body : Buffer.from(empty.body || '');
    const ewb = new ExcelJS.Workbook();
    let eok = true;
    try { await ewb.xlsx.load(ebuf); } catch (e) { eok = false; note('empty-job load error: ' + e.message); }
    ok(eok, 'and that file opens too');
    const eNoItems = eok ? cellsIn(ewb.getWorksheet('Budget'), 2).filter((x) => String(x.cell.value ?? '') === 'No items') : [];
    ok(eNoItems.length === 17, 'with all seventeen divisions showing "No items"', String(eNoItems.length));

    // ══ 11. PERMISSION — sub and client get 403 and NO FILE ════════════════
    // Each refusal reports WHICH gate fired, so "403" cannot quietly become a
    // plan or ownership refusal while the category rule rots.
    const refusalOf = (r) => {
      try { return JSON.parse(Buffer.from(r.body || '').toString('utf8')).message || ''; }
      catch { return ''; }
    };

    const subRes = await exportFor(900, SUBTOK);
    ok(subRes.status === 403, 'a SUBCONTRACTOR calling the export endpoint gets 403', String(subRes.status));
    note('subcontractor refusal: ' + refusalOf(subRes));
    const subBuf = Buffer.isBuffer(subRes.body) ? subRes.body : Buffer.from(subRes.body || '');
    ok(subBuf.slice(0, 2).toString() !== 'PK', 'and no workbook is produced for them', subBuf.slice(0, 8).toString('hex'));

    const cliRes = await exportFor(900, CLIENTTOK);
    ok(cliRes.status === 403, 'a CLIENT calling the export endpoint gets 403', String(cliRes.status));
    note('client refusal: ' + refusalOf(cliRes));
    const cliBuf = Buffer.isBuffer(cliRes.body) ? cliRes.body : Buffer.from(cliRes.body || '');
    ok(cliBuf.slice(0, 2).toString() !== 'PK', 'and no workbook is produced for them either', cliBuf.slice(0, 8).toString('hex'));

    const empRes = await exportFor(900, EMPTOK);
    ok(empRes.status === 403, 'an EMPLOYEE gets 403 too — payments are owner-only', String(empRes.status));
    note('employee refusal: ' + refusalOf(empRes));
    // The employee is the one actor who reaches the category gate and passes it
    // (category 1 is not restricted job data) and the plan gate (resolveOwnerId
    // promotes employees to the owner's subscription). So their refusal is
    // requireAccountOwner's and nothing else's — which makes it the assertion
    // that actually pins that gate in place.
    ok(/account owner/i.test(refusalOf(empRes)),
      "and the employee's refusal comes from the owner-only rule, not the plan or ownership gate",
      refusalOf(empRes));

    // ══ 12. the permission test is MEANINGFUL ══════════════════════════════
    // Those strings must be present in the authorised file, or "absent from the
    // refusal" proves nothing.
    const haystack = buf.toString('latin1');
    // xlsx is a zip, so the readable strings live in the shared-strings part —
    // unzip via ExcelJS instead of grepping raw deflate.
    const allText = [];
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (c) => {
          const v = c.value;
          if (typeof v === 'string') allText.push(v);
        });
      });
    }
    const joined = allText.join('\n');
    ok(/Ruiz Framing/.test(joined), 'the authorised workbook DOES contain a subcontractor name');
    ok(/10421/.test(joined), 'and DOES contain a cheque number');
    ok(!/Ruiz Framing/.test(subBuf.toString('latin1')) && !/10421/.test(subBuf.toString('latin1')),
      'neither string appears anywhere in the subcontractor\'s refused response');
    ok(!/Ruiz Framing/.test(cliBuf.toString('latin1')) && !/10421/.test(cliBuf.toString('latin1')),
      'nor in the client\'s');

    // ══ 13. workbook-as-workbook ═══════════════════════════════════════════
    const frozen = (budget.views || []).some((v) => v.state === 'frozen' && v.ySplit > 0);
    ok(frozen, 'the Budget header row is frozen', JSON.stringify(budget.views));
    ok((payments.views || []).some((v) => v.state === 'frozen' && v.ySplit > 0), 'and the Payments one is too');
    const widths = budget.columns.map((c) => c.width);
    ok(widths.slice(0, 8).every((w) => w && w >= 6), 'every visible column has a width set — nothing arrives as #####', JSON.stringify(widths));
    ok(budget.pageSetup.orientation === 'landscape', 'print set-up is landscape', String(budget.pageSetup.orientation));
    ok(budget.pageSetup.fitToWidth === 1, 'and fits to one page wide', String(budget.pageSetup.fitToWidth));
    ok(/^\d+:\d+$/.test(String(budget.pageSetup.printTitlesRow || '')),
      'and repeats the header row on every printed page', String(budget.pageSetup.printTitlesRow));

    // ══ 14. a job name with a slash ════════════════════════════════════════
    const slash = await exportFor(903, OWNER);
    const cd = String(slash.headers['content-disposition'] || '');
    ok(slash.status === 200, 'the slash-named job exports', String(slash.status));
    ok(!/[\\/:*?"<>|]/.test((cd.match(/filename="([^"]+)"/) || [])[1] || ''),
      'its filename carries no character Windows or macOS rejects', cd);
    note('content-disposition: ' + cd);

    // ══ 15. sizes ══════════════════════════════════════════════════════════
    // A big job, built now so the figure is real rather than guessed.
    for (let i = 0; i < 200; i++) {
      await conn.query(
        `INSERT INTO division_lineitems (division_id,lineitem_description,amount,sub_cost,csi_number,job_id,owner_type,subcontractor_id,paid_amount,contingency,overhead_percent,profit_percent,gl_percent)
         VALUES (?,?,?,?,?,902,'job',?,?,6,10,8,2)`,
        [(i % 16) + 1, `Line item ${i + 1}`, 1000 + i, 800 + i, `${String((i % 16) + 1).padStart(2, '0')} 00 ${i}`, i % 2 ? 101 : 102, 100],
      );
    }
    const big = await exportFor(902, OWNER);
    const bigBuf = Buffer.isBuffer(big.body) ? big.body : Buffer.from(big.body || '');
    ok(big.status === 200 && bigBuf.slice(0, 2).toString() === 'PK', 'a 200+ line job exports a valid file', String(big.status));
    note(`file sizes — Mann ADU ${buf.length} bytes; 201-line job ${bigBuf.length} bytes`);

    // ══ the stored column vs the payments behind it ════════════════════════
    // Sheet 1 sums Sheet 2, so if paid_amount and the payment rows ever diverge
    // the workbook follows the payments. Worth knowing which is which.
    const [[chk]] = await conn.query(
      `SELECT (SELECT COALESCE(SUM(paid_amount),0) FROM division_lineitems WHERE job_id=900) AS col,
              (SELECT COALESCE(SUM(p.amount),0) FROM division_lineitem_payments p
                 JOIN division_lineitems li ON li.id=p.lineitem_id WHERE li.job_id=900) AS pay`);
    ok(Math.abs(Number(chk.col) - Number(chk.pay)) < 0.005,
      'the stored paid_amount column agrees with the payment rows behind it',
      `column ${chk.col} vs payments ${chk.pay}`);

    console.log(rec.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (e) {
    console.log(rec.join('\n'));
    console.error('HARNESS ERROR:', (e && e.stack) || e);
    fail++;
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})();
