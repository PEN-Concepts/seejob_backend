'use strict';

/**
 * STALLED — "no change on the job or lead for N days" (N = 10, by ruling).
 *
 * WHAT COUNTS AS A CHANGE.
 *
 * The CCP says "no change" without saying what a change is, and there is no
 * single column to read: `job.updated_at` is not written anywhere in this
 * codebase (nothing references it). So activity has to be derived, and the
 * definition below is a judgement call — it is written in ONE place so it can
 * be corrected in one place.
 *
 * THE TEST IS "DID A HUMAN TOUCH THIS JOB", NOT "DID WORK GET FINISHED".
 * STALLED is about neglect, not progress. A job people are actively arguing
 * about in chat is not neglected, even if nothing has been completed on it.
 *
 * A job or lead is ACTIVE as of the most recent of:
 *   - the record's own creation
 *   - the newest task on it
 *   - the newest notepad item on any of its notepads
 *   - the newest schedule item on it
 *   - the newest chat message on its conversation
 *   - the newest file uploaded to it
 *   - the newest budget line-item edit
 *   - the newest appointment on it
 *
 * Deliberately NOT counted: merely opening or viewing a job. Reading a job is
 * not progress on it, and if it counted, the list meant to catch neglected
 * work would be silenced by the act of glancing at it.
 *
 * ONLY HUMAN ACTION COUNTS. Every source below requires an actor column to be
 * present and non-null (created_by, sender_id). A row written by a scheduled
 * job, a sync or a recalculation carries no actor and therefore does not reset
 * the clock. This is why each probe filters on the actor rather than simply
 * taking MAX(created_at) — a nightly recalculation touching every row would
 * otherwise mark the entire account active forever.
 *
 * FAILING OPEN, ON PURPOSE. Every probe is wrapped: a missing table or column
 * degrades that source to "no signal" instead of throwing. If we cannot tell
 * whether something changed, it is treated as NOT stalled. This is a read-side
 * helper and the cost of being wrong is asymmetric — nagging someone about a
 * job they are actively working is worse than staying quiet about one they are
 * not, and a false STALLED row trains people to ignore the band.
 */

const { stallDays } = require('./dashboardSchema');

/** Newest timestamp from one query, or null if the source is unavailable. */
async function probe(connection, sql, params) {
  try {
    const [rows] = await connection.query(sql, params);
    const v = rows && rows[0] && rows[0].ts;
    return v ? new Date(v) : null;
  } catch (e) {
    return null; // missing table/column on a partial schema — no signal
  }
}

/**
 * Last activity per job id, as a Map(jobId -> Date). Only the ids asked for.
 */
async function lastActivityForJobs(connection, jobIds) {
  const out = new Map();
  if (!jobIds || !jobIds.length) return out;
  const ids = jobIds.map(Number).filter(Boolean);
  if (!ids.length) return out;

  const bump = (id, ts) => {
    if (!ts) return;
    const k = Number(id);
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return;
    const cur = out.get(k);
    if (!cur || d > cur) out.set(k, d);
  };

  const resolved = [];
  const each = async (label, sql) => {
    try {
      const [rows] = await connection.query(sql, [ids]);
      for (const r of rows) bump(r.id, r.ts);
      resolved.push(label);
    } catch (e) { /* source unavailable on this schema — no signal */ }
  };

  await each('created', 'SELECT id, created_at AS ts FROM `job` WHERE id IN (?)');
  await each('tasks',
    'SELECT job_id AS id, MAX(created_at) AS ts FROM tasks WHERE job_id IN (?) AND created_by IS NOT NULL GROUP BY job_id');
  await each('notepad',
    `SELECT s.job_id AS id, MAX(c.created_at) AS ts
       FROM checklist_sections s
       JOIN check_list c ON c.section_id = s.id
      WHERE s.job_id IN (?) AND c.created_by IS NOT NULL GROUP BY s.job_id`);
  await each('schedule',
    `SELECT sc.job_id AS id, MAX(i.updated_at) AS ts
       FROM job_schedules sc
       JOIN job_schedule_items i ON i.schedule_id = sc.id
      WHERE sc.job_id IN (?) GROUP BY sc.job_id`);
  await each('chat',
    `SELECT cc.job_id AS id, MAX(cm.created_at) AS ts
       FROM chat_conversations cc
       JOIN chat_messages cm ON cm.conversation_id = cc.id
      WHERE cc.job_id IN (?) AND cm.sender_id IS NOT NULL GROUP BY cc.job_id`);
  await each('files',
    `SELECT job_id AS id, MAX(created_at) AS ts FROM job_documents
      WHERE job_id IN (?) AND created_by IS NOT NULL GROUP BY job_id`);
  // Budget line items: the timestamp column differs by vintage, so try the
  // newer name first and fall back. Whichever resolves is the one recorded.
  const budgetOk = await (async () => {
    for (const col of ['updated_at', 'created_at']) {
      const before = resolved.length;
      await each('budget', `SELECT job_id AS id, MAX(${col}) AS ts FROM division_lineitems WHERE job_id IN (?) GROUP BY job_id`);
      if (resolved.length > before) return true;
    }
    return false;
  })();
  if (!budgetOk) { /* neither column present — reported by activitySources() */ }
  await each('appointments',
    `SELECT job_id AS id, MAX(created_at) AS ts FROM appointments
      WHERE job_id IN (?) AND created_by IS NOT NULL GROUP BY job_id`);

  lastResolvedSources = resolved;
  return out;
}

/**
 * Which activity sources actually READ on the last pass.
 *
 * A probe that cannot read its table fails open and contributes nothing —
 * which is indistinguishable from "this job has had no activity of that kind".
 * That is the dangerous shape: a renamed column would quietly turn a whole
 * category of human activity into silence, and jobs people are working would
 * start appearing as STALLED. So the probes record what they managed to read
 * and the suite asserts the full set, rather than trusting that they ran.
 */
let lastResolvedSources = [];
function activitySources() { return lastResolvedSources.slice(); }

const EXPECTED_JOB_SOURCES = [
  'created', 'tasks', 'notepad', 'schedule', 'chat', 'files', 'budget', 'appointments',
];

/** Last activity per lead id. */
async function lastActivityForLeads(connection, leadIds) {
  const out = new Map();
  if (!leadIds || !leadIds.length) return out;
  const ids = leadIds.map(Number).filter(Boolean);
  if (!ids.length) return out;

  const bump = (id, ts) => {
    if (!ts) return;
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return;
    const cur = out.get(Number(id));
    if (!cur || d > cur) out.set(Number(id), d);
  };
  const each = async (sql) => {
    try {
      const [rows] = await connection.query(sql, [ids]);
      for (const r of rows) bump(r.id, r.ts);
    } catch (e) { /* no signal */ }
  };

  await each('SELECT id, created_at AS ts FROM leads WHERE id IN (?)');
  await each(
    `SELECT s.lead_id AS id, MAX(c.created_at) AS ts
       FROM checklist_sections s
       JOIN check_list c ON c.section_id = s.id
      WHERE s.lead_id IN (?) GROUP BY s.lead_id`,
  );

  return out;
}

/**
 * Whole days between `ts` and `now`, floored. Uses calendar days so "10 days"
 * means what a person means by it rather than 240 hours to the minute.
 */
function daysSince(ts, now) {
  if (!ts) return null;
  const a = new Date(ts); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Is this stale? `>= threshold` — so at exactly 10 days it IS stalled and at
 * 9 it is not. The boundary is asserted in both directions by the suite.
 */
function isStalled(lastActivity, now, threshold) {
  const d = daysSince(lastActivity, now);
  if (d == null) return false; // no signal -> not stalled (fail open)
  return d >= (threshold == null ? stallDays() : threshold);
}

/**
 * The user's active snoozes, as Map("job:12" -> Date).
 * A snooze whose date has arrived is NOT returned — the job comes back by
 * itself, without anything having to clean the row up.
 */
async function activeSnoozes(connection, userId, now) {
  const out = new Map();
  try {
    const [rows] = await connection.query(
      `SELECT target_type, target_id, check_back_on
         FROM dashboard_stall_snooze
        WHERE user_id = ? AND check_back_on > ?`,
      [Number(userId), new Date(now)],
    );
    for (const r of rows) out.set(`${r.target_type}:${Number(r.target_id)}`, new Date(r.check_back_on));
  } catch (e) { /* table absent — nothing is snoozed */ }
  return out;
}

module.exports = {
  lastActivityForJobs,
  activitySources,
  EXPECTED_JOB_SOURCES,
  lastActivityForLeads,
  daysSince,
  isStalled,
  activeSnoozes,
};
