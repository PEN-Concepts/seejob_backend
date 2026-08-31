'use strict';
// Signed-document PDF + "email a copy to both parties" for Quotes and Change Orders.
// Generated server-side (pdfkit — pure JS, no external binary) the moment the client
// signs, so it works regardless of the client's browser. Emailed to the client with
// a CC to the sender/creator. Reuses services/mailer (attachments supported).
const PDFDocument = require('pdfkit');
const pool = require('../config/connection');
const logger = require('../common/logger');
const mailer = require('../services/mailer');

const money = (n) => '$' + (Number(n) || 0).toFixed(2);

/** Build a signed-document PDF Buffer from a quotes/change_orders row + its items. */
function buildSignedPdf(row, items, kind) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const title = kind === 'change_order' ? 'CHANGE ORDER' : 'QUOTE';
      const number = row.change_order_number || row.quote_number || row.id;
      const dateRaw = row.change_order_date || row.quote_date || row.created_at || '';
      const date = dateRaw ? String(dateRaw).slice(0, 10) : '';
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;

      // Header: company (left) + doc title/# (right)
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(18).text(row.company_name || 'Company', left, 50, { width: 300 });
      doc.font('Helvetica').fontSize(9).fillColor('#555');
      if (row.company_address) doc.text(String(row.company_address), left, undefined, { width: 300 });
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#c42034').text(title, right - 220, 50, { width: 220, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor('#333')
        .text(`#${number}`, right - 220, 76, { width: 220, align: 'right' })
        .text(date ? `Date: ${date}` : '', right - 220, 90, { width: 220, align: 'right' });

      doc.moveTo(left, 118).lineTo(right, 118).strokeColor('#111').lineWidth(1.5).stroke();

      // Bill to
      let y = 132;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#999').text('BILL TO', left, y);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(row.client_name || '—', left, y + 12);
      doc.font('Helvetica').fontSize(9).fillColor('#444');
      if (row.client_email) doc.text(String(row.client_email), left, undefined);
      if (row.project_address) doc.text(String(row.project_address), left, undefined);

      // Items table
      y = 200;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#666');
      doc.text('DESCRIPTION', left, y);
      doc.text('QTY', right - 210, y, { width: 50, align: 'right' });
      doc.text('RATE', right - 150, y, { width: 70, align: 'right' });
      doc.text('AMOUNT', right - 70, y, { width: 70, align: 'right' });
      doc.moveTo(left, y + 14).lineTo(right, y + 14).strokeColor('#111').lineWidth(1).stroke();
      y += 22;
      doc.font('Helvetica').fontSize(9).fillColor('#222');
      for (const it of (items || [])) {
        const amt = it.line_total_price != null ? it.line_total_price : (Number(it.qty || 0) * Number(it.unit_price || 0));
        const h = doc.heightOfString(String(it.description || ''), { width: right - left - 230 });
        doc.text(String(it.description || ''), left, y, { width: right - left - 230 });
        doc.text(String(it.qty ?? ''), right - 210, y, { width: 50, align: 'right' });
        doc.text(money(it.unit_price), right - 150, y, { width: 70, align: 'right' });
        doc.font('Helvetica-Bold').text(money(amt), right - 70, y, { width: 70, align: 'right' });
        doc.font('Helvetica');
        y += Math.max(16, h + 6);
        if (y > 640) { doc.addPage(); y = 60; }
      }
      // Total
      doc.moveTo(right - 200, y + 2).lineTo(right, y + 2).strokeColor('#111').lineWidth(1.5).stroke();
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('TOTAL', right - 200, y + 10, { width: 120 });
      doc.fillColor('#c42034').text(money(row.grand_total_amount), right - 80, y + 10, { width: 80, align: 'right' });
      y += 40;

      // Signature block
      if (y > 560) { doc.addPage(); y = 60; }
      doc.moveTo(left, y).lineTo(right, y).strokeColor('#ddd').lineWidth(1).stroke();
      y += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1f7a44').text('✓ SIGNED', left, y);
      doc.font('Helvetica').fontSize(9).fillColor('#333')
        .text(`Signed by: ${row.client_signed_name || row.client_name || ''}`, left, y + 14)
        .text(`Date: ${row.client_signed_at ? String(row.client_signed_at).slice(0, 19).replace('T', ' ') : ''}`, left, y + 28);
      // Embed the drawn signature PNG (data URL → buffer)
      const sig = String(row.client_signature_data || '');
      const b64 = sig.startsWith('data:image') ? sig.split(',')[1] : '';
      if (b64) {
        try { doc.image(Buffer.from(b64, 'base64'), left, y + 44, { fit: [220, 70] }); } catch (e) { /* skip bad image */ }
      }

      doc.end();
    } catch (e) { reject(e); }
  });
}

/** After a client signs, email the signed PDF to the client (to) + the sender (cc). */
async function sendSignedCopy(row, kind) {
  try {
    const table = kind === 'change_order' ? 'change_order_items' : 'quote_items';
    const fk = kind === 'change_order' ? 'change_order_id' : 'quote_id';
    const [items] = await pool.query(
      `SELECT description, qty, unit_price, line_total_price FROM ${table} WHERE ${fk} = ? ORDER BY sort_order ASC`,
      [row.id]
    ).catch(() => [[]]);
    let creatorEmail = null;
    if (row.created_by_user_id) {
      const [[u]] = await pool.query('SELECT email FROM `user` WHERE id = ? LIMIT 1', [row.created_by_user_id]);
      creatorEmail = u && u.email ? u.email : null;
    }
    const to = row.client_email;
    const number = row.change_order_number || row.quote_number || row.id;
    // "Emailed to both" needs a client address. In practice one always exists (the
    // send-for-signature link was emailed to the client). If it's missing, this is a
    // DELIBERATE, VISIBLE exception: warn + send the sender their copy so the signed
    // PDF isn't lost, rather than silently dropping it.
    if (!to) logger.warn(`sendSignedCopy (${kind} #${number}): no client_email on the signed record — sender copy only, client copy NOT sent.`);
    if (!to && !creatorEmail) { logger.warn(`sendSignedCopy (${kind} #${number}): no client OR sender email — no signed copy emailed.`); return; }
    const buf = await buildSignedPdf(row, items, kind);
    const label = kind === 'change_order' ? 'Change Order' : 'Quote';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
        <p>The ${label} <b>#${number}</b> from ${row.company_name || 'your contractor'} has been <b>signed</b>${row.client_signed_name ? ' by ' + row.client_signed_name : ''}.</p>
        <p>A signed PDF copy is attached for your records.</p>
      </div>`;
    await mailer.sendMail({
      to: to || creatorEmail,
      cc: to && creatorEmail && creatorEmail !== to ? creatorEmail : undefined,
      subject: `Signed ${label} #${number}`,
      html,
      attachments: [{ filename: `${kind === 'change_order' ? 'change-order' : 'quote'}-${number}-signed.pdf`, content: buf, contentType: 'application/pdf' }],
    });
  } catch (e) {
    logger.error(`sendSignedCopy (${kind}) failed: ` + (e && e.message));
    // non-fatal — signing already succeeded; email is best-effort
  }
}

module.exports = { buildSignedPdf, sendSignedCopy };
