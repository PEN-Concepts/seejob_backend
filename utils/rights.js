"use strict";

/**
 * Rights inheritance helpers.
 *
 * When a GC (or any non-subcontractor user) invites a Client or a
 * Subcontractor — from the standalone Invitation page, from the Job form, or
 * from the Lead form — the new user must inherit the inviter's rights so they
 * can immediately work in the parts of the system the inviter has access to.
 *
 * Subcontractors can later subscribe to their own plan; that flow
 * (`syncSubcontractorRole12Rights` in routes/payments.js) wipes every
 * `role_right_permission` row for that user and writes a fresh set derived
 * from the plan's features. Until then, the inherited rights stay in place.
 */

/**
 * Read the rights the inviter currently uses.
 *
 * Mirrors the canonical login flow (routes/users.js around line 141): prefer
 * per-user rows; if the inviter has none (typical for GC, role 14, whose
 * rights live as role-defaults with `user_id IS NULL`), fall back to the
 * role-default rows for the inviter's role.
 *
 * Returned rows include `right_id`, `read`, `create`, `update`, `delete` —
 * everything we need to recreate equivalent rows for the new user.
 */
async function readInviterRights(connection, inviterId) {
  if (!inviterId) return { rights: [], inviterRole: null };

  const [inviterRows] = await connection.query(
    "SELECT id, role FROM user WHERE id = ? LIMIT 1",
    [inviterId],
  );
  if (!inviterRows.length) return { rights: [], inviterRole: null };

  const inviterRole = Number(inviterRows[0].role);

  const [perUser] = await connection.query(
    `SELECT rrp.right_id, rrp.\`read\`, rrp.\`create\`, rrp.\`update\`, rrp.\`delete\`
       FROM role_right_permission rrp
       JOIN \`right\` r ON r.id = rrp.right_id
      WHERE rrp.role_id = ? AND rrp.user_id = ? AND r.sub_heading = 0`,
    [inviterRole, inviterId],
  );
  if (perUser.length) return { rights: perUser, inviterRole };

  const [roleDefaults] = await connection.query(
    `SELECT rrp.right_id, rrp.\`read\`, rrp.\`create\`, rrp.\`update\`, rrp.\`delete\`
       FROM role_right_permission rrp
       JOIN \`right\` r ON r.id = rrp.right_id
      WHERE rrp.role_id = ? AND rrp.user_id IS NULL AND r.sub_heading = 0`,
    [inviterRole],
  );
  return { rights: roleDefaults, inviterRole };
}

/**
 * Clone the inviter's effective rights onto a freshly invited user.
 *
 * - Wipes every existing `role_right_permission` row for `newUserId` first so
 *   re-invites and edge-case retries can't leave stale rows behind.
 * - Inserts a fresh row per inviter-right with `role_id = newUserRoleId`.
 *   Using the new user's own role here keeps the rows discoverable by the
 *   login flow's per-user lookup (`WHERE role_id = user.role AND user_id = N`).
 *
 * Safe to call with a missing inviter or empty rights set — it just no-ops.
 */
async function cloneRightsFromInviter(
  connection,
  { inviterId, newUserId, newUserRoleId },
) {
  if (!newUserId || !newUserRoleId) return 0;

  const { rights } = await readInviterRights(connection, inviterId);
  // Always clear any pre-existing rows for the new user, even if the inviter
  // has nothing to clone — keeps the table clean in re-invite / retry paths.
  await connection.query(
    "DELETE FROM role_right_permission WHERE user_id = ?",
    [newUserId],
  );
  if (!rights.length) return 0;

  const values = rights.map((r) => [
    Number(newUserRoleId),
    Number(newUserId),
    r.right_id,
    r.read,
    r.create,
    r.update,
    r.delete,
  ]);

  await connection.query(
    "INSERT INTO role_right_permission (role_id, user_id, right_id, `read`, `create`, `update`, `delete`) VALUES ?",
    [values],
  );
  return values.length;
}

module.exports = {
  cloneRightsFromInviter,
  readInviterRights,
};
