'use strict';
const cron = require('node-cron');
const pool = require('../config/connection');
const logger = require('../common/logger');

/**
 * Ensure the tasks.archived_at column exists (idempotent).
 * archived_at = the timestamp a completed task was moved out of the active list.
 * NULL = still active/visible; non-NULL = archived (hidden unless "Show Archived").
 */
async function ensureArchivedColumn(connection) {
  const [cols] = await connection.query("SHOW COLUMNS FROM tasks LIKE 'archived_at'");
  if (!cols.length) {
    await connection.query(
      "ALTER TABLE tasks ADD COLUMN archived_at DATETIME NULL DEFAULT NULL"
    );
    logger.info('[ArchiveTasks] added tasks.archived_at column');
  }
}

/** Flag every completed (status = 1) task as archived so the next day starts clean. */
async function archiveCompletedTasks() {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureArchivedColumn(connection);
    const [res] = await connection.query(
      "UPDATE tasks SET archived_at = NOW() WHERE status = 1 AND archived_at IS NULL"
    );
    logger.info(`[ArchiveTasks] archived ${res.affectedRows} completed task(s).`);
  } catch (err) {
    logger.error('[ArchiveTasks] error: ' + err.message);
  } finally {
    if (connection) connection.release();
  }
}

// Make sure the column exists at startup, before any task query references it.
(async () => {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureArchivedColumn(connection);
  } catch (err) {
    logger.error('[ArchiveTasks] startup ensure error: ' + err.message);
  } finally {
    if (connection) connection.release();
  }
})();

// Nightly at 10:00 PM Pacific — archive completed tasks to clean up Task Manager.
cron.schedule('0 22 * * *', archiveCompletedTasks, { timezone: 'America/Los_Angeles' });

module.exports = { ensureArchivedColumn, archiveCompletedTasks };
