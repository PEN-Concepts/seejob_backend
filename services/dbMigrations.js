'use strict';

// One-time, idempotent schema fixes that code paths depend on.

// contact.status was an ENUM('Pending','Accept','Reject'); the contacts hub
// also stores 'Saved' (saved but not invited). Widen to VARCHAR once.
let contactStatusEnsured = false;
async function ensureContactStatusColumn(connection) {
  if (contactStatusEnsured) return;
  const [[col]] = await connection.query(
    `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contact' AND COLUMN_NAME = 'status'`
  );
  if (col && /^enum/i.test(col.COLUMN_TYPE) && !col.COLUMN_TYPE.includes('Saved')) {
    await connection.query(`UPDATE contact SET status = 'Pending' WHERE status IS NULL OR status = ''`);
    await connection.query(
      `ALTER TABLE contact MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'Pending'`
    );
  }
  contactStatusEnsured = true;
}

// leads.bid_status may be an ENUM('New Bid','Bid Now','Waiting','Lost Project').
// The Archive feature adds an 'Archived' value; widen to VARCHAR so any string
// (incl. 'Archived') is accepted. Idempotent — only ALTERs when the column is
// not already a wide-enough VARCHAR (e.g. still an ENUM).
let leadBidStatusEnsured = false;
async function ensureLeadBidStatusColumn(connection) {
  if (leadBidStatusEnsured) return;
  const [[col]] = await connection.query(
    `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'bid_status'`
  );
  if (col) {
    const t = String(col.COLUMN_TYPE || '');
    const m = /^varchar\((\d+)\)/i.exec(t);
    const isWideVarchar = !!m && Number(m[1]) >= 30;
    if (!isWideVarchar) {
      await connection.query(
        `ALTER TABLE leads MODIFY COLUMN bid_status VARCHAR(50) NULL DEFAULT NULL`
      );
    }
    // prior_bid_status remembers the status before archiving so Unarchive can
    // restore it (instead of forcing 'Waiting').
    const [pcols] = await connection.query(`SHOW COLUMNS FROM leads LIKE 'prior_bid_status'`);
    if (!pcols.length) {
      await connection.query(
        `ALTER TABLE leads ADD COLUMN prior_bid_status VARCHAR(50) NULL DEFAULT NULL`
      );
    }
  }
  leadBidStatusEnsured = true;
}

// The lead detail view reuses the job Budget/Stage/Materials/Contacts panels,
// passing the LEAD id in the job_id column. Those four tables historically keyed
// rows purely by job_id with no type discriminator, so a lead and a job with the
// same id would read/write each other's rows once their id ranges overlap.
// owner_type disambiguates every row: 'job' (default) or 'lead'.
let ownerTypeEnsured = false;
async function ensureOwnerTypeColumns(connection) {
  if (ownerTypeEnsured) return;
  const tables = ['division_lineitems', 'stages', 'materials', 'job_contacts'];
  for (const t of tables) {
    const [cols] = await connection.query(
      `SHOW COLUMNS FROM ${t} LIKE 'owner_type'`
    );
    if (!cols.length) {
      await connection.query(
        `ALTER TABLE ${t} ADD COLUMN owner_type VARCHAR(8) NOT NULL DEFAULT 'job'`
      );
      // One-time backfill, run once right after the column is added: any existing
      // row whose job_id is unambiguously a LEAD id (present in leads, absent from
      // job) belongs to a lead. This is only safe because at migration time the
      // job/lead id ranges do not overlap, so no row can be both.
      await connection.query(
        `UPDATE ${t} SET owner_type = 'lead'
         WHERE job_id IN (SELECT id FROM leads)
           AND job_id NOT IN (SELECT id FROM job)`
      );
    }
  }
  ownerTypeEnsured = true;
}

// Materials redesign (2026-08-31): the table originally had item_type/room/material/
// manufacturer/size/color. The new 9-field spec adds three net-new columns —
// category (a fixed dropdown), location (the card title), and finish. Additive +
// idempotent; existing columns are relabelled in the UI (item_type→Material/Type,
// material→Color, color→Model/Code #), no data touched.
let materialsExtraColsEnsured = false;
async function ensureMaterialsExtraColumns(connection) {
  if (materialsExtraColsEnsured) return;
  for (const col of ['category', 'location', 'finish']) {
    const [cols] = await connection.query(`SHOW COLUMNS FROM materials LIKE '${col}'`);
    if (!cols.length) {
      await connection.query(`ALTER TABLE materials ADD COLUMN ${col} VARCHAR(45) NULL`);
    }
  }
  materialsExtraColsEnsured = true;
}

// Job Budget: `sub_cost` = what the subcontractor charges you for a line, stored
// alongside `amount` (= what you bill the client / "Client budget"). Additive,
// idempotent; runs once per process before a budget save/load.
let subCostEnsured = false;
async function ensureSubCostColumn(connection) {
  if (subCostEnsured) return;
  const [cols] = await connection.query(
    `SHOW COLUMNS FROM division_lineitems LIKE 'sub_cost'`
  );
  if (!cols.length) {
    await connection.query(
      `ALTER TABLE division_lineitems ADD COLUMN sub_cost DECIMAL(12,2) NULL DEFAULT NULL`
    );
  }
  subCostEnsured = true;
}

// Job Budget: `in_house` = the line item is done by the company's own crew
// (the viewing account itself) instead of a subcontractor. Mutually exclusive
// with subcontractor_id (when in_house=1 the sub id is forced NULL). Additive,
// idempotent; runs before a budget save/load.
let inHouseEnsured = false;
async function ensureInHouseColumn(connection) {
  if (inHouseEnsured) return;
  const [cols] = await connection.query(
    `SHOW COLUMNS FROM division_lineitems LIKE 'in_house'`
  );
  if (!cols.length) {
    await connection.query(
      `ALTER TABLE division_lineitems ADD COLUMN in_house TINYINT NOT NULL DEFAULT 0`
    );
  }
  inHouseEnsured = true;
}

// Job Budget: `is_allowance` = this line is an ALLOWANCE (a budgeted figure whose
// actual cost is settled later). Purely a per-line flag set by an explicit
// checkbox — never inferred from the line's name. Drives the allowance column's
// row tint + over/unspent language on the FE. Additive, idempotent; runs before a
// budget save/load. NOTE: contingency is a job-level percentage, NOT an allowance,
// and never uses this flag.
let allowanceEnsured = false;
async function ensureAllowanceColumn(connection) {
  if (allowanceEnsured) return;
  const [cols] = await connection.query(
    `SHOW COLUMNS FROM division_lineitems LIKE 'is_allowance'`
  );
  if (!cols.length) {
    await connection.query(
      `ALTER TABLE division_lineitems ADD COLUMN is_allowance TINYINT NOT NULL DEFAULT 0`
    );
  }
  allowanceEnsured = true;
}

// Job Budget summary-card percentages, stored per line item like `contingency`
// (same value across a job's rows, updated by job_id). overhead_percent (O&P,
// calc off Building Cost) + gl_percent (General liability, calc off Client
// budget). Additive, idempotent.
let budgetPercentEnsured = false;
async function ensureBudgetPercentColumns(connection) {
  if (budgetPercentEnsured) return;
  for (const col of ['overhead_percent', 'gl_percent']) {
    const [cols] = await connection.query(`SHOW COLUMNS FROM division_lineitems LIKE '${col}'`);
    if (!cols.length) {
      await connection.query(`ALTER TABLE division_lineitems ADD COLUMN ${col} DECIMAL(7,3) NOT NULL DEFAULT 0`);
    }
  }
  // profit_percent: split out of the old combined "Overhead & profit" field. Kept
  // NULLABLE (NOT default 0) ON PURPOSE — a legacy budget that predates the split
  // has profit_percent = NULL, which lets the FE tell "never split" (show the
  // one-time re-split prompt, and DON'T fire the zero-profit warning) apart from a
  // user who deliberately set profit to 0. No existing value is ever touched: a
  // legacy overhead_percent stays as Overhead, profit is NULL, and every contract
  // total is preserved exactly (a NULL profit contributes nothing to the total).
  const [pcol] = await connection.query(`SHOW COLUMNS FROM division_lineitems LIKE 'profit_percent'`);
  if (!pcol.length) {
    await connection.query(`ALTER TABLE division_lineitems ADD COLUMN profit_percent DECIMAL(7,3) NULL DEFAULT NULL`);
  }
  budgetPercentEnsured = true;
}

// Subcontractor payments recorded against a budget line item's sub_cost.
// `division_lineitem_payments` holds the live payment rows; every create/edit/
// delete is also logged to `division_lineitem_payment_audit` (old/new JSON
// snapshot + who + when) so the audit trail survives even a hard delete. Both
// are first-class migrated tables (unlike the older *_history tables).
let paymentsTablesEnsured = false;
async function ensurePaymentsTables(connection) {
  if (paymentsTablesEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS division_lineitem_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      lineitem_id INT NOT NULL,
      method VARCHAR(20) NOT NULL,
      check_number VARCHAR(50) NULL,
      payment_date DATE NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by INT NULL,
      updated_at DATETIME NULL,
      INDEX idx_dlp_lineitem (lineitem_id)
    ) ENGINE=InnoDB
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS division_lineitem_payment_audit (
      id INT AUTO_INCREMENT PRIMARY KEY,
      payment_id INT NULL,
      lineitem_id INT NULL,
      action VARCHAR(10) NOT NULL,
      old_value TEXT NULL,
      new_value TEXT NULL,
      changed_by INT NULL,
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dlpa_lineitem (lineitem_id),
      INDEX idx_dlpa_payment (payment_id)
    ) ENGINE=InnoDB
  `);
  paymentsTablesEnsured = true;
}

// ---- Budget lock (fixed baseline) ----
// Once a project starts being built, the account owner (interim; Employee Levels
// pending) can LOCK the Budget tab: the summary card's calculated values freeze
// as a stored snapshot and every division line item becomes read-only. Only a
// signed Change Order (or an owner Unlock) may change it afterward. `budget_locks`
// holds one row per (job_id, owner_type); `budget_lock_audit` logs every
// lock/unlock (who + when).
let budgetLockTablesEnsured = false;
async function ensureBudgetLockTables(connection) {
  if (budgetLockTablesEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS budget_locks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      job_id INT NOT NULL,
      owner_type VARCHAR(10) NOT NULL DEFAULT 'job',
      locked TINYINT NOT NULL DEFAULT 0,
      snapshot TEXT NULL,
      locked_by INT NULL,
      locked_by_name VARCHAR(255) NULL,
      locked_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_budget_lock (job_id, owner_type)
    ) ENGINE=InnoDB
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS budget_lock_audit (
      id INT AUTO_INCREMENT PRIMARY KEY,
      job_id INT NOT NULL,
      owner_type VARCHAR(10) NOT NULL DEFAULT 'job',
      action VARCHAR(10) NOT NULL,
      changed_by INT NULL,
      changed_by_name VARCHAR(255) NULL,
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bla_job (job_id, owner_type)
    ) ENGINE=InnoDB
  `);
  budgetLockTablesEnsured = true;
}

// ---- Change orders → Budget (job-linked, signed COs feed the Budget tab) ----
// System B `change_orders` is provisioned outside this codebase, so we ALTER it
// idempotently: `job_id` links a Change Order to a job (set only for CO-mode
// documents), `budget_sub_cost` is the manually-entered "what it costs you" for
// the CO's Budget row, and `budget_paid_amount` is the running Paid-to-date
// (maintained from change_order_payments, mirroring division_lineitems).
let changeOrderBudgetColsEnsured = false;
async function ensureChangeOrderBudgetColumns(connection) {
  if (changeOrderBudgetColsEnsured) return;
  const adds = [
    ['job_id', 'INT NULL'],
    ['budget_sub_cost', 'DECIMAL(12,2) NULL'],
    ['budget_paid_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of adds) {
    const [cols] = await connection.query(`SHOW COLUMNS FROM change_orders LIKE '${col}'`);
    if (!cols.length) {
      await connection.query(`ALTER TABLE change_orders ADD COLUMN ${col} ${def}`);
    }
  }
  changeOrderBudgetColsEnsured = true;
}

// Payments recorded against a signed change order's Budget row — mirrors
// division_lineitem_payments (+ audit) so the CO "$ Pay" reuses the exact same
// mechanic. Keyed by change_order_id.
let changeOrderPaymentTablesEnsured = false;
async function ensureChangeOrderPaymentTables(connection) {
  if (changeOrderPaymentTablesEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS change_order_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      change_order_id INT NOT NULL,
      method VARCHAR(20) NOT NULL,
      check_number VARCHAR(50) NULL,
      payment_date DATE NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by INT NULL,
      updated_at DATETIME NULL,
      INDEX idx_cop_co (change_order_id)
    ) ENGINE=InnoDB
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS change_order_payment_audit (
      id INT AUTO_INCREMENT PRIMARY KEY,
      payment_id INT NULL,
      change_order_id INT NULL,
      action VARCHAR(10) NOT NULL,
      old_value TEXT NULL,
      new_value TEXT NULL,
      changed_by INT NULL,
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_copa_co (change_order_id),
      INDEX idx_copa_payment (payment_id)
    ) ENGINE=InnoDB
  `);
  changeOrderPaymentTablesEnsured = true;
}

// ---- Company-wide sequential Job Number + per-job invoice numbering ----
// "Company" = an account owner (a user who is not an employee) plus the members
// they invited (user.created_by = ownerId, category = 1). A job's company owner
// is resolved from its created_by. Job Number is sequential WITHIN a company.

// Resolve the account-owner id for a set of creator user ids (employees map to
// their inviter; everyone else maps to themselves).
async function resolveOwnersFor(connection, creatorIds) {
  const map = new Map();
  const ids = [...new Set(creatorIds.filter((x) => x != null).map(Number))];
  if (!ids.length) return map;
  const [rows] = await connection.query(
    `SELECT id, created_by, category FROM \`user\` WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const id of ids) {
    const u = byId.get(id);
    const owner = u && Number(u.category) === 1 && u.created_by ? Number(u.created_by) : id;
    map.set(id, owner);
  }
  return map;
}

let jobNumberColumnEnsured = false;
async function ensureJobNumberColumn(connection) {
  if (jobNumberColumnEnsured) return;
  const [cols] = await connection.query("SHOW COLUMNS FROM `job` LIKE 'job_number'");
  if (!cols.length) {
    await connection.query("ALTER TABLE `job` ADD COLUMN `job_number` INT NULL DEFAULT NULL");
  }
  await backfillJobNumbers(connection);
  jobNumberColumnEnsured = true;
}

// One-time (idempotent) backfill: every job without a job_number gets one,
// sequential per company in creation-date order, continuing after any numbers
// already assigned for that company. Re-running is a no-op (only fills NULLs).
async function backfillJobNumbers(connection) {
  const [nulls] = await connection.query(
    "SELECT id, created_by FROM `job` WHERE job_number IS NULL ORDER BY created_at ASC, id ASC"
  );
  if (!nulls.length) return;
  // Current max per company from already-numbered jobs.
  const [numbered] = await connection.query(
    "SELECT created_by, job_number FROM `job` WHERE job_number IS NOT NULL"
  );
  const creators = [...nulls.map((j) => j.created_by), ...numbered.map((j) => j.created_by)];
  const owners = await resolveOwnersFor(connection, creators);
  const maxByOwner = new Map();
  for (const j of numbered) {
    const owner = owners.get(Number(j.created_by)) ?? Number(j.created_by);
    maxByOwner.set(owner, Math.max(maxByOwner.get(owner) || 0, Number(j.job_number) || 0));
  }
  for (const j of nulls) {
    const owner = owners.get(Number(j.created_by)) ?? Number(j.created_by);
    const next = (maxByOwner.get(owner) || 0) + 1;
    maxByOwner.set(owner, next);
    await connection.query("UPDATE `job` SET job_number = ? WHERE id = ? AND job_number IS NULL", [next, j.id]);
  }
}

// Assign the next company-sequential job_number to one job if it doesn't have
// one yet. Returns the job's number. Safe to call repeatedly.
async function assignJobNumberIfMissing(connection, jobId) {
  await ensureJobNumberColumn(connection);
  const [rows] = await connection.query("SELECT created_by, job_number FROM `job` WHERE id = ? LIMIT 1", [Number(jobId)]);
  if (!rows.length) return null;
  if (rows[0].job_number != null) return Number(rows[0].job_number);
  const owners = await resolveOwnersFor(connection, [rows[0].created_by]);
  const ownerId = owners.get(Number(rows[0].created_by)) ?? Number(rows[0].created_by);
  const [[{ next }]] = await connection.query(
    `SELECT COALESCE(MAX(job_number), 0) + 1 AS next FROM \`job\`
      WHERE created_by IN (SELECT id FROM \`user\` WHERE id = ? OR (created_by = ? AND category = 1))`,
    [ownerId, ownerId]
  );
  await connection.query("UPDATE `job` SET job_number = ? WHERE id = ? AND job_number IS NULL", [next, Number(jobId)]);
  const [[chk]] = await connection.query("SELECT job_number FROM `job` WHERE id = ? LIMIT 1", [Number(jobId)]);
  return chk ? Number(chk.job_number) : next;
}

// Per-job client invoices. Numbering (invoice_seq) is sequential per job from 1.
// Invoice CONTENT (amounts/PDF/client details) is a separate feature; this table
// + the numbering + status slot are the entry point.
let invoicesTableEnsured = false;
async function ensureInvoicesTable(connection) {
  if (invoicesTableEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS job_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      job_id INT NOT NULL,
      invoice_seq INT NOT NULL,
      status VARCHAR(20) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ji_job (job_id)
    ) ENGINE=InnoDB
  `);
  invoicesTableEnsured = true;
}

// Invoice DOCUMENT schema (2026-08-28): extends job_invoices with the editable
// content (dates, tax, notes, payment instructions), computed totals, status
// timestamps (sent/viewed/paid) and a public share token; adds the line-items
// table; and adds a company-profile payment_instructions source on the user row
// (auto-fills a new invoice). Idempotent, self-bootstrapping from the invoice routes.
let invoiceDocSchemaEnsured = false;
async function ensureInvoiceDocumentSchema(connection) {
  if (invoiceDocSchemaEnsured) return;
  await ensureInvoicesTable(connection);
  const addCol = async (table, col, def) => {
    const [[c]] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
      [table, col]
    );
    if (!c) await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN ${col} ${def}`);
  };
  const cols = [
    ["issued_date", "DATE NULL"],
    ["due_date", "DATE NULL"],
    ["tax_rate", "DECIMAL(6,3) NULL DEFAULT 0"],
    ["notes", "TEXT NULL"],
    ["payment_instructions", "TEXT NULL"],
    ["subtotal", "DECIMAL(12,2) NULL DEFAULT 0"],
    ["tax_amount", "DECIMAL(12,2) NULL DEFAULT 0"],
    ["total", "DECIMAL(12,2) NULL DEFAULT 0"],
    ["sent_at", "DATETIME NULL"],
    ["viewed_at", "DATETIME NULL"],
    ["paid_at", "DATETIME NULL"],
    ["public_token", "VARCHAR(64) NULL"],
    ["updated_at", "DATETIME NULL"],
  ];
  for (const [col, def] of cols) await addCol("job_invoices", col, def);
  try { await connection.query("ALTER TABLE job_invoices ADD INDEX idx_ji_token (public_token)"); } catch (e) { /* exists */ }
  await connection.query("UPDATE job_invoices SET status='Draft' WHERE status IS NULL OR status=''").catch(() => {});
  await connection.query(`
    CREATE TABLE IF NOT EXISTS job_invoice_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      description TEXT NULL,
      qty DECIMAL(12,3) NULL DEFAULT 0,
      rate DECIMAL(12,2) NULL DEFAULT 0,
      amount DECIMAL(12,2) NULL DEFAULT 0,
      sort INT NULL DEFAULT 0,
      INDEX idx_ii_invoice (invoice_id)
    ) ENGINE=InnoDB
  `);
  // Company-profile default for the invoice "how to pay me" block.
  await addCol("user", "payment_instructions", "TEXT NULL");
  invoiceDocSchemaEnsured = true;
}

// Backend-scheduled reminders: rows the sendReminders cron scans each minute and
// delivers via FCM, so alerts fire even when the app is closed. fire_at is stored
// in UTC (compared against UTC_TIMESTAMP()) to be timezone-safe.
let remindersTableEnsured = false;
async function ensureRemindersTable(connection) {
  if (remindersTableEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      source_type VARCHAR(20) NOT NULL,
      source_id VARCHAR(64) NULL,
      title VARCHAR(255) NOT NULL,
      body VARCHAR(255) NULL,
      job_name VARCHAR(255) NULL,
      appt_time VARCHAR(40) NULL,
      appt_address VARCHAR(255) NULL,
      url VARCHAR(80) NULL,
      fire_at DATETIME NOT NULL,
      sent_at DATETIME NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_reminders_due (sent_at, fire_at),
      INDEX idx_reminders_source (user_id, source_type, source_id)
    ) ENGINE=InnoDB
  `);
  // If the table pre-existed with an INT source_id (goals use string ids like
  // 'l1720…'), widen it once.
  const [[col]] = await connection.query("SHOW COLUMNS FROM reminders LIKE 'source_id'");
  if (col && /int/i.test(col.Type)) {
    await connection.query("ALTER TABLE reminders MODIFY source_id VARCHAR(64) NULL");
  }
  remindersTableEnsured = true;
}

// Multi-assignee: a task may be assigned to SEVERAL people. `tasks.user_id` stays
// as the PRIMARY (first) assignee so every existing single-assignee query, filter,
// and notification keeps working untouched; this join table holds the full list.
// One-time backfill seeds it from the existing single assignee so legacy tasks
// already have a row. Additive + backward-compatible.
let taskAssigneesTableEnsured = false;
async function ensureTaskAssigneesTable(connection) {
  if (taskAssigneesTableEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS task_assignees (
      id INT AUTO_INCREMENT PRIMARY KEY,
      task_id INT NOT NULL,
      user_id INT NOT NULL,
      seen_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_task_user (task_id, user_id),
      INDEX idx_ta_task (task_id),
      INDEX idx_ta_user (user_id)
    ) ENGINE=InnoDB
  `);
  // seen_at is PER-PERSON: each assignee's own "opened it" stamp (the shared
  // completion flag stays on tasks.status). Added via ensureScheduleColumn too so
  // a DB whose table predates this column gets it. Idempotent.
  await ensureScheduleColumn(connection, 'task_assignees', 'seen_at', 'DATETIME NULL');
  // PER-PERSON one-time written response: each assignee may submit exactly once;
  // responded_at != null locks it (no further edits, by them or anyone).
  await ensureScheduleColumn(connection, 'task_assignees', 'response', 'TEXT NULL');
  await ensureScheduleColumn(connection, 'task_assignees', 'responded_at', 'DATETIME NULL');
  // Backfill once (guarded by emptiness) from the legacy single-assignee column,
  // carrying the existing per-task seen stamp onto that primary assignee's row.
  const [[{ n }]] = await connection.query('SELECT COUNT(*) AS n FROM task_assignees');
  if (Number(n) === 0) {
    await connection.query(
      `INSERT IGNORE INTO task_assignees (task_id, user_id, seen_at)
       SELECT id, user_id, assignee_seen_at FROM tasks WHERE user_id IS NOT NULL`
    );
  }
  taskAssigneesTableEnsured = true;
}

// Schedule Template feature: a reusable NAMED library of construction line items
// with durations + item-to-item dependencies, applied to a job to auto-generate a
// sequenced schedule (tasks + stages) that then stays live-synced. Two groups of
// tables kept physically separate so master-template edits never retroactively
// touch an already-applied job:
//   MASTER LIBRARY  : schedule_templates / _items / _deps
//   APPLIED INSTANCE: job_schedules / _items / _deps  (an independent copy per apply)
// Dependencies reference a STABLE item PK, never a display number. FKs are declared
// only AMONG these new tables (where we own the types); the applied-instance
// task_id/stage_id are plain indexed columns (no hard FK to the legacy tasks/stages
// tables) so the migration can't fail on engine/charset mismatch and a hard task
// delete can't be blocked by a constraint.
let scheduleTablesEnsured = false;
async function ensureScheduleTemplateTables(connection) {
  if (scheduleTablesEnsured) return;

  await connection.query(`
    CREATE TABLE IF NOT EXISTS schedule_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      account_owner_id INT NULL,
      created_by INT NULL,
      is_seed TINYINT NOT NULL DEFAULT 0,
      status VARCHAR(12) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sched_tpl_owner (account_owner_id, status)
    ) ENGINE=InnoDB
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS schedule_template_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      template_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      default_duration_days INT NULL,
      depends_on_all TINYINT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sti_tpl (template_id, sort_order),
      CONSTRAINT fk_sti_tpl FOREIGN KEY (template_id)
        REFERENCES schedule_templates(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS schedule_template_deps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      item_id INT NOT NULL,
      depends_on_item_id INT NOT NULL,
      UNIQUE KEY uq_std (item_id, depends_on_item_id),
      INDEX idx_std_item (item_id),
      CONSTRAINT fk_std_item FOREIGN KEY (item_id)
        REFERENCES schedule_template_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_std_dep FOREIGN KEY (depends_on_item_id)
        REFERENCES schedule_template_items(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS job_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      job_id INT NOT NULL,
      owner_type VARCHAR(8) NOT NULL DEFAULT 'job',
      source_template_id INT NULL,
      name VARCHAR(255) NULL,
      start_date DATE NULL,
      skip_saturday TINYINT NOT NULL DEFAULT 0,
      skip_sunday TINYINT NOT NULL DEFAULT 0,
      status VARCHAR(12) NOT NULL DEFAULT 'active',
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_js_job (job_id, owner_type, status),
      CONSTRAINT fk_js_tpl FOREIGN KEY (source_template_id)
        REFERENCES schedule_templates(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS job_schedule_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      schedule_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      duration_days INT NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      computed_start_date DATE NULL,
      computed_end_date DATE NULL,
      pinned_start_date DATE NULL,
      assignee_user_id INT NULL,
      task_id INT NULL,
      stage_id INT NULL,
      template_item_id INT NULL,
      depends_on_all TINYINT NOT NULL DEFAULT 0,
      has_conflict TINYINT NOT NULL DEFAULT 0,
      conflict_reason VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_jsi_sched (schedule_id, sort_order),
      INDEX idx_jsi_task (task_id),
      CONSTRAINT fk_jsi_sched FOREIGN KEY (schedule_id)
        REFERENCES job_schedules(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS job_schedule_deps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      schedule_id INT NOT NULL,
      item_id INT NOT NULL,
      depends_on_item_id INT NOT NULL,
      UNIQUE KEY uq_jsd (item_id, depends_on_item_id),
      INDEX idx_jsd_sched (schedule_id),
      CONSTRAINT fk_jsd_sched FOREIGN KEY (schedule_id)
        REFERENCES job_schedules(id) ON DELETE CASCADE,
      CONSTRAINT fk_jsd_item FOREIGN KEY (item_id)
        REFERENCES job_schedule_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_jsd_dep FOREIGN KEY (depends_on_item_id)
        REFERENCES job_schedule_items(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // ---- UX-overhaul column adds (idempotent) ----
  //  is_inspection: a real data flag (not a naming convention) so inspection items
  //    render with their own badge/border.
  //  cloned_from_template_id: provenance so "Use See Job Run's template" reopens the
  //    account's existing personal copy instead of duplicating, and powers the
  //    "Based on …" caption + "Reset to starter".
  await ensureScheduleColumn(connection, 'schedule_template_items', 'is_inspection', 'TINYINT NOT NULL DEFAULT 0');
  await ensureScheduleColumn(connection, 'job_schedule_items', 'is_inspection', 'TINYINT NOT NULL DEFAULT 0');
  await ensureScheduleColumn(connection, 'schedule_templates', 'cloned_from_template_id', 'INT NULL');
  // is_start: EXPLICIT "Start with this item" flag (max one row per schedule).
  // Distinct from "has no dependencies" — an untouched item is blank, not a start.
  // Drives the dependency-derived row order (the start item leads at position 1).
  await ensureScheduleColumn(connection, 'job_schedule_items', 'is_start', 'TINYINT NOT NULL DEFAULT 0');

  await seedStandardNewHomeBuild(connection);
  await markSeedInspections(connection);
  scheduleTablesEnsured = true;
}

async function ensureScheduleColumn(connection, table, column, definition) {
  const [cols] = await connection.query(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
  if (!cols.length) {
    await connection.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Task Manager Phase-1 columns (visual/UX redesign — single-assignee):
//  tasks.is_urgent            — the new Urgent escalation flag (distinct red push);
//                               deliberately SEPARATE from the legacy `priority`
//                               field (old gold star = "high priority", not urgent).
//  tasks.assignee_seen_at     — stamped once when the assignee genuinely OPENS the
//                               task detail (not on delivery/dismissal) → "Seen".
//  tasks.completion_response  — the one optional written reply submitted with Mark
//                               Complete (single one-time submission, not editable).
//  tasks_images.kind          — 'request' (default, created with the task) vs
//                               'response' (uploaded at completion) so the photo
//                               gallery can group REQUEST vs RESPONSE.
//  tasks_images.uploaded_by   — who added the photo (for the gallery's "· [name]").
let taskManagerColumnsEnsured = false;
async function ensureTaskManagerColumns(connection) {
  if (taskManagerColumnsEnsured) return;
  await ensureScheduleColumn(connection, 'tasks', 'is_urgent', 'TINYINT NOT NULL DEFAULT 0');
  await ensureScheduleColumn(connection, 'tasks', 'assignee_seen_at', 'DATETIME NULL');
  await ensureScheduleColumn(connection, 'tasks', 'completion_response', 'TEXT NULL');
  await ensureScheduleColumn(connection, 'tasks_images', 'kind', "VARCHAR(10) NOT NULL DEFAULT 'request'");
  await ensureScheduleColumn(connection, 'tasks_images', 'uploaded_by', 'INT NULL');
  taskManagerColumnsEnsured = true;
}

// Flag + rename the seed's inspection items on an ALREADY-seeded database (prod),
// where the seed rows still carry the old "Inspection …" names. Idempotent: matches
// on the OLD name, so it renames once and is a no-op forever after (and a no-op on a
// fresh DB, which is seeded with the new names + flags directly). Base names have
// "Inspection" removed since it's now shown as a badge.
async function markSeedInspections(connection) {
  const [[seed]] = await connection.query('SELECT id FROM schedule_templates WHERE is_seed = 1 LIMIT 1');
  if (!seed) return;
  const RENAMES = [
    ['Inspection Slab, Plumbing, Ufa ground', 'Slab, Plumbing & UFER Ground'],
    ['Roof Sheeting Inspection', 'Roof Sheeting'],
    ['Inspection Rough Ins', 'Rough-Ins'],
    ['Inspection Insulation', 'Insulation'],
    ['Inspection Final', 'Final Walkthrough'],
  ];
  for (const [oldName, newName] of RENAMES) {
    await connection.query(
      'UPDATE schedule_template_items SET is_inspection = 1, name = ? WHERE template_id = ? AND name = ?',
      [newName, seed.id, oldName]
    );
  }
}

// The default/example template. Idempotent: only inserts if no is_seed row exists.
// account_owner_id is NULL so the seed is a shared starter visible to every account
// (accounts customize it by cloning, never by editing it in place). Durations stay
// NULL on the master — the user fills them in per job at apply time. Item 42
// ("Inspection Final") uses depends_on_all=1 instead of explicit deps, so it always
// stays last even if items are added later.
async function seedStandardNewHomeBuild(connection) {
  const [[existing]] = await connection.query(
    "SELECT id FROM schedule_templates WHERE is_seed = 1 LIMIT 1"
  );
  if (existing) return;

  // display # → { name, deps: [display #s] , all?: true }
  const ITEMS = [
    { name: 'Temp. Toilet', deps: [] },
    { name: 'Stake out building', deps: [1] },
    { name: 'Rough Grading', deps: [2] },
    { name: 'Foundation Set up', deps: [3] },
    { name: 'Under Slab Plumbing', deps: [4] },
    { name: 'Electrical Sweeps', deps: [4] },
    { name: 'Slab, Plumbing & UFER Ground', deps: [4, 5, 6], insp: true },
    { name: 'Foundation Pour', deps: [7] },
    { name: 'Utilities', deps: [7] },
    { name: 'Lumber Drop & Steel', deps: [7] },
    { name: 'Framing', deps: [9] },
    { name: 'Trusses & Sheeting', deps: [10] },
    { name: 'Ext. Windows & Doors', deps: [12] },
    { name: 'Roof Sheeting', deps: [12], insp: true },
    { name: 'Load Roof', deps: [14] },
    { name: 'Roofing', deps: [15] },
    { name: 'Rough Electric', deps: [14] },
    { name: 'Rough HVAC', deps: [14] },
    { name: 'Rough Plumbing', deps: [14] },
    { name: 'Rough-Ins', deps: [17, 18, 19], insp: true },
    { name: 'Siding / Stucco', deps: [20] },
    { name: 'Insulation', deps: [21] },
    { name: 'Insulation', deps: [22], insp: true },
    { name: 'Drywall', deps: [23] },
    { name: 'Tape & Texture', deps: [24] },
    { name: 'Driveway / sidewalk poured', deps: [9, 20] },
    { name: 'Garage Doors', deps: [25] },
    { name: 'Interior doors & Closets', deps: [25] },
    { name: 'Paint', deps: [27] },
    { name: 'Cabinets', deps: [28] },
    { name: 'Tile Showers/Tubs', deps: [25] },
    { name: 'Template counters & Install', deps: [29] },
    { name: 'Flooring', deps: [29] },
    { name: 'Appliances Installed', deps: [33] },
    { name: 'Baseboards', deps: [33] },
    { name: 'Door hardware & stops', deps: [35] },
    { name: 'Paint touch ups', deps: [34] },
    { name: 'Bath Accessories', deps: [37] },
    { name: 'Finish Plumbing', deps: [30, 31] },
    { name: 'Finish Electrical', deps: [31] },
    { name: 'Finish HVAC', deps: [28] },
    { name: 'Final Walkthrough', deps: [], all: true, insp: true },
  ];

  const [tpl] = await connection.query(
    `INSERT INTO schedule_templates (name, account_owner_id, created_by, is_seed, status)
     VALUES ('Standard New Home Build', NULL, NULL, 1, 'active')`
  );
  const templateId = tpl.insertId;

  // Insert items in display order, capturing the STABLE auto-increment id for each.
  const idByDisplay = {};
  for (let i = 0; i < ITEMS.length; i++) {
    const [r] = await connection.query(
      `INSERT INTO schedule_template_items
         (template_id, name, default_duration_days, depends_on_all, is_inspection, sort_order)
       VALUES (?, ?, NULL, ?, ?, ?)`,
      [templateId, ITEMS[i].name, ITEMS[i].all ? 1 : 0, ITEMS[i].insp ? 1 : 0, i + 1]
    );
    idByDisplay[i + 1] = r.insertId;
  }

  // Map each item's display-number deps to the newly-created stable ids.
  for (let i = 0; i < ITEMS.length; i++) {
    if (ITEMS[i].all) continue; // depends_on_all handles this one
    for (const depDisplay of ITEMS[i].deps) {
      await connection.query(
        `INSERT INTO schedule_template_deps (item_id, depends_on_item_id) VALUES (?, ?)`,
        [idByDisplay[i + 1], idByDisplay[depDisplay]]
      );
    }
  }
}

// Cumulative plan-tier ladder. `plans.level` gives every plan a numeric rank so
// feature gates can say "level >= Gold" instead of matching plan names — the day
// Platinum (a higher level) is subscribed to, it automatically clears every
// Gold-gated check with no code change. Ladder (matches the frontend RANK map in
// m-access.service.ts): Basic=1, Bronze=2, Silver=3, Gold=4, Platinum=5.
// Bid Pro is a separate ADD-ON, not a rung on this ladder, so it deliberately
// gets NO level (stays NULL) and never grants tier-gated access on its own.
let planLevelEnsured = false;
async function ensurePlanLevelColumn(connection) {
  if (planLevelEnsured) return;
  const [cols] = await connection.query("SHOW COLUMNS FROM plans LIKE 'level'");
  if (!cols.length) {
    await connection.query("ALTER TABLE plans ADD COLUMN level INT NULL");
  }
  // Populate by name for any plan not yet ranked. Only fills NULLs, so a manual
  // override is never clobbered on rerun; unknown names (Free, Bid Pro, add-ons)
  // keep NULL via the ELSE branch.
  await connection.query(
    `UPDATE plans SET level = CASE
        WHEN name LIKE 'Basic%'    THEN 1
        WHEN name LIKE 'Bronze%'   THEN 2
        WHEN name LIKE 'Silver%'   THEN 3
        WHEN name LIKE 'Gold%'     THEN 4
        WHEN name LIKE 'Platinum%' THEN 5
        ELSE level
      END
      WHERE level IS NULL`
  );
  planLevelEnsured = true;
}

// Per-user IANA timezone (e.g. 'America/Los_Angeles'). This is the CANONICAL
// timezone the app's date/time logic is intended to read (crons, reminders,
// "today" filtering, due dates). It is DISTINCT from the legacy `time_zone`
// short-code column (EST/PST/MST_DENVER…), which is display-only and is not read
// by any server-side time logic. Existing users default to Pacific so behavior
// is unchanged until per-user enforcement is wired up.
let userTimezoneEnsured = false;
async function ensureUserTimezoneColumn(connection) {
  if (userTimezoneEnsured) return;
  const [cols] = await connection.query("SHOW COLUMNS FROM `user` LIKE 'timezone'");
  if (!cols.length) {
    await connection.query(
      "ALTER TABLE `user` ADD COLUMN `timezone` VARCHAR(64) NOT NULL DEFAULT 'America/Los_Angeles'"
    );
  }
  userTimezoneEnsured = true;
}

// `subscriptions.needs_reverification` — set at the sandbox→production go-live so
// pre-switch "active" subscriptions (which point at sandbox profiles/ARB ids that
// don't exist on the live account, and never really charged anyone) can be shown
// as "needs re-verification" and their owners prompted to re-add a card. Adding the
// flag column keeps the existing `status` value set untouched. Idempotent.
let subReverifyEnsured = false;
async function ensureSubscriptionReverifyColumn(connection) {
  if (subReverifyEnsured) return;
  const [cols] = await connection.query(
    "SHOW COLUMNS FROM subscriptions LIKE 'needs_reverification'"
  );
  if (!cols.length) {
    await connection.query(
      "ALTER TABLE subscriptions ADD COLUMN needs_reverification TINYINT NOT NULL DEFAULT 0"
    );
  }
  // Grace deadline: while this is in the future, a flagged account keeps FULL
  // access (see utils/access.js) even though its sandbox subscription is canceled,
  // so users have an uninterrupted window to re-enter a card + re-subscribe.
  const [dueCols] = await connection.query(
    "SHOW COLUMNS FROM subscriptions LIKE 'reverification_due_at'"
  );
  if (!dueCols.length) {
    await connection.query(
      "ALTER TABLE subscriptions ADD COLUMN reverification_due_at DATETIME NULL"
    );
  }
  subReverifyEnsured = true;
}

// Audit log for the owner-triggered re-verification emails (who got which email,
// when, and whether it sent) so a send can be verified afterward. Idempotent.
let reverifyEmailLogEnsured = false;
async function ensureReverifyEmailLogTable(connection) {
  if (reverifyEmailLogEnsured) return;
  await connection.query(
    `CREATE TABLE IF NOT EXISTS reverification_email_log (
       id INT PRIMARY KEY AUTO_INCREMENT,
       user_id INT NULL,
       email_type CHAR(1) NOT NULL,
       recipient_email VARCHAR(190) NULL,
       status VARCHAR(20) NOT NULL,
       triggered_by INT NULL,
       sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`
  );
  reverifyEmailLogEnsured = true;
}

// Idempotency ledger for the ARB webhook: one row per Authorize.Net
// notificationId so a redelivered event is a no-op (safe on redelivery).
// Self-bootstrapped from the webhook handler (DDL is idempotent + cached).
let webhookEventsEnsured = false;
async function ensureWebhookEventsTable(connection) {
  if (webhookEventsEnsured) return;
  await connection.query(
    `CREATE TABLE IF NOT EXISTS webhook_events (
       notification_id VARCHAR(120) PRIMARY KEY,
       event_type VARCHAR(120) NULL,
       subscription_ref VARCHAR(60) NULL,
       received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`
  );
  webhookEventsEnsured = true;
}

// job.color — persisted pool colour for a job (NULL = unassigned / released).
let jobColorEnsured = false;
async function ensureJobColorColumn(connection) {
  if (jobColorEnsured) return;
  const [[row]] = await connection.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job' AND COLUMN_NAME = 'color'`
  );
  if (!row) await connection.query('ALTER TABLE `job` ADD COLUMN `color` VARCHAR(9) DEFAULT NULL');
  jobColorEnsured = true;
}

// job.color_locked (2026-08-28) — 1 when a user MANUALLY picked the job's colour
// from the Jobs-page override picker. Auto-assignment (pickJobColor) and every
// reassign/backfill routine must SKIP a locked job so a user choice is never
// silently overwritten. "Use automatic color" clears it back to 0.
let jobColorLockedEnsured = false;
async function ensureJobColorLockedColumn(connection) {
  if (jobColorLockedEnsured) return;
  const [[row]] = await connection.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job' AND COLUMN_NAME = 'color_locked'`
  );
  if (!row) await connection.query('ALTER TABLE `job` ADD COLUMN `color_locked` TINYINT(1) NOT NULL DEFAULT 0');
  jobColorLockedEnsured = true;
}

// appointments.all_day — 1 = all-day event (no meaningful time/countdown). The
// appointment dialogs had an "All-day" toggle that was never persisted; this
// column lets it stick so the Spartan dashboard can render the all-day card.
let apptAllDayEnsured = false;
async function ensureAppointmentAllDayColumn(connection) {
  if (apptAllDayEnsured) return;
  const [[row]] = await connection.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'appointments' AND COLUMN_NAME = 'all_day'`
  );
  if (!row) await connection.query('ALTER TABLE appointments ADD COLUMN all_day TINYINT NOT NULL DEFAULT 0');
  apptAllDayEnsured = true;
}

// The `user.mobile` column carried a UNIQUE index, which forbade two users from
// sharing a phone number. That broke saving legitimate contacts (two subs, a
// company + its owner, or a license-lookup placeholder + a manual entry, sharing
// one line) with a raw "Duplicate entry … for key 'user.mobile_UNIQUE'" 500.
// Phone numbers are not an identity here (login is by email/OTP), so drop any
// SINGLE-COLUMN unique index on user.mobile. Idempotent — a second run finds none.
let mobileUniqueDropped = false;
async function dropUserMobileUniqueIndex(connection) {
  if (mobileUniqueDropped) return;
  const [idx] = await connection.query(
    "SHOW INDEX FROM `user` WHERE Column_name = 'mobile' AND Non_unique = 0"
  );
  const names = [...new Set(idx.map((r) => r.Key_name))].filter(
    (n) => n && n.toUpperCase() !== 'PRIMARY'
  );
  for (const name of names) {
    // Only drop it if it's a single-column index on `mobile` (never touch a
    // composite unique that happens to include the mobile column).
    const [[{ cols }]] = await connection.query(
      `SELECT COUNT(*) AS cols FROM information_schema.STATISTICS
        WHERE table_schema = DATABASE() AND table_name = 'user' AND index_name = ?`,
      [name]
    );
    if (Number(cols) === 1) {
      await connection.query('ALTER TABLE `user` DROP INDEX `' + name.replace(/`/g, '') + '`');
    }
  }
  mobileUniqueDropped = true;
}

// `user.account_source` — how this user row was created, so the admin billing
// page can EXCLUDE non-app-user artifacts (CSLB license-lookup imports,
// placeholder clients auto-created during job creation) exactly, instead of
// sniffing the email string. Values: 'signup' | 'invite' | 'cslb_lookup' |
// 'placeholder_client'. Additive + idempotent; new rows are stamped at their
// insert site, existing rows are backfilled once from the strongest signal.
let accountSourceEnsured = false;
let contactAuthorityEnsured = false;

/**
 * Per-EMPLOYEE "authority" flag: when 1, an employee may see the WHOLE account's
 * contact book (all subs/clients/employees) in Assign-To pickers; when 0 (default)
 * they — like clients and subcontractors — see only their own contacts + the
 * account owner. Only the owner can grant it, and only to Employees. Clients/subs
 * are NEVER granted it. (There was no existing column/right that meant this.)
 */
async function ensureContactAuthorityColumn(connection) {
  if (contactAuthorityEnsured) return;
  const [cols] = await connection.query(
    "SHOW COLUMNS FROM `user` LIKE 'can_view_all_contacts'"
  );
  if (!cols.length) {
    await connection.query(
      "ALTER TABLE `user` ADD COLUMN can_view_all_contacts TINYINT(1) NOT NULL DEFAULT 0"
    );
  }
  contactAuthorityEnsured = true;
}
async function ensureUserAccountSourceColumn(connection) {
  if (accountSourceEnsured) return;
  const [cols] = await connection.query(
    "SHOW COLUMNS FROM `user` LIKE 'account_source'"
  );
  if (!cols.length) {
    await connection.query(
      "ALTER TABLE `user` ADD COLUMN account_source VARCHAR(20) NULL"
    );
    // One-time backfill for existing rows (NULL only), most-specific first:
    // CSLB imports → cslb_lookup; other @no-email.invalid placeholders (clients
    // auto-created on job creation) → placeholder_client; rows with a real
    // password → signup; everything else (real email, no password) → invite.
    // Best-effort: a schema variant (e.g. no password column) must not abort boot.
    try {
      await connection.query(
        "UPDATE `user` SET account_source = 'cslb_lookup' WHERE account_source IS NULL AND email LIKE 'lic-%@no-email.invalid'"
      );
      await connection.query(
        "UPDATE `user` SET account_source = 'placeholder_client' WHERE account_source IS NULL AND email LIKE '%@no-email.invalid'"
      );
      await connection.query(
        "UPDATE `user` SET account_source = 'signup' WHERE account_source IS NULL AND password IS NOT NULL AND password <> ''"
      );
      await connection.query(
        "UPDATE `user` SET account_source = 'invite' WHERE account_source IS NULL"
      );
    } catch (e) { /* backfill best-effort; the column exists either way */ }
  }
  accountSourceEnsured = true;
}

// `user.first_login_at` — the first time this user actually logged into the app.
// Stamped once (guarded IF NULL) on the first successful password/OTP login.
// DISPLAY-ONLY for the admin billing page's four-state status (Invited vs Trial):
// deliberately NOT wired into utils/access.js, so the real access-gating trial
// clock stays created_at-based (avoids the 2026-07-20 lockout class of change).
// Additive + idempotent. Backfill is best-effort: any user who already has a
// user_devices row has logged in, so approximate their first login as created_at.
let firstLoginEnsured = false;
async function ensureUserFirstLoginColumn(connection) {
  if (firstLoginEnsured) return;
  const [cols] = await connection.query(
    "SHOW COLUMNS FROM `user` LIKE 'first_login_at'"
  );
  if (!cols.length) {
    await connection.query(
      "ALTER TABLE `user` ADD COLUMN first_login_at DATETIME NULL"
    );
    try {
      await connection.query(
        `UPDATE \`user\` u SET u.first_login_at = u.created_at
          WHERE u.first_login_at IS NULL
            AND EXISTS (SELECT 1 FROM user_devices ud WHERE ud.user_id = u.id)`
      );
    } catch (e) { /* user_devices absent (e.g. test DB) → leave NULL, non-fatal */ }
  }
  firstLoginEnsured = true;
}

// "Family/Friend" role/subcategory (category 1 = employee-class roles). SHARED
// list: getsubcategory/:categoryId serves both web + mobile, so adding it here
// surfaces it on both. Idempotent + defensive (a schema surprise on the
// subcategory table must never break boot).
let familyFriendEnsured = false;
async function ensureFamilyFriendSubcategory(connection) {
  if (familyFriendEnsured) return;
  try {
    const [rows] = await connection.query(
      "SELECT id FROM subcategory WHERE category_id = 1 AND name = 'Family/Friend' LIMIT 1"
    );
    if (!rows.length) {
      await connection.query(
        "INSERT INTO subcategory (name, category_id) VALUES ('Family/Friend', 1)"
      );
    }
  } catch (e) {
    // Non-fatal: never let a subcategory-schema surprise break boot.
    console.error('ensureFamilyFriendSubcategory:', e && e.message);
  }
  familyFriendEnsured = true;
}

// `user.level` — the permission LEVEL (1–5) on the access ladder, assigned
// INDEPENDENTLY of the Role/subcategory label (a "Family/Friend" can be any
// level). NULL = off the ladder: account owners, subcontractors (category 2),
// clients (category 3), and not-yet-assigned users. The Subcontractor class is
// its own fixed, non-escalating scope (identified by category=2) and is NOT part
// of the 1–5 scale. Additive + idempotent; no backfill — assignment happens in
// the Employees UI (a later stage). Backend Admin is NEVER derived from level.
let userLevelEnsured = false;
async function ensureUserLevelColumn(connection) {
  if (userLevelEnsured) return;
  const [cols] = await connection.query("SHOW COLUMNS FROM `user` LIKE 'level'");
  if (!cols.length) {
    await connection.query(
      "ALTER TABLE `user` ADD COLUMN `level` TINYINT NULL DEFAULT NULL"
    );
  }
  userLevelEnsured = true;
}

// `subscriptions` payment-tracking columns the webhook writes (paid_count,
// last_payment_at, past_due_since) but that no migration created on main. Add
// them so the authcapture branch can't hit ER_BAD_FIELD_ERROR once the payment
// webhook events are subscribed. Additive + idempotent.
let subPaymentColsEnsured = false;
async function ensureSubscriptionPaymentColumns(connection) {
  if (subPaymentColsEnsured) return;
  const adds = [
    ["paid_count", "ALTER TABLE subscriptions ADD COLUMN paid_count INT NOT NULL DEFAULT 0"],
    ["last_payment_at", "ALTER TABLE subscriptions ADD COLUMN last_payment_at DATETIME NULL"],
    ["past_due_since", "ALTER TABLE subscriptions ADD COLUMN past_due_since DATETIME NULL"],
  ];
  for (const [col, ddl] of adds) {
    const [c] = await connection.query(
      "SHOW COLUMNS FROM subscriptions LIKE ?",
      [col]
    );
    if (!c.length) await connection.query(ddl);
  }
  subPaymentColsEnsured = true;
}

// `payment_receipts` — a per-charge dollar-amount ledger. One row per real
// settled payment (Authcapture webhook), recording the ACTUAL settled amount as
// it happens (never paid_count × current price, which would misstate history for
// grandfathered/plan-changed customers). Total Received per customer = SUM(amount)
// for their rows; grand total = SUM across all. Idempotent on transaction_id.
// Seeds the one confirmed historical charge (owner's Gold $175, txn 121727692015,
// settled 2026-07-18) so the totals are accurate on day one.
let paymentReceiptsEnsured = false;
async function ensurePaymentReceiptsTable(connection) {
  if (paymentReceiptsEnsured) return;
  await connection.query(
    `CREATE TABLE IF NOT EXISTS payment_receipts (
       id INT PRIMARY KEY AUTO_INCREMENT,
       user_id INT NULL,
       subscription_id INT NULL,
       authorize_subscription_id VARCHAR(60) NULL,
       amount DECIMAL(12,2) NOT NULL DEFAULT 0,
       transaction_id VARCHAR(60) NULL,
       notification_id VARCHAR(120) NULL,
       source VARCHAR(20) NOT NULL DEFAULT 'webhook',
       settled_at DATETIME NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       UNIQUE KEY uq_txn (transaction_id),
       KEY idx_user (user_id)
     ) ENGINE=InnoDB`
  );
  // One-time seed of the single confirmed real settled payment.
  try {
    const [[seedSub]] = await connection.query(
      "SELECT id, user_id FROM subscriptions WHERE authorize_subscription_id = '73729730' ORDER BY created_at DESC LIMIT 1"
    );
    const [[existing]] = await connection.query(
      "SELECT id FROM payment_receipts WHERE transaction_id = '121727692015' LIMIT 1"
    );
    if (seedSub && !existing) {
      await connection.query(
        `INSERT INTO payment_receipts
           (user_id, subscription_id, authorize_subscription_id, amount, transaction_id, notification_id, source, settled_at)
         VALUES (?, ?, '73729730', 175.00, '121727692015', NULL, 'seed', '2026-07-18 17:13:00')`,
        [seedSub.user_id, seedSub.id]
      );
    }
  } catch (e) { /* subscriptions/seed absent (e.g. test DB) → skip, non-fatal */ }
  paymentReceiptsEnsured = true;
}

// `gantt_stage_progress` — the Stages → Gantt sub-tab's OWN per-trade % complete,
// stored separately from the Gantt Scheduler (which has no % field on a trade).
// Keyed by schedule_item_id (a Gantt trade = job_schedule_items.id) with a FK
// ON DELETE CASCADE: deleting a trade from the Gantt Scheduler drops its progress
// row, so a later re-add (a NEW item id) starts fresh at 0% — the confirmed
// behavior. job_id/owner_type are carried for a cheap scoped fetch per job.
let ganttStageProgressEnsured = false;
async function ensureGanttStageProgressTable(connection) {
  if (ganttStageProgressEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS gantt_stage_progress (
      id INT AUTO_INCREMENT PRIMARY KEY,
      schedule_item_id INT NOT NULL,
      job_id INT NOT NULL,
      owner_type VARCHAR(8) NOT NULL DEFAULT 'job',
      percent TINYINT NOT NULL DEFAULT 0,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_gsp_item (schedule_item_id),
      INDEX idx_gsp_job (job_id, owner_type),
      CONSTRAINT fk_gsp_item FOREIGN KEY (schedule_item_id)
        REFERENCES job_schedule_items(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  ganttStageProgressEnsured = true;
}

// Static CSI suggested-items reference library (powers the Job Budget
// "Suggested items for Division N" chips). This is REFERENCE data, distinct
// from division_lineitems (which holds per-job budget lines with job_id +
// amounts). One row per catalog item, tagged R/C/B, linked to divisions by
// division_id (= divisions.id = division_number).
let suggestedItemsEnsured = false;

/** Idempotent upsert of the full reference list (keyed by unique `code`).
 *  Safe to re-run; updates name/applicability/division/order in place. */
async function seedSuggestedItems(connection) {
  const { ROWS } = require("../data/suggestedItems");
  if (!ROWS.length) return 0;
  const values = ROWS.map((r) => [r.division_id, r.code, r.name, r.applicability, r.sort_order]);
  await connection.query(
    `INSERT INTO suggested_items (division_id, code, name, applicability, sort_order)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       division_id = VALUES(division_id),
       name = VALUES(name),
       applicability = VALUES(applicability),
       sort_order = VALUES(sort_order)`,
    [values]
  );
  return ROWS.length;
}

async function ensureSuggestedItemsTable(connection) {
  if (suggestedItemsEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS suggested_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      division_id INT NOT NULL,
      code VARCHAR(16) NOT NULL,
      name VARCHAR(255) NOT NULL,
      applicability ENUM('R','C','B') NOT NULL DEFAULT 'B',
      sort_order INT NOT NULL DEFAULT 0,
      UNIQUE KEY uq_suggested_code (code),
      INDEX idx_suggested_division (division_id)
    ) ENGINE=InnoDB
  `);
  // First-time population only; re-seeds/updates go through seedSuggestedItems
  // (the owner-only endpoint), so we never clobber the table on every request.
  const [[{ c }]] = await connection.query("SELECT COUNT(*) AS c FROM suggested_items");
  if (Number(c) === 0) await seedSuggestedItems(connection);
  suggestedItemsEnsured = true;
}

// Persistent-mobile-login revoke: a bumpable version stamp embedded in each JWT.
// authenticateToken rejects a token whose tv != the user's current token_version,
// giving a real remote "sign out this person everywhere" without waiting for expiry.
let tokenVersionEnsured = false;
async function ensureUserTokenVersionColumn(connection) {
  if (tokenVersionEnsured) return;
  const [[row]] = await connection.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'token_version'`
  );
  if (!row) {
    await connection.query('ALTER TABLE `user` ADD COLUMN token_version INT NOT NULL DEFAULT 0');
  }
  tokenVersionEnsured = true;
}

// One FCM token = one device install → make it globally UNIQUE so a registration
// race can never leave duplicate rows (the duplicate-push cause). Dedupe first
// (keep the newest row per token), then add the index. Idempotent.
let deviceTokenUniqueEnsured = false;
async function ensureDeviceTokenUnique(connection) {
  if (deviceTokenUniqueEnsured) return;
  const [existing] = await connection.query(
    "SHOW INDEX FROM user_device_tokens WHERE Column_name = 'fcm_token' AND Non_unique = 0"
  );
  if (existing && existing.length) { deviceTokenUniqueEnsured = true; return; }
  // Collapse duplicate rows of the same token down to the newest id (a token
  // belongs to whichever device/user registered it last), so the UNIQUE can apply.
  await connection.query(
    `DELETE t1 FROM user_device_tokens t1
       JOIN user_device_tokens t2
         ON t1.fcm_token = t2.fcm_token AND t1.fcm_token IS NOT NULL AND t1.id < t2.id`
  );
  await connection.query('ALTER TABLE user_device_tokens ADD UNIQUE KEY uniq_fcm_token (fcm_token)');
  deviceTokenUniqueEnsured = true;
}

// ── Chat system (group chat per Job/Lead + 1:1 DMs) ──────────────────────────
// Four tables modeled on the existing task_assignees/tasks_images patterns.
let chatTablesEnsured = false;
async function ensureChatTables(connection) {
  if (chatTablesEnsured) return;
  await connection.query(`CREATE TABLE IF NOT EXISTS chat_conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type ENUM('job','lead','direct','group') NOT NULL,
    job_id INT NULL,
    lead_id INT NULL,
    dm_key VARCHAR(40) NULL,
    title VARCHAR(160) NULL,
    owner_id INT NULL,
    created_by INT NULL,
    last_message_at DATETIME NULL,
    last_message_preview VARCHAR(200) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_dm (dm_key),
    UNIQUE KEY uniq_job (job_id),
    UNIQUE KEY uniq_lead (lead_id),
    INDEX idx_conv_owner (owner_id),
    INDEX idx_conv_lastmsg (last_message_at)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TABLE IF NOT EXISTS chat_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    user_id INT NOT NULL,
    role ENUM('owner','member') NOT NULL DEFAULT 'member',
    last_read_message_id INT NULL,
    muted TINYINT NOT NULL DEFAULT 0,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_conv_user (conversation_id, user_id),
    INDEX idx_cm_user (user_id),
    INDEX idx_cm_conv (conversation_id)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    sender_id INT NOT NULL,
    body TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_msg_conv (conversation_id, id)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TABLE IF NOT EXISTS chat_message_attachments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    conversation_id INT NOT NULL,
    type ENUM('image','file','link') NOT NULL DEFAULT 'file',
    file_path VARCHAR(255) NULL,
    file_name VARCHAR(255) NULL,
    mime_type VARCHAR(120) NULL,
    url VARCHAR(500) NULL,
    uploaded_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_att_msg (message_id),
    INDEX idx_att_conv (conversation_id)
  ) ENGINE=InnoDB`);
  chatTablesEnsured = true;
}

// One-time (idempotent) backfill: a group conversation for every EXISTING job and
// lead, with the owner seeded as 'owner' and the job's existing job_contacts as
// members. Cheap after the first run (the LEFT JOIN … IS NULL sets go empty).
// Going forward, job/lead CREATE routes create the conversation directly.
let chatBackfillDone = false;
async function ensureChatBackfill(connection) {
  if (chatBackfillDone) return;
  await connection.query(`
    INSERT IGNORE INTO chat_conversations (type, job_id, owner_id, created_by, created_at)
    SELECT 'job', j.id, COALESCE(u.created_by, j.created_by), j.created_by, NOW()
    FROM job j
    LEFT JOIN chat_conversations c ON c.type='job' AND c.job_id = j.id
    LEFT JOIN user u ON u.id = j.created_by
    WHERE c.id IS NULL`);
  await connection.query(`
    INSERT IGNORE INTO chat_conversations (type, lead_id, owner_id, created_by, created_at)
    SELECT 'lead', l.id, COALESCE(u.created_by, l.user_id), l.user_id, NOW()
    FROM leads l
    LEFT JOIN chat_conversations c ON c.type='lead' AND c.lead_id = l.id
    LEFT JOIN user u ON u.id = l.user_id
    WHERE c.id IS NULL AND (l.status IS NULL OR l.status <> 3)`); /* skip CONVERTED leads (status 3 → became a job) */
  await connection.query(`
    INSERT IGNORE INTO chat_members (conversation_id, user_id, role, joined_at)
    SELECT c.id, c.created_by, 'owner', NOW()
    FROM chat_conversations c
    LEFT JOIN chat_members m ON m.conversation_id=c.id AND m.user_id=c.created_by
    WHERE c.type IN ('job','lead') AND c.created_by IS NOT NULL AND m.id IS NULL`);
  await connection.query(`
    INSERT IGNORE INTO chat_members (conversation_id, user_id, role, joined_at)
    SELECT DISTINCT c.id, jc.contact_id, 'member', NOW()
    FROM chat_conversations c
    JOIN job_contacts jc ON jc.job_id = c.job_id
    LEFT JOIN chat_members m ON m.conversation_id=c.id AND m.user_id=jc.contact_id
    WHERE c.type='job' AND jc.contact_id IS NOT NULL AND m.id IS NULL`);
  chatBackfillDone = true;
}

// Add icon_url to chat_conversations (owner-set custom chat photo). Idempotent.
let chatIconColEnsured = false;
async function ensureChatIconColumn(connection) {
  if (chatIconColEnsured) return;
  try {
    const [[col]] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_conversations' AND COLUMN_NAME='icon_url'`
    );
    if (!col) await connection.query("ALTER TABLE chat_conversations ADD COLUMN icon_url VARCHAR(500) NULL");
  } catch (e) { /* non-fatal */ }
  chatIconColEnsured = true;
}

// Add edited_at to chat_messages (2-minute in-place message editing). Idempotent.
let chatEditColEnsured = false;
async function ensureChatMessageEditColumn(connection) {
  if (chatEditColEnsured) return;
  try {
    const [[col]] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_messages' AND COLUMN_NAME='edited_at'`
    );
    if (!col) await connection.query("ALTER TABLE chat_messages ADD COLUMN edited_at DATETIME NULL");
  } catch (e) { /* non-fatal */ }
  chatEditColEnsured = true;
}

// Chat Files feature (2026-08-28): link a chat attachment to a SHARED job_documents
// row (job-attached chats — rename/detach act on the shared record), and a per-member
// "can edit the group photo" grant (chat-creator can toggle it). Both idempotent.
let chatFilesColsEnsured = false;
async function ensureChatFilesColumns(connection) {
  if (chatFilesColsEnsured) return;
  try {
    const [[a]] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_message_attachments' AND COLUMN_NAME='job_document_id'`
    );
    if (!a) await connection.query("ALTER TABLE chat_message_attachments ADD COLUMN job_document_id INT NULL, ADD INDEX idx_att_jobdoc (job_document_id)");
    // Files pulled from the job attach to the panel WITHOUT posting a thread message, so
    // message_id must allow NULL (panel-only attachments).
    await connection.query("ALTER TABLE chat_message_attachments MODIFY COLUMN message_id INT NULL");
  } catch (e) { /* non-fatal */ }
  try {
    const [[m]] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_members' AND COLUMN_NAME='can_edit_photo'`
    );
    if (!m) await connection.query("ALTER TABLE chat_members ADD COLUMN can_edit_photo TINYINT(1) NOT NULL DEFAULT 0");
  } catch (e) { /* non-fatal */ }
  chatFilesColsEnsured = true;
}

// Message reactions ("tapbacks") — one emoji per user per message (tap a new one
// to replace, the same one to remove). Idempotent create.
let chatReactionsEnsured = false;
async function ensureChatReactionsTable(connection) {
  if (chatReactionsEnsured) return;
  await connection.query(`CREATE TABLE IF NOT EXISTS chat_message_reactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    conversation_id INT NOT NULL,
    user_id INT NOT NULL,
    emoji VARCHAR(16) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_msg_user (message_id, user_id),
    INDEX idx_react_msg (message_id),
    INDEX idx_react_conv (conversation_id)
  ) ENGINE=InnoDB`);
  chatReactionsEnsured = true;
}

// Add 'group' to the chat type enum on an EXISTING table (custom group chats).
let chatGroupTypeEnsured = false;
async function ensureChatGroupType(connection) {
  if (chatGroupTypeEnsured) return;
  try {
    const [[col]] = await connection.query(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_conversations' AND COLUMN_NAME='type'`
    );
    if (col && !/'group'/.test(String(col.COLUMN_TYPE))) {
      await connection.query("ALTER TABLE chat_conversations MODIFY COLUMN type ENUM('job','lead','direct','group') NOT NULL");
    }
  } catch (e) { /* non-fatal */ }
  chatGroupTypeEnsured = true;
}

// One-time cleanup: a lead converted to a job (job.lead_id set, lead.status=3) left
// BOTH a lead chat and a job chat → the same project showed twice. Merge the lead
// chat INTO the job chat (moving any messages/attachments/members, so nothing is
// lost), then delete the redundant lead chat. Idempotent (finds no pairs once done).
let chatMergeDone = false;
async function ensureChatMergeConvertedLeadChats(connection) {
  if (chatMergeDone) return;
  const [pairs] = await connection.query(`
    SELECT jc.id AS job_conv, lc.id AS lead_conv
      FROM job j
      JOIN chat_conversations jc ON jc.type='job'  AND jc.job_id  = j.id
      JOIN chat_conversations lc ON lc.type='lead' AND lc.lead_id = j.lead_id
     WHERE j.lead_id IS NOT NULL`);
  for (const p of pairs) {
    await connection.query('UPDATE chat_messages SET conversation_id=? WHERE conversation_id=?', [p.job_conv, p.lead_conv]);
    await connection.query('UPDATE chat_message_attachments SET conversation_id=? WHERE conversation_id=?', [p.job_conv, p.lead_conv]);
    await connection.query(
      "INSERT IGNORE INTO chat_members (conversation_id, user_id, role, joined_at) SELECT ?, user_id, 'member', NOW() FROM chat_members WHERE conversation_id=?",
      [p.job_conv, p.lead_conv]
    );
    await connection.query('DELETE FROM chat_members WHERE conversation_id=?', [p.lead_conv]);
    await connection.query('DELETE FROM chat_conversations WHERE id=?', [p.lead_conv]);
    await connection.query(
      `UPDATE chat_conversations c
          SET last_message_at = (SELECT MAX(created_at) FROM chat_messages WHERE conversation_id=c.id),
              last_message_preview = (SELECT body FROM chat_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1)
        WHERE c.id=?`,
      [p.job_conv]
    );
  }
  chatMergeDone = true;
}

// One-time cleanup (idempotent): the checklist "shopping" type was retired long
// ago — creation is rejected and reads collapse to 'task' — but legacy shopping
// sections and their items may still sit in the DB and render as read-only pages.
// With no live customer data (every row is Poul's test data), remove them
// outright: items first (FK-safe), then the sections. Idempotent — after the
// first run there are no shopping rows, so it deletes 0. Returns counts + the
// distinct owner_user_ids removed so the boot log is auditable (if an owner id
// that isn't Poul's ever appears, the no-users assumption was wrong).
async function purgeShoppingLists(connection) {
  const [secRows] = await connection.query(
    "SELECT id, owner_user_id FROM checklist_sections WHERE type = 'shopping'"
  );
  if (!secRows.length) return { sections: 0, items: 0, owners: [], aborted: false, foreign: [] };
  const ids = secRows.map((r) => r.id);
  const owners = [...new Set(secRows.map((r) => Number(r.owner_user_id)).filter(Boolean))];

  // GUARD (check FIRST, before deleting): every shopping section must belong to
  // Poul's account. Resolve each owner to its account owner and require that
  // owner's email be in OWNER_EXEMPT_EMAILS. If ANY is foreign, the "no users"
  // assumption is wrong — ABORT, delete nothing, and let the boot log say why.
  // (Not throwing: the deploy must not fail; the purge simply skips.)
  const { OWNER_EXEMPT_EMAILS, resolveOwnerId } = require("../utils/access");
  const foreign = [];
  for (const oid of owners) {
    let accountOwnerId = oid;
    try { accountOwnerId = await resolveOwnerId(oid, connection); } catch (e) { /* fall back to self */ }
    const [[u]] = await connection.query("SELECT email FROM `user` WHERE id = ? LIMIT 1", [accountOwnerId]);
    const email = String(u && u.email ? u.email : "").trim().toLowerCase();
    if (!OWNER_EXEMPT_EMAILS.has(email)) foreign.push({ owner_user_id: oid, account_owner_id: accountOwnerId, email });
  }
  if (foreign.length) {
    return { sections: 0, items: 0, owners, aborted: true, foreign };
  }

  const [itemDel] = await connection.query(
    "DELETE FROM check_list WHERE section_id IN (?)", [ids]
  );
  const [secDel] = await connection.query(
    "DELETE FROM checklist_sections WHERE type = 'shopping'"
  );
  return { sections: secDel.affectedRows || 0, items: itemDel.affectedRows || 0, owners, aborted: false, foreign: [] };
}

module.exports = {
  purgeShoppingLists,
  ensureChatTables,
  ensureChatGroupType,
  ensureChatReactionsTable,
  ensureChatMessageEditColumn,
  ensureChatIconColumn,
  ensureChatFilesColumns,
  ensureChatBackfill,
  ensureChatMergeConvertedLeadChats,
  ensureUserTokenVersionColumn,
  ensureDeviceTokenUnique,
  dropUserMobileUniqueIndex,
  ensureSuggestedItemsTable,
  seedSuggestedItems,
  ensureGanttStageProgressTable,
  ensureUserAccountSourceColumn,
  ensureContactAuthorityColumn,
  ensureUserFirstLoginColumn,
  ensureUserLevelColumn,
  ensureFamilyFriendSubcategory,
  ensureSubscriptionPaymentColumns,
  ensurePaymentReceiptsTable,
  ensureJobColorColumn,
  ensureJobColorLockedColumn,
  ensureAppointmentAllDayColumn,
  ensureContactStatusColumn,
  ensureLeadBidStatusColumn,
  ensureOwnerTypeColumns,
  ensureMaterialsExtraColumns,
  ensureSubCostColumn,
  ensureInHouseColumn,
  ensureAllowanceColumn,
  ensureBudgetPercentColumns,
  ensurePaymentsTables,
  ensureBudgetLockTables,
  ensureChangeOrderBudgetColumns,
  ensureChangeOrderPaymentTables,
  ensureJobNumberColumn,
  backfillJobNumbers,
  assignJobNumberIfMissing,
  ensureInvoicesTable,
  ensureInvoiceDocumentSchema,
  ensureRemindersTable,
  ensureScheduleTemplateTables,
  ensurePlanLevelColumn,
  ensureUserTimezoneColumn,
  ensureSubscriptionReverifyColumn,
  ensureReverifyEmailLogTable,
  ensureWebhookEventsTable,
  ensureTaskManagerColumns,
  ensureTaskAssigneesTable,
};
