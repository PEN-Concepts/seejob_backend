"use strict";

/**
 * Admin gate for sensitive super-admin routes (impersonation, billing overview).
 *
 * Passes when EITHER:
 *   - the authenticated user is the hard-coded super-admin id 246 ("gc gc"), OR
 *   - the authenticated user's email is an owner-exempt email.
 *
 * This is the SAME allowlist `requireImpersonator` used (id 246) broadened to let
 * the platform owner reach admin pages from their normal login. It is a genuine
 * server-side gate (403), applied AFTER auth.authenticateToken. The email is
 * looked up from the DB by user id, so it does not depend on the JWT carrying an
 * email claim. Fails CLOSED — any lookup error denies access.
 */

const pool = require("../config/connection");
const logger = require("../common/logger");
const { OWNER_EXEMPT_EMAILS } = require("./access");

const SUPER_ADMIN_ID = 246;

async function isAdminUser(userId) {
  if (!userId) return false;
  if (Number(userId) === SUPER_ADMIN_ID) return true;
  try {
    const [rows] = await pool.query(
      "SELECT email FROM `user` WHERE id = ? LIMIT 1",
      [userId]
    );
    if (!rows.length) return false;
    const email = String(rows[0].email || "").trim().toLowerCase();
    return OWNER_EXEMPT_EMAILS.has(email);
  } catch (err) {
    logger.error("adminGate.isAdminUser error: " + err.message);
    return false; // fail closed
  }
}

async function requireAdmin(req, res, next) {
  const userId = req.user && req.user.id ? req.user.id : (res.locals && res.locals.id);
  if (!userId) {
    return res.status(401).json({ code: "401", message: "Unauthorized", data: {} });
  }
  const allowed = await isAdminUser(userId);
  if (!allowed) {
    return res.status(403).json({ code: "403", message: "Forbidden", data: {} });
  }
  return next();
}

module.exports = { SUPER_ADMIN_ID, isAdminUser, requireAdmin };
