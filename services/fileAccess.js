"use strict";

/**
 * FILE ACCESS — one place that answers "may this caller read this file?"
 *
 * Every uploaded file is stored on disk under uploads/ and, historically, was
 * served straight off disk by nginx at /uploads/<name> with NO login and NO
 * ownership check (a LIVE cross-tenant hole). The fix is an authenticated app
 * route that resolves the file's OWNING account from the DB row that references
 * the filename, and serves it only to that account.
 *
 * TWO things live here:
 *   fileOwnerId(conn, filename)  -> the user id whose account owns the file, or
 *                                   null (default-deny: unknown file = no read).
 *   sign/verifyFileToken         -> a SHORT-LIVED token an <img src> can carry in
 *                                   the query string, because an <img> can't send
 *                                   the Authorization header the app uses. It is
 *                                   scoped to the caller and expires fast, so a
 *                                   leaked URL is not a durable session.
 */
const jwt = require("jsonwebtoken");
const { isSameAccount } = require("../utils/access");

const FILE_TOKEN_TTL_SECONDS = 900; // 15 minutes

/** Mint a short-lived, caller-scoped file token (for ?t= on <img> URLs). */
function signFileToken(userId) {
  return jwt.sign({ id: Number(userId), kind: "file" }, process.env.ACCESS_TOKEN, {
    expiresIn: FILE_TOKEN_TTL_SECONDS,
  });
}

/** Verify a file token; returns the user id, or null. Only 'file'-kind tokens
 *  pass, so an ordinary session JWT can't be smuggled in via the query. */
function verifyFileToken(token) {
  try {
    const d = jwt.verify(String(token || ""), process.env.ACCESS_TOKEN);
    return d && d.kind === "file" && d.id ? Number(d.id) : null;
  } catch (_) {
    return null;
  }
}

/** Just the basename — the only part of any stored reference that is reliable,
 *  and the traversal-safe piece. Splits BOTH separators (Windows dev boxes). */
function basenameOf(ref) {
  const s = String(ref || "").trim();
  if (!s) return "";
  const last = s.split(/[/\\]/).filter(Boolean).pop() || "";
  return last.split(/[?#]/)[0];
}

/** Reject anything that could escape the uploads dir. */
function isSafeName(name) {
  const s = String(name || "");
  return !!s && !s.includes("/") && !s.includes("\\") && !s.includes("..") && s === basenameOf(s);
}

/**
 * The user id whose ACCOUNT owns the file called `filename`, resolved from the
 * DB row that references it. Checks every table that stores an upload name,
 * matching on the BASENAME (stored refs are a mix of absolute paths, /uploads/x
 * and bare names). Returns the first owner found, or null. Default-deny.
 *
 * Owner columns (audited): job_documents.job_id->job.created_by,
 * tasks_images.task_id->tasks.created_by, notepad.user_id (image/audio_note),
 * notepad_gallery.notepad_id->notepad.user_id, user.image (the user itself),
 * equipments.created_by, chat_message_attachments->conversation->job.created_by.
 */
async function fileOwnerId(conn, filename) {
  const name = basenameOf(filename);
  if (!name) return null;
  const like = "%" + name; // matches '/uploads/<name>', '/home/.../<name>', '<name>'

  const tries = [
    // job documents & photos
    `SELECT j.created_by AS owner FROM job_documents d JOIN job j ON j.id = d.job_id
       WHERE d.path = ? OR d.path LIKE ? LIMIT 1`,
    // task images
    `SELECT t.created_by AS owner FROM tasks_images ti JOIN tasks t ON t.id = ti.task_id
       WHERE ti.file_path = ? OR ti.file_path LIKE ? LIMIT 1`,
    // notepad image(s) (comma-joined) / audio
    `SELECT n.user_id AS owner FROM notepad n
       WHERE n.image = ? OR FIND_IN_SET(?, n.image) OR n.audio_note = ? OR n.audio_note LIKE ? LIMIT 1`,
    // notepad gallery
    `SELECT n.user_id AS owner FROM notepad_gallery g JOIN notepad n ON n.id = g.notepad_id
       WHERE g.image = ? OR FIND_IN_SET(?, g.image) OR g.image LIKE ? LIMIT 1`,
    // user avatar (the file belongs to that user's account)
    `SELECT id AS owner FROM \`user\` WHERE image = ? OR image LIKE ? LIMIT 1`,
    // equipment
    `SELECT created_by AS owner FROM equipments WHERE image = ? OR image LIKE ? LIMIT 1`,
    // chat attachments -> job conversation -> job owner
    `SELECT j.created_by AS owner
       FROM chat_message_attachments a
       JOIN chat_conversations cc ON cc.id = a.conversation_id
       JOIN job j ON j.id = cc.job_id
       WHERE a.file_path = ? OR a.file_path LIKE ? LIMIT 1`,
  ];
  const params = [
    [name, like],
    [name, like],
    [name, name, name, like],
    [name, name, like],
    [name, like],
    [name, like],
    [name, like],
  ];

  for (let i = 0; i < tries.length; i++) {
    try {
      const [[row]] = await conn.query(tries[i], params[i]);
      if (row && row.owner != null) return Number(row.owner);
    } catch (_) {
      // a table may not exist on a bare schema — skip, never throw (fail closed
      // means "no owner found here", not "grant").
    }
  }
  return null;
}

/** Does this caller's account own the file? Fail closed on any error. */
async function callerOwnsFile(conn, callerId, filename) {
  try {
    if (!isSafeName(basenameOf(filename))) return false;
    const ownerId = await fileOwnerId(conn, filename);
    if (ownerId == null) return false;
    return await isSameAccount(callerId, ownerId, conn);
  } catch (_) {
    return false;
  }
}

module.exports = {
  FILE_TOKEN_TTL_SECONDS,
  signFileToken,
  verifyFileToken,
  basenameOf,
  isSafeName,
  fileOwnerId,
  callerOwnsFile,
};
