'use strict';
/* BUDGET → A STYLED EXCEL WORKBOOK.
 *
 * Two sheets: `Budget` (the page, as a workbook) and `Payments` (the history,
 * which cannot go inline — one line item with six cheques would tear the grid
 * apart).
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: these are numbers, not pictures of
 * numbers. Every money cell is a real number carrying a currency format, every
 * subtotal and grand total is a live formula, and Sheet 1's Paid-to-date column
 * is a cross-sheet SUMIF against Sheet 2 so the two cannot disagree. A workbook
 * whose totals are pasted values is a PDF that lies about being a spreadsheet.
 *
 * THE ARITHMETIC IS THE PAGE'S, NOT A SECOND OPINION. Every total below mirrors
 * a getter in budget.component.ts exactly — including the parts that look odd:
 *
 *   buildingCost        Σ client budget over divisions 1..16 ONLY
 *   constructionServices  division 17 alone
 *   overhead / profit / contingency   % of buildingCost
 *   glInsurance         % of the CLIENT BUDGET (all divisions), not buildingCost
 *                       — the GL premium is on gross sales
 *   projectTotal        buildingCost + constructionServices + contingency
 *                       + overhead + profit + glInsurance
 *   remaining (a line)  MAX(0, subCost − paid)   ← floored at zero, per line
 *
 * If one of those is wrong it is wrong on the page too, and it gets fixed there
 * first. This file must never become the second place the rule lives.
 */

const ExcelJS = require('exceljs');

// ── palette ──────────────────────────────────────────────────────────────────
// ARGB, which is what ExcelJS wants. Taken from the app's own brand tokens so a
// printed budget matches the screen it came from.
const GOLD = 'FFF0AD2B';
const GOLD_RULE = 'FFC99A22';
const INK = 'FF2A2214';
const GREY = 'FF6B6B6B';
const GREY_SOFT = 'FF8A8A8A';
const RED = 'FFC0392B';
const GREEN = 'FF2E7D32';
const ZEBRA = 'FFF7F3EA';
const BAND_INK = 'FF3A2700';
const DARK_BAR = 'FF2A2214';
const WHITE = 'FFFFFFFF';

const MONEY = '$#,##0.00';
const MONEY_UNSPENT = '$#,##0.00" unspent"';
const MONEY_OVER = '$#,##0.00" over"';
const DATE_FMT = 'ddd d mmm yyyy';

// Sheet 1 columns. The hidden 9th carries the line-item id so Paid-to-date can
// SUMIF against the Payments sheet without matching on text.
const B_CSI = 1, B_ITEM = 2, B_ALLW = 3, B_SUB = 4,
      B_CLIENT = 5, B_COST = 6, B_PAID = 7, B_REM = 8, B_ID = 9;

// Sheet 2 columns, likewise.
const P_DATE = 1, P_DIV = 2, P_CSI = 3, P_ITEM = 4, P_SUBC = 5,
      P_METHOD = 6, P_REF = 7, P_AMOUNT = 8, P_ID = 9;

const num = (v) => (Number(v) || 0);

/**
 * Windows rejects \ / : * ? " < > | in a filename and macOS rejects :. A job
 * called "Mann ADU — Phase 1/2" has to save on both, so the separators become a
 * dash rather than vanishing (dropping them silently turns "1/2" into "12").
 */
function budgetExportFilename(jobName, dateYmd) {
  const safe = String(jobName || 'Budget')
    .replace(/[\\/:*?"<>|]+/g, '-')   // illegal on Windows and/or macOS
    .split('').filter(function (ch) { return ch.charCodeAt(0) > 31; }).join('')  // strip control characters
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')  // trailing dots break Windows too
    .slice(0, 120)
    .trim();
  return `${safe || 'Budget'} Budget ${dateYmd}.xlsx`;
}

/**
 * Everything the workbook needs, in one round trip per table.
 *
 * Returns the derived totals ALONGSIDE the raw rows, so a test can diff the
 * workbook against the same numbers the API serves without recomputing them a
 * third way.
 */
async function fetchBudgetExportData(connection, { jobId, ownerType, requestedByUserId }) {
  const isLead = String(ownerType || 'job').toLowerCase() === 'lead';

  let job = null;
  if (isLead) {
    const [[row]] = await connection.query(
      'SELECT id, lead_name AS name, address, city, state, zipcode FROM leads WHERE id = ? LIMIT 1',
      [jobId],
    );
    job = row || null;
  } else {
    const [[row]] = await connection.query(
      `SELECT id, name,
              COALESCE(NULLIF(job_address,''), address)  AS address,
              COALESCE(NULLIF(job_city,''), city)        AS city,
              COALESCE(NULLIF(job_state,''), state)      AS state,
              COALESCE(NULLIF(job_zipcode,''), zipcode)  AS zipcode
         FROM job WHERE id = ? LIMIT 1`,
      [jobId],
    );
    job = row || null;
  }

  const [[preparer]] = await connection.query(
    'SELECT name, business FROM `user` WHERE id = ? LIMIT 1',
    [requestedByUserId],
  );

  const [divisions] = await connection.query(
    'SELECT id, division_number, name, description FROM divisions ORDER BY division_number ASC, id ASC',
  );

  const [items] = await connection.query(
    `SELECT li.id, li.division_id, li.lineitem_description, li.amount, li.sub_cost,
            li.csi_number, li.subcontractor_id, li.in_house, li.is_allowance,
            li.paid_amount, li.contingency, li.overhead_percent, li.profit_percent,
            li.gl_percent,
            u.name AS subcontractor_name, u.business AS subcontractor_business
       FROM division_lineitems li
       LEFT JOIN \`user\` u ON u.id = li.subcontractor_id
      WHERE li.job_id = ? AND li.owner_type = ?
      ORDER BY li.division_id ASC, li.id ASC`,
    [Number(jobId), isLead ? 'lead' : 'job'],
  );

  const itemIds = items.map((i) => i.id);
  let payments = [];
  if (itemIds.length) {
    const [rows] = await connection.query(
      `SELECT p.id, p.lineitem_id, p.method, p.check_number, p.payment_date, p.amount
         FROM division_lineitem_payments p
        WHERE p.lineitem_id IN (?)
        ORDER BY p.payment_date ASC, p.id ASC`,
      [itemIds],
    );
    payments = rows || [];
  }

  // ── the page's arithmetic, restated ────────────────────────────────────────
  const byDivision = new Map();
  for (const d of divisions) byDivision.set(d.id, { division: d, items: [] });
  for (const it of items) {
    if (!byDivision.has(it.division_id)) {
      // A line pointing at a division row that no longer exists would otherwise
      // vanish from the export without anyone noticing. Keep it under a stub.
      byDivision.set(it.division_id, {
        division: { id: it.division_id, division_number: it.division_id, name: 'Unknown division', description: '' },
        items: [],
      });
    }
    byDivision.get(it.division_id).items.push(it);
  }
  const groups = [...byDivision.values()].sort(
    (a, b) => num(a.division.division_number) - num(b.division.division_number) || num(a.division.id) - num(b.division.id),
  );

  const divTotal = (g) => g.items.reduce((s, i) => s + num(i.amount), 0);
  const divCost = (g) => g.items.reduce((s, i) => s + num(i.sub_cost), 0);
  const divPaid = (g) => g.items.reduce((s, i) => s + num(i.paid_amount), 0);
  const divRemaining = (g) => g.items.reduce((s, i) => s + Math.max(0, num(i.sub_cost) - num(i.paid_amount)), 0);

  // The four percentages are stored per line (denormalised); the page reads them
  // off the rows, so the first line that carries one wins here too.
  const pct = (field, fallback) => {
    const row = items.find((i) => i[field] !== null && i[field] !== undefined);
    return row ? Number(row[field]) : fallback;
  };
  const contingencyPercent = pct('contingency', 6);
  const overheadPercent = pct('overhead_percent', 0);
  const profitPercentRaw = items.find((i) => i.profit_percent !== null && i.profit_percent !== undefined);
  const profitPercent = profitPercentRaw ? Number(profitPercentRaw.profit_percent) : null;
  const glPercent = pct('gl_percent', 0);

  const totalClientBudget = groups.reduce((s, g) => s + divTotal(g), 0);
  const totalYourCost = groups.reduce((s, g) => s + divCost(g), 0);
  const totalPaidToDate = groups.reduce((s, g) => s + divPaid(g), 0);
  const totalRemaining = groups.reduce((s, g) => s + divRemaining(g), 0);

  const buildingCost = groups
    .filter((g) => num(g.division.id) >= 1 && num(g.division.id) <= 16)
    .reduce((s, g) => s + divTotal(g), 0);
  const d17 = groups.find((g) => num(g.division.id) === 17);
  const constructionServices = d17 ? divTotal(d17) : 0;

  const pctOf = (base, p) => {
    const n = Number(p);
    if (p == null || isNaN(n) || n <= 0) return 0;
    return base * (n / 100);
  };
  const overhead = pctOf(buildingCost, overheadPercent);
  const profit = pctOf(buildingCost, profitPercent);
  // GROSS = building cost + profit (Poul's confirmed base — interpretation A).
  // GL insurance and builder's contingency are % of gross (not building cost /
  // client budget). Non-circular: gross depends only on buildingCost + profit.
  const gross = buildingCost + profit;
  const contingency = pctOf(gross, contingencyPercent);
  const glInsurance = pctOf(gross, glPercent);
  const projectTotal = buildingCost + constructionServices + contingency + overhead + profit + glInsurance;

  // paid_amount is a stored column; the payments table is the detail behind it.
  // They CAN disagree (a payment written before the column existed, a manual
  // edit). Sheet 1 sums the payments, so the divergence is surfaced here rather
  // than silently resolved one way.
  const paidFromPayments = payments.reduce((s, p) => s + num(p.amount), 0);

  return {
    job,
    preparer: preparer || null,
    groups,
    items,
    payments,
    percents: { contingencyPercent, overheadPercent, profitPercent, glPercent },
    totals: {
      totalClientBudget, totalYourCost, totalPaidToDate, totalRemaining,
      buildingCost, constructionServices, gross, contingency, overhead, profit,
      glInsurance, projectTotal,
      paidFromPayments,
      paidColumnMatchesPayments: Math.abs(paidFromPayments - totalPaidToDate) < 0.005,
    },
    perDivision: groups.map((g) => ({
      id: g.division.id,
      number: g.division.division_number,
      name: g.division.name,
      clientBudget: divTotal(g),
      subCost: divCost(g),
      paid: divPaid(g),
      remaining: divRemaining(g),
      itemCount: g.items.length,
    })),
  };
}

// ── small styling helpers ────────────────────────────────────────────────────
const setMoney = (cell, value, fmt = MONEY) => {
  cell.value = value;
  cell.numFmt = fmt;
};
const bold = (cell, color = INK) => { cell.font = { bold: true, color: { argb: color } }; };
const greyCaps = (cell) => {
  cell.font = { size: 8, bold: true, color: { argb: GREY } };
  cell.alignment = { horizontal: 'left' };
};
const fill = (cell, argb) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; };
const goldTop = (cell) => { cell.border = { ...(cell.border || {}), top: { style: 'medium', color: { argb: GOLD_RULE } } }; };

function subcontractorLabel(item) {
  if (Number(item.in_house) === 1) return 'IN HOUSE';
  return item.subcontractor_business || item.subcontractor_name || '';
}

function titleBlock(sheet, data, subtitleSuffix, lastCol) {
  const jobName = (data.job && data.job.name) || 'Budget';
  const addr = [data.job && data.job.address, data.job && data.job.city,
                data.job && data.job.state, data.job && data.job.zipcode]
    .map((s) => String(s || '').trim()).filter(Boolean).join(', ');
  const today = new Date();
  const asOf = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const who = [data.preparer && data.preparer.name, data.preparer && data.preparer.business]
    .map((s) => String(s || '').trim()).filter(Boolean).join(', ');

  const t = sheet.getRow(1);
  t.getCell(1).value = subtitleSuffix ? `${jobName} — ${subtitleSuffix}` : jobName;
  t.getCell(1).font = { size: 19, bold: true, color: { argb: INK } };
  t.height = 26;
  sheet.mergeCells(1, 1, 1, lastCol);

  const meta = sheet.getRow(2);
  meta.getCell(1).value = [addr, `Budget as of ${asOf}`, who ? `Prepared by ${who}` : '']
    .filter(Boolean).join('  ·  ');
  meta.getCell(1).font = { size: 9, color: { argb: GREY } };
  sheet.mergeCells(2, 1, 2, lastCol);

  // The 2pt gold rule: an empty short row carrying a bottom border across the
  // full width. A merged cell would only paint the border on the merge anchor.
  const rule = sheet.getRow(3);
  rule.height = 4;
  for (let c = 1; c <= lastCol; c++) {
    rule.getCell(c).border = { bottom: { style: 'medium', color: { argb: GOLD_RULE } } };
  }
  return 4;
}

function buildBudgetSheet(wb, data) {
  const sheet = wb.addWorksheet('Budget', {
    views: [{ state: 'frozen', ySplit: 0 }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  sheet.columns = [
    { width: 10 },  // CSI
    { width: 46 },  // Item
    { width: 6 },   // Allw
    { width: 26 },  // Subcontractor
    { width: 16 },  // Client budget
    { width: 16 },  // Sub cost
    { width: 16 },  // Paid to date
    { width: 18 },  // Remaining
    { width: 10 },  // hidden line-item id
  ];
  sheet.getColumn(B_ID).hidden = true;

  let r = titleBlock(sheet, data, '', B_REM);
  r += 1;

  // ── the four totals, boxed across the width ──────────────────────────────
  const t = data.totals;
  // CLIENT BUDGET tile = full Project Total; YOUR COST tile = raw sub cost + GL
  // insurance + builder's contingency (NO profit) — Poul's confirmed tile rules,
  // matching the on-screen Budget summary.
  const boxes = [
    ['CLIENT BUDGET', t.projectTotal, INK],
    ['YOUR COST', t.totalYourCost + t.glInsurance + t.contingency, RED],
    ['PAID TO DATE', t.totalPaidToDate, GREEN],
    ['REMAINING', t.totalRemaining, INK],
  ];
  const labelRow = sheet.getRow(r);
  const valueRow = sheet.getRow(r + 1);
  boxes.forEach(([label, value, color], i) => {
    const col = B_CLIENT + i - 4 > 0 ? i + 1 : i + 1; // A..D
    greyCaps(labelRow.getCell(col));
    labelRow.getCell(col).value = label;
    const vc = valueRow.getCell(col);
    setMoney(vc, value);
    vc.font = { size: 13, bold: true, color: { argb: color } };
    vc.border = {
      top: { style: 'thin', color: { argb: GOLD_RULE } },
      left: { style: 'thin', color: { argb: GOLD_RULE } },
      bottom: { style: 'thin', color: { argb: GOLD_RULE } },
      right: { style: 'thin', color: { argb: GOLD_RULE } },
    };
  });
  valueRow.height = 22;
  r += 3;

  // ── the summary block ────────────────────────────────────────────────────
  const p = data.percents;
  const summary = [
    ['Building cost', null, t.buildingCost],
    ['Construction services', null, t.constructionServices],
    ['Overhead', p.overheadPercent, t.overhead],
    ['Profit', p.profitPercent, t.profit],
    ['General liability insurance', p.glPercent, t.glInsurance],
    ["Builder's contingency", p.contingencyPercent, t.contingency],
  ];
  for (const [label, percent, value] of summary) {
    const row = sheet.getRow(r);
    row.getCell(B_ITEM).value = label;
    if (percent != null && Number(percent) > 0) {
      row.getCell(B_ALLW).value = `${Number(percent)}%`;
      row.getCell(B_ALLW).font = { size: 9, color: { argb: GREY } };
      row.getCell(B_ALLW).alignment = { horizontal: 'left' };
    }
    setMoney(row.getCell(B_REM), value);
    r += 1;
  }
  const ptRow = sheet.getRow(r);
  ptRow.getCell(B_ITEM).value = 'Project total';
  bold(ptRow.getCell(B_ITEM));
  setMoney(ptRow.getCell(B_REM), t.projectTotal);
  bold(ptRow.getCell(B_REM));
  goldTop(ptRow.getCell(B_ITEM));
  goldTop(ptRow.getCell(B_REM));
  goldTop(ptRow.getCell(B_ALLW));
  r += 2;

  // ── column headers (the freeze line sits under this row) ─────────────────
  const headerRowIndex = r;
  const head = sheet.getRow(r);
  ['CSI', 'Item', 'Allw', 'Subcontractor', 'Client budget', 'Sub cost', 'Paid to date', 'Remaining']
    .forEach((h, i) => {
      const c = head.getCell(i + 1);
      c.value = h;
      c.font = { size: 9, bold: true, color: { argb: WHITE } };
      fill(c, DARK_BAR);
      c.alignment = { horizontal: i >= 4 ? 'right' : 'left' };
    });
  head.height = 18;
  sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];
  sheet.autoFilter = { from: { row: headerRowIndex, column: 1 }, to: { row: headerRowIndex, column: B_REM } };
  r += 1;

  // ── every division, in CSI order, INCLUDING the empty ones ───────────────
  const subtotalRows = [];
  for (const g of data.groups) {
    const d = g.division;
    const band = sheet.getRow(r);
    band.getCell(B_CSI).value = String(d.division_number ?? d.id).padStart(2, '0');
    band.getCell(B_ITEM).value = d.description
      ? `${d.name}   —   ${d.description}`
      : d.name;
    for (let c = 1; c <= B_REM; c++) {
      fill(band.getCell(c), GOLD);
      band.getCell(c).font = { bold: true, size: 10, color: { argb: BAND_INK } };
    }
    band.getCell(B_ITEM).font = { bold: true, size: 10, color: { argb: BAND_INK } };
    const bandRowIndex = r;
    r += 1;

    const firstItemRow = r;
    if (!g.items.length) {
      // An empty division still appears. A builder scanning for 13 must not
      // think the export is broken.
      const none = sheet.getRow(r);
      none.getCell(B_ITEM).value = 'No items';
      none.getCell(B_ITEM).font = { italic: true, color: { argb: GREY_SOFT }, size: 10 };
      r += 1;
    } else {
      g.items.forEach((it, idx) => {
        const row = sheet.getRow(r);
        row.getCell(B_CSI).value = it.csi_number || '';
        row.getCell(B_ITEM).value = it.lineitem_description || '';
        if (Number(it.is_allowance) === 1) {
          row.getCell(B_ALLW).value = '✓';
          row.getCell(B_ALLW).alignment = { horizontal: 'center' };
        }
        row.getCell(B_SUB).value = subcontractorLabel(it);
        setMoney(row.getCell(B_CLIENT), num(it.amount));
        setMoney(row.getCell(B_COST), num(it.sub_cost));

        // PAID IS A CROSS-SHEET FORMULA, not the stored paid_amount column, so
        // Sheet 1 and Sheet 2 cannot disagree: add a payment on Sheet 2 and this
        // follows. The hidden id column is what it matches on — matching on the
        // item text would break the moment two divisions share a description.
        row.getCell(B_ID).value = it.id;
        row.getCell(B_PAID).value = {
          formula: `SUMIF(Payments!$I:$I,$I${r},Payments!$H:$H)`,
        };
        row.getCell(B_PAID).numFmt = MONEY;

        // Remaining stays a NUMBER on an allowance line; the " unspent" wording
        // is a number FORMAT, not a string. It still sorts and re-sums.
        const remCell = row.getCell(B_REM);
        if (Number(it.is_allowance) === 1) {
          remCell.value = { formula: `ABS(F${r}-G${r})` };
          remCell.numFmt = num(it.paid_amount) > num(it.sub_cost) ? MONEY_OVER : MONEY_UNSPENT;
        } else {
          remCell.value = { formula: `MAX(0,F${r}-G${r})` };
          remCell.numFmt = MONEY;
        }

        if (idx % 2 === 1) {
          for (let c = 1; c <= B_REM; c++) fill(row.getCell(c), ZEBRA);
        }
        r += 1;
      });
    }
    const lastItemRow = r - 1;

    // ── subtotal: a LIVE formula over this division's rows ─────────────────
    const sub = sheet.getRow(r);
    sub.getCell(B_ITEM).value = 'Subtotal';
    bold(sub.getCell(B_ITEM));
    for (const col of [B_CLIENT, B_COST, B_PAID, B_REM]) {
      const letter = String.fromCharCode(64 + col);
      const c = sub.getCell(col);
      c.value = { formula: `SUM(${letter}${firstItemRow}:${letter}${lastItemRow})` };
      c.numFmt = MONEY;
      bold(c);
      c.border = { top: { style: 'thin', color: { argb: GOLD_RULE } } };
    }
    subtotalRows.push(r);

    // The band's own four totals point AT the subtotal, rather than summing the
    // rows a second time — two formulas over the same range is two chances to
    // disagree after someone inserts a row.
    for (const col of [B_CLIENT, B_COST, B_PAID, B_REM]) {
      const letter = String.fromCharCode(64 + col);
      const c = sheet.getRow(bandRowIndex).getCell(col);
      c.value = { formula: `${letter}${r}` };
      c.numFmt = MONEY;
      c.font = { bold: true, size: 10, color: { argb: BAND_INK } };
      c.alignment = { horizontal: 'right' };
    }

    r += 2;
  }

  // ── grand total ──────────────────────────────────────────────────────────
  const grand = sheet.getRow(r);
  grand.getCell(B_ITEM).value = 'ALL DIVISIONS';
  for (let c = 1; c <= B_REM; c++) {
    fill(grand.getCell(c), DARK_BAR);
    grand.getCell(c).font = { bold: true, color: { argb: WHITE } };
  }
  for (const col of [B_CLIENT, B_COST, B_PAID, B_REM]) {
    const letter = String.fromCharCode(64 + col);
    const c = grand.getCell(col);
    c.value = { formula: subtotalRows.map((n) => `${letter}${n}`).join('+') || '0' };
    c.numFmt = MONEY;
    c.font = { bold: true, color: { argb: WHITE } };
    c.alignment = { horizontal: 'right' };
  }
  grand.height = 20;

  // Repeat the header row on every printed page.
  sheet.pageSetup.printTitlesRow = `${headerRowIndex}:${headerRowIndex}`;

  return { headerRowIndex, subtotalRows, grandRow: r };
}

function buildPaymentsSheet(wb, data) {
  const sheet = wb.addWorksheet('Payments', {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  sheet.columns = [
    { width: 16 },  // Date
    { width: 7 },   // Div
    { width: 10 },  // CSI
    { width: 40 },  // Item
    { width: 26 },  // Subcontractor
    { width: 11 },  // Method
    { width: 16 },  // Reference
    { width: 16 },  // Amount
    { width: 10 },  // hidden line-item id
  ];
  sheet.getColumn(P_ID).hidden = true;

  let r = titleBlock(sheet, data, 'Payments', P_AMOUNT);
  r += 1;

  const headerRowIndex = r;
  const head = sheet.getRow(r);
  ['Date', 'Div', 'CSI', 'Item', 'Subcontractor', 'Method', 'Reference', 'Amount']
    .forEach((h, i) => {
      const c = head.getCell(i + 1);
      c.value = h;
      c.font = { size: 9, bold: true, color: { argb: WHITE } };
      fill(c, DARK_BAR);
      c.alignment = { horizontal: i === P_AMOUNT - 1 ? 'right' : 'left' };
    });
  head.height = 18;
  sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];
  r += 1;

  // index the line items so each payment can name its division, CSI and sub
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const divById = new Map(data.groups.map((g) => [g.division.id, g.division]));

  const firstPaymentRow = r;
  data.payments.forEach((p, idx) => {
    const it = itemById.get(p.lineitem_id) || {};
    const div = divById.get(it.division_id);
    const row = sheet.getRow(r);

    // A REAL DATE, not a string — so it sorts and filters as a date.
    const d = p.payment_date instanceof Date ? p.payment_date : (p.payment_date ? new Date(p.payment_date) : null);
    if (d && !isNaN(d.getTime())) {
      row.getCell(P_DATE).value = d;
      row.getCell(P_DATE).numFmt = DATE_FMT;
    }
    row.getCell(P_DIV).value = div ? String(div.division_number ?? div.id).padStart(2, '0') : '';
    row.getCell(P_CSI).value = it.csi_number || '';
    row.getCell(P_ITEM).value = it.lineitem_description || '';
    row.getCell(P_SUBC).value = subcontractorLabel(it);

    const m = sheet.getRow(r).getCell(P_METHOD);
    m.value = String(p.method || '').toUpperCase();
    m.font = { size: 8, bold: true, color: { argb: BAND_INK } };
    m.alignment = { horizontal: 'center' };
    fill(m, GOLD);

    // An em dash where there is no cheque number — an empty cell reads as a
    // missing value rather than a deliberate "there isn't one".
    row.getCell(P_REF).value = String(p.check_number || '').trim() || '—';
    setMoney(row.getCell(P_AMOUNT), num(p.amount));
    row.getCell(P_ID).value = p.lineitem_id;

    if (idx % 2 === 1) for (let c = 1; c <= P_AMOUNT; c++) fill(row.getCell(c), ZEBRA);
    r += 1;
  });
  const lastPaymentRow = r - 1;

  const totalRow = sheet.getRow(r);
  totalRow.getCell(P_SUBC).value = 'Total paid';
  bold(totalRow.getCell(P_SUBC));
  const tc = totalRow.getCell(P_AMOUNT);
  tc.value = data.payments.length
    ? { formula: `SUM(H${firstPaymentRow}:H${lastPaymentRow})` }
    : 0;
  tc.numFmt = MONEY;
  bold(tc);
  goldTop(tc);
  goldTop(totalRow.getCell(P_SUBC));
  r += 3;

  // ── By subcontractor — the point of this tab ─────────────────────────────
  // "What do I still owe Guillermo on this job" currently means opening every
  // division he appears in and adding it up.
  const bySub = new Map();
  for (const it of data.items) {
    const key = subcontractorLabel(it) || '(no subcontractor)';
    if (!bySub.has(key)) bySub.set(key, { subCost: 0, paid: 0 });
    const e = bySub.get(key);
    e.subCost += num(it.sub_cost);
    e.paid += num(it.paid_amount);
  }

  const bsHead = sheet.getRow(r);
  ['Subcontractor', 'Sub cost', 'Paid', 'Balance left'].forEach((h, i) => {
    const c = bsHead.getCell(i === 0 ? P_SUBC : P_SUBC + i);
    c.value = h;
    c.font = { size: 9, bold: true, color: { argb: WHITE } };
    fill(c, DARK_BAR);
    c.alignment = { horizontal: i === 0 ? 'left' : 'right' };
  });
  r += 1;

  const bsFirst = r;
  [...bySub.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([name, e]) => {
      const row = sheet.getRow(r);
      row.getCell(P_SUBC).value = name;
      setMoney(row.getCell(P_SUBC + 1), e.subCost);
      setMoney(row.getCell(P_SUBC + 2), e.paid);
      const bal = row.getCell(P_SUBC + 3);
      bal.value = { formula: `F${r}-G${r}` };
      bal.numFmt = MONEY;
      r += 1;
    });
  const bsLast = r - 1;

  const bsTotal = sheet.getRow(r);
  bsTotal.getCell(P_SUBC).value = 'All subcontractors';
  bold(bsTotal.getCell(P_SUBC));
  for (let i = 1; i <= 3; i++) {
    const col = P_SUBC + i;
    const letter = String.fromCharCode(64 + col);
    const c = bsTotal.getCell(col);
    c.value = bySub.size ? { formula: `SUM(${letter}${bsFirst}:${letter}${bsLast})` } : 0;
    c.numFmt = MONEY;
    bold(c);
    goldTop(c);
  }
  goldTop(bsTotal.getCell(P_SUBC));

  sheet.pageSetup.printTitlesRow = `${headerRowIndex}:${headerRowIndex}`;
  return { headerRowIndex, bySubCount: bySub.size };
}

function buildBudgetWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SeeJobRun';
  wb.created = new Date();
  // Payments is built FIRST so Sheet 1's cross-sheet SUMIF resolves against a
  // sheet that already exists, then moved behind Budget for tab order.
  const budget = buildBudgetSheet(wb, data);
  const payments = buildPaymentsSheet(wb, data);
  return { workbook: wb, layout: { budget, payments } };
}

module.exports = {
  fetchBudgetExportData,
  buildBudgetWorkbook,
  budgetExportFilename,
};
