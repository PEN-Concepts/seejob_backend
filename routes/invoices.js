const express = require("express");
const router = express.Router();
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const pool = require("../config/connection");
const auth = require("../services/authentication");
const logger = require("../common/logger");
const access = require("../utils/access");
const { blockExpiredOwnRecord, requirePlan, isSameAccount } = require("../utils/access");
const { ensureInvoicesTable, ensureInvoiceDocumentSchema, assignJobNumberIfMissing } = require("../services/dbMigrations");
const mailer = require("../services/mailer");

// Client-facing preview base (mirrors the quotes public link).
const PUBLIC_BASE = "https://seejobrun.com/user-dashboard";
// PDF attachment upload for "Send" — the FE renders the same PDF it downloads and
// posts it here as multipart. Memory storage → buffer straight onto the email.
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---- small helpers (function declarations → hoisted for the public route above) ----
function displayNumber(jobNumber, invoiceSeq) {
  const j = String(jobNumber == null ? 0 : Number(jobNumber)).padStart(2, "0");
  const i = String(invoiceSeq == null ? 0 : Number(invoiceSeq)).padStart(3, "0");
  return j + i;
}
function num(x) { const n = Number(x); return isNaN(n) ? 0 : n; }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
/** Recompute line-item amounts + subtotal/tax/total server-side (never trust the
 *  client's totals). Returns normalized items + the money figures. */
function computeTotals(items, taxRate) {
  let subtotal = 0;
  const norm = (Array.isArray(items) ? items : []).map((it, idx) => {
    const qty = num(it.qty), rate = num(it.rate);
    const amount = round2(qty * rate);
    subtotal = round2(subtotal + amount);
    return { description: String(it.description == null ? "" : it.description), qty, rate, amount, sort: idx };
  });
  // SeeJobRun invoices charge NO tax (B4): labor isn't taxable and this isn't a
  // retail resale tool. Tax is forced to zero regardless of any tax_rate sent;
  // the tax_rate/tax_amount columns stay (always 0) rather than being torn out.
  // NOTE (do not build): a few states tax contractor-supplied MATERIALS
  // differently. If SeeJobRun ever sells into one, a materials-tax line comes
  // back here.
  const tax_amount = 0;
  const total = subtotal;
  return { items: norm, subtotal, tax_amount, total };
}
/** The invoice "from" block — the account owner's company profile (live). */
async function companyBlock(conn, jobCreatedBy) {
  let ownerId = Number(jobCreatedBy);
  try { ownerId = await access.resolveOwnerId(Number(jobCreatedBy), conn); } catch (e) { /* fallback to creator */ }
  const [[u]] = await conn.query(
    "SELECT business, organization_name, name, street, city, state, zipcode, mobile, email, website_link, payment_instructions FROM `user` WHERE id = ? LIMIT 1",
    [ownerId]
  );
  if (!u) return {};
  const cityState = [u.city, u.state].filter(Boolean).join(", ");
  const address = [u.street, cityState, u.zipcode].filter(Boolean).join(" ").trim();
  return {
    name: u.business || u.organization_name || u.name || "",
    address, phone: u.mobile || "", email: u.email || "",
    website: u.website_link || "", payment_instructions: u.payment_instructions || "",
  };
}
/** The invoice "bill to" block — the job's client (live), + job name/number. */
async function billToBlock(conn, jobId) {
  const [[j]] = await conn.query(
    `SELECT j.name AS job_name, j.job_number,
            COALESCE(u.name, j.additional_client_name) AS client_name,
            COALESCE(u.email, j.additional_client_email) AS client_email,
            COALESCE(u.mobile, j.additional_client_mobile) AS client_mobile,
            u.street AS c_street, u.city AS c_city, u.state AS c_state, u.zipcode AS c_zip
       FROM job j LEFT JOIN \`user\` u ON u.id = j.client_id WHERE j.id = ? LIMIT 1`,
    [jobId]
  );
  if (!j) return {};
  const cityState = [j.c_city, j.c_state].filter(Boolean).join(", ");
  const client_address = [j.c_street, cityState, j.c_zip].filter(Boolean).join(" ").trim();
  return {
    job_name: j.job_name || "", job_number: j.job_number,
    client_name: j.client_name || "", client_email: j.client_email || "",
    client_mobile: j.client_mobile || "", client_address,
  };
}
function mapItems(rows) {
  return (rows || []).map((r) => ({ id: r.id, description: r.description || "", qty: num(r.qty), rate: num(r.rate), amount: num(r.amount), sort: r.sort }));
}
function publicInvoicePayload(inv, jobNumber) {
  return {
    id: inv.id, display_number: displayNumber(jobNumber, inv.invoice_seq),
    status: inv.status || "Draft",
    issued_date: inv.issued_date || (inv.created_at ? String(inv.created_at).slice(0, 10) : null),
    due_date: inv.due_date,
    // No tax on the client-facing payload (B4) — tax_rate/tax_amount omitted.
    subtotal: num(inv.subtotal), total: num(inv.total),
    notes: inv.notes || "", payment_instructions: inv.payment_instructions || "",
    sent_at: inv.sent_at || null, viewed_at: inv.viewed_at || null, paid_at: inv.paid_at || null,
  };
}
async function ensureToken(conn, inv) {
  if (inv.public_token) return inv.public_token;
  const token = uuidv4();
  await conn.query("UPDATE job_invoices SET public_token = ? WHERE id = ?", [token, inv.id]);
  inv.public_token = token;
  return token;
}

// ============================================================================
// PUBLIC (no auth) — client-viewable read-only invoice. Defined BEFORE the auth
// gate below so it stays open. Opening flips the invoice to Viewed (unless Paid).
// ============================================================================
router.get("/public/:token", async (req, res) => {
  const token = String(req.params.token || "");
  if (!token) return res.status(400).json({ message: "Missing token" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const [[inv]] = await connection.query("SELECT * FROM job_invoices WHERE public_token = ? LIMIT 1", [token]);
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const jobNumber = await assignJobNumberIfMissing(connection, inv.job_id);
    // First open (and not already Paid) → mark Viewed.
    if (inv.status !== "Paid" && !inv.viewed_at) {
      await connection.query("UPDATE job_invoices SET viewed_at = NOW(), status = 'Viewed' WHERE id = ? AND status <> 'Paid'", [inv.id]);
      inv.viewed_at = new Date();
      inv.status = "Viewed";
    }
    const [items] = await connection.query("SELECT * FROM job_invoice_items WHERE invoice_id = ? ORDER BY sort ASC, id ASC", [inv.id]);
    const [[job]] = await connection.query("SELECT created_by FROM job WHERE id = ? LIMIT 1", [inv.job_id]);
    const company = job ? await companyBlock(connection, job.created_by) : {};
    const bill_to = await billToBlock(connection, inv.job_id);
    const payload = publicInvoicePayload(inv, jobNumber);
    if (!payload.payment_instructions) payload.payment_instructions = company.payment_instructions || "";
    return res.json({ invoice: payload, items: mapItems(items), company, bill_to, job_number: jobNumber });
  } catch (err) {
    logger.error("Public invoice view error", err);
    return res.status(500).json({ message: "Failed to load invoice" });
  } finally {
    if (connection) connection.release();
  }
});

// ---- everything below requires auth + Platinum (client invoicing lives with Budget) ----
router.use(auth.authenticateToken, requirePlan("platinum"));

// Cross-account isolation: every /:jobId route must belong to the caller's account.
router.param("jobId", async (req, res, next, jobId) => {
  try {
    const [[job]] = await pool.query("SELECT created_by FROM job WHERE id = ? LIMIT 1", [Number(jobId)]);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!(await isSameAccount(req.user.id, job.created_by)))
      return res.status(403).json({ code: "403", message: "This job does not belong to your account." });
    req._jobCreatedBy = job.created_by;
    return next();
  } catch (e) {
    logger.error("invoices jobId guard: " + e.message);
    return res.status(403).json({ code: "403", message: "Forbidden" });
  }
});

const jobIdOf = (r) => r.params.jobId;
const asJob = () => "job";

// GET /invoices/:jobId — the job's number + its invoice list (with status + tracking
// fields the Billing list needs: status, sent/viewed/paid timestamps, total, due).
router.get("/:jobId", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!jobId) return res.status(400).json({ message: "Invalid job id" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const jobNumber = await assignJobNumberIfMissing(connection, jobId);
    const [rows] = await connection.query(
      `SELECT i.id, i.job_id, i.invoice_seq, i.status, i.created_at, i.created_by,
              i.total, i.due_date, i.sent_at, i.viewed_at, i.paid_at, i.public_token,
              u.name AS created_by_name
         FROM job_invoices i LEFT JOIN \`user\` u ON u.id = i.created_by
        WHERE i.job_id = ? ORDER BY i.invoice_seq ASC`,
      [jobId]
    );
    const invoices = (rows || []).map((r) => ({
      id: r.id,
      invoice_seq: r.invoice_seq,
      status: r.status || "Draft",
      created_at: r.created_at,
      created_by_name: r.created_by_name || null,
      total: num(r.total),
      due_date: r.due_date,
      sent_at: r.sent_at || null,
      viewed_at: r.viewed_at || null,
      paid_at: r.paid_at || null,
      has_link: !!r.public_token,
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

// GET /invoices/:jobId/:invoiceId — the full invoice document (row + items + the
// live-computed company / bill-to blocks) for the editor page.
router.get("/:jobId/:invoiceId", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const invoiceId = Number(req.params.invoiceId);
  if (!jobId || !invoiceId) return res.status(400).json({ message: "Invalid ids" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const jobNumber = await assignJobNumberIfMissing(connection, jobId);
    const [[inv]] = await connection.query("SELECT * FROM job_invoices WHERE id = ? AND job_id = ? LIMIT 1", [invoiceId, jobId]);
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const [items] = await connection.query("SELECT * FROM job_invoice_items WHERE invoice_id = ? ORDER BY sort ASC, id ASC", [invoiceId]);
    const company = await companyBlock(connection, req._jobCreatedBy);
    const bill_to = await billToBlock(connection, jobId);
    const payload = publicInvoicePayload(inv, jobNumber);
    payload.public_token = inv.public_token || null;
    // A never-saved invoice inherits the company profile's payment instructions.
    if (!payload.payment_instructions) payload.payment_instructions = company.payment_instructions || "";
    return res.json({ invoice: payload, items: mapItems(items), company, bill_to, job_number: jobNumber });
  } catch (err) {
    logger.error("Error fetching invoice", err);
    return res.status(500).json({ message: "Failed to fetch invoice" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /invoices/:jobId — allocate the next per-job invoice number (blank draft).
router.post("/:jobId", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const createdBy = res.locals.id;
  if (!jobId) return res.status(400).json({ message: "Invalid job id" });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const jobNumber = await assignJobNumberIfMissing(connection, jobId);
    await connection.beginTransaction();
    const [[{ next }]] = await connection.query(
      "SELECT COALESCE(MAX(invoice_seq), 0) + 1 AS next FROM job_invoices WHERE job_id = ?",
      [jobId]
    );
    const [ins] = await connection.query(
      "INSERT INTO job_invoices (job_id, invoice_seq, status, issued_date, created_by, created_at) VALUES (?,?, 'Draft', CURDATE(), ?, NOW())",
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

// PUT /invoices/:jobId/:invoiceId — save the editable content (draft). Totals are
// recomputed server-side. Status is NOT changed here.
router.put("/:jobId/:invoiceId", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const invoiceId = Number(req.params.invoiceId);
  if (!jobId || !invoiceId) return res.status(400).json({ message: "Invalid ids" });
  const body = req.body || {};
  const { items, subtotal, tax_amount, total } = computeTotals(body.items, body.tax_rate);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const [[inv]] = await connection.query("SELECT id FROM job_invoices WHERE id = ? AND job_id = ? LIMIT 1", [invoiceId, jobId]);
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    await connection.beginTransaction();
    await connection.query(
      `UPDATE job_invoices SET tax_rate = ?, due_date = ?, notes = ?, payment_instructions = ?,
              subtotal = ?, tax_amount = ?, total = ?, issued_date = COALESCE(issued_date, DATE(created_at)),
              updated_at = NOW() WHERE id = ? AND job_id = ?`,
      [num(body.tax_rate), body.due_date || null, body.notes || null, body.payment_instructions || null,
       subtotal, tax_amount, total, invoiceId, jobId]
    );
    await connection.query("DELETE FROM job_invoice_items WHERE invoice_id = ?", [invoiceId]);
    for (const it of items) {
      await connection.query(
        "INSERT INTO job_invoice_items (invoice_id, description, qty, rate, amount, sort) VALUES (?,?,?,?,?,?)",
        [invoiceId, it.description, it.qty, it.rate, it.amount, it.sort]
      );
    }
    await connection.commit();
    return res.json({ ok: true, subtotal, tax_amount, total });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error("Error saving invoice", err);
    return res.status(500).json({ message: "Failed to save invoice" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /invoices/:jobId/:invoiceId/share-link — ensure a public token + return the URL.
router.post("/:jobId/:invoiceId/share-link", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const invoiceId = Number(req.params.invoiceId);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const [[inv]] = await connection.query("SELECT id, public_token FROM job_invoices WHERE id = ? AND job_id = ? LIMIT 1", [invoiceId, jobId]);
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const token = await ensureToken(connection, inv);
    return res.json({ token, url: `${PUBLIC_BASE}/invoice-preview/${token}` });
  } catch (err) {
    logger.error("Invoice share-link error", err);
    return res.status(500).json({ message: "Failed to create link" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /invoices/:jobId/:invoiceId/send — email the client the view link + PDF.
// The FE posts the same PDF it renders for Download (multipart field "pdf").
router.post("/:jobId/:invoiceId/send", pdfUpload.single("pdf"), blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const invoiceId = Number(req.params.invoiceId);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const jobNumber = await assignJobNumberIfMissing(connection, jobId);
    const [[inv]] = await connection.query("SELECT * FROM job_invoices WHERE id = ? AND job_id = ? LIMIT 1", [invoiceId, jobId]);
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const bill_to = await billToBlock(connection, jobId);
    const to = (req.body && req.body.to) || bill_to.client_email;
    if (!to) return res.status(400).json({ code: "NO_CLIENT_EMAIL", message: "This job's client has no email. Add one on the job, or enter a recipient." });
    const company = await companyBlock(connection, req._jobCreatedBy);
    const token = await ensureToken(connection, inv);
    const url = `${PUBLIC_BASE}/invoice-preview/${token}`;
    const num5 = displayNumber(jobNumber, inv.invoice_seq);
    const fromName = company.name || "Your contractor";
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
        <p>Hello${bill_to.client_name ? " " + bill_to.client_name : ""},</p>
        <p>${fromName} has sent you invoice <b>#${num5}</b>${inv.total != null ? ` for <b>$${num(inv.total).toFixed(2)}</b>` : ""}.</p>
        <p style="margin:22px 0"><a href="${url}" style="background:#c42034;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">View invoice</a></p>
        <p>The invoice is also attached as a PDF.</p>
        <p style="color:#888;font-size:12px">If the button doesn't work, paste this link into your browser:<br>${url}</p>
      </div>`;
    const attachments = [];
    if (req.file && req.file.buffer && req.file.buffer.length) {
      attachments.push({ filename: `invoice-${num5}.pdf`, content: req.file.buffer, contentType: "application/pdf" });
    }
    await mailer.sendMail({ to, subject: `Invoice #${num5} from ${fromName}`, html, attachments });
    // First send stamps sent_at + moves Draft → Sent (never downgrades Viewed/Paid).
    await connection.query(
      "UPDATE job_invoices SET sent_at = COALESCE(sent_at, NOW()), status = CASE WHEN status = 'Draft' OR status IS NULL THEN 'Sent' ELSE status END WHERE id = ?",
      [invoiceId]
    );
    return res.json({ ok: true, url, sent_to: to });
  } catch (err) {
    logger.error("Invoice send error", err);
    return res.status(500).json({ message: "Failed to send the invoice" });
  } finally {
    if (connection) connection.release();
  }
});

// POST /invoices/:jobId/:invoiceId/mark-paid  and  /mark-unpaid (manual, no processor).
router.post("/:jobId/:invoiceId/mark-paid", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const invoiceId = Number(req.params.invoiceId);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const [r] = await connection.query("UPDATE job_invoices SET status = 'Paid', paid_at = COALESCE(paid_at, NOW()) WHERE id = ? AND job_id = ?", [invoiceId, jobId]);
    if (!r.affectedRows) return res.status(404).json({ message: "Invoice not found" });
    return res.json({ ok: true, status: "Paid" });
  } catch (err) {
    logger.error("Invoice mark-paid error", err);
    return res.status(500).json({ message: "Failed to update" });
  } finally {
    if (connection) connection.release();
  }
});
router.post("/:jobId/:invoiceId/mark-unpaid", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const invoiceId = Number(req.params.invoiceId);
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    const [[inv]] = await connection.query("SELECT sent_at, viewed_at FROM job_invoices WHERE id = ? AND job_id = ? LIMIT 1", [invoiceId, jobId]);
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const revert = inv.viewed_at ? "Viewed" : (inv.sent_at ? "Sent" : "Draft");
    await connection.query("UPDATE job_invoices SET status = ?, paid_at = NULL WHERE id = ? AND job_id = ?", [revert, invoiceId, jobId]);
    return res.json({ ok: true, status: revert });
  } catch (err) {
    logger.error("Invoice mark-unpaid error", err);
    return res.status(500).json({ message: "Failed to update" });
  } finally {
    if (connection) connection.release();
  }
});

// PATCH /invoices/:jobId/:invoiceId/tracking — edit status + Sent/Viewed/Paid
// timestamps directly from the Billing list's History expander. Owner-only (guarded).
router.patch("/:jobId/:invoiceId/tracking", blockExpiredOwnRecord(jobIdOf, asJob), async (req, res) => {
  const jobId = Number(req.params.jobId);
  const invoiceId = Number(req.params.invoiceId);
  const body = req.body || {};
  const sets = [], params = [];
  if (body.status !== undefined) {
    const s = String(body.status);
    if (!["Draft", "Sent", "Viewed", "Paid"].includes(s)) return res.status(400).json({ message: "Invalid status" });
    sets.push("status = ?"); params.push(s);
    if (s === "Paid") { sets.push("paid_at = COALESCE(paid_at, NOW())"); }
  }
  for (const f of ["sent_at", "viewed_at", "paid_at"]) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(body[f] || null); }
  }
  if (!sets.length) return res.json({ ok: true });
  let connection;
  try {
    connection = await pool.getConnection();
    await ensureInvoiceDocumentSchema(connection);
    params.push(invoiceId, jobId);
    const [r] = await connection.query(`UPDATE job_invoices SET ${sets.join(", ")} WHERE id = ? AND job_id = ?`, params);
    if (!r.affectedRows) return res.status(404).json({ message: "Invoice not found" });
    return res.json({ ok: true });
  } catch (err) {
    logger.error("Invoice tracking-edit error", err);
    return res.status(500).json({ message: "Failed to update tracking" });
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
    await connection.query("DELETE FROM job_invoice_items WHERE invoice_id = ?", [invoiceId]).catch(() => {});
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
