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

module.exports = { ensureContactStatusColumn };
