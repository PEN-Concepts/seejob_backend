'use strict';
const cron = require('node-cron');
const pool = require('../config/connection');
const { checkAllLicenses } = require('../services/cslbChecker');
const logger = require('../common/logger');

// Runs every day at 2:00 AM — checks all contractor licenses and updates cslb_status
cron.schedule('0 2 * * *', async () => {
  logger.info('[LicenseCheck] Starting nightly CSLB license check...');
  let connection;
  try {
    connection = await pool.getConnection();

    // Get all connected users who have a license number
    const [contractors] = await connection.query(`
      SELECT DISTINCT u.id, u.name, u.business, u.organization_name, u.license_number
      FROM user u
      WHERE (u.license_number IS NOT NULL AND u.license_number != '')
        AND EXISTS (
          SELECT 1 FROM contact c
          WHERE c.status = 'Accept'
            AND (c.request_by = u.id OR c.request_to = u.id)
        )
    `);

    if (!contractors.length) {
      logger.info('[LicenseCheck] No contractors with license numbers found.');
      return;
    }

    logger.info(`[LicenseCheck] Checking ${contractors.length} licenses...`);
    const results = await checkAllLicenses(contractors);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const r of results) {
      await connection.query(
        `UPDATE user SET cslb_status = ?, cslb_checked_at = ? WHERE id = ?`,
        [r.cslb_status, now, r.id]
      );
    }

    const flagged = results.filter(r => !['Active', 'No License #'].includes(r.cslb_status));
    logger.info(`[LicenseCheck] Done. ${results.length} checked, ${flagged.length} flagged.`);
  } catch (err) {
    logger.error('[LicenseCheck] Cron error:', err);
  } finally {
    if (connection) connection.release();
  }
}, { timezone: 'America/Los_Angeles' });
