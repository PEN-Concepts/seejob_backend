const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const auth = require("../services/authentication");
const logger = require("../common/logger");
const { blockExpiredOwnRecord, requirePlan } = require("../utils/access");
const { ensureInvoicesTable, assignJobNumberIfMissing } = require("../services/dbMigrations");

// Client invoicing lives with Budget (Platinum). Invoice CONTENT (amounts/PDF)
// is a separate feature; this router owns the numbering + list entry point.
router.use(auth.authenticateToken, requirePlan("platinum"));

// Displayed invoice number = company Job Number (min 2 digits) concatenated with
// the per-job invoice sequence (min 3 digits). Both widths expand automatically
// (Job 100 -> "100"; invoice 1000 -> "1000"). e.g. Job 1, invoice 37 -> "01037".
function displayNumber(jobNumber, invoiceSeq) {
  const j = String(jobNumber == null ? 0 : Number(jobNumber)).padStart(2, "0");
  const i = String(invoiceSeq == null ? 0 : Number(invoiceSeq)).padStart(3, "0");
  return j + i;
}

const jobIdOf = (r) => r.params.jobId;
const asJob = () => "job";

// GET /invoices/:jobId — the job's number + its invoice list (combined numbers).
router.get("/:jobId", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!jobId) return res.status(400).json({ message: "Invalid job id" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoicesTable(connection);
    const jobNumber = await assignJobNumberIfMissing(connection, jobId);
    const [rows] = await connection.query(
      `SELECT i.id, i.job_id, i.invoice_seq, i.status, i.created_at, i.created_by, u.name AS created_by_name
         FROM job_invoices i LEFT JOIN \`user\` u ON u.id = i.created_by
        WHERE i.job_id = ? ORDER BY i.invoice_seq ASC`,
      [jobId]
    );
    const invoices = (rows || []).map((r) => ({
      id: r.id,
      invoice_seq: r.invoice_seq,
      status: r.status || null,
      created_at: r.created_at,
      created_by_name: r.created_by_name || null,
      display_number: displayNumber(jobNumber, r.invoice_seq),
    }));
    return res.json({ job_id: jobId, job_number: jobNumber, invoices });
  } catch (err) {
    logger.error("Error fetching invoices", err);
    return res.status(500).json({ message: "Failed to fetch invoices" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /invoices/:jobId — allocate the next per-job invoice number (entry point
// for the invoice-generation feature; content is filled in by that feature).
router.post("/:jobId", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const createdBy = res.locals.id;
  if (!jobId) return res.status(400).json({ message: "Invalid job id" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoicesTable(connection);
    const jobNumber = await assignJobNumberIfMissing(connection, jobId);
    await connection.beginTransaction();
    const [[{ next }]] = await connection.query(
      "SELECT COALESCE(MAX(invoice_seq), 0) + 1 AS next FROM job_invoices WHERE job_id = ?",
      [jobId]
    );
    const [ins] = await connection.query(
      "INSERT INTO job_invoices (job_id, invoice_seq, created_by, created_at) VALUES (?,?,?,NOW())",
      [jobId, next, createdBy ?? null]
    );
    await connection.commit();
    return res.status(201).json({ id: ins.insertId, invoice_seq: next, job_number: jobNumber, display_number: displayNumber(jobNumber, next) });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error creating invoice", err);
    return res.status(500).json({ message: "Failed to create invoice" });
  } finally {
    if (connection) connection.release();
  }
});

// DELETE /invoices/:jobId/:invoiceId
router.delete("/:jobId/:invoiceId", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const invoiceId = Number(req.params.invoiceId);
  if (!jobId || !invoiceId) return res.status(400).json({ message: "Invalid ids" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoicesTable(connection);
    const [r] = await connection.query("DELETE FROM job_invoices WHERE id = ? AND job_id = ?", [invoiceId, jobId]);
    return res.json({ deleted: r.affectedRows });
  } catch (err) {
    logger.error("Error deleting invoice", err);
    return res.status(500).json({ message: "Failed to delete invoice" });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
