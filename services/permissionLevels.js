'use strict';
/**
 * Permission LEVELS — single source of truth for the 1–5 access ladder.
 *
 * Design (confirmed with Poul): Level is a SEPARATE axis from the Role/subcategory
 * LABEL. A person's Level generates a preset `rights[]` set; the existing
 * role_right_permission model + guards then enforce it (decision #1 — reuse, don't
 * rewrite). Standalone TOGGLES (Notepad-create, can_view_all_contacts,
 * project_manager) are layered on top per-person and are NOT part of this preset.
 *
 * CRUD flags express "view vs manage": e.g. `job` read-only at L2 lets a field-crew
 * member SEE a job's tabs (Docs/Pictures/Materials); full CRUD at L3 lets them
 * upload/edit/delete. Cumulative — each level includes everything below it.
 *
 * A few actions a coarse module-right can't distinguish get an EXTRA level check
 * (LEVEL_MIN below), enforced at the wiring stage — e.g. uploading a doc and
 * creating a brand-new Job both touch `job.create`, but creating a new Job is L4.
 *
 * Scope ("only jobs/leads they're on", "contacts on those jobs") is handled by the
 * EXISTING account-scoping (resolveOwnerId / canViewJob / assigned-task rules), not
 * by this preset. This file only answers "which modules + CRUD does a level get."
 *
 * Backend Admin is NEVER represented here and can never be produced by any level.
 */

// CRUD helper. delete is a reserved word as a bare identifier in some contexts, so
// build the object explicitly.
function R(read, create, update, del) {
  return { read: !!read, create: !!create, update: !!update, delete: !!del };
}
const VIEW = R(true, false, false, false);           // read-only
const FULL = R(true, true, true, true);               // full CRUD
const clone = (o) => JSON.parse(JSON.stringify(o));

// Universal floor — every logged-in person, regardless of level. Own-data only.
// (Support = file a ticket; Subscription = VIEW own status; managing billing is L5.)
const UNIVERSAL = {
  dashboard: VIEW,
  spartan: VIEW,
  profile: R(true, false, true, false),   // manage own profile
  support: R(true, true, false, false),   // read FAQ + create a ticket
  subscription: VIEW,                      // see own plan/status only
  invitation: VIEW,                        // see/accept invitations sent to them
};

// Cumulative "adds" at each level (merged onto UNIVERSAL for L1, then L1..n).
// A right present at a higher level REPLACES the lower level's entry (higher wins).
const ADDS = {
  // L1 Guest / Family-Friend — universal only. Everything else is one-at-a-time
  // shared/assigned items, handled by SCOPE, not by a module right. (Notepad-create
  // is a toggle, added per-person, never by level.)
  1: {},

  // L2 Field Crew — see jobs/contacts they're on (read-only); check off their tasks;
  // log their own time. View (not manage) job Docs/Pictures/Materials = job:read.
  2: {
    job: VIEW,                              // view jobs they're on + tabs (read)
    contact: VIEW,                          // view people on those jobs
    task: R(true, false, true, false),      // view + check-off / % complete
    timecard: R(true, true, false, false),  // log their OWN hours
  },

  // L3 Foreman — manage within their jobs (Docs/Pictures/Materials/Stages = job full),
  // assign tasks to crew, Master Calendar / Daily Production / Safety for their jobs,
  // Equipment check-out/in (update, not add/remove), add/edit contacts tied to jobs.
  3: {
    job: R(true, true, true, true),         // manage job content (NOT create new job — see LEVEL_MIN)
    task: R(true, true, true, false),       // assign to crew
    contact: R(true, true, true, false),    // add/edit (job-scoped); company-wide delete is L4
    calendar: R(true, true, true, false),   // their jobs
    dailysheet: R(true, true, true, false), // Daily Production
    jobanalysis: R(true, true, true, false),// Safety Meetings
    equipment: R(true, false, true, false), // check out/in (update); inventory CRUD is L4
    appointment: R(true, true, true, false),
    checklist: VIEW,                         // recipient of shared Notepads (create-own is a toggle)
  },

  // L4 Office Manager — pipeline + money + company-wide people/calendar.
  4: {
    lead: FULL,                             // Leads pipeline (create/edit new)
    quote: FULL,                            // Quote Manager + Change Orders
    changeorder: FULL,
    team: FULL,
    contact: FULL,                          // full company-wide Contact CRUD
    calendar: FULL,                         // all jobs
    timecard: FULL,                         // company-wide time tracking
    equipment: FULL,                        // manage inventory records
    appointment: FULL,
    'bid-requests': R(true, true, true, false),
  },

  // L5 Owner/Admin — Employees (assign levels + toggles) and own-company billing.
  // Backend Admin is NOT here and is never derived from level.
  5: {
    user: FULL,                             // Employees CRUD
    subscription: FULL,                     // manage billing/plan (beyond the universal VIEW)
  },
};

// Actions a coarse module-right can't isolate — gated by LEVEL directly at the
// wiring stage (in addition to the module right). Minimum level required.
const LEVEL_MIN = {
  createNewJob: 4,
  createNewLead: 4,
  editGanttSchedule: 4,     // L3 keeps Gantt VIEW; editing the schedule is L4
  manualLicenseImport: 4,   // company-wide contact creation = full Contact CRUD tier
};

/**
 * Rights preset for a level (1–5). Returns { rightName: {read,create,update,delete} }
 * or null for anything off-ladder / invalid — callers MUST treat null as deny
 * (fail CLOSED). NULL level = off-ladder (owner accounts, subcontractors, clients,
 * unassigned) and is intentionally not resolved here.
 */
function rightsForLevel(level) {
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null; // fail closed
  const out = clone(UNIVERSAL);
  for (let i = 1; i <= n; i++) Object.assign(out, clone(ADDS[i] || {}));
  return out;
}

// Subcontractor class — fixed, non-escalating, off the 1–5 ladder. Read-only view of
// their assigned job(s), check-off + photo + notes on their own tasks, respond to
// bid invites. No company Contacts / Time Tracking / Master Calendar / other jobs.
// (Scope to the specific assigned job is enforced by the existing account rules.)
const SUBCONTRACTOR_RIGHTS = Object.assign(clone(UNIVERSAL), {
  job: VIEW,                              // read-only, their assigned job(s) only (scope elsewhere)
  task: R(true, false, true, false),      // check-off + photo/notes on their own task
  'bid-requests': R(true, true, true, false),
});

/** True if a level meets the minimum for a LEVEL_MIN action. Fail closed. */
function levelAllows(level, actionKey) {
  const need = LEVEL_MIN[actionKey];
  if (need == null) return false;         // unknown action → deny
  const n = Number(level);
  return Number.isInteger(n) && n >= need;
}

module.exports = {
  UNIVERSAL, ADDS, LEVEL_MIN, SUBCONTRACTOR_RIGHTS,
  rightsForLevel, levelAllows,
  VIEW, FULL, R,
};
