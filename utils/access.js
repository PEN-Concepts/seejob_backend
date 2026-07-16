"use strict";

/**
 * Access-tier helpers — the server-side source of truth for the free-trial model.
 *
 * Tiers (per user; each user, including invited ones, has their own 60-day
 * clock from their own signup):
 *   paid          = the user has their OWN active subscription
 *   trial_active  = no own subscription, still within 60 days of signup
 *   expired_free  = no own subscription, past the 60-day window
 *
 * Everything FAILS OPEN ('paid') on missing data or error, so a bug in tier
 * calculation can never lock a legitimate user out of their account.
 */

const pool = require("../config/connection");
const logger = require("../common/logger");

const TRIAL_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// Roles that are internal/admin and must never be trial-gated.
const NEVER_GATED_ROLES = new Set([12]);

// Owner / internal accounts that must ALWAYS have full access, regardless of
// subscription status or account age. This protects the platform owner from
// ever being swept into the expired-trial state if a comped/manual
// subscription is ever switched off. Compared case-insensitively. Add more
// internal emails here as needed.
const OWNER_EXEMPT_EMAILS = new Set([
  "poul@oakcoast.net",
  "admin@oakcoast.net",
]);

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
 * Resolve the account-owner id for a user — i.e. whose data this user is part of.
 *
 * Only EMPLOYEES (category = 1) share their inviter's account: they work the
 * owner's jobs/data (subject to the permissions the owner grants). Everyone
 * else — contractors/subcontractors (category 2), clients (category 3), and
 * top-level account owners — belongs to THEMSELVES. So a contractor never sees
 * or edits the inviter's jobs; they only ever get their own data + tasks
 * specifically assigned to them.
 */
const EMPLOYEE_CATEGORY = 1;

async function resolveOwnerId(userId, connection) {
  return withConnection(connection, async (conn) => {
    try {
      const [rows] = await conn.query(
        "SELECT created_by, category FROM user WHERE id = ? LIMIT 1",
        [userId]
      );
      if (
        rows.length &&
        rows[0].created_by &&
        Number(rows[0].category) === EMPLOYEE_CATEGORY
      ) {
        return Number(rows[0].created_by);
      }
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
      // Employees (category 1) share their account OWNER's access tier — an
      // employee never holds their own subscription (the paid plan lives on the
      // owner's account), so evaluate the owner here, not the employee.
      // resolveOwnerId returns the user themselves for owners/contractors/clients,
      // so this is a no-op for everyone except employees.
      const effectiveId = await resolveOwnerId(userId, conn);

      const [userRows] = await conn.query(
        "SELECT id, role, created_at, email FROM user WHERE id = ? LIMIT 1",
        [effectiveId]
      );
      if (!userRows.length) return fallback;

      const role = userRows[0].role;
      const email = String(userRows[0].email || "").trim().toLowerCase();
      const [subRows] = await conn.query(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
        [effectiveId]
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
      if (
        OWNER_EXEMPT_EMAILS.has(email) ||
        NEVER_GATED_ROLES.has(Number(role)) ||
        hasActiveSubscription
      ) {
        mode = "paid";
      } else if (!createdAt || isNaN(createdAt.getTime())) {
        // Unknown signup date -> don't restrict.
        mode = "paid";
      } else {
        mode = daysLeft > 0 ? "trial_active" : "expired_free";
      }

      // Re-verification grace: an account whose sandbox subscription was flagged
      // at the production switch keeps FULL access until its grace deadline, so the
      // go-live notice can honestly promise uninterrupted service. Only matters for
      // accounts that would otherwise be expired_free (trial/paid already have it).
      // Scoped try/catch so a not-yet-migrated column can never lock anyone out.
      let reverifyGraceUntil = null;
      if (mode === "expired_free") {
        try {
          const [graceRows] = await conn.query(
            `SELECT reverification_due_at FROM subscriptions
              WHERE user_id = ? AND needs_reverification = 1
                AND reverification_due_at IS NOT NULL AND reverification_due_at > NOW()
              ORDER BY reverification_due_at DESC LIMIT 1`,
            [effectiveId]
          );
          if (graceRows.length) {
            reverifyGraceUntil = graceRows[0].reverification_due_at;
            mode = "paid"; // grace window: full access while they re-verify
          }
        } catch (graceErr) {
          // Column may not exist pre-migration — ignore and keep expired_free.
        }
      }

      return { mode, trialEndsAt, daysLeft, hasActiveSubscription, reverifyGraceUntil };
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
 * Cumulative plan-tier ladder (mirrors plans.level and the frontend RANK map in
 * m-access.service.ts). Higher number = more inclusive tier. Bid Pro is a separate
 * ADD-ON, not a rung here — it has no level and never satisfies a tier gate.
 */
const PLAN_LEVELS = {
  free: 0,
  trial: 0,
  basic: 1,
  bronze: 2,
  silver: 3,
  gold: 4,
  platinum: 5,
};

// Fallback name→level used when a plan row has no level yet (pre-migration) or an
// unknown name. Prefix-match so "Gold Monthly"/"Gold Annual" still rank as Gold.
function planNameToLevel(name) {
  const n = String(name || "").trim().toLowerCase();
  for (const key of Object.keys(PLAN_LEVELS)) {
    if (n.startsWith(key)) return PLAN_LEVELS[key];
  }
  return 0;
}

/**
 * The HIGHEST tier level among a user's active subscriptions (0 if none).
 * Employees resolve to their account owner (the plan lives on the owner's
 * account), matching getAccessInfo. Uses the highest, not the latest, so an
 * add-on like Bid Pro (no level) can never mask the base tier. Deliberately NOT
 * owner-exempt and trial-agnostic — plan-gated features are governed purely by
 * the plan. Reads plans.level; if that column isn't migrated yet, falls back to
 * ranking by plan name so gating still works.
 */
async function getActivePlanLevel(userId, connection) {
  return withConnection(connection, async (conn) => {
    try {
      const effectiveId = await resolveOwnerId(userId, conn);
      let rows;
      try {
        [rows] = await conn.query(
          `SELECT p.name, p.level
             FROM subscriptions s
             JOIN plans p ON p.id = s.plan_id
            WHERE s.user_id = ? AND s.status = 'active'`,
          [effectiveId]
        );
      } catch (e) {
        if (e && e.code === "ER_BAD_FIELD_ERROR") {
          // plans.level not migrated yet — rank by name instead.
          [rows] = await conn.query(
            `SELECT p.name
               FROM subscriptions s
               JOIN plans p ON p.id = s.plan_id
              WHERE s.user_id = ? AND s.status = 'active'`,
            [effectiveId]
          );
        } else {
          throw e;
        }
      }
      let max = 0;
      for (const r of rows) {
        const lvl =
          r.level !== undefined && r.level !== null
            ? Number(r.level)
            : planNameToLevel(r.name);
        if (Number.isFinite(lvl) && lvl > max) max = lvl;
      }
      return max;
    } catch (err) {
      logger.error("getActivePlanLevel error: " + err.message);
      return 0; // fail closed — callers deny when they can't confirm the tier
    }
  });
}

/**
 * Express middleware: require the caller's account to be on AT LEAST a given plan
 * tier before allowing the request. Apply AFTER auth.authenticateToken.
 *
 * CUMULATIVE by design: `requirePlan('gold')` means "level >= Gold's level (4)",
 * so any higher tier (Platinum = 5) passes automatically — no need to add new
 * tiers to every call site as they launch. Accepts a plan name (resolved via
 * PLAN_LEVELS) or a numeric level directly.
 *
 * This is a genuine SERVER-SIDE tier gate (a 403, not just a hidden UI button).
 * Unlike the trial guard it is NOT owner-exempt — the owner's own plan decides
 * access. FAILS CLOSED: if the tier can't be verified (no active sub, unknown
 * minimum, or a DB error) access is denied — a premium feature must never leak.
 */
function requirePlan(min = "gold") {
  const minLevel =
    typeof min === "number" ? min : (PLAN_LEVELS[String(min).trim().toLowerCase()] || 0);
  return async (req, res, next) => {
    const userId = req.user && req.user.id ? req.user.id : (res.locals && res.locals.id);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    try {
      const level = await getActivePlanLevel(userId);
      if (minLevel > 0 && level >= minLevel) return next();
      return res.status(403).json({
        success: false,
        code: "PLAN_UPGRADE_REQUIRED",
        message: "This feature requires the Gold plan. Please upgrade to use Schedule Templates.",
      });
    } catch (err) {
      logger.error("requirePlan error: " + err.message);
      return res.status(403).json({
        success: false,
        code: "PLAN_UPGRADE_REQUIRED",
        message: "Unable to verify your plan for this feature.",
      });
    }
  };
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
  OWNER_EXEMPT_EMAILS,
  resolveOwnerId,
  getAccessInfo,
  getAccessMode,
  isExpiredFree,
  isSameAccount,
  canViewJob,
  denyExpiredFreeWrites,
  PLAN_LEVELS,
  getActivePlanLevel,
  requirePlan,
};
