'use strict';

/**
 * Schema for the one-day Spartan Dashboard.
 *
 * Two tables, both additive, both PER USER. Nothing here is shared with the
 * account: one person snoozing a stalled job must not silence it for anybody
 * else, and one person's review of a past item is their own.
 *
 * Two shapes below are load-bearing. They are not conventions that code has
 * to remember — they are the reason two of the rules cannot be broken by a
 * later mistake:
 *
 *   1. `check_back_on DATE NOT NULL` — THERE IS NO INDEFINITE SNOOZE.
 *      A job silenced permanently is a hole in the list meant to catch it.
 *      Because the column cannot be null, "hide forever" has nowhere to be
 *      written. There is no flag to set and no sentinel to pass. The only way
 *      to add one would be to change this column.
 *
 *   2. GREY IS THE ABSENCE OF A ROW.
 *      An unreviewed past item has no `dashboard_item_review` row at all.
 *      Grey means "not yet reviewed"; red means "the user confirmed it was
 *      missed". Since only a user action inserts a row, grey CANNOT harden
 *      into red on its own — there is no timer that could do it, because
 *      ageing a row that does not exist is not a thing that can happen.
 */

const logger = require('../common/logger');

let ensured = false;

async function ensureDashboardSchema(connection) {
  if (ensured) return;
  let allOk = true;

  const run = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      allOk = false;
      logger.error(`dashboard schema step failed (${label}): ${e.message}`);
    }
  };

  // ── STALL SNOOZE ──────────────────────────────────────────────────────
  // "Check back on <date>" for one job or lead, for ONE user.
  //
  // UNIQUE on (user_id, target_type, target_id): picking a new date replaces
  // the old one rather than stacking rows, so "when does this come back" has
  // exactly one answer.
  await run('dashboard_stall_snooze', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS dashboard_stall_snooze (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        target_type VARCHAR(8) NOT NULL,
        target_id INT NOT NULL,
        check_back_on DATE NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_dss_user_target (user_id, target_type, target_id),
        KEY idx_dss_user_date (user_id, check_back_on)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  // ── MISSED / KEPT ─────────────────────────────────────────────────────
  // A RECORD OF WHAT HAPPENED, AND THEREFORE ACCOUNT-WIDE.
  //
  // This is the one thing here that is NOT per user, and the distinction is
  // deliberate. The snooze means "stop nagging ME", and two people can
  // reasonably want different things. Missed/kept is a fact: if the Tuesday
  // inspection did not happen, it did not happen for everybody. Scoped per
  // user, the boss and an employee could hold contradictory beliefs about
  // whether an inspection took place and the app would show both as true.
  //
  // So the key is the ACCOUNT, not the person. Whoever sets it, sets it for
  // everyone. `set_by_user_id` records who, because "it did not happen" is
  // worth being able to attribute — but it is not part of the key, so it
  // cannot fork the answer.
  //
  // `occurs_on` IS part of the key, because a Planner goal recurs: missing it
  // on Monday says nothing about Tuesday. Without the day, confirming one
  // Monday missed would mark every occurrence of that goal missed forever.
  //
  // `state` is only ever 'missed' or 'kept'. There is deliberately no third
  // value for "unreviewed" — that is the absence of the row (see above).
  await run('dashboard_item_review', () =>
    connection.query(`
      CREATE TABLE IF NOT EXISTS dashboard_item_review (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_owner_id INT NOT NULL,
        item_type VARCHAR(16) NOT NULL,
        item_id INT NOT NULL,
        occurs_on DATE NOT NULL,
        state VARCHAR(8) NOT NULL,
        set_by_user_id INT NULL DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL DEFAULT NULL,
        UNIQUE KEY uq_dir_account_item_day (account_owner_id, item_type, item_id, occurs_on),
        KEY idx_dir_account_day (account_owner_id, occurs_on)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `),
  );

  if (allOk) ensured = true;
}

/**
 * No change on a job or lead for this many days makes it STALLED. Same
 * threshold for both, by Poul's ruling. Configurable, shipped at 10 —
 * override with DASHBOARD_STALL_DAYS.
 */
function stallDays() {
  const raw = Number(process.env.DASHBOARD_STALL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
}

/** Item types that can carry a missed/kept review. */
const REVIEWABLE = new Set(['appointment', 'task', 'planner', 'master']);

/** The only two review states. Anything else is rejected at the route. */
const REVIEW_STATES = new Set(['missed', 'kept']);

/** The only two things that can be snoozed. */
const SNOOZE_TARGETS = new Set(['job', 'lead']);

module.exports = {
  ensureDashboardSchema,
  stallDays,
  REVIEWABLE,
  REVIEW_STATES,
  SNOOZE_TARGETS,
  /** Test seam: let a suite re-run the DDL against a fresh database. */
  _resetForTests: () => { ensured = false; },
};
