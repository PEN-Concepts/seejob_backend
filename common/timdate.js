const moment = require('moment-timezone');

const DEFAULT_TZ = 'America/Los_Angeles';

/** Validate an IANA zone, falling back to the process/Pacific default. */
const resolveTz = (tz) => (tz && moment.tz.zone(tz) ? tz : (process.env.TZ || DEFAULT_TZ));

/** "Now" as a moment in the given user's timezone (or the default when unset).
 *  Pass an IANA string like 'America/New_York'. This is the Phase-B replacement
 *  for assuming Pacific everywhere — callers that know the owning user's zone
 *  should use this instead of the bare getCurrentDateTime/getTimeStamp. */
const nowFor = (tz) => moment.tz(resolveTz(tz));

/** 'YYYY-MM-DD HH:mm:ss' timestamp in the given timezone. */
const timeStampFor = (tz) => nowFor(tz).format('YYYY-MM-DD HH:mm:ss');

/** 'YYYY-MM-DD' calendar day in the given timezone. */
const todayFor = (tz) => nowFor(tz).format('YYYY-MM-DD');

/** Load a user's saved IANA timezone from the DB (falls back to the default).
 *  `db` is any object with `.query` (a pool or a checked-out connection). */
const getUserTz = async (db, userId) => {
  try {
    const [rows] = await db.query('SELECT timezone FROM `user` WHERE id = ? LIMIT 1', [userId]);
    const tz = rows && rows[0] && rows[0].timezone;
    if (tz && moment.tz.zone(tz)) return tz;
  } catch (e) { /* fall through to default */ }
  return process.env.TZ || DEFAULT_TZ;
};

// ---- Back-compat: existing callers get the default (Pacific) zone unchanged.
const getCurrentDateTime = () => nowFor().format();
const getTimeStamp = () => timeStampFor();

module.exports = {
  DEFAULT_TZ,
  resolveTz,
  nowFor,
  timeStampFor,
  todayFor,
  getUserTz,
  getCurrentDateTime,
  getTimeStamp,
};
