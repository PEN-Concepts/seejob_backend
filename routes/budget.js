const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const auth = require("../services/authentication");
const logger = require("../common/logger");
const { ensureOwnerTypeColumns, ensureSubCostColumn, ensureInHouseColumn, ensureBudgetPercentColumns, ensurePaymentsTables, ensureSuggestedItemsTable, seedSuggestedItems, ensureBudgetLockTables } = require("../services/dbMigrations");
const { blockExpiredOwnRecord, requirePlan, OWNER_EXEMPT_EMAILS } = require("../utils/access");
const { requireAccountOwner } = require("../utils/adminGate");

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

  if (!subRows.length) return [];

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

const requireJobBudgetFeature = requirePlanFeatures(["job_budget", "budget"]);

// Budget is now PLATINUM-ONLY (task #84). Tier gate on the whole router, in
// addition to the per-route plan-feature check below. Owner-exempt accounts are
// level 5 so they pass; Gold accounts (even with the job_budget feature) are 403.
// authenticateToken runs here so requirePlan can read req.user.
router.use(auth.authenticateToken, requirePlan("platinum"));


router.get(
  "/subcontractors",
  auth.authenticateToken,
  requireJobBudgetFeature,
  async (req, res) => {
    let connection;
    try {
      const userId = (req.user && req.user.id) ? req.user.id : res.locals.id;
      connection = await pool.getConnection();

      const [rows] = await connection.query(
        `(
          SELECT id, name, email
          FROM user
          WHERE role = 12 AND status = 1
        )
        UNION
        (
          SELECT u.id, u.name, u.email
          FROM contact c
          INNER JOIN user u ON u.id = c.request_user2
          WHERE c.request_user1 = ?
            AND u.role = 12 AND u.status = 1
        )
        UNION
        (
          SELECT u.id, u.name, u.email
          FROM contact c
          INNER JOIN user u ON u.id = c.request_user1
          WHERE c.request_user2 = ?
            AND u.role = 12 AND u.status = 1
        )
        ORDER BY name ASC, id ASC`,
        [userId, userId]
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
    await ensureBudgetPercentColumns(connection);
    const [rows] = await connection.query(
      `SELECT id, division_id, lineitem_description, amount, sub_cost, csi_number, job_id,
              subcontractor_id, in_house, foreman_percent, paid_amount,
              contingency, overhead_percent, gl_percent
       FROM division_lineitems
       WHERE job_id = ? AND owner_type = ?
       ORDER BY division_id ASC, id ASC`,
      [Number(job_id), ownerType]
    );
    return res.json(rows);
  } catch (err) {
    logger.error("Error fetching all lineitems", err);
    return res.status(500).json({ message: "Failed to fetch lineitems" });
  } finally {
    if (connection) connection.release();
  }
});

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
  const cols = { contingency: 'contingency', overhead_percent: 'overhead_percent', gl_percent: 'gl_percent' };
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
router.get("/divisions/:divisionId/lineitems", auth.authenticateToken, blockExpiredOwnRecord((r) => r.query.job_id, (r) => r.query.job_type), requireJobBudgetFeature, async (req, res) => {
  const { divisionId } = req.params;
  const { job_id, job_type } = req.query;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);
    await ensureSubCostColumn(connection);
    await ensureInHouseColumn(connection);
    await ensureBudgetPercentColumns(connection);
    const params = [];
    let sql = `SELECT id, division_id, lineitem_description, amount, sub_cost, csi_number, job_id, contingency,
                     overhead_percent, gl_percent, subcontractor_id, in_house, foreman_percent, paid_amount
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
          amount: it.amount ?? null,
          sub_cost: it.sub_cost ?? null,
          contingency: it.contingency ?? null,
          in_house: it.in_house ? 1 : 0,
          overhead_percent: it.overhead_percent ?? 0,
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
                overhead_percent = ?, gl_percent = ?,
                subcontractor_id = ?, in_house = ?, foreman_percent = ?, paid_amount = ?
            WHERE id = ? AND division_id = ? AND job_id = ? AND owner_type = ?`;

          const updateValues = [
            normalized.csi_number,
            normalized.lineitem_description,
            normalized.amount,
            normalized.sub_cost,
            normalized.contingency,
            normalized.overhead_percent,
            normalized.gl_percent,
            normalized.subcontractor_id,
            normalized.in_house,
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
             overhead_percent, gl_percent,
             subcontractor_id, in_house, foreman_percent, paid_amount,
             created_at, created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)`;

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
            normalized.gl_percent,
            normalized.subcontractor_id,
            normalized.in_house,
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
