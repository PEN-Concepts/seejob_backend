'use strict';

/**
 * The one-day Dashboard's day stream: four sources merged onto calendar days.
 *
 *   appointments            — `appointments`, dated by `doa`
 *   planner goals           — `spartan_goals`, recurring, expanded per weekday
 *   dated notepad tasks     — `check_list.due_date`
 *   DATED INSPECTION ROWS   — `job_schedule_items` where is_inspection = 1
 *
 * A NOTE ON WORDING, so the next person does not lose an hour to it.
 * The original brief called the fourth source "Master Calendar items". That is
 * the name of the PAGE inspections are scheduled from, not a table.
 * `master_calendar_tasks` is the reusable per-account TRADE LIST — flat, with
 * no date, no time and no job — and nothing in it can be placed on a day.
 * Nothing from that table reaches this stream. Dated inspections live on job
 * schedules, which is also where §8's multi-day counting comes from.
 *
 * VISIBILITY IS NOT WIDENED HERE. Notepad tasks are read through exactly the
 * three-clause rule notepadHub uses — own pads, company pads when the caller is
 * on the allowlist, and pads explicitly shared with them. This page must not
 * become a way to see a notepad you could not already open.
 */

const engine = require('./scheduleEngine');

/** 'YYYY-MM-DD' for a Date, in local time. */
function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function eachDay(fromYMD, toYMD) {
  const out = [];
  const [fy, fm, fd] = fromYMD.split('-').map(Number);
  const [ty, tm, td] = toYMD.split('-').map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end) { out.push(fmt(cur)); cur.setDate(cur.getDate() + 1); }
  return out;
}

/**
 * Which weekdays a Planner goal falls on (0 = Sunday).
 *
 * Mirrors the expansion the mobile home page already uses, INCLUDING its
 * deliberate last case: a 'custom' or unknown recurrence with no parseable day
 * set shows on NO day rather than every day. Expanding an unparseable goal to
 * all seven made a single-day goal appear daily, which is worse than it not
 * appearing until it is re-saved.
 */
function plannerDaysOf(goal) {
  const raw = goal && goal.day_of_week;
  if (raw != null && String(raw).trim() !== '') {
    const parsed = String(raw).split(',').map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);
    if (parsed.length) return parsed;
  }
  switch (goal && goal.recurrence) {
    case 'daily': return [0, 1, 2, 3, 4, 5, 6];
    case 'mwf': return [1, 3, 5];
    case 'tth': return [2, 4];
    case 'sat': return [6];
    case 'weekly': return raw != null ? [Number(raw)] : [];
    default: return [];
  }
}

/**
 * §8 — the working days a multi-day item actually occupies.
 *
 * SKIPPED DAYS DO NOT COUNT. A five-day item starting Thursday reads
 * Thu 1/5, Fri 2/5, Mon 3/5 — the weekend is not day three. This calls the
 * SAME `addWorkingDays` the scheduler uses rather than re-deriving weekends,
 * so the pill can never disagree with the Gantt chart it came from.
 */
function workingDaysFor(startYMD, durationDays, skipSaturday, skipSunday) {
  const n = engine.normalizeDuration(durationDays);
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = engine.addWorkingDays(startYMD, i, skipSaturday, skipSunday);
    if (!d) break;
    days.push(d);
  }
  return days;
}

/** 'HH:MM' from a DATETIME, or null when there is no time on it. */
function timeOf(dt) {
  if (!dt) return null;
  const s = String(dt);
  const m = s.match(/\d{2}:\d{2}/);
  if (!m) return null;
  return m[0];
}

function ymdOf(dt) {
  if (!dt) return null;
  const s = String(dt);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(dt);
  return isNaN(d.getTime()) ? null : fmt(d);
}

/**
 * Build the merged stream for a date range.
 *
 * Returns { days: { 'YYYY-MM-DD': [item, ...] } }, each day's items sorted
 * with timed rows first (by time) and all-day rows after them, per §7.
 */
async function buildDayStream(connection, opts) {
  const uid = Number(opts.uid);
  const owner = Number(opts.owner);
  const fromYMD = opts.from;
  const toYMD = opts.to;
  const full = !!opts.full; // caller is on the notepad allowlist

  const byDay = new Map();
  for (const d of eachDay(fromYMD, toYMD)) byDay.set(d, []);
  const push = (day, item) => { if (byDay.has(day)) byDay.get(day).push(item); };

  const jobName = new Map();
  const jobColor = new Map();
  const jobAddress = new Map();
  try {
    const [jobs] = await connection.query(
      'SELECT id, name, color, job_address, job_city, job_state, job_zipcode FROM `job` WHERE created_by = ?',
      [owner],
    );
    for (const j of jobs) {
      jobName.set(Number(j.id), j.name);
      jobColor.set(Number(j.id), j.color || null);
      const addr = [j.job_address, j.job_city, j.job_state].filter((x) => x && String(x).trim()).join(', ');
      jobAddress.set(Number(j.id), addr || '');
    }
  } catch (e) { /* no jobs readable */ }

  const userName = new Map();
  try {
    const [us] = await connection.query('SELECT id, name FROM `user` WHERE id = ? OR created_by = ?', [owner, owner]);
    for (const u of us) userName.set(Number(u.id), u.name);
  } catch (e) { /* names are decoration */ }

  // ── 1. APPOINTMENTS ───────────────────────────────────────────────────
  try {
    const [appts] = await connection.query(
      `SELECT id, job_id, user_id, subject, description, doa, all_day, address
         FROM appointments
        WHERE DATE(doa) BETWEEN ? AND ?
          AND (created_by = ? OR user_id = ?)`,
      [fromYMD, toYMD, owner, uid],
    );
    for (const a of appts) {
      const day = ymdOf(a.doa);
      if (!day) continue;
      const jid = a.job_id == null ? null : Number(a.job_id);
      push(day, {
        kind: 'appointment',
        id: Number(a.id),
        title: a.subject || a.description || 'Appointment',
        time: Number(a.all_day) === 1 ? null : timeOf(a.doa),
        all_day: Number(a.all_day) === 1,
        job_id: jid,
        job_name: jid ? (jobName.get(jid) || null) : null,
        job_color: jid ? (jobColor.get(jid) || null) : null,
        address: a.address || (jid ? jobAddress.get(jid) : '') || '',
        assignee_name: a.user_id ? (userName.get(Number(a.user_id)) || null) : null,
        starred: false,
        checkbox: false,          // §7: appointments have no checkbox
        is_inspection: false,
        day_index: null, day_total: null,
      });
    }
  } catch (e) { /* appointments unreadable */ }

  // ── 2. PLANNER GOALS (server-side, per §1) ────────────────────────────
  try {
    const [goals] = await connection.query(
      `SELECT id, goal, start_time, duration_minutes, recurrence, day_of_week, is_special, sort_order
         FROM spartan_goals WHERE user_id = ?`,
      [uid],
    );
    for (const day of byDay.keys()) {
      const [y, m, d] = day.split('-').map(Number);
      const dow = new Date(y, m - 1, d).getDay();
      for (const g of goals) {
        if (!plannerDaysOf(g).includes(dow)) continue;
        push(day, {
          kind: 'planner',
          id: Number(g.id),
          title: g.goal,
          time: g.start_time ? String(g.start_time).slice(0, 5) : null,
          // A goal with no start time is UNTIMED, which is not the same thing as
          // ALL-DAY. all_day is a stored column with its own meaning; reusing it
          // here would be inferring all-day from a missing time, which is exactly
          // what the rule forbids. Untimed rows simply sort after timed ones.
          all_day: false,
          untimed: !g.start_time,
          duration_minutes: g.duration_minutes == null ? null : Number(g.duration_minutes),
          job_id: null, job_name: null, job_color: null,
          address: '',
          assignee_name: null,
          starred: false,
          checkbox: true,
          shield: true,             // §7: Spartan red shield on the right
          is_inspection: false,
          day_index: null, day_total: null,
        });
      }
    }
  } catch (e) { /* planner unreadable */ }

  // ── 3. DATED NOTEPAD TASKS ────────────────────────────────────────────
  // Same three visibility clauses as notepadHub. Nothing is widened.
  try {
    const where = ['s.owner_user_id = ?'];
    const params = [uid];
    if (full) {
      where.push('(s.scope = \'company\' AND COALESCE(s.account_owner_id, s.owner_user_id) = ?)');
      params.push(owner);
    }
    where.push('EXISTS (SELECT 1 FROM checklist_section_shares sh WHERE sh.section_id = s.id AND sh.user_id = ?)');
    params.push(uid);

    const [items] = await connection.query(
      `SELECT c.id, c.name, c.due_date, c.all_day, c.assign_to, c.status,
              s.id AS section_id, s.job_id, s.lead_id
         FROM check_list c
         JOIN checklist_sections s ON s.id = c.section_id
        WHERE (${where.join(' OR ')})
          AND c.due_date IS NOT NULL
          AND DATE(c.due_date) BETWEEN ? AND ?`,
      [...params, fromYMD, toYMD],
    );
    for (const it of items) {
      const day = ymdOf(it.due_date);
      if (!day) continue;
      const jid = it.job_id == null ? null : Number(it.job_id);
      const isAllDay = Number(it.all_day) === 1;
      push(day, {
        kind: 'task',
        id: Number(it.id),
        section_id: Number(it.section_id),
        title: it.name,
        // ALL-DAY IS THE COLUMN, NEVER THE ABSENCE OF A TIME. A task with
        // all_day = 0 and no time keeps its (empty) time and is NOT an
        // all-day row — those are two different states.
        time: isAllDay ? null : timeOf(it.due_date),
        all_day: isAllDay,
        job_id: jid,
        job_name: jid ? (jobName.get(jid) || null) : null,
        job_color: jid ? (jobColor.get(jid) || null) : null,
        address: jid ? (jobAddress.get(jid) || '') : '',
        assignee_name: it.assign_to ? (userName.get(Number(it.assign_to)) || null) : null,
        starred: false,
        checkbox: true,
        // 'completed', not 'complete'. check_list.status only ever holds
        // 'active', 'archived' or 'completed' — the notepad writes 'completed'
        // and nothing in the codebase writes the short form. Comparing to
        // 'complete' was therefore ALWAYS false, so an item ticked on the
        // notepad rendered unticked on the dashboard.
        complete: String(it.status || '').toLowerCase() === 'completed',
        is_inspection: false,
        day_index: null, day_total: null,
      });
    }
  } catch (e) { /* notepad tasks unreadable */ }

  // ── 4. DATED INSPECTION ROWS FROM JOB SCHEDULES ───────────────────────
  // (What the brief called "Master Calendar items".) Multi-day items fan out
  // across WORKING days only, per §8.
  try {
    const [rows] = await connection.query(
      `SELECT i.id, i.name, i.duration_days, i.computed_start_date, i.computed_end_date,
              i.is_inspection, i.assignee_user_id,
              sc.job_id, sc.skip_saturday, sc.skip_sunday
         FROM job_schedule_items i
         JOIN job_schedules sc ON sc.id = i.schedule_id
         JOIN \`job\` j ON j.id = sc.job_id
        WHERE j.created_by = ? AND i.computed_start_date IS NOT NULL`,
      [owner],
    );
    for (const r of rows) {
      const start = ymdOf(r.computed_start_date);
      if (!start) continue;
      const days = workingDaysFor(start, r.duration_days, !!r.skip_saturday, !!r.skip_sunday);
      const total = days.length;
      days.forEach((day, idx) => {
        if (!byDay.has(day)) return;
        const jid = Number(r.job_id);
        push(day, {
          kind: 'inspection',
          id: Number(r.id),
          title: r.name,
          time: null,
          // Whole-day by nature (its duration is in DAYS), but this is not the
          // stored all_day flag and must not be confused with it.
          all_day: false,
          untimed: true,
          job_id: jid,
          job_name: jobName.get(jid) || null,
          job_color: jobColor.get(jid) || null,
          address: jobAddress.get(jid) || '',
          assignee_name: r.assignee_user_id ? (userName.get(Number(r.assignee_user_id)) || null) : null,
          starred: false,
          checkbox: true,
          is_inspection: Number(r.is_inspection) === 1,
          // §8: 1-based position among the WORKING days it covers.
          day_index: total > 1 ? idx + 1 : null,
          day_total: total > 1 ? total : null,
        });
      });
    }
  } catch (e) { /* schedules unreadable */ }

  // §7 — timed rows first by time, all-day rows after them.
  const out = {};
  for (const [day, items] of byDay) {
    items.sort((a, b) => {
      const at = a.time, bt = b.time;
      if (at && bt) return at.localeCompare(bt);
      if (at && !bt) return -1;
      if (!at && bt) return 1;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
    out[day] = items;
  }
  return { days: out };
}

module.exports = { buildDayStream, plannerDaysOf, workingDaysFor, eachDay, fmt };
