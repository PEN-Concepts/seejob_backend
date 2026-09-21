'use strict';

/**
 * ONE ANSWER TO "WHOSE ACCOUNT IS THIS", AND ONE PREDICATE FOR "WHICH JOBS".
 *
 * THE DEFECT THIS EXISTS TO CLOSE.
 *
 * Two functions both claimed to answer the account question and they
 * disagreed:
 *
 *   utils/access.js  resolveOwnerId()   — promotes ONLY employees (category 1)
 *   services/notepadAccess.js
 *                    accountOwnerOf()   — promoted ANY user with a created_by
 *
 * The jobs list used the first; the dashboard used the second as a positive
 * row selector (`WHERE created_by = ?`). So a SUBCONTRACTOR or a CLIENT
 * invited by a contractor resolved to that contractor, and the dashboard
 * handed them the contractor's private job names and colours — jobs they
 * could not open from any screen, because the jobs list correctly refused
 * them. A subcontractor is a separate business; a client is a customer who
 * was being shown other customers' job names.
 *
 * Fixing the fallback alone would have left two functions that merely agree
 * today. They are one function now, and the job predicate the jobs list
 * already had is lifted here so both callers read the same SQL rather than
 * two copies that drift.
 *
 * WHY THE FALLBACK WAS SAFE IN ITS ORIGINAL HOME AND UNSAFE IN THE NEW ONE.
 * `notepadAccess` used it to ask "am I the account owner?" and "am I on the
 * allowlist?" — questions where resolving to a parent DENIES you something.
 * The dashboard used the same value to decide which rows to SELECT, where
 * resolving to a parent GRANTS. The same helper, read two ways.
 */

const { resolveOwnerId } = require('../utils/access');

/** Employees share their owner's account. Nobody else does. */
const EMPLOYEE_CATEGORY = 1;

/**
 * THE account resolver. Employees resolve to their owner; everyone else —
 * owners, subcontractors, clients — is their own account.
 *
 * This is deliberately a thin pass-through to `resolveOwnerId` rather than a
 * reimplementation of it. A second copy of this rule is how the original bug
 * happened.
 */
async function resolveAccountOwner(connection, userId) {
  return Number(await resolveOwnerId(Number(userId), connection));
}

/**
 * The set of user ids that make up one account: the owner, plus their
 * EMPLOYEES. Not their subcontractors and not their clients — those are
 * separate businesses and separate people who happen to have been invited.
 *
 * Returned as SQL rather than ids so it can sit inside a larger query and be
 * indexed, which is what the jobs list already did.
 */
const ACCOUNT_MEMBER_SQL =
  '(SELECT id FROM `user` WHERE id = ? OR (created_by = ? AND category = ' + EMPLOYEE_CATEGORY + '))';

/**
 * WHICH JOBS MAY THIS ACCOUNT SEE — lifted verbatim in meaning from
 * routes/jobs.js, which was the correct implementation all along.
 *
 * A job is visible when:
 *   1. it belongs to my account (the owner or an employee created it), OR
 *   2. an account member is the CLIENT on it (so clients see their own job), OR
 *   3. an ACTIVE job has a task assigned to an account member (real work sent
 *      to us by another contractor).
 *
 * Being merely a passive contact does NOT surface a foreign job — the
 * standing rule is that a job is not assigned to you unless a task came to
 * you. Clause 3 is restricted to `status = 1` so that when the other
 * contractor completes or archives the job it leaves your side too.
 *
 * @param {string} alias the table alias for `job` in the calling query
 * @returns {{ sql: string, params: number[] }} a WHERE fragment and its params
 */
function jobScopeWhere(alias, accountOwnerId) {
  const a = alias || 'j';
  const owner = Number(accountOwnerId);
  const sql = `(
        ${a}.created_by IN ${ACCOUNT_MEMBER_SQL}
        OR ${a}.client_id IN ${ACCOUNT_MEMBER_SQL}
        OR (
          ${a}.status = 1
          AND ${a}.id IN (
            SELECT DISTINCT job_id FROM tasks WHERE user_id IN ${ACCOUNT_MEMBER_SQL}
          )
        )
      )`;
  // Six params: two per ACCOUNT_MEMBER_SQL expansion, three expansions.
  return { sql, params: [owner, owner, owner, owner, owner, owner] };
}

/**
 * The ids of the jobs this user may see. The dashboard needs a LIST rather
 * than a fragment because it then reads activity, schedules and snoozes
 * against those ids.
 *
 * This runs the same predicate as the jobs list, so the two can never
 * disagree about what exists. Filtering AFTER the query was explicitly not
 * an option: the rows must not be selected in the first place.
 */
/**
 * ACTIVE ONLY. `job.status` is 0 = completed, 1 = current, 2 = archived —
 * confirmed at routes/jobs.js:1553, whose own comment reads "expecting
 * status = 0 (completed) or 2 (archived)" and whose guard is
 * `if (![0, 2, 1].includes(status))`. jobColorPalette.js says the same from
 * the other side: "color released on complete/archive, so only status=1
 * holds".
 *
 * This is the §1 clause for every dashboard list. It lives HERE, in the query
 * that builds the list, and not in the template that draws it — a template
 * that hides rows the query still returns leaks the moment anything else
 * consumes that query, which is exactly how the tenant-scope bug worked.
 */
const ACTIVE_JOB_SQL = 'j.status = 1';

/**
 * A LIVE LEAD. `leads.status = 3` is closed/converted (routes/leads.js:760,
 * "Update lead status = 3 (closed/converted)"; routes/tasks.js:942 reads
 * `status<>3` to mean live), and `bid_status = 'Archived'` is a SEPARATE
 * archive flag (routes/leads.js:202, "returns active leads and EXCLUDES
 * bid_status='Archived'"). Both have to be excluded — one alone leaves the
 * other kind of finished lead on the dashboard.
 *
 * NULL-tolerant on both columns: a lead that has never been given a status
 * or a bid_status is live, not hidden. The reverse would REMOVE rows for a
 * reason nobody chose.
 */
const LIVE_LEAD_SQL =
  "(status IS NULL OR status <> 3) AND (bid_status IS NULL OR bid_status <> 'Archived')";

/**
 * "This notepad section is not sitting on a finished job."
 *
 * Takes the alias of the `checklist_sections` row in the calling query. A
 * section with NO job (job_id IS NULL) passes: that is a real pad and §5
 * gives its tasks a NO JOB chip. A section pointing at a job that is
 * completed, archived or DELETED fails, because none of those is live work.
 *
 * IT LIVES HERE RATHER THAN INLINE IN routes/dashboard.js FOR A REASON, and
 * the reason has teeth: test/dashboardScopeGuard.test.js asserts at source
 * level that dashboard.js contains no direct query against the `job` table,
 * so that a future edit cannot quietly add an unscoped one. Writing this
 * EXISTS inline broke that guard on the first run — which is the guard doing
 * exactly the job it was built for.
 */
const SECTION_ON_LIVE_JOB_SQL = (sectionAlias) => {
  const s = String(sectionAlias || 's').replace(/[^a-z0-9_]/gi, '') || 's';
  return `(
    ${s}.job_id IS NULL
    OR EXISTS (SELECT 1 FROM \`job\` j WHERE j.id = ${s}.job_id AND ${ACTIVE_JOB_SQL})
  )`;
};

async function visibleJobsForUser(connection, userId, columns) {
  const owner = await resolveAccountOwner(connection, userId);
  const { sql, params } = jobScopeWhere('j', owner);
  const cols = (columns && columns.length ? columns : ['id', 'name', 'color'])
    .map((c) => 'j.`' + String(c).replace(/[^a-z0-9_]/gi, '') + '`')
    .join(', ');
  const [rows] = await connection.query(
    `SELECT ${cols} FROM \`job\` j WHERE ${sql} AND ${ACTIVE_JOB_SQL}`,
    params,
  );
  return rows;
}

/**
 * The same question for LEADS. The dashboard reads these beside jobs, and
 * they had the identical defect: `WHERE user_id = <promoted owner>`.
 *
 * Leads have no client or assignment concept, so account membership is the
 * whole rule here.
 */
async function visibleLeadsForUser(connection, userId) {
  const owner = await resolveAccountOwner(connection, userId);
  const [rows] = await connection.query(
    `SELECT id, lead_name AS name FROM leads
      WHERE user_id IN ${ACCOUNT_MEMBER_SQL} AND ${LIVE_LEAD_SQL}`,
    [owner, owner],
  );
  return rows;
}

/**
 * WHO OWNS ONE SPECIFIC job OR lead — for an ownership CHECK, not a read.
 *
 * The snooze endpoint needs to know whether a target id belongs to the
 * caller's account before it writes a row naming that id. That is a
 * different question from "which rows may I see", and it deliberately
 * selects ONLY the owner column: no name, no colour, nothing that reaches
 * the caller. The handler compares and 403s.
 *
 * It lives here rather than in the route so that `routes/dashboard.js`
 * contains no direct query against the job table at all. That is what
 * makes the structural guard absolute instead of a rule with an exemption
 * — and a rule with an exemption is one someone widens later.
 *
 * @returns {number|null} the resolved account owner, or null if no such row
 */
async function targetAccountOwner(connection, targetType, targetId) {
  const table = targetType === 'job' ? '`job`' : 'leads';
  const ownerCol = targetType === 'job' ? 'created_by' : 'user_id';
  const [[found]] = await connection.query(
    `SELECT ${ownerCol} AS owner_id FROM ${table} WHERE id = ? LIMIT 1`,
    [Number(targetId)],
  );
  if (!found) return null;
  return resolveAccountOwner(connection, Number(found.owner_id));
}

module.exports = {
  EMPLOYEE_CATEGORY,
  ACCOUNT_MEMBER_SQL,
  resolveAccountOwner,
  jobScopeWhere,
  // §1 — exported so the two /exceptions queries that build their own SQL
  // use the SAME clause rather than a second copy of the rule. Two copies of
  // "which jobs count" is how the dashboard and the jobs list disagreed in
  // the first place.
  ACTIVE_JOB_SQL,
  LIVE_LEAD_SQL,
  SECTION_ON_LIVE_JOB_SQL,
  visibleJobsForUser,
  visibleLeadsForUser,
  targetAccountOwner,
};
