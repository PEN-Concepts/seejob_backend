// Shared cross-account ownership guards (IDOR remediation — Tier 1+).
//
// One place for "does this record belong to the caller's account?" so every
// job/record-scoped endpoint enforces it the SAME way instead of each re-deriving
// (or forgetting) the check. All fail CLOSED (403 on error), 404 when the record
// doesn't exist, 403 when it's another account's.
//
//   requireOwnsRecord — middleware: a record owned directly by a user column
//                       (e.g. tasks.created_by, teams.created_by).
//   requireOwnsJob    — middleware: a job_id/lead_id supplied in the request.
//   ownsJob           — helper: assert account owns a job id (for handlers that
//                       already resolved job_id via a JOIN, incl. multi-hop legacy).
//
const pool = require("../config/connection");
const logger = require("../common/logger");
const { isSameAccount } = require("./access");

function pick(req, from, key) {
  const bag = (from === "query" ? req.query : from === "body" ? req.body : req.params) || {};
  return bag[key];
}

/**
 * Require the caller's account to own a record identified by `idKey` in the given
 * table, where `ownerCol` holds the owning user id. 400 if id missing (unless
 * optional), 404 if the row is gone, 403 if it's another account's.
 */
function requireOwnsRecord({ table, ownerCol, idFrom = "params", idKey = "id", idCol = "id", optional = false }) {
  return async (req, res, next) => {
    try {
      const id = pick(req, idFrom, idKey);
      if (id == null || id === "") {
        if (optional) return next();
        return res.status(400).json({ code: "400", message: `${idKey} is required` });
      }
      const [[row]] = await pool.query(
        `SELECT \`${ownerCol}\` AS owner FROM \`${table}\` WHERE \`${idCol}\` = ? LIMIT 1`,
        [id]
      );
      if (!row) return res.status(404).json({ code: "404", message: "Not found" });
      if (!(await isSameAccount(req.user.id, row.owner))) {
        return res.status(403).json({ code: "403", message: "This record does not belong to your account." });
      }
      return next();
    } catch (e) {
      logger.error(`requireOwnsRecord(${table}): ${e.message}`);
      return res.status(403).json({ code: "403", message: "Forbidden" });
    }
  };
}

/**
 * Require the caller's account to own a job/lead supplied in the request.
 * owner_type=lead → leads.user_id, else job.created_by.
 */
function requireOwnsJob({ idFrom = "params", idKey = "job_id", typeFrom = "query", typeKey = "owner_type", fixedType = null, optional = false } = {}) {
  return async (req, res, next) => {
    try {
      const id = pick(req, idFrom, idKey);
      if (id == null || id === "") {
        if (optional) return next();
        return res.status(400).json({ code: "400", message: `${idKey} is required` });
      }
      const isLead = fixedType
        ? String(fixedType).toLowerCase() === "lead"
        : String(pick(req, typeFrom, typeKey) || "job").toLowerCase() === "lead";
      const [[row]] = await pool.query(
        isLead
          ? "SELECT user_id AS owner FROM leads WHERE id = ? LIMIT 1"
          : "SELECT created_by AS owner FROM job WHERE id = ? LIMIT 1",
        [id]
      );
      if (!row) return res.status(404).json({ code: "404", message: "Job not found" });
      if (!(await isSameAccount(req.user.id, row.owner))) {
        return res.status(403).json({ code: "403", message: "This job does not belong to your account." });
      }
      return next();
    } catch (e) {
      logger.error(`requireOwnsJob: ${e.message}`);
      return res.status(403).json({ code: "403", message: "Forbidden" });
    }
  };
}

/**
 * Require a user-id in the request to be in the CALLER's account. For endpoints
 * that trust a `:userId`/`:user_id` path param as a data filter (e.g. time logs by
 * user, "jobs created by user_id") — a caller must not be able to read another
 * account's data by swapping the id. Passes for self or any same-account user.
 */
function requireSameAccountAsParam({ idFrom = "params", idKey = "user_id", optional = false } = {}) {
  return async (req, res, next) => {
    try {
      const target = pick(req, idFrom, idKey);
      if (target == null || target === "") {
        if (optional) return next();
        return res.status(400).json({ code: "400", message: `${idKey} is required` });
      }
      if (Number(target) === Number(req.user.id)) return next();
      if (await isSameAccount(req.user.id, target)) return next();
      return res.status(403).json({ code: "403", message: "This does not belong to your account." });
    } catch (e) {
      logger.error(`requireSameAccountAsParam(${idKey}): ${e.message}`);
      return res.status(403).json({ code: "403", message: "Forbidden" });
    }
  };
}

/**
 * Helper (not middleware): does `userId`'s account own job `jobId`? For handlers
 * that already resolved a job_id (e.g. a legacy change_order/quote row joined to
 * its job) and want an inline check. Fails closed (false on missing/error).
 */
async function ownsJob(userId, jobId, connection) {
  try {
    if (jobId == null || jobId === "") return false;
    const db = connection || pool;
    const [[row]] = await db.query("SELECT created_by AS owner FROM job WHERE id = ? LIMIT 1", [jobId]);
    if (!row) return false;
    return await isSameAccount(userId, row.owner, connection);
  } catch (e) {
    logger.error(`ownsJob(${jobId}): ${e.message}`);
    return false;
  }
}

module.exports = { requireOwnsRecord, requireOwnsJob, requireSameAccountAsParam, ownsJob };
