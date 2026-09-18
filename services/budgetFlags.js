'use strict';

/**
 * "THIS LINE IS NOT SETTLED" — ONE DEFINITION.
 *
 * Two reasons a budget line can be unsettled:
 *   MISSING — the app found an empty cell. Automatic.
 *   TBD     — Poul marked it himself and said why. Manual, and independent of
 *             whether anything is empty.
 *
 * Both flag the same way, both are counted, both clear the moment they are
 * resolved. A line carrying both reasons is ONE line needing attention.
 *
 * This lives in a service and not in the route because THREE things read it:
 * the lineitems response (so the page renders the server's answer instead of
 * re-deriving its own), the lock endpoint (the gate), and the tests. Three
 * copies of "is this line finished" is how the button and the page end up
 * disagreeing about whether a budget can be locked.
 */

/**
 * BLANK IS NOT ZERO.
 *
 * A cell containing 0 is ANSWERED — a line can genuinely cost nothing. Only
 * empty is missing. `sub_cost` is nullable in the schema precisely so the two
 * are distinguishable, so nothing on this path may coerce NULL to 0.
 *
 * Note the deliberate absence of a falsy check: `!value` would treat 0, '' and
 * null identically and silently defeat the whole rule.
 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  return String(value).trim() === '';
}

/**
 * AN EMPTY SUBCONTRACTOR IS ALWAYS FLAGGED. Ruled by Poul, no exceptions, and
 * explicitly NOT conditional on whether a sub cost has been entered.
 *
 * Self-performed work is not an exception to this — the owner selects their own
 * company from the dropdown, which is what `in_house` records. The app never
 * assumes the owner will do it.
 *
 * A brand-new line therefore starts flagged on all three cells. That is correct
 * and intended; do not soften it.
 */
function subcontractorAnswered(row) {
  if (Number(row && row.in_house) === 1) return true;
  const id = row && row.subcontractor_id;
  return !isBlank(id) && Number(id) > 0;
}

/** Which of the three cells are empty on this line. */
function missingFields(row) {
  const out = [];
  if (isBlank(row && row.amount)) out.push('amount');
  if (isBlank(row && row.sub_cost)) out.push('sub_cost');
  if (!subcontractorAnswered(row)) out.push('subcontractor');
  return out;
}

function isTbd(row) {
  return Number(row && row.is_tbd) === 1;
}

/**
 * The whole answer for one line. `flagged` is what the row tint, the count and
 * the lock gate all read — one boolean, whatever the reasons behind it.
 */
function lineFlags(row) {
  const missing = missingFields(row);
  const tbd = isTbd(row);
  return {
    missing,
    is_tbd: tbd,
    tbd_note: (row && row.tbd_note) || null,
    flagged: missing.length > 0 || tbd,
  };
}

/**
 * How many LINES need attention — never how many reasons. A line that is both
 * TBD and missing two cells counts once.
 */
function countFlagged(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => lineFlags(r).flagged).length;
}

/** Decorate rows for the API response, so the page never re-derives the rule. */
function withFlags(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, flags: lineFlags(r) }));
}

/**
 * TWENTY CHARACTERS, and the cap is enforced here as well as in the column and
 * the input. A 21-character note sent straight to the endpoint is rejected, not
 * truncated: silently shortening someone's words is worse than refusing them.
 */
const TBD_NOTE_MAX = 20;

function tbdNoteError(note) {
  if (note === null || note === undefined || note === '') return null;
  if (typeof note !== 'string') return 'tbd_note must be text';
  if (note.length > TBD_NOTE_MAX) {
    return `tbd_note is limited to ${TBD_NOTE_MAX} characters`;
  }
  return null;
}

/**
 * '' and undefined become NULL; 0 and '0' survive untouched.
 *
 * This is the write-side half of blank-is-not-zero. Without it an empty input
 * reaches a DECIMAL column as '' and MySQL stores 0.00 — every blank cell
 * would answer itself and the flags would quietly stop working.
 */
function blankToNull(value) {
  return isBlank(value) ? null : value;
}

module.exports = {
  isBlank,
  blankToNull,
  subcontractorAnswered,
  missingFields,
  isTbd,
  lineFlags,
  countFlagged,
  withFlags,
  tbdNoteError,
  TBD_NOTE_MAX,
};
