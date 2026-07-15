const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require("nodemailer");
const auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp, nowFor, todayFor, getUserTz } = require("../common/timdate");
const PDFDocument = require("pdfkit");
const pdf = require("html-pdf");
const { v4: uuidv4 } = require("uuid");

async function sendInviteEmail(toEmail, inviterName) {
  const mailOptions = {
    from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: "Invitation to Join SeeJobRun",
    text: `Mr. ${inviterName} You are invited to join SeeJobRun. Please sign up and accept the invitation at: https://seejobrun.com/signup`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Invitation to Join SeeJobRun</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .logo-container { text-align: center; padding: 20px 0; }
            .logo { max-width: 150px; height: auto; }
            .header { background-color: #2196F3; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 30px; border: 1px solid #ddd; }
            .invite-box { background-color: #e3f2fd; padding: 15px; text-align: center; font-size: 18px; font-weight: bold; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #777; font-size: 14px; }
            .signup-link { display: inline-block; padding: 10px 20px; background-color: #2196F3; color: white!important; text-decoration: none; border-radius: 4px; margin: 15px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo-container">
              <img src="http://seejobrun.com/user-dashboard/assets/seeJobRun.png" alt="SeeJobRun Logo" class="logo">
            </div>
            <div class="header">
              <h1>You're Invited!</h1>
            </div>
            <div class="content">
              <h2>Join SeeJobRun</h2>
              <p>Hello,</p>
              <p><strong>Mr. ${inviterName}</strong> You are invited to join <strong>SeeJobRun</strong>.</p>
              <div class="invite-box">Accept the invitation and sign up today!</div>
              <a href="http://seejobrun.com/user-dashboard/signup" class="signup-link">Accept Invitation</a>
              <p>If you werenâ€™t expecting this invitation, you may ignore this email.</p>
            </div>
            <div class="footer">
              <p>&copy; 2025 SeeJobRun. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info("Invitation email sent successfully!");
  } catch (error) {
    logger.error("Error sending invitation email:", error);
  }
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: true, // true if using port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false, // allow self-signed certs if needed
  },
});

// ============ PUBLIC (no auth) routes for external client quote preview ============

// GET public quote by token (no authentication required)
router.get('/quotes/public/:token', async (req, res) => {
  let connection;
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token required' });

    connection = await pool.getConnection();

    const [quoteRows] = await connection.execute(
      `SELECT q.*, u.name as creator_name FROM quotes q
       LEFT JOIN user u ON q.created_by_user_id = u.id
       WHERE q.public_token = ? LIMIT 1`,
      [token],
    );

    if (!quoteRows.length) {
      return res.status(404).json({ message: 'Quote not found' });
    }

    const quote = quoteRows[0];
    // Remove internal-only fields
    delete quote.internal_notes;
    delete quote.total_cost_amount;
    delete quote.gross_profit_amount;
    delete quote.gross_profit_pct;

    const [itemRows] = await connection.execute(
      `SELECT id, quote_id, sort_order, description, qty, unit_price, line_total_price
       FROM quote_items WHERE quote_id = ? ORDER BY sort_order ASC, id ASC`,
      [quote.id],
    );

    return res.status(200).json({
      code: '200',
      message: 'Quote fetched',
      data: { quote, items: itemRows },
    });
  } catch (err) {
    logger.error('Public quote fetch error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST accept/reject quote by public token (no authentication required)
router.post('/quotes/public/:token/respond', async (req, res) => {
  let connection;
  try {
    const { token } = req.params;
    const { action, signature_data, signed_name, signed_date, client_notes } = req.body; // action: 'accept' or 'reject'

    if (!token) return res.status(400).json({ message: 'Token required' });
    if (!action || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be "accept" or "reject"' });
    }

    connection = await pool.getConnection();

    const [quoteRows] = await connection.execute(
      `SELECT * FROM quotes WHERE public_token = ? LIMIT 1`,
      [token],
    );

    if (!quoteRows.length) {
      return res.status(404).json({ message: 'Quote not found' });
    }

    const quote = quoteRows[0];

    // Check if quote has expired (valid_until has passed)
    if (quote.valid_until) {
      const validUntilDate = new Date(quote.valid_until);
      validUntilDate.setHours(23, 59, 59, 999);
      if (new Date() > validUntilDate) {
        return res.status(200).json({ code: '410', message: 'This quote has expired and can no longer be accepted or rejected.' });
      }
    }

    const safeClientNotes = client_notes !== undefined ? String(client_notes || '') : null;

    if (action === 'accept') {
      const safeSignedDate = signed_date ? String(signed_date).slice(0, 10) : null;
      await connection.execute(
        `UPDATE quotes
            SET status = 'SIGNED',
                client_signed_at = COALESCE(?, NOW()),
                client_signature_data = ?,
                client_signed_name = ?,
                client_notes = COALESCE(?, client_notes),
                updated_at = ?
          WHERE id = ?`,
        [safeSignedDate, signature_data || null, signed_name || quote.client_name, safeClientNotes, getTimeStamp(), quote.id],
      );
    } else {
      await connection.execute(
        `UPDATE quotes
            SET status = 'REJECTED',
                client_notes = COALESCE(?, client_notes),
                updated_at = ?
          WHERE id = ?`,
        [safeClientNotes, getTimeStamp(), quote.id],
      );
    }

    return res.status(200).json({
      code: '200',
      message: `Quote ${action}ed successfully`,
    });
  } catch (err) {
    logger.error('Public quote respond error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST reactivate an expired quote (sets status back to DRAFT with new 30-day validity)
router.post('/quotes/:id/reactivate', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const created_by_user_id = res.locals.id;
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT id, created_by_user_id FROM quotes WHERE id = ? AND created_by_user_id = ? LIMIT 1`,
      [id, created_by_user_id],
    );
    if (!rows.length) return res.status(404).json({ message: 'Quote not found' });

    // Document dates are shown to the client, so use the owner's calendar day
    // (their saved timezone), not a UTC toISOString() day (off near midnight PT).
    const tz = await getUserTz(connection, created_by_user_id);
    const todayStr = todayFor(tz);
    const validUntilStr = nowFor(tz).add(30, 'days').format('YYYY-MM-DD');

    await connection.execute(
      `UPDATE quotes
          SET status = 'DRAFT',
              quote_date = ?,
              valid_until = ?,
              updated_at = ?
        WHERE id = ?`,
      [todayStr, validUntilStr, getTimeStamp(), id],
    );

    return res.status(200).json({
      code: '200',
      message: 'Quote reactivated successfully',
      data: { quote_date: todayStr, valid_until: validUntilStr },
    });
  } catch (err) {
    logger.error('Quote reactivate error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST send quote email to external client
router.post('/quotes/:id/send-email', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const created_by_user_id = res.locals.id;
    connection = await pool.getConnection();

    const [quoteRows] = await connection.execute(
      `SELECT q.*, u.name as creator_name FROM quotes q
       LEFT JOIN user u ON q.created_by_user_id = u.id
       WHERE q.id = ? AND q.created_by_user_id = ? LIMIT 1`,
      [id, created_by_user_id],
    );

    if (!quoteRows.length) {
      return res.status(404).json({ message: 'Quote not found' });
    }

    const quote = quoteRows[0];
    if (!quote.client_email) {
      return res.status(400).json({ message: 'No client email on this quote' });
    }

    // Ensure public_token exists
    let publicToken = quote.public_token;
    if (!publicToken) {
      publicToken = uuidv4();
      await connection.execute(
        `UPDATE quotes SET public_token = ? WHERE id = ?`,
        [publicToken, quote.id],
      );
    }

    const frontendBase = 'https://seejobrun.com/user-dashboard';
    const previewUrl = `${frontendBase}/quote-preview/${publicToken}`;
    const creatorName = quote.creator_name || 'Someone';

    const [itemRows] = await connection.execute(
      `SELECT description, qty, unit_price, line_total_price FROM quote_items WHERE quote_id = ? ORDER BY sort_order ASC`,
      [quote.id],
    );

    let itemsHtml = '';
    itemRows.forEach((item, idx) => {
      itemsHtml += `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${idx + 1}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${item.description}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${item.qty}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">$${Number(item.unit_price).toFixed(2)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">$${Number(item.line_total_price).toFixed(2)}</td>
      </tr>`;
    });

    const mailOptions = {
      from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
      to: quote.client_email,
      subject: `Quote from ${creatorName} â€” ${quote.project_address || 'Your Project'}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; }
            .container { max-width: 640px; margin: 0 auto; padding: 20px; }
            .header { background: #2f6fa7; color: #fff; padding: 24px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background: #f9fbfd; padding: 28px; border: 1px solid #e0e8ef; border-top: none; border-radius: 0 0 8px 8px; }
            .info-row { margin-bottom: 6px; }
            .info-label { font-weight: bold; color: #555; }
            table { width: 100%; border-collapse: collapse; margin: 16px 0; }
            th { background: #eef6fb; padding: 10px 8px; text-align: left; font-size: 13px; color: #2f6fa7; }
            .total-row { font-weight: bold; font-size: 16px; }
            .btn { display: inline-block; padding: 14px 32px; background: #2f6fa7; color: #fff !important; text-decoration: none; border-radius: 6px; font-size: 16px; margin: 20px 0; }
            .footer { text-align: center; margin-top: 24px; color: #888; font-size: 13px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin:0;font-size:22px;">You Have a Quote to Review</h1>
            </div>
            <div class="content">
              <p>Hello <strong>${quote.client_name || 'there'}</strong>,</p>
              <p><strong>${creatorName}</strong>${quote.company_name ? ' from <strong>' + quote.company_name + '</strong>' : ''} has sent you a quote for your review.</p>
              
              <div class="info-row"><span class="info-label">Project:</span> ${quote.project_address || 'â€”'}</div>
              <div class="info-row"><span class="info-label">Quote Date:</span> ${quote.quote_date || 'â€”'}</div>
              <div class="info-row"><span class="info-label">Valid Until:</span> ${quote.valid_until || 'â€”'}</div>

              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Description</th><th>Qty</th><th style="text-align:right;">Price</th><th style="text-align:right;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                </tbody>
              </table>

              <div class="total-row" style="text-align:right;margin:12px 0;">
                Grand Total: <strong>$${Number(quote.grand_total_amount || 0).toFixed(2)}</strong>
              </div>

              ${quote.client_notes ? '<p><strong>Notes:</strong> ' + quote.client_notes + '</p>' : ''}

              <div style="text-align:center;">
                <a href="${previewUrl}" class="btn">Review &amp; Respond to Quote</a>
              </div>
              <p style="font-size:13px;color:#888;">Or copy this link: ${previewUrl}</p>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} SeeJobRun. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    logger.info(`Sending quote email to: ${quote.client_email} preview URL: ${previewUrl}`);
    await transporter.sendMail(mailOptions);
    logger.info(`Quote email sent successfully to: ${quote.client_email}`);

    return res.status(200).json({ code: '200', message: 'Quote email sent to client' });
  } catch (err) {
    logger.error('Quote email send error:', err);
    return res.status(500).json({ message: 'Failed to send email', error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

//get contacts
router.get(
  "/get_Jobcontacts/:jid",
  auth.authenticateToken,
  async (req, res) => {
    let connection;
    try {
      const { jid } = req.params;
      connection = await pool.getConnection();

      const [rows] = await connection.execute(
        `Select u.name, u.id,u.email, s.name as 'designation', c.name as 'role' from job_contacts jc
            join job j ON jc.job_id = j.id
            join user u ON jc.contact_id = u.id
            join subcategory s  ON  u.subcategory = s.id
            join category c ON u.category = c.id
            where jc.job_id = ? AND jc.owner_type = 'job'`,
        [jid]
      );
      res.status(200).json(rows);
    } catch (err) {
      res.status(500).json({ message: "Database error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

//get contacts
router.get("/get_jobs/:user_id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const user_id = req.params.user_id; // <-- from URL param

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT * FROM job WHERE status = 1 AND created_by = ? ORDER BY created_at DESC`,
      [user_id]
    );

    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ---------------- Quote Manager (new) ----------------

router.post('/quotes', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const userId = res.locals.id;
    const effectiveCreatorId =
      req.user && [2, 3, 4, 5].includes(Number(req.user.role)) && req.user.working_id
        ? Number(req.user.working_id)
        : Number(userId);
    const currentTimestamp = getTimeStamp();

    const {
      company_id,
      status,
      client_name,
      client_phone,
      client_email,
      quote_date,
      valid_until,
      project_address,
      scope_category,
      client_notes,
      internal_notes,
      company_name,
      company_address,
      company_logo,
      items,
    } = req.body;

    const safeCompanyId = company_id ? Number(company_id) : 0;
    if (!client_name) {
      return res.status(200).json({ code: '400', message: 'client_name is required', data: {} });
    }
    if (!quote_date) {
      return res.status(200).json({ code: '400', message: 'quote_date is required', data: {} });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(200).json({ code: '400', message: 'At least one line item is required', data: {} });
    }

    const safeStatus = status || 'DRAFT';

    const computeLine = (it) => {
      const qty = Number(it.qty ?? 0);
      const unit_price = Number(it.unit_price ?? 0);
      const unit_cost = Number(it.unit_cost ?? 0);
      const line_total_price = qty * unit_price;
      const line_total_cost = qty * unit_cost;
      const line_profit_amount = line_total_price - line_total_cost;
      return {
        description: String(it.description || ''),
        qty,
        unit_price,
        unit_cost,
        line_total_price,
        line_total_cost,
        line_profit_amount,
      };
    };

    const normalizedItems = items.map(computeLine);
    const subtotal_amount = normalizedItems.reduce((s, x) => s + x.line_total_price, 0);
    const total_cost_amount = normalizedItems.reduce((s, x) => s + x.line_total_cost, 0);
    const gross_profit_amount = subtotal_amount - total_cost_amount;
    const gross_profit_pct = subtotal_amount ? (gross_profit_amount / subtotal_amount) * 100 : 0;
    const grand_total_amount = subtotal_amount;

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const publicToken = uuidv4();
    const quoteInsertSql = `INSERT INTO quotes (
      company_id,
      created_by_user_id,
      status,
      client_name,
      client_phone,
      client_email,
      quote_date,
      valid_until,
      project_address,
      scope_category,
      client_notes,
      internal_notes,
      company_name,
      company_address,
      company_logo,
      subtotal_amount,
      total_cost_amount,
      gross_profit_amount,
      gross_profit_pct,
      grand_total_amount,
      public_token,
      created_at,
      updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const [quoteInsertResult] = await connection.execute(quoteInsertSql, [
      safeCompanyId,
      effectiveCreatorId,
      safeStatus,
      client_name,
      client_phone || null,
      client_email,
      quote_date,
      valid_until || null,
      project_address || null,
      scope_category || null,
      client_notes || null,
      internal_notes || null,
      company_name || null,
      company_address || null,
      company_logo || null,
      subtotal_amount,
      total_cost_amount,
      gross_profit_amount,
      gross_profit_pct,
      grand_total_amount,
      publicToken,
      currentTimestamp,
      currentTimestamp,
    ]);

    const quoteId = quoteInsertResult.insertId;

    await connection.execute(
      `UPDATE quotes SET quote_number = ? WHERE id = ?`,
      [`Q-${quoteId}`, quoteId],
    );

    const itemInsertSql = `INSERT INTO quote_items (
      quote_id,
      sort_order,
      description,
      qty,
      unit_price,
      unit_cost,
      line_total_price,
      line_total_cost,
      line_profit_amount,
      created_at,
      updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

    for (let i = 0; i < normalizedItems.length; i++) {
      const it = normalizedItems[i];
      if (!it.description) {
        await connection.rollback();
        return res.status(200).json({ code: '400', message: 'Line item description is required', data: {} });
      }
      await connection.execute(itemInsertSql, [
        quoteId,
        Number(items[i].sort_order ?? i),
        it.description,
        it.qty,
        it.unit_price,
        it.unit_cost,
        it.line_total_price,
        it.line_total_cost,
        it.line_profit_amount,
        currentTimestamp,
        currentTimestamp,
      ]);
    }

    await connection.commit();
    return res.status(200).json({ code: '200', message: 'Quote created successfully', data: { id: quoteId } });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error('Quote create error:', err);

    const errCode = err && (err.code || err.errno) ? String(err.code || err.errno) : '';
    const errMsg = err && (err.sqlMessage || err.message) ? String(err.sqlMessage || err.message) : 'Internal server error';
    const lowerMsg = errMsg.toLowerCase();

    // Common failure when sending base64 logos/signatures: DB column too small or max_packet too small.
    if (errCode === 'ER_DATA_TOO_LONG' || lowerMsg.includes('data too long')) {
      const logoHint = lowerMsg.includes('company_logo') ? ' Company logo is too large.' : '';
      return res.status(200).json({ code: '400', message: `Payload too large for database field.${logoHint}`, data: {} });
    }
    if (errCode === 'ER_NET_PACKET_TOO_LARGE' || lowerMsg.includes('packet')) {
      return res.status(200).json({ code: '400', message: 'Payload too large. Please upload a smaller company logo.', data: {} });
    }

    return res.status(200).json({ code: '500', message: errMsg, data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/quotes', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const userId = res.locals.id;
    const effectiveCreatorId =
      req.user && [2, 3, 4, 5].includes(Number(req.user.role)) && req.user.working_id
        ? Number(req.user.working_id)
        : Number(userId);
    let loggedInEmail = '';
    const { company_id, status, q } = req.query;

    connection = await pool.getConnection();

   const [meRows] = await connection.execute(
      `SELECT email FROM user WHERE id = ? LIMIT 1`,
      [userId],
    );
    loggedInEmail = meRows && meRows.length && meRows[0].email
      ? String(meRows[0].email).trim().toLowerCase()
      : '';

    const where = ['created_by_user_id = ?'];

    const params = [effectiveCreatorId];
if (loggedInEmail) {
      where[0] = `(created_by_user_id = ? OR LOWER(client_email) = ?)`;
      params.push(loggedInEmail);
    }
    if (q) {
      where.push('(quote_number LIKE ? OR client_name LIKE ? OR client_email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const [rows] = await connection.execute(
      `SELECT * FROM quotes WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
      params,
    );

    return res.status(200).json({ code: '200', message: 'Quotes fetched successfully', data: rows });
  } catch (err) {
    logger.error('Quote list error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: [] });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/quotes/:id', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const userId = res.locals.id;
    const effectiveCreatorId =
      req.user && [2, 3, 4, 5].includes(Number(req.user.role)) && req.user.working_id
        ? Number(req.user.working_id)
        : Number(userId);
    let loggedInEmail = '';
    const { id } = req.params;

    connection = await pool.getConnection();

    const [meRows] = await connection.execute(
      `SELECT email FROM user WHERE id = ? LIMIT 1`,
      [userId],
    );
    loggedInEmail = meRows && meRows.length && meRows[0].email
      ? String(meRows[0].email).trim().toLowerCase()
      : '';

    const [quoteRows] = await connection.execute(
      `SELECT q.*, u.name as creator_name FROM quotes q 
       LEFT JOIN user u ON q.created_by_user_id = u.id 
       WHERE q.id = ? LIMIT 1`,
      [id],
    );

    if (!quoteRows.length) {
      return res.status(200).json({ code: '404', message: 'Quote not found', data: {} });
    }

    const quote = quoteRows[0];
    const qClientEmail = quote.client_email ? String(quote.client_email).trim().toLowerCase() : '';
    const canAccessAsCreator = Number(quote.created_by_user_id) === Number(effectiveCreatorId);
    const canAccessAsClient = !!loggedInEmail && !!qClientEmail && loggedInEmail === qClientEmail;
    if (!canAccessAsCreator && !canAccessAsClient) {
      return res.status(200).json({ code: '404', message: 'Quote not found', data: {} });
    }

    const [itemRows] = await connection.execute(
      `SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order ASC, id ASC`,
      [id],
    );

    return res.status(200).json({
      code: '200',
      message: 'Quote fetched successfully',
      data: { quote, items: itemRows },
    });
  } catch (err) {
    logger.error('Quote get error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/quotes/:id/sign', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const userId = res.locals.id;
    let loggedInEmail = '';
    const currentTimestamp = getTimeStamp();
    const { id } = req.params;
    const { signature_data, signed_name, sign_as, client_notes } = req.body || {};

    const safeSignAs = String(sign_as || '').trim().toLowerCase();
    if (safeSignAs !== 'client' && safeSignAs !== 'creator') {
      return res.status(200).json({ code: '400', message: 'sign_as must be client or creator', data: {} });
    }
    if (!signature_data) {
      return res.status(200).json({ code: '400', message: 'signature_data is required', data: {} });
    }
    if (!signed_name) {
      return res.status(200).json({ code: '400', message: 'signed_name is required', data: {} });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [meRows] = await connection.execute(
      `SELECT email FROM user WHERE id = ? LIMIT 1`,
      [userId],
    );
    loggedInEmail = meRows && meRows.length && meRows[0].email
      ? String(meRows[0].email).trim().toLowerCase()
      : '';

    const [quoteRows] = await connection.execute(
      `SELECT id, created_by_user_id, client_email,
              creator_signature_data, creator_signed_name, creator_signed_at,
              client_signature_data, client_signed_name, client_signed_at
         FROM quotes
        WHERE id = ?
        LIMIT 1`,
      [id],
    );

    if (!quoteRows.length) {
      await connection.rollback();
      return res.status(200).json({ code: '404', message: 'Quote not found', data: {} });
    }

    const quote = quoteRows[0];
    const qClientEmail = quote.client_email ? String(quote.client_email).trim().toLowerCase() : '';
    const isCreator = Number(quote.created_by_user_id) === Number(userId);
    const isClient = !!loggedInEmail && !!qClientEmail && loggedInEmail === qClientEmail;

    if (safeSignAs === 'creator' && !isCreator) {
      await connection.rollback();
      return res.status(200).json({ code: '403', message: 'Not allowed to sign as creator', data: {} });
    }
    if (safeSignAs === 'client' && !isClient) {
      await connection.rollback();
      return res.status(200).json({ code: '403', message: 'Not allowed to sign as client', data: {} });
    }

    if (safeSignAs === 'creator') {
      await connection.execute(
        `UPDATE quotes
            SET creator_signature_data = ?,
                creator_signed_name = ?,
                creator_signed_at = ?,
                updated_at = ?
          WHERE id = ?`,
        [signature_data, signed_name, currentTimestamp, currentTimestamp, id],
      );
    } else {
      await connection.execute(
        `UPDATE quotes
            SET client_signature_data = ?,
                client_signed_name = ?,
                client_signed_at = ?,
                client_notes = ?,
                updated_at = ?
          WHERE id = ?`,
        [signature_data, signed_name, currentTimestamp, client_notes || null, currentTimestamp, id],
      );
    }

    // Mark quote as SIGNED immediately after the client signs.
    // Creator is allowed to sign after status becomes SIGNED.
    if (safeSignAs === 'client') {
      await connection.execute(
        `UPDATE quotes SET status = 'SIGNED', updated_at = ? WHERE id = ?`,
        [currentTimestamp, id],
      );
    }

    const [updatedRows] = await connection.execute(
      `SELECT creator_signed_at, client_signed_at FROM quotes WHERE id = ? LIMIT 1`,
      [id],
    );
    const bothSigned = !!updatedRows[0]?.creator_signed_at && !!updatedRows[0]?.client_signed_at;

    await connection.commit();
    return res.status(200).json({
      code: '200',
      message: bothSigned ? 'Quote signed by both parties' : 'Signature saved',
      data: { fully_signed: bothSigned },
    });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error('Quote sign error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/quotes/:id', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const updated_by_user_id = res.locals.id;
    const currentTimestamp = getTimeStamp();
    const { id } = req.params;

    const {
      status,
      client_name,
      client_phone,
      client_email,
      quote_date,
      valid_until,
      project_address,
      scope_category,
      client_notes,
      internal_notes,
      company_name,
      company_address,
      company_logo,
      items,
    } = req.body;

    if (!client_name) {
      return res.status(200).json({ code: '400', message: 'client_name is required', data: {} });
    }
    if (!quote_date) {
      return res.status(200).json({ code: '400', message: 'quote_date is required', data: {} });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(200).json({ code: '400', message: 'At least one line item is required', data: {} });
    }

    const computeLine = (it) => {
      const qty = Number(it.qty ?? 0);
      const unit_price = Number(it.unit_price ?? 0);
      const unit_cost = Number(it.unit_cost ?? 0);
      const line_total_price = qty * unit_price;
      const line_total_cost = qty * unit_cost;
      const line_profit_amount = line_total_price - line_total_cost;
      return {
        description: String(it.description || ''),
        qty,
        unit_price,
        unit_cost,
        line_total_price,
        line_total_cost,
        line_profit_amount,
      };
    };

    const normalizedItems = items.map(computeLine);
    const subtotal_amount = normalizedItems.reduce((s, x) => s + x.line_total_price, 0);
    const total_cost_amount = normalizedItems.reduce((s, x) => s + x.line_total_cost, 0);
    const gross_profit_amount = subtotal_amount - total_cost_amount;
    const gross_profit_pct = subtotal_amount ? (gross_profit_amount / subtotal_amount) * 100 : 0;
    const grand_total_amount = subtotal_amount;

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.execute(
      `SELECT id FROM quotes WHERE id = ? AND created_by_user_id = ? LIMIT 1`,
      [id, updated_by_user_id],
    );

    if (!existing.length) {
      await connection.rollback();
      return res.status(200).json({ code: '404', message: 'Quote not found', data: {} });
    }

    await connection.execute(
      `UPDATE quotes SET
        status = ?,
        client_name = ?,
        client_phone = ?,
        client_email = ?,
        quote_date = ?,
        valid_until = ?,
        project_address = ?,
        scope_category = ?,
        client_notes = ?,
        internal_notes = ?,
        company_name = ?,
        company_address = ?,
        company_logo = ?,
        subtotal_amount = ?,
        total_cost_amount = ?,
        gross_profit_amount = ?,
        gross_profit_pct = ?,
        grand_total_amount = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        status || 'DRAFT',
        client_name,
        client_phone || null,
        client_email || null,
        quote_date,
        valid_until || null,
        project_address || null,
        scope_category || null,
        client_notes || null,
        internal_notes || null,
        company_name || null,
        company_address || null,
        company_logo || null,
        subtotal_amount,
        total_cost_amount,
        gross_profit_amount,
        gross_profit_pct,
        grand_total_amount,
        currentTimestamp,
        id,
      ],
    );

    await connection.execute(`DELETE FROM quote_items WHERE quote_id = ?`, [id]);

    const itemInsertSql = `INSERT INTO quote_items (
      quote_id,
      sort_order,
      description,
      qty,
      unit_price,
      unit_cost,
      line_total_price,
      line_total_cost,
      line_profit_amount,
      created_at,
      updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

    for (let i = 0; i < normalizedItems.length; i++) {
      const it = normalizedItems[i];
      if (!it.description) {
        await connection.rollback();
        return res.status(200).json({ code: '400', message: 'Line item description is required', data: {} });
      }
      await connection.execute(itemInsertSql, [
        id,
        Number(items[i].sort_order ?? i),
        it.description,
        it.qty,
        it.unit_price,
        it.unit_cost,
        it.line_total_price,
        it.line_total_cost,
        it.line_profit_amount,
        currentTimestamp,
        currentTimestamp,
      ]);
    }

    await connection.commit();
    return res.status(200).json({ code: '200', message: 'Quote updated successfully', data: {} });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error('Quote update error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.delete('/quotes/:id', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const user_id = res.locals.id;
    const { id } = req.params;

    connection = await pool.getConnection();
    const [result] = await connection.execute(
      `DELETE FROM quotes WHERE id = ? AND created_by_user_id = ?`,
      [id, user_id],
    );

    if (!result.affectedRows) {
      return res.status(200).json({ code: '404', message: 'Quote not found', data: {} });
    }

    return res.status(200).json({ code: '200', message: 'Quote deleted successfully', data: {} });
  } catch (err) {
    logger.error('Quote delete error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/create", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { job_id, items, change_quote_type } = req.body;
    // items = [{ description, amount }, { description, amount }]
    const created_by = res.locals.id; // from token
    const currentTimestamp = getTimeStamp();

    if (!items || items.length === 0) {
      return res
        .status(400)
        .json({ message: "one item is required" });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Step 1: Check if job_id already exists in quote
    const [existing] = await connection.execute(
      `SELECT id, completed 
       FROM quote 
       WHERE job_id = ?
       ORDER BY id DESC LIMIT 1`,
      [job_id]
    );

    let quoteId;

    if (existing.length > 0 && existing[0].completed === 0) {
      // Reuse existing unfinished change order
      quoteId = existing[0].id;
    } else {
      // No unfinished record OR existing is completed â†’ create a new row
      const [coResult] = await connection.execute(
        `INSERT INTO quote (job_id, created_at, created_by, completed, change_quote_type)
         VALUES (?, ?, ?, 0,?)`,
        [job_id, currentTimestamp, created_by, change_quote_type]
      );
      quoteId = coResult.insertId;
    }

    // Step 2: Insert all items into change_order_list with change_order_id
    const listQuery = `
      INSERT INTO quote_list (job_id, quote_id, description, amount, created_at, created_by, change_quote_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    for (const item of items) {
      await connection.execute(listQuery, [
        job_id,
        quoteId,
        item.description,
        item.amount,
        currentTimestamp,
        created_by,
        change_quote_type
      ]);
    }

    await connection.commit();

    res.status(201).json({
      message: "Change order created/updated with items",
      quote_id: quoteId,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// GET job by user_id and job_id
router.get(
  "/list-job/:user_id/:job_id",
  auth.authenticateToken,
  async (req, res) => {
    let connection;
    try {
      const { user_id, job_id } = req.params;

      connection = await pool.getConnection();
      const [rows] = await connection.execute(
        `SELECT 
       co.id AS quote_id,
       co.job_id,
       co.created_by,
       co.completed,
       col.description,
        col.amount,
       j.id   AS lead_id,
       col.id AS item_id,
	   j.name AS job_name
FROM quote co
LEFT JOIN job j       ON co.job_id = j.id
LEFT JOIN quote_list col ON col.quote_id = co.id
WHERE col.created_by=  ? and
      j.id = ?
    AND co.completed = 0

    ORDER BY co.created_at DESC, col.id DESC;`,
        [user_id, job_id]
      );

      res.status(200).json(rows);
    } catch (err) {
      res.status(500).json({ message: "Database error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

// GET leadss quote list by user_id and job_id
router.get(
  "/list/:user_id/:job_id",
  auth.authenticateToken,
  async (req, res) => {
    let connection;
    try {
      const { user_id, job_id } = req.params;

      connection = await pool.getConnection();
      const [rows] = await connection.execute(
        `SELECT 
       co.id AS quote_id,
       co.job_id,
       co.created_by,
       co.completed,
       col.description,
        col.amount,
       j.id   AS lead_id,
       col.id AS item_id,
	   j.lead_name AS job_name
FROM quote co
LEFT JOIN leads j       ON co.job_id = j.id
LEFT JOIN quote_list col ON col.quote_id = co.id
WHERE col.created_by=  ? and
      j.id = ?
    AND co.completed = 0

    ORDER BY co.created_at DESC, col.id DESC;`,
        [user_id, job_id]
      );

      res.status(200).json(rows);
    } catch (err) {
      res.status(500).json({ message: "Database error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

// DELETE change order item
router.delete("/delete/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    connection = await pool.getConnection();
    const [result] = await connection.execute(
      `DELETE FROM quote_list WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "quote not found" });
    }

    res.status(200).json({ message: "quote deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// PUT update change order
// PUT update change order item
router.put("/edit/:id", auth.authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { description, amount, job_id } = req.body;

  if (!description || !amount || !job_id) {
    return res
      .status(400)
      .json({ message: "Description, Amount, and Job are required" });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    const [result] = await connection.execute(
      `UPDATE quote_list 
       SET description = ?, amount = ?, job_id = ? 
       WHERE id = ?`,
      [description, amount, job_id, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "quote not found" });
    }

    res.status(200).json({ message: "quote updated successfully" });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// update change order relations
router.put("/changewith/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params; // change order table id
    const { change_quote_with, change_quote_from } = req.body;

    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `UPDATE quote 
       SET change_quote_with = ?, change_quote_from  = ? , completed = 1
       WHERE job_id = ?`,
      [change_quote_with, change_quote_from, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "quote not found" });
    }

    res.status(200).json({ message: "quote successfully" });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/get_employees/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `Select u.id, u.name, u.email, u.mobile,u.subcategory,u.category, s.name as 'subcategory', c.name as 'role' from user u
        join subcategory s on u.subcategory = s.id
        join category c on u.category = c.id 
        where u.created_by = ? And u.category = 1`,
      [id]
    );
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/get_all_users", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const created_by = res.locals.id;
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT u.id, u.name, u.email, u.mobile, u.subcategory, u.category,
              s.name AS subcategory_name, c.name AS role
       FROM user u
       LEFT JOIN subcategory s ON u.subcategory = s.id
       LEFT JOIN category c ON u.category = c.id
       WHERE u.id != ?
       ORDER BY u.name ASC`,
      [created_by]
    );
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/add_contact", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { job_id, emp_id, change_quote_type } = req.body;
    const created_by = res.locals.id; // from token
    const created_at = getTimeStamp();

    if (!job_id || !emp_id) {
      return res
        .status(400)
        .json({ message: "Job ID and Employee ID are required" });
    }

    connection = await pool.getConnection();

    // 1ï¸âƒ£ Find active change_order for this job
    const [active] = await connection.execute(
      `SELECT id FROM quote 
         WHERE job_id = ? AND completed = 0 AND change_quote_type = ?
         ORDER BY created_at DESC LIMIT 1`,
      [job_id, change_quote_type]
    );

    if (active.length === 0) {
      return res.status(400).json({
        message: "No active change order for this job. Cannot assign contact.",
      });
    }

    const quote_id = active[0].id;

    // 2ï¸âƒ£ Prevent duplicate assignment for the same change_order
    const [existing] = await connection.execute(
      `SELECT id FROM quote_emp 
         WHERE quote_id = ? AND emp_id = ?  AND change_quote_type = ?`,
      [quote_id, emp_id, change_quote_type]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: "Employee already assigned to this active quote",
      });
    }

    // 3ï¸âƒ£ Insert new record with change_order_id
    const [result] = await connection.execute(
      `INSERT INTO quote_emp
         (quote_id, job_id, emp_id, created_at, created_by, change_quote_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [quote_id, job_id, emp_id, created_at, created_by, change_quote_type]
    );

    res.status(201).json({
      message: "Employee assigned to active change order",
      id: result.insertId,
      quote_id,
    });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Get all contacts for a job
router.get(
  "/job_contacts/:job_id/:change_quote_type",
  auth.authenticateToken,
  async (req, res) => {
    let connection;
    try {
      const { job_id, change_quote_type } = req.params;
      connection = await pool.getConnection();

      const [rows] = await connection.execute(
        `SELECT coe.id, u.name, u.email, u.image, s.name AS subcategory, c.name AS role, co.completed,coe.job_id
       FROM quote_emp coe
       Join quote co ON coe.quote_id = co.id
       JOIN user u ON coe.emp_id = u.id
       JOIN subcategory s ON u.subcategory = s.id
       JOIN category c ON u.category = c.id
       WHERE coe.job_id = ? and coe.change_quote_type = ?`,
        [job_id, change_quote_type]
      );

      res.status(200).json(rows);
    } catch (err) {
      res.status(500).json({ message: "Database error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

router.get("/details/:job_id/:change_quote_type", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const changeorder_with = res.locals.id;
    const { job_id, change_quote_type } = req.params;  // now both are available

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `
      SELECT 
        co.id AS quote_id,
        co.status,
        co.completed,
        co.created_by,
        co.created_at,
        j.id AS job_id,
        j.name AS job_name,

        -- quote_from (user)
        u_from.id AS from_user_id,
        u_from.name AS from_user_name,
        u_from.email AS from_user_email,
        cat_from.name AS from_category,
        sub_from.name AS from_subcategory,
        u_from.street AS from_user_street,
          u_from.city AS from_user_city,
          u_from.state AS from_user_state,
          u_from.mobile AS from_user_mobile,

        u_with.id AS with_user_id,
        u_with.name AS with_user_name,
        u_with.email AS with_user_email,
        cat_with.name AS with_category,
        sub_with.name AS with_subcategory,
        u_with.street AS with_user_street,
          u_with.city AS with_user_city,
          u_with.state AS with_user_state,
          u_with.mobile AS with_user_mobile,

        JSON_ARRAYAGG(
          JSON_OBJECT(
            'id', u.id,
            'name', u.name,
            'email', u.email,
            'mobile', u.mobile,
            'category', c.name,
            'subcategory', s.name
          )
        ) AS employees,

        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', col.id,
              'description', col.description,
              'amount', col.amount
            )
          )
          FROM quote_list col
          WHERE col.quote_id = co.id
            AND co.completed = 1
            AND col.change_quote_type = ?
        ) AS items

      FROM quote co
      JOIN job j ON co.job_id = j.id

      LEFT JOIN user u_from ON co.change_quote_from = u_from.id
      LEFT JOIN category cat_from ON u_from.category = cat_from.id
      LEFT JOIN subcategory sub_from ON u_from.subcategory = sub_from.id

      LEFT JOIN user u_with ON co.change_quote_with = u_with.id
      LEFT JOIN category cat_with ON u_with.category = cat_with.id
      LEFT JOIN subcategory sub_with ON u_with.subcategory = sub_with.id

      LEFT JOIN quote_emp coe ON co.id = coe.quote_id
      LEFT JOIN user u ON coe.emp_id = u.id
      LEFT JOIN category c ON u.category = c.id
      LEFT JOIN subcategory s ON u.subcategory = s.id

      WHERE (co.job_id = ? OR co.change_quote_with = ?)
        AND co.change_quote_type = ?
      GROUP BY co.id
      `,
      [change_quote_type, job_id, changeorder_with, change_quote_type]
    );

    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});


router.get("/lead_details/:job_id/:change_quote_type", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const changeorder_with = res.locals.id;
    const { job_id, change_quote_type } = req.params;  // now both are available

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `
      SELECT 
        co.id AS quote_id,
        co.status,
        co.completed,
        j.id AS job_id,
        j.lead_name AS job_name,

        -- quote_from (user)
        u_from.id AS from_user_id,
        u_from.name AS from_user_name,
        u_from.email AS from_user_email,
        cat_from.name AS from_category,
        sub_from.name AS from_subcategory,

        u_with.id AS with_user_id,
        u_with.name AS with_user_name,
        u_with.email AS with_user_email,
        cat_with.name AS with_category,
        sub_with.name AS with_subcategory,

        JSON_ARRAYAGG(
          JSON_OBJECT(
            'id', u.id,
            'name', u.name,
            'email', u.email,
            'mobile', u.mobile,
            'category', c.name,
            'subcategory', s.name
          )
        ) AS employees,

        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', col.id,
              'description', col.description,
              'amount', col.amount
            )
          )
          FROM quote_list col
          WHERE col.quote_id = co.id
            AND co.completed = 1
            AND col.change_quote_type = ?
        ) AS items

      FROM quote co
      JOIN leads j ON co.job_id = j.id

      LEFT JOIN user u_from ON co.change_quote_from = u_from.id
      LEFT JOIN category cat_from ON u_from.category = cat_from.id
      LEFT JOIN subcategory sub_from ON u_from.subcategory = sub_from.id

      LEFT JOIN user u_with ON co.change_quote_with = u_with.id
      LEFT JOIN category cat_with ON u_with.category = cat_with.id
      LEFT JOIN subcategory sub_with ON u_with.subcategory = sub_with.id

      LEFT JOIN quote_emp coe ON co.id = coe.quote_id
      LEFT JOIN user u ON coe.emp_id = u.id
      LEFT JOIN category c ON u.category = c.id
      LEFT JOIN subcategory s ON u.subcategory = s.id

      WHERE (co.job_id = ? OR co.change_quote_with = ?)
        AND co.change_quote_type = ?
      GROUP BY co.id
      `,
      [change_quote_type, job_id, changeorder_with, change_quote_type]
    );

    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Update Change Order Status (Approve/Reject)
router.put("/status/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const { status, reason } = req.body; // status = 1 (accept), 2 (reject), reason optional

    connection = await pool.getConnection();

    const query = `
      UPDATE quote
      SET status = ?, reason = ?
      WHERE id = ?
    `;

    await connection.query(query, [status, reason || null, id]);

    res
      .status(200)
      .json({ message: "quote status updated successfully" });
  } catch (err) {
    logger.error("Error updating quote status:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post(
  "/email-quote/:quoteId",
  auth.authenticateToken,
  async (req, res) => {
    const { quoteId } = req.params;

    const { contacts } = req.body; // recipients = array of emails
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ message: "Recipients required" });
    }

    let connection;
    try {
      connection = await pool.getConnection();

      // ----- Fetch all change-order data -----
      const [rows] = await connection.execute(
        `SELECT
         co.id AS quote_id,
         co.status,
         co.completed,
         j.id  AS job_id,
         j.name AS job_name,

         u_from.id   AS from_user_id,
         u_from.name AS from_user_name,
         u_from.email AS from_user_email,
         cat_from.name AS from_category,
         sub_from.name AS from_subcategory,

         u_with.id   AS with_user_id,
         u_with.name AS with_user_name,
         u_with.email AS with_user_email,
         cat_with.name AS with_category,
         sub_with.name AS with_subcategory,

         JSON_ARRAYAGG(
           JSON_OBJECT(
             'id', u.id,
             'name', u.name,
             'email', u.email,
             'mobile', u.mobile,
             'category', c.name,
             'subcategory', s.name
           )
         ) AS employees,

         (
           SELECT JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id', col.id,
                      'description', col.description,
                      'amount', col.amount
                    )
                  )
           FROM quote_list col
           WHERE col.quote_id = co.id
         ) AS items
       FROM quote co
       JOIN job j ON co.job_id = j.id
       LEFT JOIN user u_from       ON co.chnage_order_from = u_from.id
       LEFT JOIN category cat_from ON u_from.category = cat_from.id
       LEFT JOIN subcategory sub_from ON u_from.subcategory = sub_from.id
       LEFT JOIN user u_with       ON co.change_quote_with = u_with.id
       LEFT JOIN category cat_with ON u_with.category = cat_with.id
       LEFT JOIN subcategory sub_with ON u_with.subcategory = sub_with.id
       LEFT JOIN quote_emp coe ON co.id = coe.quote_id
       LEFT JOIN user u              ON coe.emp_id = u.id
       LEFT JOIN category c          ON u.category = c.id
       LEFT JOIN subcategory s       ON u.subcategory = s.id
       WHERE co.id = ?
       GROUP BY co.id`,
        [quoteId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "No change order found" });
      }

      const data = rows[0];
      const employees = data.employees || [];
      const items = data.items || [];

      // Calculate total amount
      const totalAmount = items.reduce(
        (sum, item) => sum + parseFloat(item.amount || 0),
        0
      );
      const currentDate = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });

      // Generate HTML content using the provided template
      const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Oak Coast Construction Inc - Invoice</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Arial', sans-serif;
        }
        
        body {
            background-color: #f5f7f9;
            color: #333;
            line-height: 1.6;
            padding: 20px;
        }
        
        .invoice-container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
            border-radius: 8px;
        }
        
        .company-header {
            text-align: center;
            margin-bottom: 25px;
            padding-bottom: 20px;
            border-bottom: 2px solid #2c3e50;
        }
        
        .company-header h1 {
            color: #2c3e50;
            font-size: 28px;
            margin-bottom: 5px;
        }
        
        .company-header p {
            color: #7f8c8d;
            font-size: 14px;
        }
        
        .info-section {
            width: 100%;
            margin-bottom: 25px;
        }
        
        .info-table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 20px 0;
        }
        
        .info-table td {
            width: 50%;
            vertical-align: top;
            padding: 0;
        }
        
        .info-box {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
            border-left: 4px solid #3498db;
        }
        
        .info-box h3 {
            color: #2c3e50;
            margin-bottom: 10px;
            font-size: 16px;
        }
        
        .info-box p {
            margin-bottom: 5px;
            font-size: 14px;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 25px;
        }
        
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        
        th {
            background-color: #2c3e50;
            color: white;
        }
        
        tr:nth-child(even) {
            background-color: #f8f9fa;
        }
        
        .total-section {
            text-align: right;
            margin-bottom: 30px;
        }
        
        .total-amount {
            font-size: 20px;
            font-weight: bold;
            color: #2c3e50;
        }
        
        .signature-section {
            width: 100%;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 2px dashed #ccc;
        }
        
        .signature-table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 30px 0;
        }
        
        .signature-table td {
            width: 50%;
            vertical-align: top;
            padding: 0;
        }
        
        .signature-area {
            padding: 15px;
            background: #f8f9fa;
            border-radius: 6px;
        }
        
        .signature-area h3 {
            margin-bottom: 15px;
            color: #2c3e50;
            font-size: 16px;
        }
        
        .signature-line {
            height: 1px;
            background: #ccc;
            margin: 40px 0 10px;
        }
        
        .approval-section {
            background: #2c3e50;
            color: white;
            padding: 15px;
            border-radius: 6px;
            text-align: center;
            margin-top: 20px;
        }
        
        .notes {
            margin-top: 20px;
            font-style: italic;
            color: #7f8c8d;
            font-size: 14px;
        }
        
        @media print {
            body {
                background: white;
                padding: 0;
            }
            
            .invoice-container {
                box-shadow: none;
                padding: 0;
            }
            
            .no-print {
                display: none;
            }
        }
        
        .button-container {
            text-align: center;
            margin: 20px 0;
        }
        
        .print-button {
            background: #2c3e50;
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            transition: background 0.3s;
        }
        
        .print-button:hover {
            background: #1a252f;
        }
    </style>
</head>
<body>
    <div class="button-container no-print">
        <button class="print-button" onclick="window.print()">Print Invoice</button>
    </div>

    <div class="invoice-container">
        <div class="company-header">
            <h1>Oak Coast Construction Inc</h1>
            <p>General Contractor License #735734</p>
            <p>275 Oro Dr., Arroyo Grande, CA 93420</p>
            <p>(805) 714-0446</p>
        </div>
        
        <div class="info-section">
            <div class="info-box">
                <h3>Date & Change Order</h3>
                <p><strong>Date:</strong> 12/15/2024</p>
                <p><strong>C.O.#:</strong> 1</p>
                <p>Change order with Sub or Client</p>
                <p>Job Owner (Auto-fills)</p>
            </div>
            
            <div class="info-box">
                <h3>Contract Details</h3>
                <p><strong>Contract with:</strong> Mike Jones</p>
                <p><strong>Property Owner:</strong> Mike Jones</p>
                <p><strong>Job:</strong> Jones Residence - Bath Remodel</p>
                <p><strong>Address:</strong> 555 Jack St., Arroyo Grande, CA 93420</p>
            </div>
        </div>
        
        <h2>Bath Room Remodel</h2>
        
        <table>
            <thead>
                <tr>
                    <th>Item #</th>
                    <th>Work Description</th>
                    <th>Completed</th>
                    <th>Amount</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>1</td>
                    <td>Add a new sink to existing vanity cabinet</td>
                    <td></td>
                    <td>$358.32</td>
                </tr>
                <tr>
                    <td>2</td>
                    <td>Paint bathroom walls</td>
                    <td></td>
                    <td>$2,700.00</td>
                </tr>
                <tr>
                    <td>3</td>
                    <td>Add a door in living room</td>
                    <td></td>
                    <td>$1,520.00</td>
                </tr>
                <tr>
                    <td>4</td>
                    <td>Upgrade baseboard to 8" tall columnist style!</td>
                    <td></td>
                    <td>$750.25</td>
                </tr>
                <tr>
                    <td>5</td>
                    <td>Paint grade</td>
                    <td></td>
                    <td>$750.25</td>
                </tr>
                <tr>
                    <td>6</td>
                    <td>Paint Trim</td>
                    <td></td>
                    <td>$450.00</td>
                </tr>
                <tr>
                    <td>7</td>
                    <td>Install door handles</td>
                    <td></td>
                    <td></td>
                </tr>
            </tbody>
        </table>
        
        <div class="total-section">
            <p class="total-amount">Invoice Due: $6,528.82</p>
        </div>
        
        <p class="notes">By signing this change order I agree to the work & cost.</p>
        
        <div class="signature-section">
            <div class="signature-area">
                <h3>Client Approval</h3>
                <p>Print Name: Mike Jones</p>
                <p>Signature:</p>
                <div class="signature-line"></div>
                <p>Date: ________________</p>
            </div>
            
            <div class="signature-area">
                <h3>Company Representative</h3>
                <p>Print Name: Paul Norholm</p>
                <p>Signature:</p>
                <div class="signature-line"></div>
                <p>Date: ________________</p>
            </div>
        </div>
        
        <div class="approval-section">
            <h3>APPROVED</h3>
        </div>
        
        <div class="info-box" style="margin-top: 20px;">
            <h3>Recipients</h3>
            <p>Anne the Bookkeeper</p>
            <p>Joshua Forman</p>
            <p>Option 1</p>
        </div>
    </div>

    <div class="button-container no-print">
        <button class="print-button" onclick="window.print()">Print Invoice</button>
    </div>
</body>
</html>
    `;

      // Send email with HTML content and no PDF attachment
      await transporter.sendMail({
        from: `"SeeJobRun" <${process.env.SMTP_USER}>`,
        to: contacts.join(","),
        subject: `Change Order Report for Job ${quoteId}`,
        text: `Change Order report for job ${quoteId}.`,
        html: htmlContent,
      });

      res.json({ message: "Email sent successfully" });
    } catch (err) {
      logger.error("Email Change Order Error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

// GET /api/change-order-pdf/:job_id
router.get(
  
  "/download/:quoteId",

  
  auth.authenticateToken,
  async (req, res) => {
    const { quoteId } = req.params;
    let connection;

    try {
      connection = await pool.getConnection();

      const [rows] = await connection.query(
        `SELECT
    co.id AS quote_id,
    co.status,
    co.completed,
    j.id AS job_id,
    j.name AS job_name,
    u_from.id   AS from_user_id,
    u_from.name AS from_user_name,
    u_from.email AS from_user_email,
    cat_from.name AS from_category,
    sub_from.name AS from_subcategory,

    u_with.id   AS with_user_id,
    u_with.name AS with_user_name,
    u_with.email AS with_user_email,
    cat_with.name AS with_category,
    sub_with.name AS with_subcategory,

    JSON_ARRAYAGG(
        JSON_OBJECT(
            'id', u.id,
            'name', u.name,
            'email', u.email,
            'mobile', u.mobile,
            'category', c.name,
            'subcategory', s.name
        )
    ) AS employees,

    (
      SELECT JSON_ARRAYAGG(
               JSON_OBJECT(
                 'id', col2.id,
                 'description', col2.description,
                 'amount', col2.amount
               )
             )
      FROM quote_list col2
      WHERE col2.quote_id = co.id
    ) AS items
FROM quote co
JOIN job j ON co.job_id = j.id
LEFT JOIN user u_from       ON co.change_quote_from = u_from.id
LEFT JOIN category cat_from ON u_from.category    = cat_from.id
LEFT JOIN subcategory sub_from ON u_from.subcategory = sub_from.id
LEFT JOIN user u_with       ON co.change_quote_with = u_with.id
LEFT JOIN category cat_with ON u_with.category    = cat_with.id
LEFT JOIN subcategory sub_with ON u_with.subcategory = sub_with.id
LEFT JOIN quote_emp coe ON co.id = coe.quote_id
LEFT JOIN user u              ON coe.emp_id = u.id
LEFT JOIN category c          ON u.category = c.id
LEFT JOIN subcategory s       ON u.subcategory = s.id
JOIN quote_list ql ON ql.quote_id = co.id        -- ðŸ”¹ bring quote_list into outer query
WHERE ql.id = ?                                  -- ðŸ”¹ filter here
GROUP BY co.id;`,
        [quoteId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "No change order found" });
      }

      const data = rows[0];
      const employees = Array.isArray(data.employees)
        ? data.employees
        : JSON.parse(data.employees || "[]");
      const items = Array.isArray(data.items)
        ? data.items
        : JSON.parse(data.items || "[]");

      // Calculate total amount
      const totalAmount = items.reduce(
        (sum, item) => sum + parseFloat(item.amount || 0),
        0
      );
      const currentDate = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });

      // Generate HTML content with dynamic data
      const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Oak Coast Construction Inc - Quote</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Arial', sans-serif;
        }
        
        body {
            background-color: #f5f7f9;
            color: #333;
            line-height: 1.6;
            padding: 20px;
        }
        
        .invoice-container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
            border-radius: 8px;
        }
        
        .company-header {
            text-align: center;
            margin-bottom: 25px;
            padding-bottom: 20px;
            border-bottom: 2px solid #2c3e50;
        }
        
        .company-header h1 {
            color: #2c3e50;
            font-size: 28px;
            margin-bottom: 5px;
        }
        
        .company-header p {
            color: #7f8c8d;
            font-size: 14px;
        }
        
        .info-section {
            width: 100%;
            margin-bottom: 25px;
        }
        
        .info-table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 20px 0;
        }
        
        .info-table td {
            width: 50%;
            vertical-align: top;
            padding: 0;
        }
        
        .info-box {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
            border-left: 4px solid #3498db;
        }
        
        .info-box h3 {
            color: #2c3e50;
            margin-bottom: 10px;
            font-size: 16px;
        }
        
        .info-box p {
            margin-bottom: 5px;
            font-size: 14px;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 25px;
        }
        
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        
        th {
            background-color: #2c3e50;
            color: white;
        }
        
        tr:nth-child(even) {
            background-color: #f8f9fa;
        }
        
        .total-section {
            text-align: right;
            margin-bottom: 30px;
        }
        
        .total-amount {
            font-size: 20px;
            font-weight: bold;
            color: #2c3e50;
        }
        
        .signature-section {
            width: 100%;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 2px dashed #ccc;
        }
        
        .signature-table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 30px 0;
        }
        
        .signature-table td {
            width: 50%;
            vertical-align: top;
            padding: 0;
        }
        
        .signature-area {
            padding: 15px;
            background: #f8f9fa;
            border-radius: 6px;
        }
        
        .signature-area h3 {
            margin-bottom: 15px;
            color: #2c3e50;
            font-size: 16px;
        }
        
        .signature-line {
            height: 1px;
            background: #ccc;
            margin: 40px 0 10px;
        }
        
        .approval-section {
            background: #2c3e50;
            color: white;
            padding: 15px;
            border-radius: 6px;
            text-align: center;
            margin-top: 20px;
        }
        
        .notes {
            margin-top: 20px;
            font-style: italic;
            color: #7f8c8d;
            font-size: 14px;
        }
        
        @media print {
            body {
                background: white;
                padding: 0;
            }
            
            .invoice-container {
                box-shadow: none;
                padding: 0;
            }
            
            .no-print {
                display: none;
            }
        }
        
        .button-container {
            text-align: center;
            margin: 20px 0;
        }
        
        .print-button {
            background: #2c3e50;
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            transition: background 0.3s;
        }
        
        .print-button:hover {
            background: #1a252f;
        }
    </style>
</head>
<body>
    <div class="button-container no-print">
        <button class="print-button" onclick="window.print()">Print Change Order</button>
    </div>

    <div class="invoice-container">
        <div class="company-header">
            <h1>Oak Coast Construction Inc</h1>
            <p>General Contractor License #735734</p>
            <p>275 Oro Dr., Arroyo Grande, CA 93420</p>
            <p>(805) 714-0446</p>
        </div>
        
        <div class="info-section">
            <table class="info-table">
                <tr>
                    <td>
                        <div class="info-box">
                            <h3>Date & Change Order</h3>
                            <p><strong>Date:</strong> ${currentDate}</p>
                            <p><strong>C.O.#:</strong> ${quoteId}</p>
                            <p>Change order with ${data.with_category || "Sub"
        } or Client</p>
                            <p>${data.from_user_name || "Job Owner"
        } (Auto-fills)</p>
                        </div>
                    </td>
                    <td>
                        <div class="info-box">
                            <h3>Contract Details</h3>
                            <p><strong>Contract with:</strong> ${data.with_user_name || "N/A"
        }</p>
                            <p><strong>Property Owner:</strong> ${data.from_user_name || "N/A"
        }</p>
                            <p><strong>Job:</strong> ${data.job_name || "N/A"
        }</p>
                            <p><strong>Address:</strong> N/A</p>
                        </div>
                    </td>
                </tr>
            </table>
        </div>
        
        <h2>${data.job_name || "Change Order"}</h2>
        
        <table>
            <thead>
                <tr>
                    <th>Item #</th>
                    <th>Work Description</th>
                    <th>Completed</th>
                    <th>Amount</th>
                </tr>
            </thead>
            <tbody>
                ${items
          .map(
            (item, index) => `
                <tr>
                    <td>${index + 1}</td>
                    <td>${item.description || ""}</td>
                    <td></td>
                    <td>$${parseFloat(item.amount || 0).toFixed(2)}</td>
                </tr>
                `
          )
          .join("")}
            </tbody>
        </table>
        
        <div class="total-section">
            <p class="total-amount">Invoice Due: $${totalAmount.toFixed(2)}</p>
        </div>
        
        <p class="notes">By signing this change order I agree to the work & cost.</p>
        
        <div class="signature-section">
            <table class="signature-table">
                <tr>
                    <td>
                        <div class="signature-area">
                            <h3>Client Approval</h3>
                            <p>Print Name: ${data.with_user_name || "N/A"}</p>
                            <p>Signature:</p>
                            <div class="signature-line"></div>
                            <p>Date: ________________</p>
                        </div>
                    </td>
                    <td>
                        <div class="signature-area">
                            <h3>Company Representative</h3>
                            <p>Print Name: ${data.from_user_name || "N/A"}</p>
                            <p>Signature:</p>
                            <div class="signature-line"></div>
                            <p>Date: ________________</p>
                        </div>
                    </td>
                </tr>
            </table>
        </div>
        
        <div class="approval-section">
            <h3>APPROVED</h3>
        </div>
        
        <div class="info-box" style="margin-top: 20px;">
            <h3>Recipients</h3>
            ${employees.map((emp) => `<p>${emp.name || "N/A"}</p>`).join("")}
        </div>
    </div>

    <div class="button-container no-print">
        <button class="print-button" onclick="window.print()">Print Change Order</button>
    </div>
</body>
</html>
      `;

      // Configure PDF options
      const options = {
        format: "A4",
        border: {
          top: "0.5in",
          right: "0.5in",
          bottom: "0.5in",
          left: "0.5in",
        },
        header: {
          height: "0mm",
        },
        footer: {
          height: "0mm",
        },
      };

      // Generate PDF from HTML
      pdf.create(htmlContent, options).toBuffer((err, buffer) => {
        if (err) {
          logger.error("PDF generation error:", err);
          return res
            .status(500)
            .json({ message: "PDF generation failed", error: err.message });
        }

        // Set headers for PDF response
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="quote_${quoteId}.pdf"`
        );

        // Send PDF buffer
        res.send(buffer);
      });
    } catch (err) {
      logger.error("Error generating download:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

router.delete("/job-contact/:id/:job_id/:change_quote_type", auth.authenticateToken, async (req, res) => {
  const contactId = req.params.id;
  const change_quote_with = req.params.change_quote_type
  const job_id = req.params.job_id
  try {
    const [result] = await pool.execute(
      "DELETE FROM quote_emp WHERE id = ? and job_id = ? and change_quote_type= ?",
      [contactId, job_id, change_quote_with]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Contact not found" });
    }
    res.json({ message: "Employee contact deleted successfully" });
  } catch (err) {
    logger.error("Error deleting job contact:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }

});
router.delete("/job-contact/:id", auth.authenticateToken, async (req, res) => {
  const contactId = req.params.id;
  try {
    const [result] = await pool.execute(
      "DELETE FROM quote_emp WHERE id = ?",
      [contactId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Contact not found" });
    }
    res.json({ message: "Employee contact deleted successfully" });
  } catch (err) {
    logger.error("Error deleting job contact:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }

});
// lead quote Api 

router.get(
  "/get_Leadcontacts",
  auth.authenticateToken,
  async (req, res) => {
    let connection;
    try {

      connection = await pool.getConnection();

      const [rows] = await connection.execute(
        `Select u.name, u.id,u.email,sc.name as designation, u.category as 'role' from user u
       join subcategory sc on sc.id= u.subcategory ;`
      );
      res.status(200).json(rows);
    } catch (err) {
      res.status(500).json({ message: "Database error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  }
);

module.exports = router;

