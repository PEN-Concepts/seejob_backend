"use strict";

/**
 * Access-tier helpers — the server-side source of truth for the free-trial model.
 *
 * Tiers (per user; each user, including invited ones, has their own 30-day
 * clock from their own signup):
 *   paid          = the user has their OWN active subscription
 *   trial_active  = no own subscription, still within 30 days of signup
 *   expired_free  = no own subscription, past the 30-day window
 *
 * Everything FAILS OPEN ('paid') on missing data or error, so a bug in tier
 * calculation can never lock a legitimate user out of their account.
 */

const pool = require("../config/connection");
const logger = require("../common/logger");

const TRIAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Roles that are internal/admin and must never be trial-gated.
const NEVER_GATED_ROLES = new Set([12]);

async function withConnection(connection, fn) {
  if (connection) return fn(connection);
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

/**
 * Resolve the account-owner id for a user. Invited sub-users (created_by set)
 * belong to the account that created them; account owners belong to themselves.
 * Mirrors the owner-resolution pattern already used across the job routes.
 */
async function resolveOwnerId(userId, connection) {
  return withConnection(connection, async (conn) => {
    try {
      const [rows] = await conn.query(
        "SELECT created_by FROM user WHERE id = ? LIMIT 1",
        [userId]
      );
      if (rows.length && rows[0].created_by) return Number(rows[0].created_by);
    } catch (err) {
      logger.error("resolveOwnerId error: " + err.message);
    }
    return Number(userId);
  });
}

/**
 * Full access info for a user: { mode, trialEndsAt, daysLeft, hasActiveSubscription }.
 * This is the single source of truth consumed by both /users/my-rights (for the
 * client) and the write/read guards (for enforcement).
 */
async function getAccessInfo(userId, connection) {
  return withConnection(connection, async (conn) => {
    const fallback = {
      mode: "paid",
      trialEndsAt: null,
      daysLeft: 0,
      hasActiveSubscription: false,
    };
    try {
      const [userRows] = await conn.query(
        "SELECT id, role, created_at FROM user WHERE id = ? LIMIT 1",
        [userId]
      );
      if (!userRows.length) return fallback;

      const role = userRows[0].role;
      const [subRows] = await conn.query(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
        [userId]
      );
      const hasActiveSubscription = subRows.length > 0;

      const createdAt = userRows[0].created_at
        ? new Date(userRows[0].created_at)
        : null;
      let trialEndsAt = null;
      let daysLeft = 0;
      if (createdAt && !isNaN(createdAt.getTime())) {
        const end = createdAt.getTime() + TRIAL_DAYS * DAY_MS;
        trialEndsAt = new Date(end).toISOString();
        daysLeft = Math.max(0, Math.ceil((end - Date.now()) / DAY_MS));
      }

      let mode;
      if (NEVER_GATED_ROLES.has(Number(role)) || hasActiveSubscription) {
        mode = "paid";
      } else if (!createdAt || isNaN(createdAt.getTime())) {
        // Unknown signup date -> don't restrict.
        mode = "paid";
      } else {
        mode = daysLeft > 0 ? "trial_active" : "expired_free";
      }

      return { mode, trialEndsAt, daysLeft, hasActiveSubscription };
    } catch (err) {
      logger.error("getAccessInfo error: " + err.message);
      return fallback;
    }
  });
}

async function getAccessMode(userId, connection) {
  return (await getAccessInfo(userId, connection)).mode;
}

async function isExpiredFree(userId, connection) {
  return (await getAccessMode(userId, connection)) === "expired_free";
}

/**
 * Rule 2 (ownership) — applies to ALL tiers, always. A user may modify a record
 * only if it belongs to the SAME account: their own account, or the account
 * that owns them. Compares the resolved account-owner of the actor and of the
 * record's creator. Returns false when the record has no creator.
 */
async function isSameAccount(userId, recordCreatedBy, connection) {
  if (recordCreatedBy == null) return false;
  return withConnection(connection, async (conn) => {
    const actorAccount = await resolveOwnerId(userId, conn);
    const recordAccount = await resolveOwnerId(recordCreatedBy, conn);
    return Number(actorAccount) === Number(recordAccount);
  });
}

/**
 * May this user VIEW this job? Mirrors the jobs-list visibility rules so a
 * direct by-id request can't bypass them:
 *   expired_free -> only jobs they're assigned to (own jobs hidden)
 *   paid/trial   -> their own account's jobs, or any job they're assigned to
 */
async function canViewJob(userId, jobId, connection) {
  return withConnection(connection, async (conn) => {
    const [jobRows] = await conn.query(
      "SELECT created_by FROM job WHERE id = ? LIMIT 1",
      [jobId]
    );
    if (!jobRows.length) return false;

    const isAssigned = async () => {
      const [t] = await conn.query(
        "SELECT 1 FROM tasks WHERE job_id = ? AND user_id = ? LIMIT 1",
        [jobId, userId]
      );
      return t.length > 0;
    };

    const mode = await getAccessMode(userId, conn);
    if (mode === "expired_free") return isAssigned();
    if (await isSameAccount(userId, jobRows[0].created_by, conn)) return true;
    return isAssigned();
  });
}

/**
 * Express middleware: block create/update/delete for expired free-trial users.
 * Apply AFTER auth.authenticateToken on write endpoints. Read routes are not
 * affected here. The one write expired_free users are allowed — checking off
 * their own assigned task — must NOT use this guard.
 */
function denyExpiredFreeWrites(req, res, next) {
  const userId = req.user && req.user.id ? req.user.id : null;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  getAccessMode(userId)
    .then((mode) => {
      if (mode === "expired_free") {
        return res.status(403).json({
          success: false,
          code: "TRIAL_EXPIRED",
          message:
            "Your free trial has ended. Your data is saved — upgrade to create or edit again.",
        });
      }
      return next();
    })
    .catch((err) => {
      logger.error("denyExpiredFreeWrites error: " + err.message);
      return next(); // fail open
    });
}

module.exports = {
  TRIAL_DAYS,
  resolveOwnerId,
  getAccessInfo,
  getAccessMode,
  isExpiredFree,
  isSameAccount,
  canViewJob,
  denyExpiredFreeWrites,
};
