'use strict';

/**
 * WHO MAY CHANGE AN APPOINTMENT.
 *
 * Until this existed, nobody was asked. Both write paths were:
 *
 *     DELETE FROM appointments WHERE id = ?
 *     UPDATE appointments … WHERE id = ?
 *
 * No creator check, no account scope, nothing — so ANY authenticated user could
 * edit or delete ANY appointment in the database by id, including one belonging
 * to a different company. There was no UI gap to close; there was no rule.
 *
 * ── THE RULE, as Poul gave it ──────────────────────────────────────────────
 *
 * Inside one company, exactly two today:
 *
 *   1. the user who MADE the appointment (`appointments.created_by`)
 *   2. that company's account OWNER
 *
 * and never anyone outside the company, under any circumstance.
 *
 * ── THE THIRD CASE, AND WHY IT IS NOT HERE ─────────────────────────────────
 *
 * Poul also named "anyone the Owner explicitly authorized to act with Owner
 * authority over company information". THAT GRANT DOES NOT EXIST. The only
 * user-level flag in the schema is `can_view_all_contacts`, which gates exactly
 * one read — whether an employee sees the whole contact book in get-task-users.
 * Reusing it here would silently convert "may see the contact book" into "may
 * delete other people's appointments".
 *
 * Inventing a permission model inside a security fix is the wrong trade, so the
 * seam is named and left empty: see `holdsCompanyAuthorityGrant` below. When the
 * grant exists, that function is the only thing that changes.
 *
 * ── COMPANY IS `resolveAccountOwner`, AND ONLY THAT ────────────────────────
 *
 * It promotes EMPLOYEES to their owner and resolves everyone else to themselves,
 * because a subcontractor is a separate business and a client is a customer.
 * Two users are in the same company when it returns the same id for both. This
 * is the canonical test; do not write a second one.
 *
 * FAILS CLOSED. Anything the rule does not clearly permit is refused, including
 * a lookup error and an appointment whose author cannot be identified.
 */

const { resolveAccountOwner } = require('./accountScope');
const logger = require('../common/logger');

/**
 * THE SEAM. Returns false, always, and that is deliberate — see the header.
 *
 * When Poul rules on what "authorized like the Owner" means, this is the one
 * function that changes, and both write paths pick it up. Keep it a pure
 * yes/no on (connection, actorId, accountOwnerId) so it cannot grow into a
 * second copy of the company rule.
 */
// eslint-disable-next-line no-unused-vars
async function holdsCompanyAuthorityGrant(connection, actorId, accountOwnerId) {
  return false;
}

/** Refusal reasons, so the route and the tests name the same things. */
const REASONS = {
  NOT_FOUND: 'not_found',
  NO_AUTHOR: 'no_author',
  OTHER_COMPANY: 'other_company',
  NOT_YOURS: 'not_yours',
  ERROR: 'error',
};

const MESSAGES = {
  [REASONS.NOT_FOUND]: 'Appointment not found',
  [REASONS.NO_AUTHOR]:
    'This appointment has no recorded creator, so it cannot be changed. Contact the account owner.',
  [REASONS.OTHER_COMPANY]: 'This appointment belongs to another account.',
  [REASONS.NOT_YOURS]:
    'Only the person who created this appointment, or the account owner, can change it.',
  [REASONS.ERROR]: 'Forbidden',
};

/**
 * May `actorId` write to appointment `appointmentId`?
 *
 * @returns {{allowed: boolean, reason?: string, message?: string, createdBy?: number}}
 */
async function canWriteAppointment(connection, actorId, appointmentId) {
  const actor = Number(actorId);
  const id = Number(appointmentId);
  if (!actor || !id) return deny(REASONS.ERROR);

  try {
    const [[row]] = await connection.query(
      'SELECT id, created_by FROM appointments WHERE id = ? LIMIT 1',
      [id],
    );
    if (!row) return deny(REASONS.NOT_FOUND);

    const author = Number(row.created_by || 0);
    /* §0b item 5: appointments with no identifiable author exist and are
     * REPORTED, not repaired. With no author there is no company either, so
     * there is nobody the rule can permit — including the owner, who cannot be
     * shown to be in the same company as a row that names none. Refused, with a
     * message that says why rather than a bare Forbidden. */
    if (!author) return deny(REASONS.NO_AUTHOR);

    const actorAccount = Number(await resolveAccountOwner(connection, actor));
    const authorAccount = Number(await resolveAccountOwner(connection, author));

    // NEVER anyone outside the company. Checked first, so a later rule cannot
    // accidentally reach across accounts.
    if (!actorAccount || !authorAccount || actorAccount !== authorAccount) {
      return deny(REASONS.OTHER_COMPANY);
    }

    // 1. the user who made it
    if (actor === author) return { allowed: true, createdBy: author };

    // 2. that company's account owner — the root of their own account
    if (actorAccount === actor) return { allowed: true, createdBy: author };

    // 3. the grant, when it exists. Today this is always false.
    if (await holdsCompanyAuthorityGrant(connection, actor, actorAccount)) {
      return { allowed: true, createdBy: author };
    }

    return deny(REASONS.NOT_YOURS);
  } catch (err) {
    logger.error('canWriteAppointment error: ' + err.message);
    return deny(REASONS.ERROR);           // fail closed
  }
}

function deny(reason) {
  return { allowed: false, reason, message: MESSAGES[reason] || MESSAGES[REASONS.ERROR] };
}

/** The HTTP status a refusal carries. A missing row is 404; everything else is
 *  a REFUSAL and must be 403 — never a 404 that reads like "already gone", and
 *  never a silent 200. */
function statusFor(reason) {
  return reason === REASONS.NOT_FOUND ? 404 : 403;
}

module.exports = { canWriteAppointment, statusFor, REASONS, MESSAGES };
