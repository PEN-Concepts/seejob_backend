// sendReminders.js — every minute:
//  (1) deliver explicit reminders from the `reminders` table (user-set leads);
//  (2) derive DEFAULT reminders from real appointments + Notepad items — 10 min
//      before a timed item, or ~8 AM for an all-day/date-only one — so every
//      dated item alerts automatically without the user setting anything.
// All sends are data-only FCM via config/firebase-admin so the service worker
// renders the branded/persistent/click-to-open notification.
const cron = require('node-cron');
const moment = require('moment-timezone');
const pool = require('../config/connection');
const logger = require('../common/logger');
const admin = require('../config/firebase-admin');
const { ensureRemindersTable } = require('../services/dbMigrations');

const TZ = process.env.TZ || 'America/Los_Angeles';

function fmtTime12(hhmmss) {
  const m = String(hhmmss || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = +m[1];
  const am = h < 12;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m[2]} ${am ? 'AM' : 'PM'}`;
}

// Send a data-only push to all of a user's device tokens; prune dead ones.
async function sendToUser(connection, userId, data) {
  const [tokRows] = await connection.query(
    'SELECT fcm_token FROM user_device_tokens WHERE user_id = ?',
    [userId]
  );
  const tokens = tokRows.map((t) => t.fcm_token).filter(Boolean);
  for (const tok of tokens) {
    try {
      await admin.messaging().send({ token: tok, data, webpush: { headers: { Urgency: 'high' } } });
    } catch (e) {
      const code = e && e.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        await connection.query('DELETE FROM user_device_tokens WHERE fcm_token = ?', [tok]);
      } else {
        logger.error(`[Reminders] send error (user ${userId}): ${e.message}`);
      }
    }
  }
}

// Claim a default reminder (dedupe): insert a marker row if none exists for this
// source. Returns true if we just claimed it (i.e., should send now).
async function claimDefault(connection, userId, sourceType, sourceKey) {
  const [rows] = await connection.query(
    'SELECT id FROM reminders WHERE user_id = ? AND source_type = ? AND source_id = ? LIMIT 1',
    [userId, sourceType, sourceKey]
  );
  if (rows.length) return false;
  await connection.query(
    `INSERT INTO reminders (user_id, source_type, source_id, title, fire_at, sent_at, created_at)
     VALUES (?, ?, ?, '(default)', UTC_TIMESTAMP(), NOW(), NOW())`,
    [userId, sourceType, sourceKey]
  );
  return true;
}

// (1) Explicit reminders the frontend wrote (custom leads).
async function sendDueExplicit(connection) {
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
      await sendToUser(connection, r.user_id, {
        type: String(r.source_type || 'task'),
        title: String(r.title || 'Reminder'),
        body: r.body ? String(r.body) : '',
        jobName: r.job_name ? String(r.job_name) : '',
        apptTime: r.appt_time ? String(r.appt_time) : '',
        apptAddress: r.appt_address ? String(r.appt_address) : '',
        url: r.url ? String(r.url) : 'dashboard',
      });
      await connection.query('UPDATE reminders SET sent_at = NOW() WHERE id = ?', [r.id]);
    } catch (inner) {
      logger.error(`[Reminders] explicit ${r.id}: ${inner.message}`);
    }
  }
}

// Resolve a user's saved IANA timezone (cached per tick). Falls back to the
// process default (Pacific) when unset or invalid. Used to interpret each item's
// LOCAL wall-clock time (appointment start, notepad due / 8 AM default) into the
// correct absolute fire instant for THAT user.
async function tzForUser(connection, uid, cache) {
  if (cache.has(uid)) return cache.get(uid);
  let tz = TZ;
  try {
    const [[row]] = await connection.query('SELECT timezone FROM `user` WHERE id = ? LIMIT 1', [uid]);
    if (row && row.timezone && moment.tz.zone(row.timezone)) tz = row.timezone;
  } catch (e) { /* keep default */ }
  cache.set(uid, tz);
  return tz;
}

// (2) Default reminders derived from appointments + Notepad items.
async function sendDefaults(connection) {
  const now = moment.tz(TZ);
  // Coarse ±1-day DB window (in the default zone) — generous enough to catch an
  // item that is "today" in any US timezone; the exact fire check below uses the
  // owning user's real zone.
  const from = now.clone().subtract(1, 'day').format('YYYY-MM-DD');
  const to = now.clone().add(1, 'day').format('YYYY-MM-DD');
  const tzCache = new Map();

  // Appointments → 10 min before start (all-day is stored 09:00 → ~8:50 AM).
  const [appts] = await connection.query(
    `SELECT a.id, a.subject, a.doa, a.time_of_appointment,
            COALESCE(a.user_id, a.created_by) AS uid,
            COALESCE(NULLIF(a.meeting_location, ''), NULLIF(a.address, '')) AS addr
     FROM appointments a
     WHERE a.doa BETWEEN ? AND ?`,
    [from, to]
  );
  for (const a of appts) {
    const uid = Number(a.uid);
    if (!uid) continue;
    const utz = await tzForUser(connection, uid, tzCache);
    const timeStr = String(a.time_of_appointment || '09:00:00');
    const apptM = moment.tz(`${a.doa} ${timeStr}`, 'YYYY-MM-DD HH:mm:ss', utz);
    if (!apptM.isValid()) continue;
    const fireM = apptM.clone().subtract(10, 'minutes');
    if (now.isSameOrAfter(fireM) && now.isBefore(apptM.clone().add(5, 'minutes'))) {
      if (await claimDefault(connection, uid, 'appointment', `${a.id}:default`)) {
        const apptTime = fmtTime12(timeStr);
        await sendToUser(connection, uid, {
          type: 'appointment',
          title: String(a.subject || 'Appointment'),
          apptTime,
          apptAddress: a.addr ? String(a.addr) : '',
          body: apptTime + (a.addr ? ' — ' + a.addr : ''),
          url: 'calendar',
        });
      }
    }
  }

  // Notepad items with a due date → 10 min before (timed) or 8 AM (date-only).
  let notes = [];
  try {
    [notes] = await connection.query(
      `SELECT c.id, c.name, c.due_date, c.created_by AS uid, j.name AS job_name
       FROM check_list c
       LEFT JOIN job j ON j.id = c.job_id
       WHERE c.due_date IS NOT NULL
         AND (c.status IS NULL OR c.status <> 'completed')
         AND DATE(c.due_date) BETWEEN ? AND ?`,
      [from, to]
    );
  } catch (e) {
    if (e && e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  for (const c of notes) {
    const uid = Number(c.uid);
    if (!uid) continue;
    const utz = await tzForUser(connection, uid, tzCache);
    const raw = String(c.due_date).replace('T', ' ');
    const dateStr = raw.slice(0, 10);
    const hasTime = /\d{2}:\d{2}/.test(raw) && !/00:00(:00)?$/.test(raw);
    let shouldFire = false;
    if (hasTime) {
      const dueM = moment.tz(raw, 'YYYY-MM-DD HH:mm:ss', utz);
      if (!dueM.isValid()) continue;
      const fireM = dueM.clone().subtract(10, 'minutes');
      shouldFire = now.isSameOrAfter(fireM) && now.isBefore(dueM.clone().add(5, 'minutes'));
    } else {
      const eightAM = moment.tz(`${dateStr} 08:00:00`, 'YYYY-MM-DD HH:mm:ss', utz);
      // Compare in the user's zone so the "same day" guard is correct for them.
      const nowUtz = now.clone().tz(utz);
      shouldFire = nowUtz.isSameOrAfter(eightAM) && nowUtz.isSame(eightAM, 'day');
    }
    if (shouldFire && (await claimDefault(connection, uid, 'note', `${c.id}:default`))) {
      await sendToUser(connection, uid, {
        type: 'note',
        title: String(c.name || 'Reminder'),
        jobName: c.job_name ? String(c.job_name) : '',
        body: c.job_name ? 'Job: ' + c.job_name : '',
        url: 'checklist3',
      });
    }
  }
}

async function tick() {
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureRemindersTable(connection);
    await sendDueExplicit(connection);
    await sendDefaults(connection);
  } catch (err) {
    logger.error('[Reminders] cron error: ' + err.message);
  } finally {
    if (connection) connection.release();
  }
}

cron.schedule('* * * * *', () => { tick(); });
logger.info('[Reminders] Cron registered – explicit + default reminders, every minute');

module.exports = { tick };
