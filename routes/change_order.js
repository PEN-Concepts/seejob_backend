const express = require("express");
const router = express.Router();
const pool = require("../config/connection");
const Joi = require("joi");
const logger = require("../common/logger");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require("nodemailer");
const auth = require("../services/authentication");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");
const PDFDocument = require("pdfkit");
const { v4: uuidv4 } = require("uuid");

async function sendInviteEmail(toEmail, clientName) {
  if (!toEmail) return;
  const safeTo = String(toEmail || '').trim();
  if (!safeTo) return;
  const mailOptions = {
    from: process.env.SMTP_USER,
    to: safeTo,
    subject: 'You have been invited',
    html: `<p>Hello ${clientName || ''},</p><p>You have been invited to See Job Run.</p>`,
  };
  await transporter.sendMail(mailOptions);
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

// ============ PUBLIC (no auth) routes for external client change order preview ============

router.get('/change-orders/public/:token', async (req, res) => {
  let connection;
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token required' });

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT co.*, u.name as creator_name FROM change_orders co
       LEFT JOIN user u ON co.created_by_user_id = u.id
       WHERE co.public_token = ? LIMIT 1`,
      [token],
    );

    if (!rows.length) return res.status(404).json({ message: 'Change order not found' });

    const co = rows[0];
    delete co.internal_notes;
    delete co.total_cost_amount;
    delete co.gross_profit_amount;
    delete co.gross_profit_pct;

    const [itemRows] = await connection.execute(
      `SELECT id, change_order_id, sort_order, description, qty, unit_price, line_total_price
       FROM change_order_items WHERE change_order_id = ? ORDER BY sort_order ASC, id ASC`,
      [co.id],
    );

    return res.status(200).json({ code: '200', message: 'Change order fetched', data: { quote: co, items: itemRows } });
  } catch (err) {
    logger.error('Public change order fetch error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/change-orders/public/:token/respond', async (req, res) => {
  let connection;
  try {
    const { token } = req.params;
    const { action, signature_data, signed_name, signed_date, client_notes } = req.body;

    if (!token) return res.status(400).json({ message: 'Token required' });
    if (!action || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be "accept" or "reject"' });
    }

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT * FROM change_orders WHERE public_token = ? LIMIT 1`,
      [token],
    );

    if (!rows.length) return res.status(404).json({ message: 'Change order not found' });

    const co = rows[0];

    // Check if change order has expired (valid_until has passed)
    if (co.valid_until) {
      const validUntilDate = new Date(co.valid_until);
      validUntilDate.setHours(23, 59, 59, 999);
      if (new Date() > validUntilDate) {
        return res.status(200).json({ code: '410', message: 'This change order has expired and can no longer be accepted or rejected.' });
      }
    }

    const safeClientNotes = client_notes !== undefined ? String(client_notes || '') : null;

    if (action === 'accept') {
      const safeSignedDate = signed_date ? String(signed_date).slice(0, 10) : null;
      await connection.execute(
        `UPDATE change_orders
            SET status = 'SIGNED',
                client_signed_at = COALESCE(?, NOW()),
                client_signature_data = ?,
                client_signed_name = ?,
                client_notes = COALESCE(?, client_notes),
                updated_at = ?
          WHERE id = ?`,
        [safeSignedDate, signature_data || null, signed_name || co.client_name, safeClientNotes, getTimeStamp(), co.id],
      );
    } else {
      await connection.execute(
        `UPDATE change_orders
            SET status = 'REJECTED',
                client_notes = COALESCE(?, client_notes),
                updated_at = ?
          WHERE id = ?`,
        [safeClientNotes, getTimeStamp(), co.id],
      );
    }

    return res.status(200).json({ code: '200', message: `Change order ${action}ed successfully` });
  } catch (err) {
    logger.error('Public change order respond error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

// POST reactivate an expired change order (sets status back to DRAFT with new 30-day validity)
router.post('/change-orders/:id/reactivate', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const created_by_user_id = res.locals.id;
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT id FROM change_orders WHERE id = ? AND created_by_user_id = ? LIMIT 1`,
      [id, created_by_user_id],
    );
    if (!rows.length) return res.status(404).json({ message: 'Change order not found' });

    const newValidUntil = new Date();
    newValidUntil.setDate(newValidUntil.getDate() + 30);
    const validUntilStr = newValidUntil.toISOString().slice(0, 10);

    const todayStr = new Date().toISOString().slice(0, 10);

    await connection.execute(
      `UPDATE change_orders
          SET status = 'DRAFT',
              change_order_date = ?,
              valid_until = ?,
              updated_at = ?
        WHERE id = ?`,
      [todayStr, validUntilStr, getTimeStamp(), id],
    );

    return res.status(200).json({
      code: '200',
      message: 'Change order reactivated successfully',
      data: { change_order_date: todayStr, valid_until: validUntilStr },
    });
  } catch (err) {
    logger.error('Change order reactivate error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/change-orders/:id/send-email', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const created_by_user_id = res.locals.id;
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT co.*, u.name as creator_name FROM change_orders co
       LEFT JOIN user u ON co.created_by_user_id = u.id
       WHERE co.id = ? AND co.created_by_user_id = ? LIMIT 1`,
      [id, created_by_user_id],
    );

    if (!rows.length) return res.status(404).json({ message: 'Change order not found' });

    const co = rows[0];
    if (!co.client_email) return res.status(400).json({ message: 'No client email on this change order' });

    let publicToken = co.public_token;
    if (!publicToken) {
      publicToken = uuidv4();
      await connection.execute(`UPDATE change_orders SET public_token = ? WHERE id = ?`, [publicToken, co.id]);
    }

    const frontendBase = 'https://seejobrun.com/user-dashboard';
    const previewUrl = `${frontendBase}/quote-preview/${publicToken}`;
    const creatorName = co.creator_name || 'Someone';

    const [itemRows] = await connection.execute(
      `SELECT description, qty, unit_price, line_total_price FROM change_order_items WHERE change_order_id = ? ORDER BY sort_order ASC`,
      [co.id],
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
      to: co.client_email,
      subject: `Change Order from ${creatorName} â€” ${co.project_address || 'Your Project'}`,
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
              <h1 style="margin:0;font-size:22px;">You Have a Change Order to Review</h1>
            </div>
            <div class="content">
              <p>Hello <strong>${co.client_name || 'there'}</strong>,</p>
              <p><strong>${creatorName}</strong>${co.company_name ? ' from <strong>' + co.company_name + '</strong>' : ''} has sent you a change order for your review.</p>
              
              <div class="info-row"><span class="info-label">Project:</span> ${co.project_address || 'â€”'}</div>
              <div class="info-row"><span class="info-label">Date:</span> ${co.change_order_date || 'â€”'}</div>
              <div class="info-row"><span class="info-label">Valid Until:</span> ${co.valid_until || 'â€”'}</div>

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
                Grand Total: <strong>$${Number(co.grand_total_amount || 0).toFixed(2)}</strong>
              </div>

              ${co.client_notes ? '<p><strong>Notes:</strong> ' + co.client_notes + '</p>' : ''}

              <div style="text-align:center;">
                <a href="${previewUrl}" class="btn">Review &amp; Respond to Change Order</a>
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

    logger.info(`Sending change order email to: ${co.client_email} preview URL: ${previewUrl}`);
    await transporter.sendMail(mailOptions);
    logger.info(`Change order email sent successfully to: ${co.client_email}`);

    return res.status(200).json({ code: '200', message: 'Change order email sent to client' });
  } catch (err) {
    logger.error('Change order email send error:', err);
    logger.error('Change order email send error:', err);
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
            where jc.job_id = ?`,
        [jid],
      );
      res.status(200).json(rows);
    } catch (err) {
      res.status(500).json({ message: "Database error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  },
);

//get contacts
router.get("/get_jobs/:user_id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const user_id = req.params.user_id; // <-- from URL param

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT * FROM job WHERE status = 1 AND created_by = ? ORDER BY created_at DESC`,
      [user_id],
    );

    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// ---------------- Change Order Manager (new) ----------------

router.post('/change-orders', auth.authenticateToken, async (req, res) => {
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
      change_order_date,
      valid_until,
      client_name,
      client_phone,
      client_email,
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
    const safeStatus = status || 'DRAFT';

    if (!client_name) {
      return res.status(200).json({ code: '400', message: 'client_name is required', data: {} });
    }
    if (!change_order_date) {
      return res.status(200).json({ code: '400', message: 'change_order_date is required', data: {} });
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

    const publicToken = uuidv4();

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const insertSql = `INSERT INTO change_orders (
      company_id,
      created_by_user_id,
      change_order_number,
      status,
      client_name,
      client_phone,
      client_email,
      change_order_date,
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
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

    const [insertResult] = await connection.execute(insertSql, [
      safeCompanyId,
      effectiveCreatorId,
      'CO-TEMP',
      'DRAFT',
      client_name,
      client_phone || null,
      client_email || null,
      change_order_date,
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

    const changeOrderId = insertResult.insertId;

    await connection.execute(
      `UPDATE change_orders SET change_order_number = ? WHERE id = ?`,
      [`CO-${changeOrderId}`, changeOrderId],
    );

    const itemInsertSql = `INSERT INTO change_order_items (
      change_order_id,
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
        changeOrderId,
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
    return res.status(200).json({ code: '200', message: 'Change order created successfully', data: { id: changeOrderId } });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error('Change order create error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/change-orders', auth.authenticateToken, async (req, res) => {
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
      // Clients should not see DRAFT documents. Creators can see their own drafts.
      where[0] = `(created_by_user_id = ? OR (LOWER(client_email) = ? AND status <> 'DRAFT'))`;
      params.push(loggedInEmail);
    }

    if (company_id) {
      const cid = String(company_id).trim();
      if (cid && cid !== 'undefined' && cid !== 'null') {
        where.push('company_id = ?');
        params.push(Number(cid));
      }
    }

    if (status) {
      const s = String(status).trim();
      if (s && s !== 'undefined' && s !== 'null') {
        where.push('status = ?');
        params.push(s);
      }
    }
    if (q) {
      where.push('(change_order_number LIKE ? OR client_name LIKE ? OR client_email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const [rows] = await connection.execute(
      `SELECT * FROM change_orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
      params,
    );

    return res.status(200).json({ code: '200', message: 'Change orders fetched successfully', data: rows });
  } catch (err) {
    logger.error('Change order list error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: [] });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/change-orders/:id', auth.authenticateToken, async (req, res) => {
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

    const [coRows] = await connection.execute(
      `SELECT * FROM change_orders WHERE id = ? LIMIT 1`,
      [id],
    );

    if (!coRows.length) {
      return res.status(200).json({ code: '404', message: 'Change order not found', data: {} });
    }

    const co = coRows[0];
    const coClientEmail = co.client_email ? String(co.client_email).trim().toLowerCase() : '';
    const canAccessAsCreator = Number(co.created_by_user_id) === Number(effectiveCreatorId);
    const canAccessAsClient = !!loggedInEmail && !!coClientEmail && loggedInEmail === coClientEmail;
    if (!canAccessAsCreator && !canAccessAsClient) {
      return res.status(200).json({ code: '404', message: 'Change order not found', data: {} });
    }

    const [itemRows] = await connection.execute(
      `SELECT * FROM change_order_items WHERE change_order_id = ? ORDER BY sort_order ASC, id ASC`,
      [id],
    );

    return res.status(200).json({
      code: '200',
      message: 'Change order fetched successfully',
      data: { change_order: co, items: itemRows },
    });
  } catch (err) {
    logger.error('Change order get error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/change-orders/:id/sign', auth.authenticateToken, async (req, res) => {
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

    const [coRows] = await connection.execute(
      `SELECT id, created_by_user_id, client_email,
              creator_signature_data, creator_signed_name, creator_signed_at,
              client_signature_data, client_signed_name, client_signed_at
         FROM change_orders
        WHERE id = ?
        LIMIT 1`,
      [id],
    );

    if (!coRows.length) {
      await connection.rollback();
      return res.status(200).json({ code: '404', message: 'Change order not found', data: {} });
    }

    const co = coRows[0];
    const coClientEmail = co.client_email ? String(co.client_email).trim().toLowerCase() : '';
    const isCreator = Number(co.created_by_user_id) === Number(userId);
    const isClient = !!loggedInEmail && !!coClientEmail && loggedInEmail === coClientEmail;

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
        `UPDATE change_orders
            SET creator_signature_data = ?,
                creator_signed_name = ?,
                creator_signed_at = ?,
                updated_at = ?
          WHERE id = ?`,
        [signature_data, signed_name, currentTimestamp, currentTimestamp, id],
      );
    } else {
      await connection.execute(
        `UPDATE change_orders
            SET client_signature_data = ?,
                client_signed_name = ?,
                client_signed_at = ?,
                client_notes = ?,
                updated_at = ?
          WHERE id = ?`,
        [signature_data, signed_name, currentTimestamp, client_notes || null, currentTimestamp, id],
      );
    }

    // Mark change order as SIGNED immediately after the client signs.
    // Creator is allowed to sign after status becomes SIGNED.
    if (safeSignAs === 'client') {
      await connection.execute(
        `UPDATE change_orders SET status = 'SIGNED', updated_at = ? WHERE id = ?`,
        [currentTimestamp, id],
      );
    }

    const [updatedRows] = await connection.execute(
      `SELECT creator_signed_at, client_signed_at FROM change_orders WHERE id = ? LIMIT 1`,
      [id],
    );
    const bothSigned = !!updatedRows[0]?.creator_signed_at && !!updatedRows[0]?.client_signed_at;

    await connection.commit();
    return res.status(200).json({
      code: '200',
      message: bothSigned ? 'Change order signed by both parties' : 'Signature saved',
      data: { fully_signed: bothSigned },
    });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error('Change order sign error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/change-orders/:id', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const userId = res.locals.id;
    const effectiveCreatorId =
      req.user && [2, 3, 4, 5].includes(Number(req.user.role)) && req.user.working_id
        ? Number(req.user.working_id)
        : Number(userId);
    const { id } = req.params;
    const currentTimestamp = getTimeStamp();

    const {
      status,
      change_order_date,
      valid_until,
      client_name,
      client_phone,
      client_email,
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
    if (!change_order_date) {
      return res.status(200).json({ code: '400', message: 'change_order_date is required', data: {} });
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
      `SELECT id FROM change_orders WHERE id = ? AND created_by_user_id = ? LIMIT 1`,
      [id, effectiveCreatorId],
    );
    if (!existing.length) {
      await connection.rollback();
      return res.status(200).json({ code: '404', message: 'Change order not found', data: {} });
    }

    await connection.execute(
      `UPDATE change_orders
       SET status = ?,
           client_name = ?,
           client_phone = ?,
           client_email = ?,
           change_order_date = ?,
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
       WHERE id = ? AND created_by_user_id = ?`,
      [
        status || 'PENDING',
        client_name,
        client_phone || null,
        client_email || null,
        change_order_date,
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
        effectiveCreatorId,
      ],
    );

    await connection.execute(`DELETE FROM change_order_items WHERE change_order_id = ?`, [id]);

    const itemInsertSql = `INSERT INTO change_order_items (
      change_order_id,
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
    return res.status(200).json({ code: '200', message: 'Change order updated successfully', data: { id: Number(id) } });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error('Change order update error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.delete('/change-orders/:id', auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const userId = res.locals.id;
    const effectiveCreatorId =
      req.user && [2, 3, 4, 5].includes(Number(req.user.role)) && req.user.working_id
        ? Number(req.user.working_id)
        : Number(userId);
    const { id } = req.params;

    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `DELETE FROM change_orders WHERE id = ? AND created_by_user_id = ?`,
      [id, effectiveCreatorId],
    );

    if (!result.affectedRows) {
      return res.status(200).json({ code: '404', message: 'Change order not found', data: {} });
    }

    return res.status(200).json({ code: '200', message: 'Change order deleted successfully', data: {} });
  } catch (err) {
    logger.error('Change order delete error:', err);
    return res.status(200).json({ code: '500', message: 'Internal server error', data: {} });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/create", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { job_id, items } = req.body;
    // items = [{ description, amount }, { description, amount }]
    const created_by = res.locals.id; // from token
    const currentTimestamp = getTimeStamp();

    if (!job_id || !items || items.length === 0) {
      return res
        .status(400)
        .json({ message: "Job ID and at least one item are required" });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Step 1: Check if job_id already exists in change_order
    const [existing] = await connection.execute(
      `SELECT id, completed 
       FROM change_order 
       WHERE job_id = ?
       ORDER BY id DESC LIMIT 1`,
      [job_id],
    );

    let changeOrderId;

    if (existing.length > 0 && existing[0].completed === 0) {
      // Reuse existing unfinished change order
      changeOrderId = existing[0].id;
    } else {
      // No unfinished record OR existing is completed â†’ create a new row
      const [coResult] = await connection.execute(
        `INSERT INTO change_order (job_id, created_at, created_by, completed)
         VALUES (?, ?, ?, 0)`,
        [job_id, currentTimestamp, created_by],
      );
      changeOrderId = coResult.insertId;
    }

    // Step 2: Insert all items into change_order_list with change_order_id
    const listQuery = `
      INSERT INTO change_order_list (job_id, change_order_id, description, amount, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    for (const item of items) {
      await connection.execute(listQuery, [
        job_id,
        changeOrderId,
        item.description,
        item.amount,
        currentTimestamp,
        created_by,
      ]);
    }

    await connection.commit();

    res.status(201).json({
      message: "Change order created/updated with items",
      change_order_id: changeOrderId,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// GET change orders by user_id and job_id
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
        co.id AS change_order_id,
        co.completed,
        col.id AS item_id,
        col.description,
        col.amount,
        j.name AS job_name,
        j.id AS job_id
    FROM change_order co
    JOIN job j ON co.job_id = j.id
    JOIN change_order_list col ON col.change_order_id = co.id
    WHERE co.created_by = ? 
      AND co.job_id = ? 
      AND co.completed = 0
    ORDER BY co.created_at DESC, col.id DESC;`,
        [user_id, job_id],
      );

      res.status(200).json(rows);
    } catch (err) {
      res.status(500).json({ message: "Database error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  },
);

// DELETE change order item
router.delete("/delete/:id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const { id } = req.params;

    connection = await pool.getConnection();
    const [result] = await connection.execute(
      `DELETE FROM change_order_list WHERE id = ?`,
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Change order item not found" });
    }

    res.status(200).json({ message: "Change order item deleted successfully" });
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
      `UPDATE change_order_list 
       SET description = ?, amount = ?, job_id = ? 
       WHERE id = ?`,
      [description, amount, job_id, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Change order item not found" });
    }

    res.status(200).json({ message: "Change order item updated successfully" });
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
    const { change_order_with, change_order_from } = req.body;

    connection = await pool.getConnection();

    const [result] = await connection.execute(
      `UPDATE change_order 
       SET change_order_with = ?, chnage_order_from = ? , completed = 1
       WHERE job_id = ?`,
      [change_order_with, change_order_from, id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Change order not found" });
    }

    res.status(200).json({ message: "Change order updated successfully" });
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
      [id],
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
    const { job_id, emp_id } = req.body;
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
      `SELECT id FROM change_order 
         WHERE job_id = ? AND completed = 0
         ORDER BY created_at DESC LIMIT 1`,
      [job_id],
    );

    if (active.length === 0) {
      return res.status(400).json({
        message: "No active change order for this job. Cannot assign contact.",
      });
    }

    const change_order_id = active[0].id;

    // 2ï¸âƒ£ Prevent duplicate assignment for the same change_order
    const [existing] = await connection.execute(
      `SELECT id FROM change_order_emp 
         WHERE change_order_id = ? AND emp_id = ?`,
      [change_order_id, emp_id],
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: "Employee already assigned to this active change order",
      });
    }

    // 3ï¸âƒ£ Insert new record with change_order_id
    const [result] = await connection.execute(
      `INSERT INTO change_order_emp
         (change_order_id, job_id, emp_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [change_order_id, job_id, emp_id, created_at, created_by],
    );

    res.status(201).json({
      message: "Employee assigned to active change order",
      id: result.insertId,
      change_order_id,
    });
  } catch (err) {
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

// Get all contacts for a job
router.get(
  "/job_contacts/:job_id",
  auth.authenticateToken,
  async (req, res) => {
    let connection;
    try {
      const { job_id } = req.params;
      connection = await pool.getConnection();

      const [rows] = await connection.execute(
        `SELECT coe.id, u.name, u.email, u.image, s.name AS subcategory, c.name AS role, co.completed
       FROM change_order_emp coe
       Join change_order co ON coe.change_order_id = co.id
       JOIN user u ON coe.emp_id = u.id
       JOIN subcategory s ON u.subcategory = s.id
       JOIN category c ON u.category = c.id
       WHERE coe.job_id = ?`,
        [job_id],
      );

      res.status(200).json(rows);
    } catch (err) {
      res.status(500).json({ message: "Database error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  },
);

// router.get("/details/:job_id", auth.authenticateToken, async (req, res) => {
//   let connection;
//   try {
//     const changeorder_with = res.locals.id;
//     console.log(changeorder_with);
//     const { job_id } = req.params;

//     connection = await pool.getConnection();

//     const [rows] = await connection.query(
//       `
//       SELECT
//         co.id AS change_order_id,
//         co.status,
//         co.completed,
//         j.id AS job_id,
//         j.name AS job_name,

//         -- change_order_from (user)
//         u_from.id AS from_user_id,
//         u_from.name AS from_user_name,
//         u_from.email AS from_user_email,
//         cat_from.name AS from_category,
//         sub_from.name AS from_subcategory,

//         -- change_order_with (user)
//         u_with.id AS with_user_id,
//         u_with.name AS with_user_name,
//         u_with.email AS with_user_email,
//         cat_with.name AS with_category,
//         sub_with.name AS with_subcategory,

//         -- employees (aggregated array)
//         JSON_ARRAYAGG(
//           JSON_OBJECT(
//             'id', u.id,
//             'name', u.name,
//             'email', u.email,
//             'mobile',u.mobile,
//             'category', c.name,
//             'subcategory', s.name
//           )
//         ) AS employees,

//         -- items (list)
//         (
//           SELECT JSON_ARRAYAGG(
//             JSON_OBJECT(
//               'id', col.id,
//               'description', col.description,
//               'amount', col.amount
//             )
//           )
//           FROM change_order_list col
//           WHERE col.change_order_id = co.id And co.completed = 1
//         ) AS items

//       FROM change_order co
//       JOIN job j ON co.job_id = j.id

//       LEFT JOIN user u_from ON co.chnage_order_from = u_from.id
//       LEFT JOIN category cat_from ON u_from.category = cat_from.id
//       LEFT JOIN subcategory sub_from ON u_from.subcategory = sub_from.id

//       LEFT JOIN user u_with ON co.change_order_with = u_with.id
//       LEFT JOIN category cat_with ON u_with.category = cat_with.id
//       LEFT JOIN subcategory sub_with ON u_with.subcategory = sub_with.id

//       LEFT JOIN change_order_emp coe ON co.id = coe.change_order_id
//       LEFT JOIN user u ON coe.emp_id = u.id
//       LEFT JOIN category c ON u.category = c.id
//       LEFT JOIN subcategory s ON u.subcategory = s.id

//       WHERE co.job_id = ? OR co.change_order_with = ?
//       GROUP BY co.id
//       `,
//       [job_id, changeorder_with]
//     );

//     res.status(200).json(rows);
//   } catch (err) {
//     res.status(500).json({ message: "Database error", error: err.message });
//   } finally {
//     if (connection) connection.release();
//   }
// });

router.get("/details/:job_id", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const user_id = res.locals.id; // used for with_user checks
    const { job_id } = req.params;

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `
      (
        /* ===================== QUOTE ===================== */
        SELECT 
          'quote' AS record_type,
          co.id AS record_id,
          co.status,
          co.completed,
          co.created_at,
          j.id AS job_id,
          j.name AS job_name,
          j.address As job_address,

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
              AND col.change_quote_type = 'job'
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
          AND co.change_quote_type = 'job'
        GROUP BY co.id
      )

      UNION ALL

      (
        /* ================= CHANGE ORDER ================= */
        SELECT 
          'change_order' AS record_type,
          co.id AS record_id,
          co.status,
          co.completed,
           co.created_at,
          j.id AS job_id,
          j.name AS job_name,
          j.address As job_address,

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
            FROM change_order_list col
            WHERE col.change_order_id = co.id
              AND co.completed = 1
          ) AS items

        FROM change_order co
        JOIN job j ON co.job_id = j.id

        LEFT JOIN user u_from ON co.chnage_order_from = u_from.id
        LEFT JOIN category cat_from ON u_from.category = cat_from.id
        LEFT JOIN subcategory sub_from ON u_from.subcategory = sub_from.id

        LEFT JOIN user u_with ON co.change_order_with = u_with.id
        LEFT JOIN category cat_with ON u_with.category = cat_with.id
        LEFT JOIN subcategory sub_with ON u_with.subcategory = sub_with.id

        LEFT JOIN change_order_emp coe ON co.id = coe.change_order_id
        LEFT JOIN user u ON coe.emp_id = u.id
        LEFT JOIN category c ON u.category = c.id
        LEFT JOIN subcategory s ON u.subcategory = s.id

        WHERE co.job_id = ? OR co.change_order_with = ?
        GROUP BY co.id
      )

      ORDER BY record_id DESC
      `,
      [
        job_id,
        user_id, // quote
        job_id,
        user_id, // change_order
      ],
    );

    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({
      message: "Database error",
      error: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get("/user-details", auth.authenticateToken, async (req, res) => {
  let connection;
  try {
    const user_id = res.locals.id; // logged-in user id

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `
      (
        /* ===================== QUOTE ===================== */
        SELECT 
          'quote' AS record_type,
          co.id AS record_id,
          co.status,
          co.completed,
          co.created_at,
          j.id AS job_id,
          j.name AS job_name,

          u_from.id AS from_user_id,
          u_from.name AS from_user_name,
          u_from.email AS from_user_email,
          u_from.street AS from_user_street,
          u_from.city AS from_user_city,
          u_from.state AS from_user_state,

          u_with.id AS with_user_id,
          u_with.name AS with_user_name,
          u_with.email AS with_user_email,
           u_with.street AS with_user_street,
          u_with.city AS with_user_city,
          u_with.state AS with_user_state,

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
              AND col.change_quote_type = 'job'
          ) AS items

        FROM quote co
        JOIN job j ON co.job_id = j.id

        LEFT JOIN user u_from ON co.change_quote_from = u_from.id
        LEFT JOIN user u_with ON co.change_quote_with = u_with.id

        LEFT JOIN quote_emp coe ON co.id = coe.quote_id
        LEFT JOIN user u ON coe.emp_id = u.id
        LEFT JOIN category c ON u.category = c.id
        LEFT JOIN subcategory s ON u.subcategory = s.id

        /* ðŸ”¥ UPDATED WHERE CONDITION */
        WHERE coe.emp_id = ?
        GROUP BY co.id
      )

      UNION ALL

      (
        /* ================= CHANGE ORDER ================= */
        SELECT 
          'change_order' AS record_type,
          co.id AS record_id,
          co.status,
          co.completed,
          co.created_at,
          j.id AS job_id,
          j.name AS job_name,

          u_from.id AS from_user_id,
          u_from.name AS from_user_name,
          u_from.email AS from_user_email,
          u_from.street AS from_user_street,
          u_from.city AS from_user_city,
          u_from.state AS from_user_state,

          u_with.id AS with_user_id,
          u_with.name AS with_user_name,
          u_with.email AS with_user_email,
          u_with.street AS with_user_street,
          u_with.city AS with_user_city,
          u_with.state AS with_user_state,

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
            FROM change_order_list col
            WHERE col.change_order_id = co.id
              AND co.completed = 1
          ) AS items

        FROM change_order co
        JOIN job j ON co.job_id = j.id

        LEFT JOIN user u_from ON co.chnage_order_from = u_from.id
        LEFT JOIN user u_with ON co.change_order_with = u_with.id

        LEFT JOIN change_order_emp coe ON co.id = coe.change_order_id
        LEFT JOIN user u ON coe.emp_id = u.id
        LEFT JOIN category c ON u.category = c.id
        LEFT JOIN subcategory s ON u.subcategory = s.id

        /* ðŸ”¥ UPDATED WHERE CONDITION */
        WHERE coe.emp_id = ?
        GROUP BY co.id
      )

      ORDER BY record_id DESC
      `,
      [user_id, user_id],
    );

    res.status(200).json({
      code: 200,
      message: "User change orders fetched successfully",
      data: rows,
    });
  } catch (err) {
    logger.error("Error fetching user change orders:", err);
    res.status(500).json({
      code: 500,
      message: "Database error",
      error: err.message,
    });
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
      UPDATE change_order
      SET status = ?, reason = ?
      WHERE id = ?
    `;

    await connection.query(query, [status, reason || null, id]);

    res
      .status(200)
      .json({ message: "Change order status updated successfully" });
  } catch (err) {
    logger.error("Error updating change order status:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

router.post(
  "/email-change-order/:changeOrderId",
  auth.authenticateToken,
  async (req, res) => {
    const { changeOrderId } = req.params;

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
         co.id AS change_order_id,
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
           FROM change_order_list col
           WHERE col.change_order_id = co.id
         ) AS items
       FROM change_order co
       JOIN job j ON co.job_id = j.id
       LEFT JOIN user u_from       ON co.chnage_order_from = u_from.id
       LEFT JOIN category cat_from ON u_from.category = cat_from.id
       LEFT JOIN subcategory sub_from ON u_from.subcategory = sub_from.id
       LEFT JOIN user u_with       ON co.change_order_with = u_with.id
       LEFT JOIN category cat_with ON u_with.category = cat_with.id
       LEFT JOIN subcategory sub_with ON u_with.subcategory = sub_with.id
       LEFT JOIN change_order_emp coe ON co.id = coe.change_order_id
       LEFT JOIN user u              ON coe.emp_id = u.id
       LEFT JOIN category c          ON u.category = c.id
       LEFT JOIN subcategory s       ON u.subcategory = s.id
       WHERE co.id = ?
       GROUP BY co.id`,
        [changeOrderId],
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
        0,
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
        subject: `Change Order Report for Job ${changeOrderId}`,
        text: `Change Order report for job ${changeOrderId}.`,
        html: htmlContent,
      });

      res.json({ message: "Email sent successfully" });
    } catch (err) {
      logger.error("Email Change Order Error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  },
);

// GET /api/change-order-pdf/:job_id
router.get(
  "/download/:changeOrderId",
  auth.authenticateToken,
  async (req, res) => {
    const { changeOrderId } = req.params;
    let connection;

    try {
      connection = await pool.getConnection();

      const [rows] = await connection.query(
        `SELECT
         co.id AS change_order_id,
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
                      'id', col.id,
                      'description', col.description,
                      'amount', col.amount
                    )
                  )
           FROM change_order_list col
           WHERE col.change_order_id = co.id
         ) AS items
       FROM change_order co
       JOIN job j ON co.job_id = j.id
       LEFT JOIN user u_from       ON co.chnage_order_from = u_from.id
       LEFT JOIN category cat_from ON u_from.category    = cat_from.id
       LEFT JOIN subcategory sub_from ON u_from.subcategory = sub_from.id
       LEFT JOIN user u_with       ON co.change_order_with = u_with.id
       LEFT JOIN category cat_with ON u_with.category    = cat_with.id
       LEFT JOIN subcategory sub_with ON u_with.subcategory = sub_with.id
       LEFT JOIN change_order_emp coe ON co.id = coe.change_order_id
       LEFT JOIN user u              ON coe.emp_id = u.id
       LEFT JOIN category c          ON u.category = c.id
       LEFT JOIN subcategory s       ON u.subcategory = s.id
       WHERE co.id = ?
       GROUP BY co.id`,
        [changeOrderId],
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
        0,
      );
      const currentDate = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });

      // Create PDF document using PDFKit
      const doc = new PDFDocument({ margin: 50 });

      // Set headers for PDF response
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="change_order_${changeOrderId}.pdf"`,
      );

      // Pipe the PDF to the response
      doc.pipe(res);

      // Company Header
      doc.font("Helvetica-Bold");
      doc
        .fontSize(18)
        .fillColor("#2c3e50")
        .text("Oak Coast Construction Inc", { align: "center" });
      doc.font("Helvetica");
      doc
        .fontSize(9)
        .fillColor("#7f8c8d")
        .text("General Contractor License #735734", { align: "center" })
        .text("275 Oro Dr., Arroyo Grande, CA 93420", { align: "center" })
        .text("(805) 714-0446", { align: "center" });

      doc.moveDown(1);

      // Add horizontal line under company header
      doc.strokeColor("#000").lineWidth(2);
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();

      doc.moveDown(2);

      // Date and Change Order Info
      const leftColumn = 50;
      const rightColumn = 300;
      let yPosition = doc.y;

      const writeCard = (x, y, title, items, options = {}) => {
        const width = options.width || 240;
        const padding = {
          top: 12,
          right: 16,
          bottom: 16,
          left: 18,
          ...(options.padding || {}),
        };
        const lineHeight = options.lineHeight || 14;
        const radius = options.radius ?? 12;
        const borderWidth = options.borderWidth ?? 2;
        const backgroundColor = options.backgroundColor || "#f7f9fc";
        const borderColor = options.borderColor || "#2f8bd6";
        const titleSize = options.titleSize || 11;
        const textSize = options.textSize || 8.5;

        const rawLines = Array.isArray(items) ? items : [];
        const contentLines = rawLines.filter((line) => {
          if (typeof line === "string") {
            return line.trim().length > 0;
          }
          if (line && typeof line === "object") {
            const label = line.label ? String(line.label).trim() : "";
            const value = line.value ? String(line.value).trim() : "";
            return label || value;
          }
          return false;
        });

        const contentHeight = contentLines.length * lineHeight;
        const minHeight = options.minHeight ?? 96;
        const height = Math.max(
          minHeight,
          padding.top + contentHeight + padding.bottom,
        );

        // Background card with rounded corners
        doc.save();
        doc.fillColor(backgroundColor);
        doc.roundedRect(x, y, width, height, radius).fill();
        doc.restore();

        // Accent border clipped to rounded shape
        doc.save();
        doc.roundedRect(x, y, width, height, radius).clip();
        doc.fillColor(borderColor).rect(x, y, borderWidth, height).fill();
        doc.restore();

        const textX = x + padding.left;
        let cursorY = y + padding.top;
        const maxWidth = width - padding.left - padding.right;

        doc
          .font("Helvetica-Bold")
          .fontSize(titleSize)
          .fillColor(options.titleColor || "#2c3e50")
          .text(title, textX, cursorY, { width: maxWidth });

        const titleHeight = doc.heightOfString(title, { width: maxWidth });
        cursorY += titleHeight + 10; // add margin-bottom under card headings

        contentLines.forEach((line) => {
          if (typeof line === "string") {
            doc
              .font("Helvetica")
              .fontSize(textSize)
              .fillColor("#000")
              .text(line, textX, cursorY, { width: maxWidth });
          } else if (line && typeof line === "object") {
            const labelText = line.label ? String(line.label) : "";
            const valueText = line.value ? ` ${String(line.value)}` : "";

            if (labelText) {
              doc
                .font("Helvetica-Bold")
                .fontSize(textSize)
                .fillColor("#1f2937")
                .text(labelText, textX, cursorY, {
                  continued: true,
                  width: maxWidth,
                });
            }

            doc
              .font("Helvetica")
              .fontSize(textSize)
              .fillColor("#000")
              .text(valueText, { continued: false, width: maxWidth });
          }

          cursorY += lineHeight;
        });

        return height;
      };

      // Left box - Date & Change Order
      const leftCardHeight = writeCard(
        leftColumn,
        yPosition,
        "Date & Change Order",
        [
          { label: "Date:", value: currentDate },
          { label: "C.O.#:", value: changeOrderId },
          `Change order with ${data.with_category || "Employee"} or Client`,
          data.from_user_name ? `${data.from_user_name} (Auto-fills)` : "",
        ],
      );

      // Right box - Contract Details
      const rightCardHeight = writeCard(
        rightColumn,
        yPosition,
        "Contract Details",
        [
          { label: "Contract with:", value: data.with_user_name || "N/A" },
          { label: "Property Owner:", value: data.from_user_name || "N/A" },
          { label: "Job:", value: data.job_name || "N/A" },
          { label: "Address:", value: "N/A" },
        ],
      );

      const cardsHeight = Math.max(leftCardHeight, rightCardHeight);
      doc.y = yPosition + cardsHeight + 12; // more top gap before job name
      doc.moveDown(0.1);

      // Job Name
      doc.font("Helvetica-Bold");
      doc
        .fontSize(14)
        .fillColor("#2c3e50")
        .text(data.job_name || "Change Order", leftColumn);
      doc.moveDown(0.1);

      // Items Table
      const tableTop = doc.y;
      const itemCodeX = 50;
      const descriptionX = 100;
      const completedX = 350;
      const amountX = 450;
      const tableWidth = 500;
      const rowHeight = 25;

      // Table Header Background
      doc.fillColor("#2f3e50").rect(50, tableTop, tableWidth, rowHeight).fill();

      // Table Headers (vertically centered with slight downward nudge)
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff");
      const headerTextHeight = doc.currentLineHeight();
      const headerY = Math.round(
        tableTop + (rowHeight - headerTextHeight) / 2 + 2,
      );
      doc.text("Item #", itemCodeX + 5, headerY);
      doc.text("Work Description", descriptionX + 5, headerY);
      doc.text("Completed", completedX + 5, headerY);
      doc.text("Amount", amountX + 5, headerY);

      let itemY = tableTop + rowHeight;
      doc.font("Helvetica").fontSize(9).fillColor("#000");
      const bodyTextHeight = doc.currentLineHeight();

      items.forEach((item, index) => {
        // Alternating row colors
        const fillColor = index % 2 === 0 ? "#f8f9fa" : "#ffffff";
        doc.fillColor(fillColor).rect(50, itemY, tableWidth, rowHeight).fill();

        // bottom border for each row
        doc.strokeColor("#d7dde5").lineWidth(0.8);
        doc
          .moveTo(50, itemY + rowHeight)
          .lineTo(50 + tableWidth, itemY + rowHeight)
          .stroke();

        // Add text content (vertically centered with slight downward nudge)
        doc.fillColor("#000");
        const textY = Math.round(itemY + (rowHeight - bodyTextHeight) / 2 + 2);
        doc.text(`${index + 1}`, itemCodeX + 5, textY);
        doc.text(item.description || "", descriptionX + 5, textY, {
          width: 240,
        });
        doc.text("", completedX + 5, textY);
        doc.text(
          `$${parseFloat(item.amount || 0).toFixed(2)}`,
          amountX + 5,
          textY,
          { width: 90 },
        );

        itemY += rowHeight;
      });

      // Header bottom border
      doc.strokeColor("#2f3e50").lineWidth(1.2);
      doc
        .moveTo(50, tableTop + rowHeight)
        .lineTo(50 + tableWidth, tableTop + rowHeight)
        .stroke();

      doc.y = itemY + 20;
      doc.moveDown(1);

      // Total Amount
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#2c3e50");
      doc.text(`Invoice Due: $${totalAmount.toFixed(2)}`, 50, doc.y, {
        align: "right",
        width: 500,
      });
      doc.moveDown(1.0);

      // Notes
      doc.font("Helvetica").fontSize(9).fillColor("#7f8c8d");
      doc.text("By signing this change order I agree to the work & cost.", {
        style: "italic",
      });
      doc.moveDown(2);

      // Add dashed line separator
      doc.strokeColor("#e5e7eb").lineWidth(0.8);
      for (let x = 50; x < 550; x += 10) {
        doc
          .moveTo(x, doc.y)
          .lineTo(x + 5, doc.y)
          .stroke();
      }
      doc.moveDown(1.2);

      // Signature Section
      const signatureY = doc.y;

      const drawSignatureCard = (x, y, title, printName) => {
        const width = 240;
        const height = 88;
        const radius = 10;
        const pad = { top: 10, right: 16, bottom: 10, left: 16 };

        // Card background + border
        doc.save();
        doc
          .fillColor("#f8f9fa")
          .roundedRect(x, y, width, height, radius)
          .fill();
        doc
          .strokeColor("#e1e5ea")
          .lineWidth(1)
          .roundedRect(x, y, width, height, radius)
          .stroke();
        doc.restore();

        // Title
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#2c3e50");
        doc.text(title, x + pad.left, y + pad.top, {
          width: width - pad.left - pad.right,
        });

        // Body
        const maxW = width - pad.left - pad.right;
        let cy = y + pad.top + doc.heightOfString(title, { width: maxW }) + 10; // match card title margin
        const bodySize = 8.5;

        // Print Name: (bold label + normal value)
        doc
          .font("Helvetica-Bold")
          .fontSize(bodySize)
          .fillColor("#1f2937")
          .text("Print Name:", x + pad.left, cy, {
            continued: true,
            width: maxW,
          });
        doc
          .font("Helvetica")
          .fontSize(bodySize)
          .fillColor("#000")
          .text(` ${printName || "N/A"}`, { continued: false, width: maxW });
        cy += 14;

        // Signature: (bold label + underscores)
        doc
          .font("Helvetica-Bold")
          .fontSize(bodySize)
          .fillColor("#1f2937")
          .text("Signature:", x + pad.left, cy, {
            continued: true,
            width: maxW,
          });
        doc
          .font("Helvetica")
          .fontSize(bodySize)
          .fillColor("#000")
          .text(" ________________", { continued: false, width: maxW });
        cy += 14;

        // Date: (bold label + underscores)
        doc
          .font("Helvetica-Bold")
          .fontSize(bodySize)
          .fillColor("#1f2937")
          .text("Date:", x + pad.left, cy, { continued: true, width: maxW });
        doc
          .font("Helvetica")
          .fontSize(bodySize)
          .fillColor("#000")
          .text(" ________________", { continued: false, width: maxW });

        return y + height;
      };

      const endLeft = drawSignatureCard(
        leftColumn,
        signatureY,
        "Client Approval",
        data.with_user_name,
      );
      const endRight = drawSignatureCard(
        rightColumn,
        signatureY,
        "Company Representative",
        data.from_user_name,
      );

      doc.y = Math.max(endLeft, endRight) + 10;
      doc.moveDown(0.5);

      // Approval Section with dark background
      const approvalY = doc.y;
      doc.fillColor("#2c3e50").rect(50, approvalY, 500, 40).fill();
      doc.fontSize(16).fillColor("#ffffff");
      doc.text("APPROVED", 50, approvalY + 12, { width: 500, align: "center" });

      doc.y = approvalY + 48;
      doc.moveDown(1);

      // Recipients section as rounded card with 2px accent (matches top cards)
      const recipientsY = doc.y;
      const cardW = 500;
      const pad = { top: 12, right: 14, bottom: 12, left: 18 };
      const radius = 12;
      const accent = 2;
      const rowH = 14;
      const contentRows = Math.max(1, employees.length);
      const innerContentH = 18 + contentRows * rowH; // title + rows
      const recipientHeight = Math.max(
        70,
        pad.top + innerContentH + pad.bottom,
      );

      // Background
      doc.save();
      doc
        .fillColor("#f7f9fc")
        .roundedRect(50, recipientsY, cardW, recipientHeight, radius)
        .fill();
      // Clip and draw accent
      doc.roundedRect(50, recipientsY, cardW, recipientHeight, radius).clip();
      doc
        .fillColor("#2f8bd6")
        .rect(50, recipientsY, accent, recipientHeight)
        .fill();
      doc.restore();

      // Title
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#2c3e50");
      doc.text("Recipients", 50 + pad.left, recipientsY + pad.top, {
        width: cardW - pad.left - pad.right,
      });

      // List
      doc.font("Helvetica").fontSize(9.5).fillColor("#000");
      let empY = recipientsY + pad.top + 18;
      employees.forEach((emp) => {
        doc.text(emp.name || "N/A", 50 + pad.left, empY, {
          width: cardW - pad.left - pad.right,
        });
        empY += rowH;
      });
      doc.y = recipientsY + recipientHeight + 10;

      // Finalize PDF
      doc.end();
    } catch (err) {
      logger.error("Error generating PDF:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  },
);

router.delete("/job-contact/:id", auth.authenticateToken, async (req, res) => {
  const contactId = req.params.id;
  try {
    const [result] = await pool.execute(
      "DELETE FROM change_order_emp WHERE id = ?",
      [contactId],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Contact not found" });
    }
    res.json({ message: "Employee contact deleted successfully" });
  } catch (err) {
    logger.error("Error deleting employee contact:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get(
  "/download-daily-report/:id",
  auth.authenticateToken,
  async (req, res) => {
    const { id } = req.params;
    let connection;

    try {
      connection = await pool.getConnection();

      const [rows] = await connection.query(
        `SELECT dr.*, j.name AS job_name, u.name AS foreman_name
         FROM daily_report dr
         LEFT JOIN job j ON dr.job_id = j.id
         LEFT JOIN user u ON dr.foreman_id = u.id
         WHERE dr.id = ?`,
        [id],
      );

      if (!rows.length) {
        return res.status(404).json({ message: "No report found" });
      }

      const data = rows[0];

      // Parse JSON safely
      const safeParse = (val) => {
        try {
          return typeof val === "string" ? JSON.parse(val) : val || [];
        } catch {
          return [];
        }
      };

      const weather = safeParse(data.weather_condition);
      const material = safeParse(data.material);
      const safety = safeParse(data.safety);
      const inspection = safeParse(data.inspection);
      const issue = safeParse(data.issue);
      const needs = safeParse(data.needs);

      const doc = new PDFDocument({ margin: 0, size: "A4" });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="daily_report_${id}.pdf"`,
      );

      doc.pipe(res);

      // ===== CLEAN COLOR PALETTE (Navy / Slate) =====
      const c = {
        dark: "#1a2332",
        mid: "#2c3e50",
        accent: "#34495e",
        light: "#ecf0f1",
        border: "#bdc3c7",
        text: "#2c3e50",
        textSub: "#7f8c8d",
        white: "#ffffff",
        rowAlt: "#f8f9fa",
      };

      const pw = 595.28;
      const m = 28;
      const cw = pw - m * 2;

      const formatDate = (dateVal) => {
        if (!dateVal) return "N/A";
        const d = new Date(dateVal);
        return d.toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      };

      const formatItem = (item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null)
          return item.name || item.label || item.title || JSON.stringify(item);
        return String(item);
      };

      // ===== HEADER (compact) =====
      doc.rect(0, 0, pw, 50).fill(c.dark);
      doc
        .font("Helvetica-Bold")
        .fontSize(16)
        .fillColor(c.white)
        .text("DAILY PRODUCTION REPORT", m, 12, { width: cw });
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#95a5a6")
        .text("See Job Run", m, 32, { width: cw });

      // Right-aligned date in header
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#95a5a6")
        .text(formatDate(data.date), m, 20, { width: cw, align: "right" });

      // Thin accent line
      doc.rect(0, 50, pw, 2).fill("#7f8c8d");

      // ===== PROJECT INFO ROW =====
      let y = 62;
      doc.rect(m, y, cw, 42).fill(c.light);

      // 4-column info grid
      const colW = cw / 4;
      const fields = [
        { label: "PROJECT", value: data.job_name || "N/A" },
        { label: "FOREMAN", value: data.foreman_name || "N/A" },
        { label: "HOURS", value: `${data.hours || "0"} hrs` },
        { label: "STATUS", value: data.status || "N/A" },
      ];

      fields.forEach((f, i) => {
        const fx = m + colW * i + 10;
        doc
          .font("Helvetica-Bold")
          .fontSize(6.5)
          .fillColor(c.textSub)
          .text(f.label, fx, y + 8, { width: colW - 15 });
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor(c.text)
          .text(f.value, fx, y + 19, { width: colW - 15 });
      });

      y = 110;

      // ===== STATS ROW =====
      const statsW = cw / 3;
      const stats = [
        { label: "Progress", value: `${data.progress || "0"}%` },
        {
          label: "Crew",
          value: `${data.crew || 0} Our  /  ${data.sub || 0} Subs`,
        },
        { label: "Schedule", value: data.status || "N/A" },
      ];

      stats.forEach((s, i) => {
        const sx = m + statsW * i;
        // Box with bottom border
        doc.rect(sx, y, statsW, 30).fill(c.white);
        doc.rect(sx, y + 29, statsW, 1.5).fill("#7f8c8d");
        doc
          .font("Helvetica")
          .fontSize(7)
          .fillColor(c.textSub)
          .text(s.label.toUpperCase(), sx + 8, y + 5, { width: statsW - 16 });
        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor(c.dark)
          .text(s.value, sx + 8, y + 15, { width: statsW - 16 });
      });

      y = 150;

      // ===== TABLE-STYLE SECTIONS =====
      // Section header helper
      const sectionHeader = (title) => {
        doc.rect(m, y, cw, 16).fill("#d5dbe0");
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor("#2c3e50")
          .text(title.toUpperCase(), m + 8, y + 4, { width: cw - 16 });
        y += 16;
      };

      // Key-value row helper
      const kvRow = (label, value, isAlt) => {
        const rowH = 18;
        if (isAlt) doc.rect(m, y, cw, rowH).fill(c.rowAlt);
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor(c.textSub)
          .text(label, m + 8, y + 4, { width: 120 });
        doc
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(c.text)
          .text(value || "N/A", m + 130, y + 4, { width: cw - 140 });
        y += rowH;
      };

      // List row helper
      const listRow = (items, noteField) => {
        if (!items || !items.length) {
          doc
            .font("Helvetica")
            .fontSize(8)
            .fillColor(c.textSub)
            .text("None recorded", m + 8, y + 3, { width: cw - 16 });
          y += 15;
        } else {
          items.forEach((item, i) => {
            if (i % 2 === 0) doc.rect(m, y, cw, 15).fill(c.rowAlt);
            doc
              .font("Helvetica")
              .fontSize(8)
              .fillColor(c.text)
              .text(`${i + 1}. ${formatItem(item)}`, m + 8, y + 3, {
                width: cw - 16,
              });
            y += 15;
          });
        }
        if (noteField) {
          doc
            .font("Helvetica-Oblique")
            .fontSize(7)
            .fillColor(c.textSub)
            .text(`Note: ${noteField}`, m + 8, y + 1, { width: cw - 16 });
          y += 13;
        }
      };

      // --- Work Details ---
      sectionHeader("Work Details");
      kvRow("Completion Note", data.completion_note, false);
      kvRow("Plan for Tomorrow", data.plan, true);
      kvRow("Additional Notes", data.additional_note, false);
      kvRow("Crew Notes", data.crew_note, true);

      // Divider space
      y += 4;

      // --- Weather ---
      sectionHeader("Weather Conditions");
      listRow(weather, null);
      y += 2;

      // --- Materials ---
      sectionHeader("Materials");
      listRow(material, data.material_note);
      y += 2;

      // --- Safety ---
      sectionHeader("Safety Checks");
      listRow(safety, data.safety_note);
      y += 2;

      // --- Inspections ---
      sectionHeader("Inspections");
      listRow(inspection, data.inspection_note);
      y += 2;

      // --- Issues ---
      sectionHeader("Issues");
      listRow(issue, data.issue_note);
      y += 2;

      // --- Needs ---
      sectionHeader("Needs");
      listRow(needs, data.needs_note);

      // ===== FOOTER =====
      const footerY = 820;
      doc.rect(0, footerY, pw, 22).fill(c.dark);
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor("#95a5a6")
        .text(
          `See Job Run  â€¢  Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
          m,
          footerY + 7,
          { width: cw, align: "center" },
        );

      doc.end();
    } catch (err) {
      logger.error("Error generating PDF:", err);
      res.status(500).json({ message: "Server error" });
    } finally {
      if (connection) connection.release();
    }
  },
);

module.exports = router;

