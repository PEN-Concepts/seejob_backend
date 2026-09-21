'use strict';

/**
 * One-day Spartan Dashboard — the STALLED band, the snooze, and the
 * missed/kept review.
 *
 * TWO DIFFERENT SCOPES, ON PURPOSE. Do not collapse them.
 *
 *   SNOOZE is PER USER. It means "stop nagging ME about this job", and two
 *   people can reasonably want different things. One person silencing a
 *   stalled job must never silence it for anybody else.
 *
 *   MISSED / KEPT is PER ACCOUNT. It records what happened, and what happened
 *   is the same for everyone: if the Tuesday inspection did not take place, it
 *   did not take place for the boss and the foreman alike. Per user, two
 *   people could hold contradictory beliefs about whether an inspection
 *   occurred and the app would show both as true.
 */

const express = require('express');
const router = express.Router();
const pool = require('../config/connection');
const logger = require('../common/logger');
const auth = require('../services/authentication');
const {
  ensureDashboardSchema, stallDays, SNOOZE_TARGETS, REVIEWABLE, REVIEW_STATES,
} = require('../services/dashboardSchema');
const {
  lastActivityForJobs, lastActivityForLeads, daysSince, isStalled, activeSnoozes,
} = require('../services/dashboardStalled');
// isFullAccess stays — it is a NOTEPAD question and the day stream uses it to
// decide which pads' tasks are readable. accountOwnerOf is deliberately NOT
// imported any more: it promotes a subcontractor or a client to the
// contractor who invited them, which is right for "am I on the allowlist"
// and catastrophic as a row selector. See services/accountScope.js.
const { isFullAccess, accountOwnerOf } = require('../services/notepadAccess');
const {
  resolveAccountOwner,
  visibleJobsForUser,
  visibleLeadsForUser,
  jobScopeWhere,
} = require('../services/accountScope');
const { buildDayStream, eachDay } = require('../services/dashboardDay');

/**
 * §3 THE ROUTER-WIDE SCOPE GUARD.
 *
 * Every route in this file carried nothing but authenticateToken, and that
 * omission is how the leak happened: each handler resolved its own account
 * and one of them resolved it wrongly.
 *
 * WHY NOT denyRestrictedJobData, WHICH IS THE OBVIOUS CANDIDATE. It hard-403s
 * categories 2 and 3, and the ruling for this page is the opposite: a
 * subcontractor signing in SEES THEIR OWN WORK, and a client sees their own
 * job. Blocking them would be a different bug, not a fix.
 *
 * So the guard is not a category check — it resolves the account ONCE, fails
 * CLOSED if it cannot, and puts the answer on res.locals. A route added to
 * this file tomorrow inherits a correct scope by default instead of having to
 * remember to build one, which is the failure mode being closed here.
 */
const CLIENT_CATEGORY = 3;

/**
 * §1 A CLIENT GETS NOTHING FROM THIS ROUTER. Poul's ruling, verbatim:
 * "Clients should see nothing on their dashboard for now. A client is the
 * most dangerous person to see a contractor's stuff." Not a narrower filter
 * that happens to return zero — a deny, before any query runs, so no job
 * name, colour, count or band is ever selected let alone sent. A client must
 * not be able to infer that another job exists from a number.
 *
 * WHY AN EMPTY PAYLOAD RATHER THAN A 403, which the CCP left to me.
 * On the WEB a client cannot reach this page: auth-guard's clientAllowed set
 * is job / calendar / task / client-quotes / client-bills / support / logout
 * / profile / force-password-reset / m, and the dashboard is not in it — a
 * client typing the URL is bounced to /job. So the web never asks.
 *
 * But `m` IS in that set, and the phone's m-home hosts the dashboard behind
 * `caps.spartan`, which is computed from PLAN RANK and trial state — not
 * from category. I could not rule out a client on some plan state reaching
 * it, and a 403 there would break their phone. An empty, well-formed payload
 * per route cannot white-screen anyone and withholds exactly as much.
 *
 * WRITES still 403: there is no shape to return and nothing legitimate to do.
 */
const CLIENT_EMPTY = {
  '/stalled': { success: true, stalled: [] },
  '/exceptions': { success: true, bands: {} },
  '/day': { success: true, days: {}, reviews: [] },
  '/item-review': { success: true, reviews: [] },
};

async function attachAccountScope(req, res, next) {
  const uid = Number(res.locals.id);
  if (!Number.isInteger(uid) || uid <= 0) {
    return res.status(401).json({ success: false, message: 'Not signed in.' });
  }

  if (Number(req.user && req.user.category) === CLIENT_CATEGORY) {
    // Nothing below this line runs. No connection is taken and no query is
    // built, so there is no row to filter and nothing to leak by accident.
    // METHOD MATTERS. Keyed on path alone, a client's POST /item-review came
    // back `{success: true, reviews: []}` — a write reporting success while
    // writing nothing, which is worse than refusing. The empty shape exists
    // so a READ cannot white-screen the phone; a write has no such excuse.
    const shape = req.method === 'GET' ? CLIENT_EMPTY[req.path] : null;
    if (shape) return res.status(200).json(shape);
    return res.status(403).json({
      success: false,
      message: 'This information is not available for your account type.',
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    const owner = await resolveAccountOwner(connection, uid);
    if (!Number.isInteger(owner) || owner <= 0) throw new Error('unresolvable account');
    res.locals.accountOwner = owner;
    res.locals.jobScope = jobScopeWhere('j', owner);
    return next();
  } catch (err) {
    // FAIL CLOSED. An unresolvable account must not fall through to a handler
    // that would then scope to something else, or to nothing.
    logger.error('dashboard scope guard error: ' + err.message);
    return res.status(403).json({ success: false, message: 'Account scope unavailable.' });
  } finally {
    if (connection) connection.release();
  }
}

router.use(auth.authenticateToken, attachAccountScope);

/** 'YYYY-MM-DD' only. Anything else is not a date we will store. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight for a YMD string, so comparisons are calendar-day based. */
function ymdToLocalDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function todayLocal() {
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  return n;
}

/**
 * POST /stall-snooze — "check back on this date".
 *
 * THERE IS NO INDEFINITE OPTION AND NO WAY TO CONSTRUCT ONE.
 * `check_back_on` is required, must parse as a real calendar date, and must
 * not be in the past. There is no sentinel value, no null, no "never", and
 * the column is NOT NULL so none could be stored even if this route were
 * bypassed. A job silenced for good is a hole in the list meant to catch it.
 */
router.post('/stall-snooze', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const body = req.body || {};
  const type = String(body.target_type || '').trim();
  const targetId = Number(body.target_id);
  const ymd = String(body.check_back_on || '').trim();

  if (!SNOOZE_TARGETS.has(type)) {
    return res.status(400).json({ success: false, message: 'target_type must be job or lead.' });
  }
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ success: false, message: 'target_id must be a positive id.' });
  }
  if (!YMD.test(ymd)) {
    return res.status(400).json({ success: false, message: 'check_back_on must be a YYYY-MM-DD date.' });
  }

  const picked = ymdToLocalDate(ymd);
  if (isNaN(picked.getTime())) {
    return res.status(400).json({ success: false, message: 'check_back_on is not a real date.' });
  }
  // Round-trip guard: '2026-02-31' parses to 2 March, which is not the date
  // anyone picked. Reject rather than silently storing a different day.
  const back = `${picked.getFullYear()}-${String(picked.getMonth() + 1).padStart(2, '0')}-${String(picked.getDate()).padStart(2, '0')}`;
  if (back !== ymd) {
    return res.status(400).json({ success: false, message: 'check_back_on is not a real date.' });
  }

  // PAST DAYS ARE UNSELECTABLE — enforced here, not only greyed in the UI.
  // A hidden control is not a rule; a direct POST walks straight past it.
  if (picked < todayLocal()) {
    return res.status(400).json({ success: false, message: 'Pick a date in the future — a job cannot be hidden for good.' });
  }

  try {
    const connection = await pool.getConnection();
    try {
      await ensureDashboardSchema(connection);

      // The target must be real and on the caller's own account. This does not
      // widen anything — the snooze only ever affects the caller's own view —
      // but it stops rows accruing for ids the caller has no business naming.
      const owner = await resolveAccountOwner(connection, uid);
      const table = type === 'job' ? '`job`' : 'leads';
      const ownerCol = type === 'job' ? 'created_by' : 'user_id';
      const [[found]] = await connection.query(
        `SELECT ${ownerCol} AS owner_id FROM ${table} WHERE id = ? LIMIT 1`, [targetId],
      );
      if (!found) {
        return res.status(404).json({ success: false, message: 'That job or lead does not exist.' });
      }
      const targetOwner = await resolveAccountOwner(connection, Number(found.owner_id));
      if (Number(targetOwner) !== Number(owner)) {
        return res.status(403).json({ success: false, message: 'Not your account.' });
      }

      // Upsert: picking a new date REPLACES the old one, so "when does this
      // come back" always has exactly one answer.
      await connection.query(
        `INSERT INTO dashboard_stall_snooze (user_id, target_type, target_id, check_back_on)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE check_back_on = VALUES(check_back_on)`,
        [uid, type, targetId, ymd],
      );

      const [[stored]] = await connection.query(
        `SELECT id, user_id, target_type, target_id, DATE_FORMAT(check_back_on, '%Y-%m-%d') AS check_back_on
           FROM dashboard_stall_snooze
          WHERE user_id = ? AND target_type = ? AND target_id = ? LIMIT 1`,
        [uid, type, targetId],
      );
      return res.status(200).json({ success: true, snooze: stored });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('dashboard stall-snooze error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /stalled — jobs and leads with no change for the threshold, minus the
 * caller's own active snoozes.
 */
router.get('/stalled', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    const connection = await pool.getConnection();
    try {
      await ensureDashboardSchema(connection);
      const owner = await resolveAccountOwner(connection, uid);
      const now = new Date();
      const threshold = stallDays();

      // SCOPED. This was `WHERE created_by = <promoted owner>`, which handed
      // a subcontractor or a client the inviting contractor's whole job list.
      const jobs = await visibleJobsForUser(connection, uid);
      let leads = [];
      try {
        const l = await visibleLeadsForUser(connection, uid);
        leads = l;
      } catch (e) { leads = []; }

      const jobAct = await lastActivityForJobs(connection, jobs.map((j) => j.id));
      const leadAct = await lastActivityForLeads(connection, leads.map((l) => l.id));
      const snoozed = await activeSnoozes(connection, uid, now);

      const out = [];
      for (const j of jobs) {
        const ts = jobAct.get(Number(j.id)) || null;
        if (!isStalled(ts, now, threshold)) continue;
        if (snoozed.has(`job:${Number(j.id)}`)) continue;
        out.push({ target_type: 'job', id: Number(j.id), name: j.name, color: j.color || null, days: daysSince(ts, now) });
      }
      for (const l of leads) {
        const ts = leadAct.get(Number(l.id)) || null;
        if (!isStalled(ts, now, threshold)) continue;
        if (snoozed.has(`lead:${Number(l.id)}`)) continue;
        out.push({ target_type: 'lead', id: Number(l.id), name: l.name, color: null, days: daysSince(ts, now) });
      }

      out.sort((a, b) => (b.days || 0) - (a.days || 0));
      return res.status(200).json({ success: true, threshold_days: threshold, stalled: out });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('dashboard stalled error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /item-review — mark a past item MISSED or KEPT.
 *
 * ACCOUNT-WIDE, unlike the snooze. This records what happened, and what
 * happened is the same for everyone: if the Tuesday inspection did not take
 * place, it did not take place for the boss and the foreman alike. Whoever
 * sets it, sets it for the account.
 *
 * Grey — "not yet reviewed" — is the ABSENCE of a row. Only this endpoint
 * writes one, so grey can never harden into red on its own.
 */
router.post('/item-review', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const body = req.body || {};
  const itemType = String(body.item_type || '').trim();
  const itemId = Number(body.item_id);
  const occursOn = String(body.occurs_on || '').trim();
  const state = String(body.state || '').trim();

  if (!REVIEWABLE.has(itemType)) {
    return res.status(400).json({ success: false, message: 'Unknown item_type.' });
  }
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ success: false, message: 'item_id must be a positive id.' });
  }
  if (!YMD.test(occursOn)) {
    return res.status(400).json({ success: false, message: 'occurs_on must be a YYYY-MM-DD date.' });
  }
  if (!REVIEW_STATES.has(state)) {
    return res.status(400).json({ success: false, message: 'state must be missed or kept.' });
  }

  try {
    const connection = await pool.getConnection();
    try {
      await ensureDashboardSchema(connection);
      const owner = await resolveAccountOwner(connection, uid);

      await connection.query(
        `INSERT INTO dashboard_item_review
           (account_owner_id, item_type, item_id, occurs_on, state, set_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           state = VALUES(state),
           set_by_user_id = VALUES(set_by_user_id),
           updated_at = NOW()`,
        [owner, itemType, itemId, occursOn, state, uid],
      );

      const [[stored]] = await connection.query(
        `SELECT account_owner_id, item_type, item_id,
                DATE_FORMAT(occurs_on,'%Y-%m-%d') AS occurs_on, state, set_by_user_id
           FROM dashboard_item_review
          WHERE account_owner_id = ? AND item_type = ? AND item_id = ? AND occurs_on = ? LIMIT 1`,
        [owner, itemType, itemId, occursOn],
      );
      return res.status(200).json({ success: true, review: stored });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('dashboard item-review error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/** GET /item-review?on=YYYY-MM-DD — the account's reviews for one day. */
router.get('/item-review', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const on = String(req.query.on || '').trim();
  if (!YMD.test(on)) {
    return res.status(400).json({ success: false, message: 'on must be a YYYY-MM-DD date.' });
  }
  try {
    const connection = await pool.getConnection();
    try {
      await ensureDashboardSchema(connection);
      const owner = await resolveAccountOwner(connection, uid);
      const [rows] = await connection.query(
        `SELECT item_type, item_id, DATE_FORMAT(occurs_on,'%Y-%m-%d') AS occurs_on, state, set_by_user_id
           FROM dashboard_item_review
          WHERE account_owner_id = ? AND occurs_on = ?`,
        [owner, on],
      );
      return res.status(200).json({ success: true, reviews: rows });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('dashboard item-review read error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /day?from=YYYY-MM-DD&to=YYYY-MM-DD — the merged day stream.
 *
 * Four sources: appointments, planner goals, dated notepad tasks, and dated
 * inspection rows from job schedules. Nothing from master_calendar_tasks —
 * that is the reusable trade list and has no date to be placed on.
 */
router.get('/day', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  if (!YMD.test(from) || !YMD.test(to)) {
    return res.status(400).json({ success: false, message: 'from and to must be YYYY-MM-DD dates.' });
  }
  if (from > to) {
    return res.status(400).json({ success: false, message: 'from must not be after to.' });
  }
  // A window, not the whole history — the page scrolls a few weeks either way.
  if (eachDay(from, to).length > 120) {
    return res.status(400).json({ success: false, message: 'Range too wide (max 120 days).' });
  }

  try {
    const connection = await pool.getConnection();
    try {
      await ensureDashboardSchema(connection);
      const owner = await resolveAccountOwner(connection, uid);
      const full = await isFullAccess(connection, uid);
      // padOwner is the NOTEPAD account and is deliberately the wider one:
      // a subcontractor belongs to the contractor's notepad account, which
      // is how delegated work reaches them. Jobs use `owner`. See the note
      // on source 3 in dashboardDay.js.
      const padOwner = await accountOwnerOf(connection, uid);
      const stream = await buildDayStream(connection, { uid, owner, padOwner, from, to, full });

      // Account-wide missed/kept for the window, folded in so the page does
      // not need a second round trip.
      let reviews = [];
      try {
        const [r] = await connection.query(
          `SELECT item_type, item_id, DATE_FORMAT(occurs_on,'%Y-%m-%d') AS occurs_on, state
             FROM dashboard_item_review
            WHERE account_owner_id = ? AND occurs_on BETWEEN ? AND ?`,
          [owner, from, to],
        );
        reviews = r;
      } catch (e) { reviews = []; }

      return res.status(200).json({ success: true, from, to, days: stream.days, reviews });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('dashboard day error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /exceptions — the three bands of §3.
 *
 * THE ROLL-UP RULE: one offending item on a container is named directly; two
 * or more roll up to the container with a count. The point is that a single
 * problem stays specific enough to act on, while five do not bury the rest of
 * the page.
 *
 * Incomplete Gantt items are the one exception to the exception: they are
 * NEVER listed individually — one row per job reading "<job> · Gantt chart",
 * however many are incomplete.
 */
router.get('/exceptions', auth.authenticateToken, async (req, res) => {
  const uid = Number(res.locals.id);
  try {
    const connection = await pool.getConnection();
    try {
      await ensureDashboardSchema(connection);
      const owner = await resolveAccountOwner(connection, uid);
      const full = await isFullAccess(connection, uid);
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      const jobs = new Map();
      try {
        const js = await visibleJobsForUser(connection, uid);
        for (const j of js) jobs.set(Number(j.id), { name: j.name, color: j.color || null });
      } catch (e) { /* none */ }

      // ── PAST DUE — dated notepad tasks past their day and not complete.
      const pastDue = [];
      try {
        const where = ['s.owner_user_id = ?'];
        const params = [uid];
        if (full) {
          where.push("(s.scope = 'company' AND COALESCE(s.account_owner_id, s.owner_user_id) = ?)");
          params.push(owner);
        }
        where.push('EXISTS (SELECT 1 FROM checklist_section_shares sh WHERE sh.section_id = s.id AND sh.user_id = ?)');
        params.push(uid);
        const [rows] = await connection.query(
          `SELECT c.id, c.name, c.due_date, s.id AS section_id, s.job_id
             FROM check_list c
             JOIN checklist_sections s ON s.id = c.section_id
            WHERE (${where.join(' OR ')})
              AND c.due_date IS NOT NULL
              AND DATE(c.due_date) < ?
              -- 'completed', not 'complete' (see dashboardDay.js). This filter
              -- never matched, so items already ticked off kept appearing in
              -- PAST DUE.
              AND (c.status IS NULL OR LOWER(c.status) <> 'completed')`,
          [...params, today],
        );
        pastDue.push(...rows.map((r) => ({
          id: Number(r.id), name: r.name, section_id: Number(r.section_id),
          job_id: r.job_id == null ? null : Number(r.job_id),
        })));
      } catch (e) { /* none */ }

      // ── INCOMPLETE — Gantt items with no assignee, and jobs with no schedule.
      const incompleteGantt = new Map(); // job_id -> count
      const noSchedule = [];
      // Both INCOMPLETE reads were `j.created_by = <promoted owner>`. Same
      // predicate as everything else now.
      const gScope = jobScopeWhere('j', owner);
      try {
        const [rows] = await connection.query(
          `SELECT sc.job_id, COUNT(*) AS n
             FROM job_schedule_items i
             JOIN job_schedules sc ON sc.id = i.schedule_id
             JOIN \`job\` j ON j.id = sc.job_id
            WHERE ${gScope.sql} AND (i.assignee_user_id IS NULL OR i.computed_start_date IS NULL)
            GROUP BY sc.job_id`,
          gScope.params,
        );
        for (const r of rows) incompleteGantt.set(Number(r.job_id), Number(r.n));
      } catch (e) { /* none */ }
      try {
        const [rows] = await connection.query(
          `SELECT j.id FROM \`job\` j
            WHERE ${gScope.sql}
              AND NOT EXISTS (SELECT 1 FROM job_schedules sc WHERE sc.job_id = j.id)`,
          gScope.params,
        );
        for (const r of rows) noSchedule.push(Number(r.id));
      } catch (e) { /* none */ }

      // ── STALLED (reuses the same detection as GET /stalled).
      const stalled = [];
      try {
        const js = await visibleJobsForUser(connection, uid);
        let leads = [];
        try {
          const l = await visibleLeadsForUser(connection, uid);
          leads = l;
        } catch (e) { leads = []; }
        const jobAct = await lastActivityForJobs(connection, js.map((j) => j.id));
        const leadAct = await lastActivityForLeads(connection, leads.map((l) => l.id));
        const snoozed = await activeSnoozes(connection, uid, now);
        const th = stallDays();
        for (const j of js) {
          const ts = jobAct.get(Number(j.id)) || null;
          if (!isStalled(ts, now, th) || snoozed.has(`job:${Number(j.id)}`)) continue;
          stalled.push({ target_type: 'job', id: Number(j.id), label: j.name, sub: 'nothing changed', color: j.color || null, days: daysSince(ts, now) });
        }
        for (const l of leads) {
          const ts = leadAct.get(Number(l.id)) || null;
          if (!isStalled(ts, now, th) || snoozed.has(`lead:${Number(l.id)}`)) continue;
          stalled.push({ target_type: 'lead', id: Number(l.id), label: l.name, sub: 'lead · no contact', color: null, days: daysSince(ts, now) });
        }
        stalled.sort((a, b) => (b.days || 0) - (a.days || 0));
      } catch (e) { /* none */ }

      // ── Apply the roll-up rule to PAST DUE.
      const byJob = new Map();
      const orphans = [];
      for (const p of pastDue) {
        if (p.job_id == null) { orphans.push(p); continue; }
        if (!byJob.has(p.job_id)) byJob.set(p.job_id, []);
        byJob.get(p.job_id).push(p);
      }
      const pastDueRows = [];
      for (const [jid, list] of byJob) {
        const job = jobs.get(jid) || { name: 'Job', color: null };
        if (list.length === 1) {
          // ONE offender is named directly — specific enough to act on.
          pastDueRows.push({
            kind: 'item', label: list[0].name, sub: job.name, color: job.color,
            count: 1, job_id: jid, section_id: list[0].section_id, item_id: list[0].id,
          });
        } else {
          // TWO OR MORE roll up to the container with a count.
          //
          // §F THE CHILDREN TRAVEL WITH THE ROLLUP. A rolled-up row expands
          // in place on the dashboard — Poul sees which two items are past
          // due before deciding whether to leave the screen for them. That
          // is only possible if the row already knows them; a second request
          // on tap would put a spinner in front of the answer.
          //
          // Same shape as a single-item row, so the client opens a child by
          // exactly the same path it opens a named row.
          pastDueRows.push({
            kind: 'rollup', label: job.name, sub: 'notepad', color: job.color,
            count: list.length, job_id: jid, section_id: list[0].section_id, item_id: null,
            items: list.map((p) => ({
              label: p.name,
              job_id: jid,
              section_id: p.section_id == null ? null : Number(p.section_id),
              item_id: Number(p.id),
            })),
          });
        }
      }
      for (const o of orphans) {
        pastDueRows.push({
          kind: 'item', label: o.name, sub: 'notepad', color: null,
          count: 1, job_id: null, section_id: o.section_id, item_id: o.id,
        });
      }

      // ── INCOMPLETE rows. Gantt items NEVER list individually.
      const incompleteRows = [];
      for (const [jid, n] of incompleteGantt) {
        const job = jobs.get(jid) || { name: 'Job', color: null };
        incompleteRows.push({
          kind: 'gantt', label: job.name, sub: 'Gantt chart', color: job.color,
          count: n, job_id: jid, section_id: null, item_id: null,
        });
      }
      for (const jid of noSchedule) {
        const job = jobs.get(jid) || { name: 'Job', color: null };
        incompleteRows.push({
          kind: 'no-schedule', label: job.name, sub: 'no schedule', color: job.color,
          count: 1, job_id: jid, section_id: null, item_id: null,
        });
      }

      // A band with no items is ABSENT ENTIRELY — not an empty array the page
      // has to remember to hide. §3.
      const bands = {};
      if (pastDueRows.length) bands.past_due = pastDueRows;
      if (incompleteRows.length) bands.incomplete = incompleteRows;
      if (stalled.length) bands.stalled = stalled;

      return res.status(200).json({ success: true, bands });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error('dashboard exceptions error: ' + err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
