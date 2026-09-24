const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const auth = require("../services/authentication");
const logger = require("../common/logger");
const { ensureOwnerTypeColumns, ensureSubCostColumn, ensureInHouseColumn, ensureAllowanceColumn, ensureBudgetPercentColumns, ensurePaymentsTables, ensureSuggestedItemsTable, seedSuggestedItems, ensureBudgetLockTables, ensureBudgetTbdColumns, ensureChangeOrderBudgetColumns, ensureChangeOrderPaymentTables } = require("../services/dbMigrations");
const { blockExpiredOwnRecord, requirePlan, OWNER_EXEMPT_EMAILS, denyRestrictedJobData, isSameAccount, getAccessMode } = require("../utils/access");
const { requireAccountOwner } = require("../utils/adminGate");
const { requireOwnsJob } = require("../utils/ownership");
const { countFlagged, withFlags, tbdNoteError, blankToNull, TBD_NOTE_MAX } = require("../services/budgetFlags");
const { fetchBudgetExportData, buildBudgetWorkbook, budgetExportFilename } = require("../services/budgetWorkbook");

// Payment methods a subcontractor payment can be recorded under.
const PAYMENT_METHODS = new Set(["check", "cash", "credit_card", "venmo", "wire"]);

// Normalize the job_type/owner_type param to the discriminator stored on
// division_lineitems. Anything that isn't an explicit 'lead' is a job.
function ownerTypeOf(v) {
  return String(v || "").toLowerCase() === "lead" ? "lead" : "job";
}

// Is this job's budget locked? Fail-open (false) on any error so a migration
// hiccup never blocks legitimate edits.
async function isBudgetLocked(connection, jobId, ownerType) {
  try {
    await ensureBudgetLockTables(connection);
    const [rows] = await connection.query(
      "SELECT locked FROM budget_locks WHERE job_id = ? AND owner_type = ? LIMIT 1",
      [Number(jobId), ownerType]
    );
    return rows.length ? !!Number(rows[0].locked) : false;
  } catch (_) {
    return false;
  }
}

// Display name for lock/unlock audit ("who").
async function userDisplayName(connection, userId) {
  try {
    const [rows] = await connection.query(
      "SELECT name, email FROM `user` WHERE id = ? LIMIT 1",
      [userId]
    );
    if (!rows.length) return null;
    return String(rows[0].name || rows[0].email || "").trim() || null;
  } catch (_) {
    return null;
  }
}

async function resolveBillingUserId(connection, userId) {
  let billingUserId = userId;
  const [userRows] = await connection.query(
    "SELECT id, role, created_by FROM user WHERE id = ? LIMIT 1",
    [userId]
  );

  if (!userRows.length) return billingUserId;

  const currentUser = userRows[0];
  const currentRole = Number(currentUser.role);

  if (currentRole === 14) {
    return currentUser.id;
  }

  if (currentRole !== 12 && currentUser.created_by) {
    const [managerRows] = await connection.query(
      "SELECT id, role FROM user WHERE id = ? LIMIT 1",
      [currentUser.created_by]
    );
    if (managerRows.length && Number(managerRows[0].role) === 14) {
      return managerRows[0].id;
    }
  }

  return billingUserId;
}

async function getActivePlanFeatures(connection, userId) {
  const billingUserId = await resolveBillingUserId(connection, userId);

  const [subRows] = await connection.query(
    `SELECT plan_id
     FROM subscriptions
     WHERE user_id = ? AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [billingUserId]
  );

  if (!subRows.length) {
    // No subscription row: owner-exempt accounts, internal roles and TRIAL users
    // are treated as a top-tier paying customer (full feature set). This copy
    // returned [] unconditionally, so a trial was refused with
    // FEATURE_NOT_AVAILABLE. Its twin in routes/jobs.js already handled trials
    // correctly; this one was never updated to match — which is the whole
    // pattern this fix is closing. expired_free still gets nothing.
    let mode = "paid";
    try {
      mode = await getAccessMode(userId);
    } catch (e) {
      mode = "paid"; // fail open, matching the jobs.js twin
    }
    if (mode === "paid" || mode === "trial_active") {
      const [allRows] = await connection.query(
        "SELECT DISTINCT feature_key FROM plan_features"
      );
      return allRows.map((r) => normalizeFeatureKey(r.feature_key));
    }
    return [];
  }

  const planId = subRows[0].plan_id;
  const [featureRows] = await connection.query(
    "SELECT feature_key FROM plan_features WHERE plan_id = ?",
    [planId]
  );

  return featureRows.map((r) => normalizeFeatureKey(r.feature_key));
}

function normalizeFeatureKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function requirePlanFeatures(allowedKeys) {
  const normalizedAllowed = allowedKeys.map((k) => normalizeFeatureKey(k));

  return async (req, res, next) => {
    const userId = req.user && req.user.id ? req.user.id : res.locals.id;
    if (!userId) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      });
    }

    let connection;
    try {
      connection = await pool.getConnection();
      const features = await getActivePlanFeatures(connection, userId);

      if (!features.length) {
        return res.status(403).json({
          code: "FEATURE_NOT_AVAILABLE",
          message: "Your plan does not include this feature.",
        });
      }

      const ok = normalizedAllowed.some((k) => features.includes(k));
      if (!ok) {
        return res.status(403).json({
          code: "FEATURE_NOT_AVAILABLE",
          message: "Your plan does not include this feature.",
        });
      }

      return next();
    } catch (err) {
      return res.status(500).json({
        code: "BILLING_FEATURES_ERROR",
        message: "Unable to verify plan features.",
      });
    } finally {
      if (connection) connection.release();
    }
  };
}

// Budget + Billing are off-limits to Subcontractors/Clients on ANY job. Every
// budget route already runs through requireJobBudgetFeature (after auth), so
// prepending denyRestrictedJobData here guards them all in one place (Express
// flattens the array). req.user is populated by the preceding authenticateToken.
const requireJobBudgetFeature = [denyRestrictedJobData, requirePlanFeatures(["job_budget", "budget"])];

// Budget is now PLATINUM-ONLY (task #84). Tier gate on the whole router, in
// addition to the per-route plan-feature check below. Owner-exempt accounts are
// level 5 so they pass; Gold accounts (even with the job_budget feature) are 403.
// authenticateToken runs here so requirePlan can read req.user.
router.use(auth.authenticateToken, requirePlan("platinum"));

// ── Cross-account isolation for ALL budget data ────────────────────────────────
// Budgets/invoices hang off a job (or lead). Previously any Platinum account could
// read/write another company's financials by passing a foreign job_id / itemId /
// coId. These guards resolve every id back to its TRUE parent job/lead FROM THE DB
// (never trusting a client-supplied job_id) and require it to belong to the
// caller's account. Fail CLOSED (403) — financial data must never leak on error.
async function ownsOwnerRecord(userId, jobId, ownerType) {
  if (jobId == null || jobId === "") return true; // presence is validated by handlers
  const isLead = String(ownerType || "job").toLowerCase() === "lead";
  const table = isLead ? "leads" : "job";
  const col = isLead ? "user_id" : "created_by";
  const [[row]] = await pool.query(
    `SELECT ${col} AS owner FROM ${table} WHERE id = ? LIMIT 1`,
    [Number(jobId)]
  );
  if (!row) return false;
  return isSameAccount(userId, row.owner);
}
function budgetForbidden(res, msg) {
  return res.status(403).json({ code: "403", success: false, message: msg, data: {} });
}
// job_id supplied in query/body must belong to the caller's account.
async function requireJobIdOwnership(req, res, next) {
  try {
    const jobId = req.query.job_id != null ? req.query.job_id : (req.body && req.body.job_id);
    if (jobId == null || jobId === "") return next();
    const ownerType = req.query.job_type != null ? req.query.job_type : (req.body && req.body.job_type);
    if (!(await ownsOwnerRecord(req.user.id, jobId, ownerType)))
      return budgetForbidden(res, "This job does not belong to your account.");
    return next();
  } catch (e) {
    logger.error("requireJobIdOwnership: " + e.message);
    return budgetForbidden(res, "Forbidden");
  }
}
// :itemId → its line item's parent job must belong to the caller's account.
router.param("itemId", async (req, res, next, itemId) => {
  try {
    const [[li]] = await pool.query(
      "SELECT job_id, owner_type FROM division_lineitems WHERE id = ? LIMIT 1",
      [Number(itemId)]
    );
    if (!li) return res.status(404).json({ code: "404", success: false, message: "Line item not found", data: {} });
    if (!(await ownsOwnerRecord(req.user.id, li.job_id, li.owner_type)))
      return budgetForbidden(res, "This budget item does not belong to your account.");
    return next();
  } catch (e) {
    logger.error("budget itemId guard: " + e.message);
    return budgetForbidden(res, "Forbidden");
  }
});
// :coId → its change order's parent job must belong to the caller's account.
router.param("coId", async (req, res, next, coId) => {
  try {
    const [[co]] = await pool.query(
      "SELECT job_id FROM change_orders WHERE id = ? LIMIT 1",
      [Number(coId)]
    );
    if (!co) return res.status(404).json({ code: "404", success: false, message: "Change order not found", data: {} });
    if (!(await ownsOwnerRecord(req.user.id, co.job_id, "job")))
      return budgetForbidden(res, "This change order does not belong to your account.");
    return next();
  } catch (e) {
    logger.error("budget coId guard: " + e.message);
    return budgetForbidden(res, "Forbidden");
  }
});
router.use(requireJobIdOwnership);


router.get(
  "/subcontractors",
  auth.authenticateToken,
  requireJobBudgetFeature,
  async (req, res) => {
    let connection;
    try {
      const userId = (req.user && req.user.id) ? req.user.id : res.locals.id;
      connection = await pool.getConnection();

      // TENANT ISOLATION.
      //
      // This query used to open with a third branch:
      //
      //     SELECT id, name, email FROM user WHERE role = 12 AND status = 1
      //
      // which carried NO company, user or ownership clause at all. It returned
      // every role-12 user in the database, so the UNION resolved to "every
      // subcontractor on the platform" and the two scoped branches below were
      // redundant. Any user who could open a Budget page saw other companies'
      // subcontractor names and emails, and their Budget pages showed ours.
      //
      // It was DELETED rather than given a company clause. The branches below
      // already return exactly the caller's own contacts, so removing it takes
      // away only records the caller was never entitled to see. A narrower
      // query with fewer moving parts is the point: there is now one way to be
      // in this list, not two.
      //
      // Do not add an unscoped branch back for convenience. If this list needs
      // to be wider, widen it from the CONTACT side, where ownership is
      // actually expressed.
      /*
       * §7 THE DROPDOWN SHOWED SIX OF FIFTY-ONE. Three reasons, all fixed here.
       *
       * 1. DEAD JOIN COLUMNS. This joined c.request_user1 / c.request_user2.
       *    NOTHING WRITES THOSE. Every INSERT INTO contact in this codebase
       *    writes request_by / request_to (invitations.js:229 and the six
       *    others), so both branches matched almost nothing — the six that did
       *    were legacy rows from before the column rename. The unscoped branch
       *    removed for tenant isolation was, by accident, the only one that
       *    had been returning anything, which is why this looked fine until it
       *    was taken out.
       *
       * 2. status = 1 DROPPED, per Poul's ruling. It excluded every contact
       *    who had not completed an invitation handshake — people he works
       *    with every week and would expect to pick.
       *
       * 3. role = 12 REPLACED BY category = 2. Role is the login class;
       *    category is what the contact IS. Filtering on role missed
       *    subcontractors stored with a different role but the right category.
       *
       * Tenant isolation is UNCHANGED and still comes from the contact side:
       * both branches are scoped to this caller's own contact rows. No
       * unscoped branch is reintroduced — see the note above, which still
       * stands.
       */
      /*
       * §0 — THIRTEEN OF THIRTY-SEVEN, AND THE CAUSE WAS NOT THE CATEGORY FILTER.
       *
       * Poul's picker returned 13 names while his contacts hold 33
       * subcontractors, a GC and 3 employees. The obvious suspect was
       * `u.category = 2`. It was not. PROVEN by running both queries verbatim
       * against one fixture (test/budgetSubcontractorScopeProof.test.js):
       * dropping the category filter recovered 3 rows; changing the SCOPE
       * recovered 14.
       *
       * The clause was `c.request_by = ?` — the CALLER, personally — while
       * every other picker scopes to the ACCOUNT:
       *
       *     WHERE c.request_by IN (SELECT id FROM user WHERE id = ? OR created_by = ?)
       *
       * So any contact an EMPLOYEE typed in was invisible here and visible
       * everywhere else. Nothing in the UI shows who added a contact, which is
       * why the missing names looked arbitrary.
       *
       * This is the SAME tenant boundary get-task-users already applies to the
       * same table — not a widening of who may be seen, a correction of who was
       * wrongly hidden.
       *
       * ── WHY THE FILTER IS A POSITIVE ALLOWLIST ────────────────────────────
       *
       * `category = 2` is not "is a subcontractor": the general contractor
       * carries it too, so category cannot tell them apart. And a negative test
       * (!isClient) would admit every category the code has never seen. So the
       * rule names what it wants — CONTRACTORS and EMPLOYEES — and anything
       * unrecognised is absent. Clients never appear: a budget line is work
       * somebody does, and a client is who the bill goes to.
       *
       * The effective category mirrors get-task-users: a subcategory's parent
       * wins over the raw column, so a contact filed under a subcategory is
       * classified the way Contacts classifies it.
       *
       * `business` is selected because the picker renders COMPANY FIRST. The old
       * query selected only id/name/email, which is the whole reason owner names
       * were showing. `trade` and `subcategory_name` come with it so the one
       * search box can match COMPANY, OWNER and TRADE, as the picker spec asks:
       * typing `tile` finds C & R TILE & STONE, typing `Rolando` finds the same
       * row. Neither is rendered.
       *
       * The CALLER IS EXCLUDED — Poul must not appear in his own subcontractor
       * list. He reaches this query through the reverse branch, being category 2
       * himself.
       */
      const [rows] = await connection.query(
        `SELECT p.id, p.name, p.email, p.business, p.trade, p.category,
                p.subcategory, p.subcategory_name,
                p.effective_category_id, p.effective_category_name
         FROM (
           (
             SELECT u.id, u.name, u.email, u.business, u.trade, u.category, u.subcategory,
                    COALESCE(sc.category_id, u.category) AS effective_category_id,
                    cat.name AS effective_category_name,
                    sc.name AS subcategory_name
             FROM contact c
             INNER JOIN user u ON u.id = c.request_to
             LEFT JOIN subcategory sc ON sc.id = u.subcategory
             LEFT JOIN category cat ON cat.id = COALESCE(sc.category_id, u.category)
             WHERE c.request_by IN (SELECT id FROM user WHERE id = ? OR created_by = ?)
           )
           UNION
           (
             SELECT u.id, u.name, u.email, u.business, u.trade, u.category, u.subcategory,
                    COALESCE(sc.category_id, u.category) AS effective_category_id,
                    cat.name AS effective_category_name,
                    sc.name AS subcategory_name
             FROM contact c
             INNER JOIN user u ON u.id = c.request_by
             LEFT JOIN subcategory sc ON sc.id = u.subcategory
             LEFT JOIN category cat ON cat.id = COALESCE(sc.category_id, u.category)
             WHERE c.request_to IN (SELECT id FROM user WHERE id = ? OR created_by = ?)
           )
         ) p
         WHERE p.id <> ?
           AND COALESCE(p.effective_category_id, p.category) IN (1, 2, 4, 5)
         ORDER BY COALESCE(NULLIF(TRIM(p.business), ''), p.name) ASC, p.id ASC`,
        [userId, userId, userId, userId, userId]
      );
      return res.json(rows);
    } catch (err) {
      logger.error("Error fetching subcontractors", err);
      return res.status(500).json({ message: "Failed to fetch subcontractors" });
    } finally {
      if (connection) connection.release();
    }
  }
);

// The VIEWING account's own company name — for the pinned "In House" budget
// option. Resolves the account OWNER (so an employee sees the owner's company,
// not their own blank business), then returns that owner's business name.
router.get(
  "/company-name",
  auth.authenticateToken,
  requireJobBudgetFeature,
  async (req, res) => {
    let connection;
    try {
      const userId = (req.user && req.user.id) ? req.user.id : res.locals.id;
      connection = await pool.getConnection();
      const ownerId = await resolveBillingUserId(connection, userId);
      const [rows] = await connection.query(
        "SELECT business, organization_name, name FROM user WHERE id = ? LIMIT 1",
        [ownerId]
      );
      const r = rows && rows[0] ? rows[0] : {};
      const companyName = String(r.business || r.organization_name || r.name || "").trim();
      return res.json({ company_name: companyName });
    } catch (err) {
      logger.error("Error fetching company name", err);
      return res.status(500).json({ message: "Failed to fetch company name" });
    } finally {
      if (connection) connection.release();
    }
  }
);

router.get(
  "/lineitems/:itemId/pay-history",
  auth.authenticateToken,
  requireJobBudgetFeature,
  async (req, res) => {
    const itemId = Number(req.params.itemId);

    if (!itemId) {
      return res.status(400).json({ message: "Invalid line item id" });
    }

    let connection;
    try {
      connection = await pool.getConnection();
      try {
        const [rows] = await connection.query(
          `SELECT h.id, h.lineitem_id, h.percent_applied, h.amount_total,
                  h.paid_before, h.remaining_before, h.amount_applied,
                  h.paid_after, h.remaining_after, h.check_number, h.changed_at,
                  u.name AS changed_by_name
           FROM division_lineitem_pay_history h
           LEFT JOIN user u ON u.id = h.changed_by
           WHERE h.lineitem_id = ?
           ORDER BY h.changed_at DESC, h.id DESC`,
          [itemId]
        );
        return res.json(rows || []);
      } catch (e) {
        // Older DBs may not have the check_number column
        if (e && e.code === 'ER_BAD_FIELD_ERROR') {
          const [rows] = await connection.query(
            `SELECT h.id, h.lineitem_id, h.percent_applied, h.amount_total,
                    h.paid_before, h.remaining_before, h.amount_applied,
                    h.paid_after, h.remaining_after, h.changed_at,
                    u.name AS changed_by_name
             FROM division_lineitem_pay_history h
             LEFT JOIN user u ON u.id = h.changed_by
             WHERE h.lineitem_id = ?
             ORDER BY h.changed_at DESC, h.id DESC`,
            [itemId]
          );
          return res.json(rows || []);
        }
        throw e;
      }
    } catch (err) {
      if (err && err.code === 'ER_NO_SUCH_TABLE') {
        return res.json([]);
      }
      logger.error("Error fetching pay history", err);
      return res.status(500).json({ message: "Failed to fetch pay history" });
    } finally {
      if (connection) connection.release();
    }
  }
);

// GET /divisions - list all budget divisions
router.get("/divisions", auth.authenticateToken, requireJobBudgetFeature, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT id, division_number, name, description
       FROM divisions
       ORDER BY division_number ASC`
    );
    res.json(rows);
  } catch (err) {
    logger.error("Error fetching divisions", err);
    res.status(500).json({ message: "Failed to fetch divisions" });
  } finally {
    if (connection) connection.release();
  }
});

// GET /lineitems - fetch all division lineitems for a job or lead
router.get("/lineitems", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, async (req, res) => {
  const { job_id, job_type } = req.query;

  if (!job_id) {
    return res.status(400).json({ message: "job_id is required" });
  }

  const ownerType = ownerTypeOf(job_type);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);
    await ensureSubCostColumn(connection);
    await ensureInHouseColumn(connection);
    await ensureAllowanceColumn(connection);
    await ensureBudgetTbdColumns(connection);
    await ensureBudgetPercentColumns(connection);
    const [rows] = await connection.query(
      `SELECT id, division_id, lineitem_description, amount, sub_cost, csi_number, job_id,
              subcontractor_id, in_house, is_allowance, is_tbd, tbd_note,
              foreman_percent, paid_amount,
              contingency, overhead_percent, profit_percent, gl_percent
       FROM division_lineitems
       WHERE job_id = ? AND owner_type = ?
       ORDER BY division_id ASC, id ASC`,
      [Number(job_id), ownerType]
    );
    // Each row carries the SERVER's answer about whether it is settled, so the
    // page renders that rather than re-deriving the rule and drifting from the
    // gate that actually decides whether the budget can be locked.
    return res.json(withFlags(rows));
  } catch (err) {
    logger.error("Error fetching all lineitems", err);
    return res.status(500).json({ message: "Failed to fetch lineitems" });
  } finally {
    if (connection) connection.release();
  }
});

/* GET /export — the budget as a styled .xlsx workbook.
 *
 * WHO CAN EXPORT. This file contains your costs, what you pay each sub, and
 * cheque numbers, so it is gated by COMPOSING THE GATES THAT ALREADY DECIDE WHO
 * MAY SEE THAT DATA rather than by writing a fresh rule:
 *
 *   router-level  authenticateToken + requirePlan("platinum")
 *                 + requireJobIdOwnership — the job must belong to the caller's
 *                   account, enforced across every budget route
 *   blockExpiredOwnRecord     an expired trial cannot pull its own financials
 *   requireJobBudgetFeature   = denyRestrictedJobData + requirePlanFeatures
 *   requireAccountOwner       payments are owner-only, and this workbook is
 *                               mostly payments
 *
 * WHICH GATE ACTUALLY REFUSES WHOM — measured, not assumed (see
 * test/budgetExport.test.js, which prints each refusal):
 *
 *   subcontractor / client  requireJobIdOwnership — "This job does not belong to
 *                           your account." ownsOwnerRecord resolves them to
 *                           THEMSELVES (resolveOwnerId promotes employees only),
 *                           so the owner's job is never theirs.
 *                           denyRestrictedJobData inside requireJobBudgetFeature
 *                           is the second layer behind it.
 *   employee                requireAccountOwner — it is the ONLY gate they
 *                           reach and fail, which makes it the one the test
 *                           pins directly.
 *
 * The refusal is a 403 with NO FILE, never a workbook with the cost columns
 * blanked: a blanked file still tells you how many lines there are, who the subs
 * are, and what the divisions cost to within a guess.
 *
 * There is deliberately NO client-facing variant and no `?for=client` flag. If a
 * client export is wanted it is a SEPARATE builder with the cost columns absent,
 * because a flag that removes columns is one wrong default away from sending a
 * client your margins.
 */
router.get(
  "/export",
  auth.authenticateToken,
  // No per-route ownership guard: `router.use(requireJobIdOwnership)` above
  // already resolves job_id back to its true owner and refuses a foreign job on
  // EVERY budget route. Adding requireOwnsJob here as well was a second copy of
  // the same rule — removed, and the test proves the router-level one still
  // refuses a subcontractor and a client by printing the message it returns.
  blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type),
  requireJobBudgetFeature,
  requireAccountOwner,
  async (req, res) => {
    const { job_id, job_type } = req.query;
    if (!job_id) return res.status(400).json({ message: "job_id is required" });

    const ownerType = ownerTypeOf(job_type);
    let connection;
    try {
      connection = await pool.getConnection();
      // The same schema guards the page's own reads run, so an account that has
      // never opened Budget can still export without a missing-column 500.
      await ensureOwnerTypeColumns(connection);
      await ensureSubCostColumn(connection);
      await ensureInHouseColumn(connection);
      await ensureAllowanceColumn(connection);
      await ensureBudgetTbdColumns(connection);
      await ensureBudgetPercentColumns(connection);
      await ensurePaymentsTables(connection);

      const data = await fetchBudgetExportData(connection, {
        jobId: Number(job_id),
        ownerType,
        requestedByUserId: req.user && req.user.id,
      });

      const { workbook } = buildBudgetWorkbook(data);
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const filename = budgetExportFilename(data.job && data.job.name, ymd);

      // RFC 5987 alongside a plain ASCII fallback: a job name with an accent or
      // an em dash breaks a bare filename= in older clients.
      const asciiName = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      await workbook.xlsx.write(res);
      return res.end();
    } catch (err) {
      logger.error("Error exporting budget workbook", err);
      // Nothing has been written yet on the error paths above, so a JSON error
      // is still valid here; once xlsx.write() has begun the response is binary
      // and headersSent guards against corrupting it with JSON.
      if (res.headersSent) return res.end();
      return res.status(500).json({ message: "Failed to export budget" });
    } finally {
      if (connection) connection.release();
    }
  },
);

// POST /contingency - update contingency percentage for all lineitems of a job
router.post("/contingency", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && r.body.job_id, (r) => r.body && r.body.job_type), requireJobBudgetFeature, async (req, res) => {
  const body = req.body || {};
  const { job_id, job_type } = body;

  if (!job_id) {
    return res.status(400).json({ message: "job_id is required" });
  }

  // Build the SET for whichever of the three summary-card percentages were sent
  // (backward compatible — older callers send only `contingency`). Each stored
  // on every line item of the job, mirroring the original contingency design.
  const cols = { contingency: 'contingency', overhead_percent: 'overhead_percent', profit_percent: 'profit_percent', gl_percent: 'gl_percent' };
  const setParts = [];
  const setVals = [];
  const applied = {};
  for (const [field, col] of Object.entries(cols)) {
    if (body[field] !== undefined) {
      let v = Number(body[field]);
      if (isNaN(v) || v < 0) v = 0;
      setParts.push(`${col} = ?`);
      setVals.push(v);
      applied[field] = v;
    }
  }
  if (!setParts.length) {
    return res.status(400).json({ message: "No percentage provided" });
  }

  const ownerType = ownerTypeOf(job_type);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);
    await ensureBudgetPercentColumns(connection);
    if (await isBudgetLocked(connection, job_id, ownerType)) {
      return res.status(423).json({ message: "Budget is locked. Unlock it or make the change through a signed Change Order.", locked: true });
    }
    const [result] = await connection.query(
      `UPDATE division_lineitems SET ${setParts.join(', ')} WHERE job_id = ? AND owner_type = ?`,
      [...setVals, job_id, ownerType]
    );

    return res.json({
      message: "Budget percentages updated",
      affectedRows: result.affectedRows || 0,
      ...applied,
    });
  } catch (err) {
    logger.error("Error updating budget percentages", err);
    return res.status(500).json({ message: "Failed to update budget percentages" });
  } finally {
    if (connection) connection.release();
  }
});

// GET /divisions/:divisionId/lineitems
// SECURITY: job_id is now REQUIRED + ownership-checked. Without it this returned
// every account's line items for the division (financial cross-account leak).
router.get("/divisions/:divisionId/lineitems", auth.authenticateToken, requireOwnsJob({ idFrom: "query", idKey: "job_id", typeFrom: "query", typeKey: "job_type" }), blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, async (req, res) => {
  const { divisionId } = req.params;
  const { job_id, job_type } = req.query;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);
    await ensureSubCostColumn(connection);
    await ensureInHouseColumn(connection);
    await ensureAllowanceColumn(connection);
    await ensureBudgetPercentColumns(connection);
    const params = [];
    let sql = `SELECT id, division_id, lineitem_description, amount, sub_cost, csi_number, job_id, contingency,
                     overhead_percent, profit_percent, gl_percent, subcontractor_id, in_house, is_allowance, foreman_percent, paid_amount
               FROM division_lineitems
               WHERE division_id = ?`;
    params.push(divisionId);
    if (job_id) {
      sql += ` AND job_id = ? AND owner_type = ?`;
      params.push(job_id, ownerTypeOf(job_type));
    }
    sql += ` ORDER BY id ASC`;
    const [rows] = await connection.query(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error("Error fetching lineitems", err);
    res.status(500).json({ message: "Failed to fetch lineitems" });
  } finally {
    if (connection) connection.release();
  }
});

// GET /divisions/:divisionId/suggested-items — the static suggested-items
// catalog for a division, filtered by project type. Powers the "Suggested
// items for Division N" chips. ?job_type=residential -> R + B; commercial ->
// C + B; anything else (or omitted) -> all. The FE subtracts items already on
// the budget to compute the "N remaining" count.
router.get("/divisions/:divisionId/suggested-items", auth.authenticateToken, requireJobBudgetFeature, async (req, res) => {
  const divisionId = Number(req.params.divisionId);
  const jt = String(req.query.job_type || "").toLowerCase();
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureSuggestedItemsTable(connection);
    const params = [divisionId];
    let sql = `SELECT id, division_id, code, name, applicability, sort_order
               FROM suggested_items WHERE division_id = ?`;
    if (jt === "residential") { sql += ` AND applicability IN ('R','B')`; }
    else if (jt === "commercial") { sql += ` AND applicability IN ('C','B')`; }
    sql += ` ORDER BY sort_order ASC, code ASC`;
    const [rows] = await connection.query(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error("Error fetching suggested items", err);
    res.status(500).json({ message: "Failed to fetch suggested items" });
  } finally {
    if (connection) connection.release();
  }
});

// GET /admin/seed-suggested-items — owner-only: (re)seed the suggested_items
// reference library from data/suggestedItems.js (idempotent upsert). Used to
// apply list edits after the initial auto-seed on table creation.
router.get("/admin/seed-suggested-items", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [urows] = await connection.query("SELECT email FROM `user` WHERE id = ? LIMIT 1", [req.user.id]);
    const email = String((urows && urows[0] && urows[0].email) || "").toLowerCase();
    if (!OWNER_EXEMPT_EMAILS.has(email)) {
      return res.status(403).json({ code: "FORBIDDEN", message: "Owner only." });
    }
    await ensureSuggestedItemsTable(connection);
    const count = await seedSuggestedItems(connection);
    const [[{ total }]] = await connection.query("SELECT COUNT(*) AS total FROM suggested_items");
    return res.json({ success: true, seeded: count, total });
  } catch (err) {
    logger.error("Error seeding suggested items", err);
    return res.status(500).json({ message: "Failed to seed suggested items" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /divisions/:divisionId/lineitems
router.post("/divisions/:divisionId/lineitems", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && (r.body.job_id != null ? r.body.job_id : (r.body.items && r.body.items[0] && r.body.items[0].job_id)), (r) => r.body && r.body.job_type), requireJobBudgetFeature, async (req, res) => {
  const { divisionId } = req.params;
  const created_by = res.locals.id;
  let { job_id, job_type, items } = req.body || {};

  try {
    // Normalize to array if a single item is sent
    if (!Array.isArray(items) && req.body && !req.body.items) {
      items = [req.body];
      job_id = req.body.job_id ?? job_id;
      job_type = req.body.job_type ?? job_type;
    }

    if (!job_id) {
      return res.status(400).json({ message: "job_id (lead id) is required" });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items array is required" });
    }

    /*
     * TWENTY CHARACTERS, REJECTED NOT TRUNCATED, and checked BEFORE any
     * database work. The column is VARCHAR(20) and the input is capped, but
     * neither is the rule — this is, because this is what a caller hits when
     * they bypass the page. Silently shortening someone's words is worse
     * than refusing them.
     */
    for (const it of items) {
      const noteErr = tbdNoteError(it && it.tbd_note);
      if (noteErr) {
        return res.status(400).json({
          success: false,
          code: "TBD_NOTE_TOO_LONG",
          max: TBD_NOTE_MAX,
          message: noteErr,
        });
      }
    }

    // Basic payload validation
    for (const it of items) {
      if (it == null || typeof it !== 'object') {
        return res.status(400).json({ message: "Each item must be an object" });
      }
    }

    const ownerType = ownerTypeOf(job_type);
    const connection = await pool.getConnection();
    try {
      await ensureOwnerTypeColumns(connection);
      await ensureSubCostColumn(connection);
      await ensureInHouseColumn(connection);
      await ensureAllowanceColumn(connection);
      await ensureBudgetPercentColumns(connection);
      if (await isBudgetLocked(connection, job_id, ownerType)) {
        // The inner finally releases the connection.
        return res.status(423).json({ message: "Budget is locked. Unlock it or make the change through a signed Change Order.", locked: true });
      }
      await connection.beginTransaction();

      const insertedItems = [];
      for (const it of items) {
        const normalized = {
          id: it.id ? Number(it.id) : null,
          csi_number: it.csi_number ?? null,
          lineitem_description: it.lineitem_description ?? null,
          /*
           * BLANK STAYS BLANK. An empty input arrives as '' and must be stored
           * as NULL, not as '' and certainly not as 0 — a cell containing 0 is
           * ANSWERED (a line can genuinely cost nothing) and only empty is
           * missing. `?? null` alone does not do this: it passes '' straight
           * through, and MySQL then coerces '' to 0.00 in a DECIMAL column,
           * which would silently answer every blank cell and defeat the entire
           * flag rule from three layers down.
           */
          amount: blankToNull(it.amount),
          sub_cost: blankToNull(it.sub_cost),
          contingency: it.contingency ?? null,
          in_house: it.in_house ? 1 : 0,
          // Allowance flag — explicit per-line checkbox, never inferred.
          is_allowance: it.is_allowance ? 1 : 0,
          // TBD — the manual half of "not settled", independent of any cell.
          is_tbd: it.is_tbd ? 1 : 0,
          tbd_note: it.is_tbd ? (blankToNull(it.tbd_note)) : null,
          overhead_percent: it.overhead_percent ?? 0,
          // NULL preserved for a legacy (never-split) budget; an explicit number
          // (including 0) once the owner sets Profit %.
          profit_percent: (it.profit_percent === undefined || it.profit_percent === null || it.profit_percent === '') ? null : Number(it.profit_percent),
          gl_percent: it.gl_percent ?? 0,
          // in-house and a subcontractor are mutually exclusive
          subcontractor_id: it.in_house ? null : (it.subcontractor_id ?? null),
          foreman_percent: it.foreman_percent ?? 0,
          paid_amount: it.paid_amount ?? 0,
          _pay_percent_applied: it.pay_percent_applied ?? null,
          _pay_check_number: it.check_number ?? null,
        };

        if (normalized.id) {
          const [prevRows] = await connection.query(
            `SELECT foreman_percent, amount, paid_amount FROM division_lineitems
             WHERE id = ? AND division_id = ? AND job_id = ? AND owner_type = ?
             LIMIT 1`,
            [normalized.id, Number(divisionId), Number(job_id), ownerType]
          );
          const prevForeman = prevRows && prevRows.length ? Number(prevRows[0].foreman_percent) : null;
          const prevAmount = prevRows && prevRows.length ? Number(prevRows[0].amount) : null;
          const prevPaid = prevRows && prevRows.length ? Number(prevRows[0].paid_amount) : null;

          const updateSql = `UPDATE division_lineitems
            SET csi_number = ?, lineitem_description = ?, amount = ?, sub_cost = ?, contingency = ?,
                overhead_percent = ?, profit_percent = ?, gl_percent = ?,
                subcontractor_id = ?, in_house = ?, is_allowance = ?, is_tbd = ?, tbd_note = ?, foreman_percent = ?, paid_amount = ?
            WHERE id = ? AND division_id = ? AND job_id = ? AND owner_type = ?`;

          const updateValues = [
            normalized.csi_number,
            normalized.lineitem_description,
            normalized.amount,
            normalized.sub_cost,
            normalized.contingency,
            normalized.overhead_percent,
            normalized.profit_percent,
            normalized.gl_percent,
            normalized.subcontractor_id,
            normalized.in_house,
            normalized.is_allowance,
            normalized.is_tbd,
            normalized.tbd_note,
            normalized.foreman_percent,
            normalized.paid_amount,
            normalized.id,
            Number(divisionId),
            Number(job_id),
            ownerType,
          ];

          await connection.query(updateSql, updateValues);

          const nextPaid = Number(normalized.paid_amount);
          if (
            prevAmount !== null &&
            prevPaid !== null &&
            !isNaN(prevAmount) &&
            !isNaN(prevPaid) &&
            !isNaN(nextPaid) &&
            nextPaid > prevPaid &&
            normalized._pay_percent_applied !== null &&
            normalized._pay_percent_applied !== undefined
          ) {
            const amountTotal = prevAmount;
            const paidBefore = prevPaid;
            const remainingBefore = Math.max(0, amountTotal - paidBefore);
            const amountApplied = Math.max(0, nextPaid - paidBefore);
            const paidAfter = nextPaid;
            const remainingAfter = Math.max(0, amountTotal - paidAfter);
            const pctApplied = Number(normalized._pay_percent_applied);
            const checkNumber =
              normalized._pay_check_number !== null &&
              normalized._pay_check_number !== undefined
                ? String(normalized._pay_check_number).trim()
                : null;
            try {
              try {
                await connection.query(
                  `INSERT INTO division_lineitem_pay_history
                    (lineitem_id, percent_applied, amount_total,
                     paid_before, remaining_before, amount_applied,
                     paid_after, remaining_after,
                     check_number,
                     changed_by, changed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                  [
                    normalized.id,
                    isNaN(pctApplied) ? 0 : pctApplied,
                    amountTotal,
                    paidBefore,
                    remainingBefore,
                    amountApplied,
                    paidAfter,
                    remainingAfter,
                    checkNumber,
                    created_by ?? null,
                  ]
                );
              } catch (e2) {
                if (e2 && e2.code === 'ER_BAD_FIELD_ERROR') {
                  await connection.query(
                    `INSERT INTO division_lineitem_pay_history
                      (lineitem_id, percent_applied, amount_total,
                       paid_before, remaining_before, amount_applied,
                       paid_after, remaining_after,
                       changed_by, changed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [
                      normalized.id,
                      isNaN(pctApplied) ? 0 : pctApplied,
                      amountTotal,
                      paidBefore,
                      remainingBefore,
                      amountApplied,
                      paidAfter,
                      remainingAfter,
                      created_by ?? null,
                    ]
                  );
                } else {
                  throw e2;
                }
              }
            } catch (e) {
              if (!(e && e.code === 'ER_NO_SUCH_TABLE')) {
                throw e;
              }
            }
          }

          const nextForeman = Number(normalized.foreman_percent);
          if (
            prevForeman !== null &&
            !isNaN(prevForeman) &&
            !isNaN(nextForeman) &&
            prevForeman !== nextForeman
          ) {
            try {
              await connection.query(
                `INSERT INTO division_lineitem_foreman_history
                  (lineitem_id, old_percent, new_percent, changed_by, changed_at)
                 VALUES (?, ?, ?, ?, NOW())`,
                [normalized.id, prevForeman, nextForeman, created_by ?? null]
              );
            } catch (e) {
              if (!(e && e.code === 'ER_NO_SUCH_TABLE')) {
                throw e;
              }
            }
          }

          insertedItems.push({
            id: normalized.id,
            ...it,
          });
        } else {
          const insertSql = `INSERT INTO division_lineitems
            (division_id, job_id, owner_type, csi_number, lineitem_description, amount, sub_cost, contingency,
             overhead_percent, profit_percent, gl_percent,
             subcontractor_id, in_house, is_allowance, is_tbd, tbd_note, foreman_percent, paid_amount,
             created_at, created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)`;

          const insertValues = [
            Number(divisionId),
            Number(job_id),
            ownerType,
            normalized.csi_number,
            normalized.lineitem_description,
            normalized.amount,
            normalized.sub_cost,
            normalized.contingency,
            normalized.overhead_percent,
            normalized.profit_percent,
            normalized.gl_percent,
            normalized.subcontractor_id,
            normalized.in_house,
            normalized.is_allowance,
            normalized.is_tbd,
            normalized.tbd_note,
            normalized.foreman_percent,
            normalized.paid_amount,
            created_by ?? null,
          ];

          const [result] = await connection.query(insertSql, insertValues);
          insertedItems.push({
            id: result.insertId,
            ...it,
          });
        }
      }

      await connection.commit();

      return res.status(201).json({
        message: "Line items created",
        affectedRows: insertedItems.length,
        insertId: insertedItems[0]?.id || null,
        items: insertedItems
      });
    } catch (err) {
      await connection.rollback();
      logger.error("Error creating line items", err);
      return res.status(500).json({ message: "Failed to create line items" });
    } finally {
      connection.release();
    }
  } catch (err) {
    logger.error("Unexpected error creating line items", err);
    return res.status(500).json({ message: "Unexpected error" });
  }
});

router.get(
  "/lineitems/:itemId/foreman-history",
  auth.authenticateToken,
  requireJobBudgetFeature,
  async (req, res) => {
    const itemId = Number(req.params.itemId);

    if (!itemId) {
      return res.status(400).json({ message: "Invalid line item id" });
    }

    let connection;
    try {
      connection = await pool.getConnection();
      const [rows] = await connection.query(
        `SELECT h.id, h.lineitem_id, h.old_percent, h.new_percent, h.changed_at,
                u.name AS changed_by_name
         FROM division_lineitem_foreman_history h
         LEFT JOIN user u ON u.id = h.changed_by
         WHERE h.lineitem_id = ?
         ORDER BY h.changed_at DESC, h.id DESC`,
        [itemId]
      );
      return res.json(rows || []);
    } catch (err) {
      if (err && err.code === 'ER_NO_SUCH_TABLE') {
        return res.json([]);
      }
      logger.error("Error fetching foreman history", err);
      return res.status(500).json({ message: "Failed to fetch foreman history" });
    } finally {
      if (connection) connection.release();
    }
  }
);

// DELETE /divisions/:divisionId/lineitems/:itemId
// ---- Sub-contractor payments against a line item's sub_cost ----
// Owner-only (requireAccountOwner) — INTERIM until the Employee Level system.
// A payment ADJUSTS the line item's paid_amount (the "Paid to date" total); any
// pre-existing paid_amount is preserved as an opening balance. Every mutation is
// logged to division_lineitem_payment_audit.

const paymentAmountAllowed = (v) => { const n = Number(v); return !isNaN(n) && n > 0; };

async function adjustPaidAmount(connection, itemId, ownerType, delta) {
  await connection.query(
    `UPDATE division_lineitems
       SET paid_amount = GREATEST(0, COALESCE(paid_amount, 0) + ?)
     WHERE id = ? AND owner_type = ?`,
    [delta, Number(itemId), ownerType]
  );
  const [rows] = await connection.query(
    `SELECT paid_amount FROM division_lineitems WHERE id = ? AND owner_type = ? LIMIT 1`,
    [Number(itemId), ownerType]
  );
  return rows.length ? Number(rows[0].paid_amount) : null;
}

// GET payments for a line item
router.get("/lineitems/:itemId/payments", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!itemId) return res.status(400).json({ message: "Invalid line item id" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensurePaymentsTables(connection);
    const [rows] = await connection.query(
      `SELECT p.id, p.lineitem_id, p.method, p.check_number, p.payment_date, p.amount,
              p.created_at, p.created_by, p.updated_at, p.updated_by,
              u.name AS created_by_name
         FROM division_lineitem_payments p
         LEFT JOIN user u ON u.id = p.created_by
        WHERE p.lineitem_id = ?
        ORDER BY p.payment_date ASC, p.id ASC`,
      [itemId]
    );
    return res.json(rows || []);
  } catch (err) {
    logger.error("Error fetching payments", err);
    return res.status(500).json({ message: "Failed to fetch payments" });
  } finally {
    if (connection) connection.release();
  }
});

// GET the payment audit trail for a line item (owner-only). Rows persist even
// after their payment is deleted, so this is the durable "who changed what,
// when" record for create/edit/delete of subcontractor payments.
router.get("/lineitems/:itemId/payment-audit", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!itemId) return res.status(400).json({ message: "Invalid line item id" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensurePaymentsTables(connection);
    const [rows] = await connection.query(
      `SELECT a.id, a.payment_id, a.lineitem_id, a.action, a.old_value, a.new_value,
              a.changed_by, a.changed_at, u.name AS changed_by_name
         FROM division_lineitem_payment_audit a
         LEFT JOIN user u ON u.id = a.changed_by
        WHERE a.lineitem_id = ?
        ORDER BY a.changed_at ASC, a.id ASC`,
      [itemId]
    );
    return res.json(rows || []);
  } catch (err) {
    logger.error("Error fetching payment audit", err);
    return res.status(500).json({ message: "Failed to fetch payment audit" });
  } finally {
    if (connection) connection.release();
  }
});

// POST record a payment
router.post("/lineitems/:itemId/payments", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && r.body.job_id, (r) => r.body && r.body.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const changedBy = res.locals.id;
  const { job_type, method, check_number, payment_date, amount } = req.body || {};
  if (!itemId) return res.status(400).json({ message: "Invalid line item id" });
  if (!PAYMENT_METHODS.has(String(method))) return res.status(400).json({ message: "Invalid payment method" });
  if (!paymentAmountAllowed(amount)) return res.status(400).json({ message: "Amount must be greater than 0" });
  if (!payment_date) return res.status(400).json({ message: "Payment date is required" });
  const ownerType = ownerTypeOf(job_type);
  const checkNo = String(method) === "check" ? (check_number ? String(check_number).trim() : null) : null;

  let connection;
  try {
    connection = await pool.getConnection();
    await ensurePaymentsTables(connection);
    await ensureSubCostColumn(connection);
    await connection.beginTransaction();
    const [ins] = await connection.query(
      `INSERT INTO division_lineitem_payments
         (lineitem_id, method, check_number, payment_date, amount, created_by, created_at)
       VALUES (?,?,?,?,?,?,NOW())`,
      [itemId, String(method), checkNo, payment_date, Number(amount), changedBy ?? null]
    );
    const paidAmount = await adjustPaidAmount(connection, itemId, ownerType, Number(amount));
    const newVal = JSON.stringify({ method: String(method), check_number: checkNo, payment_date, amount: Number(amount) });
    await connection.query(
      `INSERT INTO division_lineitem_payment_audit
         (payment_id, lineitem_id, action, old_value, new_value, changed_by, changed_at)
       VALUES (?,?, 'create', NULL, ?, ?, NOW())`,
      [ins.insertId, itemId, newVal, changedBy ?? null]
    );
    await connection.commit();
    return res.status(201).json({ id: ins.insertId, paid_amount: paidAmount });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error recording payment", err);
    return res.status(500).json({ message: "Failed to record payment" });
  } finally {
    if (connection) connection.release();
  }
});

// PUT edit a payment
router.put("/lineitems/:itemId/payments/:paymentId", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && r.body.job_id, (r) => r.body && r.body.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const paymentId = Number(req.params.paymentId);
  const changedBy = res.locals.id;
  const { job_type, method, check_number, payment_date, amount } = req.body || {};
  if (!itemId || !paymentId) return res.status(400).json({ message: "Invalid ids" });
  if (!PAYMENT_METHODS.has(String(method))) return res.status(400).json({ message: "Invalid payment method" });
  if (!paymentAmountAllowed(amount)) return res.status(400).json({ message: "Amount must be greater than 0" });
  if (!payment_date) return res.status(400).json({ message: "Payment date is required" });
  const ownerType = ownerTypeOf(job_type);
  const checkNo = String(method) === "check" ? (check_number ? String(check_number).trim() : null) : null;

  let connection;
  try {
    connection = await pool.getConnection();
    await ensurePaymentsTables(connection);
    await ensureSubCostColumn(connection);
    await connection.beginTransaction();
    const [prev] = await connection.query(
      `SELECT method, check_number, payment_date, amount FROM division_lineitem_payments
        WHERE id = ? AND lineitem_id = ? LIMIT 1`,
      [paymentId, itemId]
    );
    if (!prev.length) { await connection.rollback(); return res.status(404).json({ message: "Payment not found" }); }
    const oldAmount = Number(prev[0].amount);
    await connection.query(
      `UPDATE division_lineitem_payments
          SET method = ?, check_number = ?, payment_date = ?, amount = ?, updated_by = ?, updated_at = NOW()
        WHERE id = ? AND lineitem_id = ?`,
      [String(method), checkNo, payment_date, Number(amount), changedBy ?? null, paymentId, itemId]
    );
    const paidAmount = await adjustPaidAmount(connection, itemId, ownerType, Number(amount) - oldAmount);
    await connection.query(
      `INSERT INTO division_lineitem_payment_audit
         (payment_id, lineitem_id, action, old_value, new_value, changed_by, changed_at)
       VALUES (?,?, 'edit', ?, ?, ?, NOW())`,
      [paymentId, itemId,
        JSON.stringify({ method: prev[0].method, check_number: prev[0].check_number, payment_date: prev[0].payment_date, amount: oldAmount }),
        JSON.stringify({ method: String(method), check_number: checkNo, payment_date, amount: Number(amount) }),
        changedBy ?? null]
    );
    await connection.commit();
    return res.json({ id: paymentId, paid_amount: paidAmount });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error editing payment", err);
    return res.status(500).json({ message: "Failed to edit payment" });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE a payment
router.delete("/lineitems/:itemId/payments/:paymentId", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const paymentId = Number(req.params.paymentId);
  const changedBy = res.locals.id;
  const ownerType = ownerTypeOf(req.query.job_type);
  if (!itemId || !paymentId) return res.status(400).json({ message: "Invalid ids" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensurePaymentsTables(connection);
    await ensureSubCostColumn(connection);
    await connection.beginTransaction();
    const [prev] = await connection.query(
      `SELECT method, check_number, payment_date, amount FROM division_lineitem_payments
        WHERE id = ? AND lineitem_id = ? LIMIT 1`,
      [paymentId, itemId]
    );
    if (!prev.length) { await connection.rollback(); return res.status(404).json({ message: "Payment not found" }); }
    const oldAmount = Number(prev[0].amount);
    await connection.query(`DELETE FROM division_lineitem_payments WHERE id = ? AND lineitem_id = ?`, [paymentId, itemId]);
    const paidAmount = await adjustPaidAmount(connection, itemId, ownerType, -oldAmount);
    await connection.query(
      `INSERT INTO division_lineitem_payment_audit
         (payment_id, lineitem_id, action, old_value, new_value, changed_by, changed_at)
       VALUES (?,?, 'delete', ?, NULL, ?, NOW())`,
      [paymentId, itemId,
        JSON.stringify({ method: prev[0].method, check_number: prev[0].check_number, payment_date: prev[0].payment_date, amount: oldAmount }),
        changedBy ?? null]
    );
    await connection.commit();
    return res.json({ id: paymentId, paid_amount: paidAmount });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error deleting payment", err);
    return res.status(500).json({ message: "Failed to delete payment" });
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/divisions/:divisionId/lineitems/:itemId", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, async (req, res) => {
  const { divisionId, itemId } = req.params;
  const { job_id, job_type } = req.query;

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);

    if (job_id && await isBudgetLocked(connection, Number(job_id), ownerTypeOf(job_type))) {
      return res.status(423).json({ message: "Budget is locked. Unlock it or make the change through a signed Change Order.", locked: true });
    }

    await connection.beginTransaction();

    try {
      await connection.query(
        `DELETE FROM division_lineitem_pay_history WHERE lineitem_id = ?`,
        [Number(itemId)]
      );
    } catch (e) {
      if (!(e && e.code === 'ER_NO_SUCH_TABLE')) {
        throw e;
      }
    }

    // Sub-contractor payments recorded against this line item (+ their audit).
    for (const tbl of ['division_lineitem_payments', 'division_lineitem_payment_audit']) {
      try {
        await connection.query(`DELETE FROM ${tbl} WHERE lineitem_id = ?`, [Number(itemId)]);
      } catch (e) {
        if (!(e && e.code === 'ER_NO_SUCH_TABLE')) {
          throw e;
        }
      }
    }

    try {
      await connection.query(
        `DELETE FROM division_lineitem_foreman_history WHERE lineitem_id = ?`,
        [Number(itemId)]
      );
    } catch (e) {
      if (!(e && e.code === 'ER_NO_SUCH_TABLE')) {
        throw e;
      }
    }

    const params = [Number(divisionId), Number(itemId)];
    let sql = `DELETE FROM division_lineitems
               WHERE division_id = ? AND id = ?`;

    if (job_id) {
      sql += ` AND job_id = ? AND owner_type = ?`;
      params.push(Number(job_id), ownerTypeOf(job_type));
    }

    const [result] = await connection.query(sql, params);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Line item not found" });
    }

    await connection.commit();

    return res.json({ message: "Line item deleted" });
  } catch (err) {
    try {
      if (connection) await connection.rollback();
    } catch (_) {}
    logger.error("Error deleting line item", err);
    return res.status(500).json({ message: "Failed to delete line item" });
  } finally {
    if (connection) connection.release();
  }
});

// ---- Change orders → Budget (signed, job-linked COs feed the Budget tab) ----

// Recompute a change order's Budget Paid-to-date after a payment op (mirrors
// adjustPaidAmount for line items).
async function adjustCoPaidAmount(connection, coId, delta) {
  await connection.query(
    `UPDATE change_orders
       SET budget_paid_amount = GREATEST(0, COALESCE(budget_paid_amount, 0) + ?)
     WHERE id = ?`,
    [delta, Number(coId)]
  );
  const [rows] = await connection.query(
    `SELECT budget_paid_amount FROM change_orders WHERE id = ? LIMIT 1`,
    [Number(coId)]
  );
  return rows.length ? Number(rows[0].budget_paid_amount) : null;
}

// GET the company's jobs for the Quote Manager job picker (id + name + number),
// resolved to the account owner so employees see the owner's jobs too.
router.get("/jobs", auth.authenticateToken, async (req, res) => {
  const userId = res.locals.id;
  let connection;
  try {
    connection = await pool.getConnection();
    const ownerId = await resolveBillingUserId(connection, userId);
    const [rows] = await connection.query(
      `SELECT id, name, job_number
         FROM job
        WHERE status = 1
          AND (created_by = ? OR created_by IN (SELECT id FROM \`user\` WHERE created_by = ?))
        ORDER BY job_number ASC, id ASC`,
      [ownerId, ownerId]
    );
    return res.json(rows || []);
  } catch (err) {
    logger.error("Error fetching jobs for picker", err);
    return res.status(500).json({ message: "Failed to fetch jobs" });
  } finally {
    if (connection) connection.release();
  }
});

// GET signed, job-linked change orders for a job's Budget tab. Draft/Sent/
// job-less COs are excluded (only status SIGNED with this job_id).
router.get("/change-orders", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, async (req, res) => {
  const { job_id } = req.query;
  if (!job_id) return res.status(400).json({ message: "job_id is required" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureChangeOrderBudgetColumns(connection);
    const [rows] = await connection.query(
      `SELECT id, change_order_number, client_name, grand_total_amount,
              budget_sub_cost, budget_paid_amount
         FROM change_orders
        WHERE job_id = ? AND UPPER(status) = 'SIGNED'
        ORDER BY id ASC`,
      [Number(job_id)]
    );
    return res.json((rows || []).map((r) => ({
      id: r.id,
      change_order_number: r.change_order_number,
      client_name: r.client_name,
      base_amount: Number(r.grand_total_amount) || 0,
      sub_cost: r.budget_sub_cost != null ? Number(r.budget_sub_cost) : null,
      paid_amount: Number(r.budget_paid_amount) || 0,
    })));
  } catch (err) {
    logger.error("Error fetching budget change orders", err);
    return res.status(500).json({ message: "Failed to fetch change orders" });
  } finally {
    if (connection) connection.release();
  }
});

// POST set a change order's manually-entered Budget sub cost. Not lock-guarded —
// adding/costing a signed CO is exactly how a locked budget is extended.
router.post("/change-orders/:coId/sub-cost", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && r.body.job_id, (r) => r.body && r.body.job_type), requireJobBudgetFeature, async (req, res) => {
  const coId = Number(req.params.coId);
  if (!coId) return res.status(400).json({ message: "Invalid change order id" });
  const raw = req.body && req.body.sub_cost;
  const subCost = raw == null || raw === "" ? null : Number(raw);
  if (subCost != null && (isNaN(subCost) || subCost < 0)) return res.status(400).json({ message: "Invalid sub cost" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureChangeOrderBudgetColumns(connection);
    const [result] = await connection.query(
      `UPDATE change_orders SET budget_sub_cost = ? WHERE id = ?`,
      [subCost, coId]
    );
    if (!result.affectedRows) return res.status(404).json({ message: "Change order not found" });
    return res.json({ id: coId, sub_cost: subCost });
  } catch (err) {
    logger.error("Error updating change order sub cost", err);
    return res.status(500).json({ message: "Failed to update sub cost" });
  } finally {
    if (connection) connection.release();
  }
});

// ---- Change-order payments (mirror of the line-item Pay mechanic) ----
router.get("/change-orders/:coId/payments", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const coId = Number(req.params.coId);
  if (!coId) return res.status(400).json({ message: "Invalid change order id" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureChangeOrderPaymentTables(connection);
    const [rows] = await connection.query(
      `SELECT p.id, p.change_order_id, p.method, p.check_number, p.payment_date, p.amount,
              p.created_at, p.created_by, p.updated_at, p.updated_by, u.name AS created_by_name
         FROM change_order_payments p
         LEFT JOIN user u ON u.id = p.created_by
        WHERE p.change_order_id = ?
        ORDER BY p.payment_date ASC, p.id ASC`,
      [coId]
    );
    return res.json(rows || []);
  } catch (err) {
    logger.error("Error fetching CO payments", err);
    return res.status(500).json({ message: "Failed to fetch payments" });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/change-orders/:coId/payments", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && r.body.job_id, (r) => r.body && r.body.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const coId = Number(req.params.coId);
  const changedBy = res.locals.id;
  const { method, check_number, payment_date, amount } = req.body || {};
  if (!coId) return res.status(400).json({ message: "Invalid change order id" });
  if (!PAYMENT_METHODS.has(String(method))) return res.status(400).json({ message: "Invalid payment method" });
  if (!paymentAmountAllowed(amount)) return res.status(400).json({ message: "Amount must be greater than 0" });
  if (!payment_date) return res.status(400).json({ message: "Payment date is required" });
  const checkNo = String(method) === "check" ? (check_number ? String(check_number).trim() : null) : null;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureChangeOrderPaymentTables(connection);
    await ensureChangeOrderBudgetColumns(connection);
    await connection.beginTransaction();
    const [ins] = await connection.query(
      `INSERT INTO change_order_payments (change_order_id, method, check_number, payment_date, amount, created_by, created_at)
       VALUES (?,?,?,?,?,?,NOW())`,
      [coId, String(method), checkNo, payment_date, Number(amount), changedBy ?? null]
    );
    const paidAmount = await adjustCoPaidAmount(connection, coId, Number(amount));
    await connection.query(
      `INSERT INTO change_order_payment_audit (payment_id, change_order_id, action, old_value, new_value, changed_by, changed_at)
       VALUES (?,?, 'create', NULL, ?, ?, NOW())`,
      [ins.insertId, coId, JSON.stringify({ method: String(method), check_number: checkNo, payment_date, amount: Number(amount) }), changedBy ?? null]
    );
    await connection.commit();
    return res.status(201).json({ id: ins.insertId, paid_amount: paidAmount });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error recording CO payment", err);
    return res.status(500).json({ message: "Failed to record payment" });
  } finally {
    if (connection) connection.release();
  }
});

router.put("/change-orders/:coId/payments/:paymentId", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && r.body.job_id, (r) => r.body && r.body.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const coId = Number(req.params.coId);
  const paymentId = Number(req.params.paymentId);
  const changedBy = res.locals.id;
  const { method, check_number, payment_date, amount } = req.body || {};
  if (!coId || !paymentId) return res.status(400).json({ message: "Invalid ids" });
  if (!PAYMENT_METHODS.has(String(method))) return res.status(400).json({ message: "Invalid payment method" });
  if (!paymentAmountAllowed(amount)) return res.status(400).json({ message: "Amount must be greater than 0" });
  if (!payment_date) return res.status(400).json({ message: "Payment date is required" });
  const checkNo = String(method) === "check" ? (check_number ? String(check_number).trim() : null) : null;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureChangeOrderPaymentTables(connection);
    await connection.beginTransaction();
    const [prev] = await connection.query(
      `SELECT method, check_number, payment_date, amount FROM change_order_payments WHERE id = ? AND change_order_id = ? LIMIT 1`,
      [paymentId, coId]
    );
    if (!prev.length) { await connection.rollback(); return res.status(404).json({ message: "Payment not found" }); }
    const oldAmount = Number(prev[0].amount);
    await connection.query(
      `UPDATE change_order_payments SET method = ?, check_number = ?, payment_date = ?, amount = ?, updated_by = ?, updated_at = NOW()
        WHERE id = ? AND change_order_id = ?`,
      [String(method), checkNo, payment_date, Number(amount), changedBy ?? null, paymentId, coId]
    );
    const paidAmount = await adjustCoPaidAmount(connection, coId, Number(amount) - oldAmount);
    await connection.query(
      `INSERT INTO change_order_payment_audit (payment_id, change_order_id, action, old_value, new_value, changed_by, changed_at)
       VALUES (?,?, 'edit', ?, ?, ?, NOW())`,
      [paymentId, coId,
        JSON.stringify({ method: prev[0].method, check_number: prev[0].check_number, payment_date: prev[0].payment_date, amount: oldAmount }),
        JSON.stringify({ method: String(method), check_number: checkNo, payment_date, amount: Number(amount) }),
        changedBy ?? null]
    );
    await connection.commit();
    return res.json({ id: paymentId, paid_amount: paidAmount });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error editing CO payment", err);
    return res.status(500).json({ message: "Failed to edit payment" });
  } finally {
    if (connection) connection.release();
  }
});

router.delete("/change-orders/:coId/payments/:paymentId", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const coId = Number(req.params.coId);
  const paymentId = Number(req.params.paymentId);
  const changedBy = res.locals.id;
  if (!coId || !paymentId) return res.status(400).json({ message: "Invalid ids" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureChangeOrderPaymentTables(connection);
    await connection.beginTransaction();
    const [prev] = await connection.query(
      `SELECT method, check_number, payment_date, amount FROM change_order_payments WHERE id = ? AND change_order_id = ? LIMIT 1`,
      [paymentId, coId]
    );
    if (!prev.length) { await connection.rollback(); return res.status(404).json({ message: "Payment not found" }); }
    const oldAmount = Number(prev[0].amount);
    await connection.query(`DELETE FROM change_order_payments WHERE id = ? AND change_order_id = ?`, [paymentId, coId]);
    const paidAmount = await adjustCoPaidAmount(connection, coId, -oldAmount);
    await connection.query(
      `INSERT INTO change_order_payment_audit (payment_id, change_order_id, action, old_value, new_value, changed_by, changed_at)
       VALUES (?,?, 'delete', ?, NULL, ?, NOW())`,
      [paymentId, coId,
        JSON.stringify({ method: prev[0].method, check_number: prev[0].check_number, payment_date: prev[0].payment_date, amount: oldAmount }),
        changedBy ?? null]
    );
    await connection.commit();
    return res.json({ id: paymentId, paid_amount: paidAmount });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error deleting CO payment", err);
    return res.status(500).json({ message: "Failed to delete payment" });
  } finally {
    if (connection) connection.release();
  }
});

// ---- Budget lock (fixed baseline) ----
// GET current lock state + the frozen snapshot for a job's Budget tab.
router.get("/lock-state", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, async (req, res) => {
  const { job_id, job_type } = req.query;
  if (!job_id) {
    return res.status(400).json({ message: "job_id is required" });
  }
  const ownerType = ownerTypeOf(job_type);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureBudgetLockTables(connection);
    const [rows] = await connection.query(
      "SELECT locked, snapshot, locked_by, locked_by_name, locked_at FROM budget_locks WHERE job_id = ? AND owner_type = ? LIMIT 1",
      [Number(job_id), ownerType]
    );
    if (!rows.length) {
      return res.json({ locked: false, snapshot: null, locked_by: null, locked_by_name: null, locked_at: null });
    }
    const row = rows[0];
    let snap = null;
    try { snap = row.snapshot ? JSON.parse(row.snapshot) : null; } catch (_) { snap = null; }
    return res.json({
      locked: !!Number(row.locked),
      snapshot: snap,
      locked_by: row.locked_by,
      locked_by_name: row.locked_by_name,
      locked_at: row.locked_at,
    });
  } catch (err) {
    logger.error("Error fetching budget lock state", err);
    return res.status(500).json({ message: "Failed to fetch lock state" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /lock — freeze the budget. Anyone with budget edit access may lock;
// unlocking is owner-only (below). Stores the summary snapshot + logs the action.
router.post("/lock", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && r.body.job_id, (r) => r.body && r.body.job_type), requireJobBudgetFeature, async (req, res) => {
  const body = req.body || {};
  const { job_id, job_type } = body;
  if (!job_id) {
    return res.status(400).json({ message: "job_id is required" });
  }
  const ownerType = ownerTypeOf(job_type);
  const userId = res.locals.id;
  let snapshot;
  try { snapshot = body.snapshot ? JSON.stringify(body.snapshot) : null; } catch (_) { snapshot = null; }
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureBudgetLockTables(connection);

    /*
     * §4 A BUDGET CANNOT BE LOCKED WHILE ANYTHING IS RED.
     *
     * The gate lives HERE and not only on the button, because a hidden button
     * is not a rule — the test for this calls the endpoint directly.
     *
     * It is a PRECONDITION on the existing lock, not a new notion of "final":
     * what locking does is untouched — the snapshot, the read-only line items,
     * the change-order path, the audit row. Only whether it is allowed to
     * start has changed.
     *
     * TBD blocks too. A line with every number filled and TBD ticked still
     * stops the lock: to lock, the tick comes off, which means the number is
     * decided.
     *
     * UNLOCK IS DELIBERATELY NOT GUARDED THIS WAY — unlocking is how you get
     * back in to fix the flagged lines. A symmetric guard there would trap the
     * owner out of his own budget.
     */
    await ensureBudgetTbdColumns(connection);
    const [flagRows] = await connection.query(
      `SELECT amount, sub_cost, subcontractor_id, in_house, is_tbd
         FROM division_lineitems WHERE job_id = ? AND owner_type = ?`,
      [Number(job_id), ownerType]
    );
    const outstanding = countFlagged(flagRows);
    if (outstanding > 0) {
      return res.status(409).json({
        success: false,
        code: "BUDGET_HAS_FLAGGED_LINES",
        outstanding,
        message: `${outstanding} line${outstanding === 1 ? '' : 's'} still to resolve before this budget can be locked.`,
      });
    }

    const name = await userDisplayName(connection, userId);
    await connection.query(
      `INSERT INTO budget_locks (job_id, owner_type, locked, snapshot, locked_by, locked_by_name, locked_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE locked = 1, snapshot = VALUES(snapshot), locked_by = VALUES(locked_by),
         locked_by_name = VALUES(locked_by_name), locked_at = NOW(), updated_at = NOW()`,
      [Number(job_id), ownerType, snapshot, userId, name]
    );
    await connection.query(
      "INSERT INTO budget_lock_audit (job_id, owner_type, action, changed_by, changed_by_name) VALUES (?, ?, 'lock', ?, ?)",
      [Number(job_id), ownerType, userId, name]
    );
    const [[row]] = await connection.query(
      "SELECT locked_at, locked_by_name FROM budget_locks WHERE job_id = ? AND owner_type = ? LIMIT 1",
      [Number(job_id), ownerType]
    );
    return res.json({ locked: true, locked_at: row && row.locked_at, locked_by_name: row && row.locked_by_name });
  } catch (err) {
    logger.error("Error locking budget", err);
    return res.status(500).json({ message: "Failed to lock budget" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /unlock — owner-only (requireAccountOwner, fail-closed). Restores live/
// editable behavior and logs the action.
router.post("/unlock", auth.authenticateToken, blockExpiredOwnRecord((r) => r.body && r.body.job_id, (r) => r.body && r.body.job_type), requireJobBudgetFeature, requireAccountOwner, async (req, res) => {
  const body = req.body || {};
  const { job_id, job_type } = body;
  if (!job_id) {
    return res.status(400).json({ message: "job_id is required" });
  }
  const ownerType = ownerTypeOf(job_type);
  const userId = res.locals.id;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureBudgetLockTables(connection);
    const name = await userDisplayName(connection, userId);
    await connection.query(
      `INSERT INTO budget_locks (job_id, owner_type, locked, locked_by, locked_by_name, locked_at, updated_at)
       VALUES (?, ?, 0, ?, ?, NULL, NOW())
       ON DUPLICATE KEY UPDATE locked = 0, updated_at = NOW()`,
      [Number(job_id), ownerType, userId, name]
    );
    await connection.query(
      "INSERT INTO budget_lock_audit (job_id, owner_type, action, changed_by, changed_by_name) VALUES (?, ?, 'unlock', ?, ?)",
      [Number(job_id), ownerType, userId, name]
    );
    return res.json({ locked: false });
  } catch (err) {
    logger.error("Error unlocking budget", err);
    return res.status(500).json({ message: "Failed to unlock budget" });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
