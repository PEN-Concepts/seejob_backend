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

module.exports = {
  ensureContactStatusColumn,
  ensureLeadBidStatusColumn,
  ensureOwnerTypeColumns,
  ensureRemindersTable,
  ensureScheduleTemplateTables,
  ensurePlanLevelColumn,
};
