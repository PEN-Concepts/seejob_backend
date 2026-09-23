"use strict";

/**
 * Admin gate for the most sensitive routes (impersonation, billing overview).
 *
 * Passes ONLY when the authenticated user's email is an owner-exempt address —
 * Poul's own two. There is no id path.
 *
 * ── WHY THE ID PATH IS GONE ────────────────────────────────────────────────
 *
 * This used to also pass for the hard-coded id 246, commented "gc gc". Poul
 * identified that account as his FORMER WEB DEVELOPER. It is not his, it is not
 * the vendor's, and it held a standing key to impersonation and the billing
 * overview — the ability to log in as any user without their password.
 *
 * His instruction: "GC GC is my old web developer. We need to delete his
 * access. Only I should have real backend access."
 *
 * So the gate is an email allowlist and nothing else. A numeric id cannot be
 * revoked by changing a password or an email; it is a key with no lock to
 * change, which is exactly why it survived long after the person did.
 *
 * It is a genuine server-side gate (403), applied AFTER auth.authenticateToken.
 * The email is looked up from the DB by user id, so it does not depend on the
 * JWT carrying an email claim. Fails CLOSED — any lookup error denies access.
 */

const pool = require("../config/connection");
const logger = require("../common/logger");
const { OWNER_EXEMPT_EMAILS } = require("./access");

async function isAdminUser(userId) {
  if (!userId) return false;
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

/**
 * INTERIM access gate for sub-contractor PAYMENT actions (record/edit/delete).
 * Payments are sensitive financial data, so — until the Employee Level (1-5)
 * system exists — they are restricted to the ACCOUNT OWNER. Employees
 * (user.category = 1) work under an owner and may edit budget lines, but may
 * NOT touch payments. Owner-exempt addresses always pass. Fails CLOSED.
 * TODO(employee-levels): replace with a proper per-level permission once the
 * Employee Level system is built.
 */
const EMPLOYEE_CATEGORY = 1;
async function requireAccountOwner(req, res, next) {
  const userId = req.user && req.user.id ? req.user.id : (res.locals && res.locals.id);
  if (!userId) {
    return res.status(401).json({ code: "401", message: "Unauthorized", data: {} });
  }
  try {
    if (await isAdminUser(userId)) return next(); // owner-exempt email
    const [rows] = await pool.query(
      "SELECT category FROM `user` WHERE id = ? LIMIT 1",
      [userId]
    );
    const category = rows.length ? Number(rows[0].category) : null;
    if (category === EMPLOYEE_CATEGORY) {
      return res.status(403).json({
        code: "403",
        message: "Payments can only be recorded or changed by the account owner.",
        data: {},
      });
    }
    return next();
  } catch (err) {
    logger.error("requireAccountOwner error: " + err.message);
    return res.status(403).json({ code: "403", message: "Forbidden", data: {} }); // fail closed
  }
}

/**
 * Gate for the platform-admin API (admin_contactRequest.js: user_list, admin-user
 * create/edit, account status toggles, admin inboxes). Passes when EITHER the
 * caller holds a valid admin-panel JWT (`user_type === 'admin'`, issued only after
 * a valid admin_users OTP login) OR is an owner-exempt user. This
 * closes the prior holes where these endpoints were unauthenticated or reachable
 * with any normal user token (which enabled create-admin → OTP → admin-JWT
 * privilege escalation). Apply AFTER auth.authenticateToken. Fails CLOSED.
 */
async function requireAdminPanel(req, res, next) {
  const userId = req.user && req.user.id ? req.user.id : (res.locals && res.locals.id);
  if (!userId) {
    return res.status(401).json({ code: "401", message: "Unauthorized", data: {} });
  }
  try {
    if (req.user && req.user.user_type === "admin") return next();
    if (await isAdminUser(userId)) return next();
    return res.status(403).json({ code: "403", message: "Forbidden", data: {} });
  } catch (err) {
    logger.error("requireAdminPanel error: " + err.message);
    return res.status(403).json({ code: "403", message: "Forbidden", data: {} }); // fail closed
  }
}

module.exports = { isAdminUser, requireAdmin, requireAccountOwner, requireAdminPanel };
