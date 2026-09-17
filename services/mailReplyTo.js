'use strict';

/**
 * WHO OWNS THE CONVERSATION — the Reply-To for every outbound message.
 *
 * Until now there was no reply-to anywhere in the backend: not on either
 * transport, not in any of the thirteen sending files. Every message went out
 * From a no-reply address with nothing steering a reply anywhere else.
 *
 * That is survivable only while the mail lands in spam. After the SES cutover
 * it lands in inboxes, more people reply, and every one of those replies goes
 * to a no-reply address and vanishes. So this is the gate on the cutover, not
 * a tidy-up after it.
 *
 * THE PRINCIPLE:
 *
 *   Reply-to is the account email of the GENERAL CONTRACTOR ON WHOSE BEHALF
 *   the message is sent — the person who owns the conversation.
 *
 * Not the triggering user. Those coincide for sixteen of the eighteen call
 * sites and diverge for the signed-document copy, which is reached from PUBLIC
 * unauthenticated endpoints where the trigger is the CLIENT signing. There the
 * owner is the document's created_by_user_id. Resolving "the owning GC" rather
 * than "whoever called" is what makes both cases the same rule.
 *
 * An EMPLOYEE sending on the company's behalf resolves to the company owner,
 * not to themselves — resolveOwnerId does that walk. A reply to a quote should
 * reach the business, not the estimator who happened to press send and may not
 * be there next week.
 *
 * THREE KINDS OF MESSAGE, three answers:
 *
 *   user-originated  -> the owning GC's account email          replyToForUser
 *   app mail         -> MAIL_REPLY_TO (default info@seejobrun.com)
 *                       OTP, password recovery, our own admin notices. There
 *                       is no GC behind these; a reply belongs to us.
 *   inbound enquiry  -> the ENQUIRER's own address from the submission
 *                       The contact form and the demo request go TO us; the
 *                       conversation is with the person who wrote in, so the
 *                       reply-to is theirs and is passed explicitly.
 */

const logger = require('../common/logger');

/**
 * App mail, and the last-resort default at the chokepoint. Read through a
 * function, not captured at module load, so a test (and a running process that
 * has its env re-read) sees a change rather than a snapshot.
 */
function defaultReplyTo() {
  return String(process.env.MAIL_REPLY_TO || 'info@seejobrun.com').trim();
}

/** RFC-ish: "Name" <addr>. A name with a quote or backslash in it is dropped
 *  rather than escaped — a malformed header is worse than a bare address. */
function formatAddress(name, email) {
  const addr = String(email || '').trim();
  if (!addr) return '';
  const nm = String(name || '').trim();
  if (!nm || /["\\\r\n]/.test(nm)) return addr;
  return `"${nm}" <${addr}>`;
}

/**
 * The owning GC's reply-to for a user id.
 *
 * Walks employee -> account owner via resolveOwnerId, so a message sent by an
 * employee still replies to the company. Falls back to the app default rather
 * than returning nothing: a message with a reply-to pointing at us is
 * recoverable, one with no reply-to at all is the bug this closes.
 *
 * NEVER THROWS. It is called on the send path of quotes, invoices and change
 * orders; failing a customer's invoice because a name lookup hiccuped would be
 * a worse outcome than a slightly wrong header.
 */
async function replyToForUser(connection, userId) {
  const id = Number(userId || 0);
  if (!id) return defaultReplyTo();
  try {
    const { resolveOwnerId } = require('../utils/access');
    const ownerId = Number(await resolveOwnerId(id, connection));
    const [[row]] = await connection.query(
      'SELECT name, email, business FROM `user` WHERE id = ? LIMIT 1',
      [ownerId || id],
    );
    const email = row && String(row.email || '').trim();
    if (!email) return defaultReplyTo();
    // The business name if there is one — a client replying to a quote should
    // see the company, not a person they have never met.
    return formatAddress((row.business || row.name || '').trim(), email);
  } catch (e) {
    logger.error('[replyTo] resolve failed for user ' + id + ': ' + e.message);
    return defaultReplyTo();
  }
}

/**
 * The owning GC for a RECORD, given the column that holds its creator.
 * signedDocPdf uses this: the trigger there is the client signing on a public
 * endpoint, so the conversation's owner is the document's creator.
 */
async function replyToForOwnerId(connection, createdByUserId) {
  return replyToForUser(connection, createdByUserId);
}

module.exports = { defaultReplyTo, formatAddress, replyToForUser, replyToForOwnerId };
