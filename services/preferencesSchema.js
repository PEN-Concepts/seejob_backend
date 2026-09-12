'use strict';

/**
 * Per-LOGIN preferences: one small store, not a column per feature.
 *
 * Scoped to user_id, never to the account — a preference is yours, not your
 * company's, so two people sharing an account keep their own view. Set it at
 * the desk and it is set on the phone, which is the point: these follow the
 * login, not the device.
 *
 * `pref_value` is TEXT holding JSON so a boolean and a small list both fit
 * without another migration. It is NOT a general dumping ground — the route
 * allowlists the keys and caps the size (see routes/preferences.js).
 *
 * NOT here: the notepad card order. An ordered list of section ids is a
 * relational shape and lives in checklist_section_order, its own table. Two
 * mechanisms because they are two different kinds of thing.
 *
 * Additive and idempotent, like ensureNotepadSchema. The "done" flag is only
 * cached when the statement succeeded, so a genuinely missing table is retried
 * on the next request rather than skipped forever.
 */

let ensured = false;

async function ensurePreferencesSchema(connection) {
  if (ensured) return;
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        pref_key VARCHAR(64) NOT NULL,
        pref_value TEXT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_pref (user_id, pref_key),
        KEY idx_pref_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    ensured = true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('preferencesSchema:', e && e.message);
  }
}

/** Test seam — lets a suite re-run the migration against a fresh database. */
function resetPreferencesSchemaCache() {
  ensured = false;
}

module.exports = { ensurePreferencesSchema, resetPreferencesSchemaCache };
