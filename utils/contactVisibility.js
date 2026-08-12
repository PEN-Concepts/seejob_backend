"use strict";

/**
 * SINGLE source of truth for "which people/contacts may this caller see".
 * Mirrors the scope logic proven in /user/get-task-users so every people-list
 * endpoint shares ONE visibility rule instead of each re-deriving it.
 *
 * Model (per owner spec):
 *   • The account OWNER, owner-exempt platform logins, and Employees explicitly
 *     granted authority (user.can_view_all_contacts = 1) see the WHOLE account
 *     book  → scope_id = the account owner id.
 *   • Everyone else — clients, subcontractors, employees WITHOUT authority —
 *     see only THEIR OWN contacts + themselves + the account owner
 *     → scope_id = self.
 */
const { ensureContactAuthorityColumn } = require("../services/dbMigrations");
const { OWNER_EXEMPT_EMAILS, getAccessMode } = require("./access");

async function getContactScope(connection, req) {
  const user_id = Number(req.user && req.user.id) || 0;
  const owner_id = Number(req.user && req.user.working_id) || user_id;
  const email = String((req.user && req.user.email) || "").trim().toLowerCase();

  await ensureContactAuthorityColumn(connection);

  let canViewAll = owner_id === user_id || OWNER_EXEMPT_EMAILS.has(email);
  if (!canViewAll) {
    try {
      const [[me]] = await connection.query(
        "SELECT category, can_view_all_contacts FROM `user` WHERE id = ? LIMIT 1",
        [user_id]
      );
      // Authority is grantable ONLY to Employees (category 1); clients/subs never.
      canViewAll =
        Number(me && me.category) === 1 &&
        Number(me && me.can_view_all_contacts) === 1;
    } catch (e) {
      /* fail closed: a lookup error keeps the caller restricted */
    }
  }

  // A trial-EXPIRED, non-upgraded account loses contact access + delegation, even
  // the GC owner (their contacts are retained, just hidden until they upgrade).
  // Owner-exempt platform accounts are never gated.
  let expired = false;
  if (!OWNER_EXEMPT_EMAILS.has(email)) {
    try {
      const mode = await getAccessMode(user_id, connection);
      if (mode === "expired_free") { expired = true; canViewAll = false; }
    } catch (e) { /* fail open on lookup error; still scoped below */ }
  }

  const scope_id = canViewAll ? owner_id : user_id;
  return { user_id, owner_id, canViewAll, scope_id, expired };
}

/**
 * SQL predicate limiting a `user` table alias to the caller's visible book.
 * Visible = the caller, the account owner, anyone the scope created, and anyone
 * connected to scope_id via the `contact` table.
 *   • Full-visibility callers (scope_id = owner)  → the whole account.
 *   • Restricted callers      (scope_id = self)   → self + owner + own contacts.
 * Returns { sql, params }; splice `sql` into a WHERE (AND-combined) and spread
 * `params` in order. Uses the same contact columns (request_user1/2) as
 * get-task-users, so the two stay consistent.
 */
function visibleUserPredicate(alias, scope) {
  const { user_id, owner_id, scope_id, expired } = scope;
  // Trial-expired accounts see only themselves — no contact book at all.
  if (expired) {
    return { sql: `${alias}.id = ?`, params: [user_id] };
  }
  const sql = `(
    ${alias}.id = ? OR ${alias}.id = ?
    OR ${alias}.created_by = ?
    OR ${alias}.id IN (
      SELECT CASE WHEN c.request_user1 = ? THEN c.request_user2 ELSE c.request_user1 END
      FROM contact c WHERE c.request_user1 = ? OR c.request_user2 = ?
    )
  )`;
  const params = [user_id, owner_id, scope_id, scope_id, scope_id, scope_id];
  return { sql, params };
}

module.exports = { getContactScope, visibleUserPredicate };
