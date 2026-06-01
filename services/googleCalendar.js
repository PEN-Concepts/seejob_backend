const { google } = require('googleapis');
const pool = require('../config/connection');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

/**
 * Create a new OAuth2 client with the configured credentials.
 */
function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * Generate the Google OAuth consent URL for a given user.
 * We pass the user's internal id as `state` so the callback knows who to link.
 */
function getAuthUrl(userId) {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: String(userId),
  });
}

/**
 * Exchange the authorization code for tokens and persist them.
 */
async function handleCallback(code, userId) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  const connection = await pool.getConnection();
  try {
    const expiry = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 3600 * 1000);

    await connection.query(
      `INSERT INTO user_google_tokens (user_id, access_token, refresh_token, token_expiry)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
         token_expiry  = VALUES(token_expiry),
         updated_at    = NOW()`,
      [userId, tokens.access_token, tokens.refresh_token, expiry],
    );
  } finally {
    connection.release();
  }

  return tokens;
}

/**
 * Build an authenticated OAuth2 client for a specific user.
 * Automatically refreshes the access token when expired.
 */
async function getAuthenticatedClient(userId) {
  const connection = await pool.getConnection();
  try {
    const [[row]] = await connection.query(
      'SELECT access_token, refresh_token, token_expiry FROM user_google_tokens WHERE user_id = ? LIMIT 1',
      [userId],
    );
    if (!row || !row.refresh_token) return null;

    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expiry_date: row.token_expiry ? new Date(row.token_expiry).getTime() : null,
    });

    // Listen for automatic token refresh and persist updated tokens
    oauth2Client.on('tokens', async (newTokens) => {
      const conn = await pool.getConnection();
      try {
        const exp = newTokens.expiry_date
          ? new Date(newTokens.expiry_date)
          : new Date(Date.now() + 3600 * 1000);
        await conn.query(
          `UPDATE user_google_tokens
           SET access_token = ?, token_expiry = ?, updated_at = NOW()
           WHERE user_id = ?`,
          [newTokens.access_token, exp, userId],
        );
      } finally {
        conn.release();
      }
    });

    return oauth2Client;
  } finally {
    connection.release();
  }
}

/**
 * Check if a user has connected their Google Calendar.
 */
async function isConnected(userId) {
  const connection = await pool.getConnection();
  try {
    const [[row]] = await connection.query(
      'SELECT id FROM user_google_tokens WHERE user_id = ? AND refresh_token IS NOT NULL LIMIT 1',
      [userId],
    );
    return !!row;
  } finally {
    connection.release();
  }
}

/**
 * Disconnect a user's Google Calendar (remove tokens).
 */
async function disconnect(userId) {
  const connection = await pool.getConnection();
  try {
    await connection.query('DELETE FROM user_google_tokens WHERE user_id = ?', [userId]);
  } finally {
    connection.release();
  }
}

// ─── Google Calendar Event Helpers ───────────────────────────────────

/**
 * Fetch the timezone of the user's primary Google Calendar.
 * This ensures events always match the user's Google account timezone,
 * regardless of where the backend server is hosted.
 */
async function getUserCalendarTimeZone(auth) {
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.calendars.get({ calendarId: 'primary' });
    return res.data.timeZone || 'America/New_York';
  } catch (err) {
    console.error('Failed to fetch Google Calendar timezone:', err.message);
    return 'America/New_York';
  }
}

/**
 * Create a Google Calendar event from an appointment object.
 * Returns the created Google event id, or null on failure.
 */
async function createEvent(userId, appointment) {
  const auth = await getAuthenticatedClient(userId);
  if (!auth) return null;

  const userTz = await getUserCalendarTimeZone(auth);
  const calendar = google.calendar({ version: 'v3', auth });
  const event = buildEventResource(appointment, userTz);

  try {
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });
    return res.data.id || null;
  } catch (err) {
    console.error('Google Calendar createEvent error:', err.message);
    return null;
  }
}

/**
 * Update an existing Google Calendar event.
 */
async function updateEvent(userId, googleEventId, appointment) {
  if (!googleEventId) return null;
  const auth = await getAuthenticatedClient(userId);
  if (!auth) return null;

  const userTz = await getUserCalendarTimeZone(auth);
  const calendar = google.calendar({ version: 'v3', auth });
  const event = buildEventResource(appointment, userTz);

  try {
    const res = await calendar.events.update({
      calendarId: 'primary',
      eventId: googleEventId,
      requestBody: event,
    });
    return res.data.id || null;
  } catch (err) {
    console.error('Google Calendar updateEvent error:', err.message);
    return null;
  }
}

/**
 * Delete a Google Calendar event.
 */
async function deleteEvent(userId, googleEventId) {
  if (!googleEventId) return;
  const auth = await getAuthenticatedClient(userId);
  if (!auth) return;

  const calendar = google.calendar({ version: 'v3', auth });

  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: googleEventId,
    });
  } catch (err) {
    // 404/410 means already deleted — ignore
    if (err.code !== 404 && err.code !== 410) {
      console.error('Google Calendar deleteEvent error:', err.message);
    }
  }
}

/**
 * Bulk-sync all of a user's appointments to Google Calendar.
 * Returns { synced, failed } counts.
 */
async function syncAllAppointments(userId) {
  const auth = await getAuthenticatedClient(userId);
  if (!auth) throw new Error('Google Calendar not connected');

  const userTz = await getUserCalendarTimeZone(auth);

  const connection = await pool.getConnection();
  try {
    const [appointments] = await connection.query(
      `SELECT a.id, a.subject, a.description, a.doa, a.time_of_appointment,
              a.appointment_type, a.zoom_link, a.meeting_location,
              a.google_event_id,
              j.name AS job_name, j.address AS job_address
       FROM appointments a
       LEFT JOIN job j ON a.job_id = j.id
       WHERE a.created_by = ? OR a.user_id = ?`,
      [userId, userId],
    );

    const cal = google.calendar({ version: 'v3', auth });
    let synced = 0;
    let failed = 0;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isRateLimitError = (e) => {
      if (!e) return false;
      const code = e.code;
      const status = e.response && e.response.status;
      const reason = (e.errors && e.errors[0] && e.errors[0].reason) ||
        (e.response && e.response.data && e.response.data.error &&
         e.response.data.error.errors && e.response.data.error.errors[0] &&
         e.response.data.error.errors[0].reason);
      return (
        code === 429 ||
        status === 429 ||
        reason === 'rateLimitExceeded' ||
        reason === 'userRateLimitExceeded'
      );
    };

    const withRetries = async (fn, { maxRetries = 5 } = {}) => {
      let attempt = 0;
      // base delay ~500ms, exponential backoff + jitter
      let delayMs = 500;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          return await fn();
        } catch (e) {
          attempt++;
          if (!isRateLimitError(e) || attempt > maxRetries) throw e;
          const jitter = Math.floor(Math.random() * 250);
          await sleep(delayMs + jitter);
          delayMs = Math.min(delayMs * 2, 8000);
        }
      }
    };

    for (const appt of appointments) {
      try {
        const event = buildEventResource(appt, userTz);

        if (appt.google_event_id) {
          // Try to update existing event
          try {
            await withRetries(() =>
              cal.events.update({
                calendarId: 'primary',
                eventId: appt.google_event_id,
                requestBody: event,
              }),
            );
            synced++;
            await sleep(150);
            continue;
          } catch (updateErr) {
            // If event was deleted on Google side, create a new one
            if (updateErr.code !== 404 && updateErr.code !== 410) throw updateErr;
          }
        }

        // Create new event
        const res = await withRetries(() =>
          cal.events.insert({
            calendarId: 'primary',
            requestBody: event,
          }),
        );
        const googleEventId = res.data.id;

        // Store the google_event_id in appointments table
        if (googleEventId) {
          await connection.query(
            'UPDATE appointments SET google_event_id = ? WHERE id = ?',
            [googleEventId, appt.id],
          );
        }
        synced++;
        await sleep(150);
      } catch (err) {
        console.error(`Failed to sync appointment ${appt.id}:`, err.message);
        failed++;
      }
    }

    return { synced, failed, total: appointments.length };
  } finally {
    connection.release();
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────

function buildEventResource(appointment, timeZone) {
  const doa = appointment.doa
    ? typeof appointment.doa === 'string'
      ? appointment.doa.slice(0, 10)
      : new Date(appointment.doa).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const time = appointment.time_of_appointment || '09:00:00';
  const timeStr = typeof time === 'string' ? time : '09:00:00';

  // Build start datetime
  const startDateTime = `${doa}T${timeStr.length === 5 ? timeStr + ':00' : timeStr}`;
  const startDate = new Date(startDateTime);

  // Build end datetime from end_date/end_time, or default to +1 hour
  let endDate;
  let endDateTime;
  const endDoa = appointment.end_date
    ? typeof appointment.end_date === 'string'
      ? appointment.end_date.slice(0, 10)
      : new Date(appointment.end_date).toISOString().slice(0, 10)
    : null;
  const endTime = appointment.end_time || null;
  const endTimeStr = typeof endTime === 'string' ? endTime : null;

  if (endDoa && endTimeStr) {
    endDateTime = `${endDoa}T${endTimeStr.length === 5 ? endTimeStr + ':00' : endTimeStr}`;
    endDate = new Date(endDateTime);
    // If end is before or equal to start, default to +1 hour
    if (endDate.getTime() <= startDate.getTime()) {
      endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      endDateTime = null;
    }
  } else {
    endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    endDateTime = null;
  }

  // Avoid Date.toISOString() because it converts to UTC and can shift the day.
  // Google Calendar API accepts a "floating" local RFC3339 dateTime when paired with a timeZone.
  // timeZone is fetched from the user's Google Calendar account — always matches their location.
  if (!timeZone) timeZone = 'America/New_York';

  const pad2 = (n) => String(n).padStart(2, '0');
  const formatLocalDateTime = (d) => {
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mi = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  };

  const safeStartDateTime = startDateTime || formatLocalDateTime(startDate);
  const safeEndDateTime = endDateTime || formatLocalDateTime(endDate);

  // Build description
  const parts = [];
  if (appointment.description) parts.push(appointment.description);
  if (appointment.job_name) parts.push(`Job: ${appointment.job_name}`);
  if (appointment.appointment_type) parts.push(`Type: ${appointment.appointment_type}`);
  if (appointment.zoom_link) parts.push(`Zoom: ${appointment.zoom_link}`);
  const description = parts.join('\n');

  // Build location
  const location =
    appointment.meeting_location ||
    appointment.job_address ||
    appointment.address ||
    '';

  return {
    summary: appointment.subject || appointment.title || 'SeeJobRun Appointment',
    description,
    location,
    start: {
      dateTime: safeStartDateTime,
      timeZone,
    },
    end: {
      dateTime: safeEndDateTime,
      timeZone,
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
      ],
    },
  };
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getAuthenticatedClient,
  isConnected,
  disconnect,
  createEvent,
  updateEvent,
  deleteEvent,
  syncAllAppointments,
};
