const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const auth = require("../services/authentication");
const logger = require("../common/logger");
const { ensureOwnerTypeColumns } = require("../services/dbMigrations");
const { blockExpiredOwnJob } = require("../utils/access");

// Normalize the job_type/owner_type param to the discriminator stored on
// division_lineitems. Anything that isn't an explicit 'lead' is a job.
function ownerTypeOf(v) {
  return String(v || "").toLowerCase() === "lead" ? "lead" : "job";
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
router.get("/lineitems", auth.authenticateToken, blockExpiredOwnJob((r) => r.query.job_id), requireJobBudgetFeature, async (req, res) => {
  const { job_id, job_type } = req.query;

  if (!job_id) {
    return res.status(400).json({ message: "job_id is required" });
  }

  const ownerType = ownerTypeOf(job_type);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);
    const [rows] = await connection.query(
      `SELECT id, division_id, lineitem_description, amount, csi_number, job_id,
              subcontractor_id, foreman_percent, paid_amount
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
router.post("/contingency", auth.authenticateToken, blockExpiredOwnJob((r) => r.body && r.body.job_id), requireJobBudgetFeature, async (req, res) => {
  const { job_id, job_type, contingency } = req.body || {};

  if (!job_id) {
    return res.status(400).json({ message: "job_id is required" });
  }

  let value = Number(contingency);
  if (isNaN(value) || value < 0) {
    value = 0;
  }

  const ownerType = ownerTypeOf(job_type);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);
    const [result] = await connection.query(
      `UPDATE division_lineitems SET contingency = ? WHERE job_id = ? AND owner_type = ?`,
      [value, job_id, ownerType]
    );

    return res.json({
      message: "Contingency updated",
      affectedRows: result.affectedRows || 0,
      contingency: value,
    });
  } catch (err) {
    logger.error("Error updating contingency", err);
    return res.status(500).json({ message: "Failed to update contingency" });
  } finally {
    if (connection) connection.release();
  }
});

// GET /divisions/:divisionId/lineitems
router.get("/divisions/:divisionId/lineitems", auth.authenticateToken, blockExpiredOwnJob((r) => r.query.job_id), requireJobBudgetFeature, async (req, res) => {
  const { divisionId } = req.params;
  const { job_id, job_type } = req.query;
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);
    const params = [];
    let sql = `SELECT id, division_id, lineitem_description, amount, csi_number, job_id, contingency,
                     subcontractor_id, foreman_percent, paid_amount
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

// POST /divisions/:divisionId/lineitems 
router.post("/divisions/:divisionId/lineitems", auth.authenticateToken, blockExpiredOwnJob((r) => r.body && (r.body.job_id != null ? r.body.job_id : (r.body.items && r.body.items[0] && r.body.items[0].job_id))), requireJobBudgetFeature, async (req, res) => {
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
      await connection.beginTransaction();

      const insertedItems = [];
      for (const it of items) {
        const normalized = {
          id: it.id ? Number(it.id) : null,
          csi_number: it.csi_number ?? null,
          lineitem_description: it.lineitem_description ?? null,
          amount: it.amount ?? null,
          contingency: it.contingency ?? null,
          subcontractor_id: it.subcontractor_id ?? null,
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
            SET csi_number = ?, lineitem_description = ?, amount = ?, contingency = ?,
                subcontractor_id = ?, foreman_percent = ?, paid_amount = ?
            WHERE id = ? AND division_id = ? AND job_id = ? AND owner_type = ?`;

          const updateValues = [
            normalized.csi_number,
            normalized.lineitem_description,
            normalized.amount,
            normalized.contingency,
            normalized.subcontractor_id,
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
            (division_id, job_id, owner_type, csi_number, lineitem_description, amount, contingency,
             subcontractor_id, foreman_percent, paid_amount,
             created_at, created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),?)`;

          const insertValues = [
            Number(divisionId),
            Number(job_id),
            ownerType,
            normalized.csi_number,
            normalized.lineitem_description,
            normalized.amount,
            normalized.contingency,
            normalized.subcontractor_id,
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
router.delete("/divisions/:divisionId/lineitems/:itemId", auth.authenticateToken, blockExpiredOwnJob((r) => r.query.job_id), requireJobBudgetFeature, async (req, res) => {
  const { divisionId, itemId } = req.params;
  const { job_id, job_type } = req.query;

  let connection;
  try {
    connection = await pool.getConnection();
    await ensureOwnerTypeColumns(connection);

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

module.exports = router;
