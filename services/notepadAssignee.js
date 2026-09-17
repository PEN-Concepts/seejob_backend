'use strict';

/**
 * ONE RESOLVED VALUE for "who is this notepad row assigned to" (CCP §3).
 *
 * Before this file, three things described one fact and agreed only by luck:
 *
 *   row state — green or not   read check_list.delegated_task_id
 *   row label — the name       read delegated_to_name -> delegated_first_name
 *   the dialog                 read its own local dgAssigneeName
 *
 * Nothing forced them to agree, so a row could be green (task id present) and
 * blank (no name) at the same time, permanently. That is the defect this CCP
 * closes: the empty-assignee write made exactly that row, and three separate
 * checks is what let it render.
 *
 * Now there is one fact — RESOLVABLE — and everything else is a projection of
 * it. delegate_state, delegated_first_name, is_self_assigned and the assignee
 * object all come out of resolveAssignee(). They cannot diverge because there
 * is nothing left to diverge from.
 *
 * WHAT "RESOLVES" MEANS, precisely: delegated_to names a `user` row that still
 * exists AND that row has a non-blank name. Both halves matter.
 *
 *   - id with no user row   -> the person was deleted. Nothing to show.
 *   - user row, blank name  -> nothing to PRINT. A pill that renders as an
 *                              empty green box is the exact symptom we are
 *                              here to remove, so this counts as unresolved
 *                              too. Rendering "unassigned" is honest; an empty
 *                              green pill is not, and inventing a name would
 *                              be worse than both.
 *
 * A row that does not resolve renders as unassigned EVERYWHERE — by
 * construction, not because three checks happened to agree.
 */

/**
 * The single fact. Returns null when the row has nobody resolvable on it.
 *
 * @param {object} row a check_list row joined to `user` as du
 *                     (delegated_to + delegated_to_name)
 * @returns {{id:number,name:string,first_name:string}|null}
 */
function resolveAssignee(row) {
  if (!row) return null;
  const id = row.delegated_to == null ? 0 : Number(row.delegated_to);
  const name = String(row.delegated_to_name || '').trim();
  if (!id || id <= 0 || !name) return null;
  return { id, name, first_name: name.split(/\s+/)[0] || name };
}

/**
 * The pill state, derived from the SAME resolution the label uses.
 *
 *   'none'      gold-outline "Delegate"  — nobody on it, or nobody resolvable
 *   'delegated' green "Delegated"
 *   'done'      green "<first name> ✓"   — the ASSIGNEE ticked their own box
 *
 * A task id without a resolvable person is 'none', not 'delegated'. That is the
 * whole point: the green pill can no longer outlive the name it is supposed to
 * be showing.
 */
function delegateStateFor(row, assignee) {
  const who = assignee === undefined ? resolveAssignee(row) : assignee;
  if (!row || !row.delegated_task_id || !who) return 'none';
  return Number(row.task_assignee_completed) === 1 ? 'done' : 'delegated';
}

/**
 * Everything a row needs to render its assignment, as projections of the one
 * resolved value. Spread onto the outgoing item.
 *
 * `delegated_first_name` is kept — it is not renamed and no client has to
 * change to keep working — but it is now DERIVED from the same resolution
 * rather than read independently. That is what stops it disagreeing.
 */
function assignmentFields(row, viewerId) {
  const assignee = resolveAssignee(row);
  return {
    assignee,
    delegate_state: delegateStateFor(row, assignee),
    delegated_first_name: assignee ? assignee.first_name : null,
    is_self_assigned: !!assignee && Number(assignee.id) === Number(viewerId),
  };
}

module.exports = { resolveAssignee, delegateStateFor, assignmentFields };
