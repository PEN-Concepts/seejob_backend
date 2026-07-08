// sendReminders.js — every minute, deliver any due reminders via FCM so alerts
// fire even when the app is closed. Uses the working file-based Firebase Admin
// (config/firebase-admin) + data-only messages so the service worker renders the
// branded/persistent/click-to-open notification.
const cron = require('node-cron');
const pool = require('../config/connection');
const logger = require('../common/logger');
const admin = require('../config/firebase-admin');
const { ensureRemindersTable } = require('../services/dbMigrations');

async function sendDueReminders() {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureRemindersTable(connection);

    const [rows] = await connection.query(
      `SELECT id, user_id, source_type, title, body, job_name, appt_time, appt_address, url
       FROM reminders
       WHERE sent_at IS NULL
         AND fire_at <= UTC_TIMESTAMP()
         AND fire_at > (UTC_TIMESTAMP() - INTERVAL 2 DAY)
       ORDER BY fire_at ASC
       LIMIT 200`
    );

    for (const r of rows) {
      try {
        const [tokRows] = await connection.query(
          'SELECT fcm_token FROM user_device_tokens WHERE user_id = ?',
          [r.user_id]
        );
        const tokens = tokRows.map((t) => t.fcm_token).filter(Boolean);

        const data = {
          type: String(r.source_type || 'task'),
          title: String(r.title || 'Reminder'),
          body: r.body ? String(r.body) : '',
          jobName: r.job_name ? String(r.job_name) : '',
          apptTime: r.appt_time ? String(r.appt_time) : '',
          apptAddress: r.appt_address ? String(r.appt_address) : '',
          url: r.url ? String(r.url) : 'dashboard',
        };

        for (const tok of tokens) {
          try {
            await admin.messaging().send({
              token: tok,
              data,
              webpush: { headers: { Urgency: 'high' } },
            });
          } catch (e) {
            const code = e && e.code;
            if (code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token') {
              await connection.query('DELETE FROM user_device_tokens WHERE fcm_token = ?', [tok]);
            } else {
              logger.error(`[Reminders] send error (reminder ${r.id}): ${e.message}`);
            }
          }
        }

        // Mark sent regardless of token presence so it doesn't retry forever
        // (a user with no token simply gets no push).
        await connection.query('UPDATE reminders SET sent_at = NOW() WHERE id = ?', [r.id]);
      } catch (inner) {
        logger.error(`[Reminders] processing reminder ${r.id}: ${inner.message}`);
      }
    }
  } catch (err) {
    logger.error('[Reminders] cron error: ' + err.message);
  } finally {
    if (connection) connection.release();
  }
}

cron.schedule('* * * * *', () => {
  sendDueReminders();
});

logger.info('[Reminders] Cron registered – checks every minute for due reminders');

module.exports = { sendDueReminders };
