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
      source_id INT NULL,
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
    )
  `);
  remindersTableEnsured = true;
}

module.exports = { ensureContactStatusColumn, ensureOwnerTypeColumns, ensureRemindersTable };
