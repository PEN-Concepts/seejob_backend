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
async function findFileRow(conn, filename) {
  const name = basenameOf(filename);
  if (!name) return null;
  const like = "%" + name; // matches '/uploads/<name>', '/home/.../<name>', 'tasks/<id>/<name>', '<name>'

  // Each returns the owning user AND the STORED path, so the caller can serve
  // the file at its real on-disk location (task images live in a subdirectory,
  // e.g. tasks/<id>/<name>, not the uploads root).
  const tries = [
    [`SELECT j.created_by AS owner, d.path AS spath FROM job_documents d JOIN job j ON j.id = d.job_id
        WHERE d.path = ? OR d.path LIKE ? LIMIT 1`, [name, like]],
    [`SELECT t.created_by AS owner, ti.file_path AS spath FROM tasks_images ti JOIN tasks t ON t.id = ti.task_id
        WHERE ti.file_path = ? OR ti.file_path LIKE ? LIMIT 1`, [name, like]],
    [`SELECT n.user_id AS owner, ? AS spath FROM notepad n
        WHERE n.image = ? OR FIND_IN_SET(?, n.image) OR n.audio_note = ? OR n.audio_note LIKE ? LIMIT 1`, [name, name, name, name, like]],
    [`SELECT n.user_id AS owner, ? AS spath FROM notepad_gallery g JOIN notepad n ON n.id = g.notepad_id
        WHERE g.image = ? OR FIND_IN_SET(?, g.image) OR g.image LIKE ? LIMIT 1`, [name, name, name, like]],
    [`SELECT id AS owner, image AS spath FROM \`user\` WHERE image = ? OR image LIKE ? LIMIT 1`, [name, like]],
    [`SELECT created_by AS owner, image AS spath FROM equipments WHERE image = ? OR image LIKE ? LIMIT 1`, [name, like]],
    [`SELECT j.created_by AS owner, a.file_path AS stored
        FROM chat_message_attachments a
        JOIN chat_conversations cc ON cc.id = a.conversation_id
        JOIN job j ON j.id = cc.job_id
        WHERE a.file_path = ? OR a.file_path LIKE ? LIMIT 1`, [name, like]],
  ];

  for (const [sql, params] of tries) {
    try {
      const [[row]] = await conn.query(sql, params);
      if (row && row.owner != null) return { owner: Number(row.owner), stored: String(row.spath || name) };
    } catch (_) {
      // a table may not exist on a bare schema — skip, never throw (fail closed
      // means "no owner found here", not "grant").
    }
  }
  return null;
}

/** The user id whose account owns the file, or null. */
async function fileOwnerId(conn, filename) {
  const row = await findFileRow(conn, filename);
  return row ? row.owner : null;
}

/** Does this caller's account own the file? Fail closed on any error. */
async function callerOwnsFile(conn, callerId, filename) {
  try {
    if (!isSafeName(basenameOf(filename))) return false;
    const row = await findFileRow(conn, filename);
    if (!row) return false;
    return await isSameAccount(callerId, row.owner, conn);
  } catch (_) {
    return false;
  }
}

/**
 * The file's on-disk path RELATIVE TO uploads/, if the caller owns it — else
 * null. Derived from the STORED reference, so a subdir'd file (tasks/<id>/<name>)
 * is served from its real location, not a wrong uploads-root guess. Rejects any
 * '..' segment so it can never escape uploads/.
 */
async function ownedRelPath(conn, callerId, filename) {
  try {
    if (!isSafeName(basenameOf(filename))) return null;
    const row = await findFileRow(conn, filename);
    if (!row) return null;
    if (!(await isSameAccount(callerId, row.owner, conn))) return null;
    return storedToRelPath(row.stored);
  } catch (_) {
    return null;
  }
}

/** Reduce a stored reference to a safe path relative to uploads/. */
function storedToRelPath(stored) {
  let s = String(stored || "").replace(/\\/g, "/").trim();
  if (!s) return null;
  // Everything after the LAST 'uploads/' is the part under the uploads dir.
  const m = s.toLowerCase().lastIndexOf("uploads/");
  if (m >= 0) s = s.slice(m + "uploads/".length);
  s = s.replace(/^\/+/, "");
  // No traversal, no absolute, no empty segment.
  if (!s || s.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return s;
}

module.exports = {
  FILE_TOKEN_TTL_SECONDS,
  signFileToken,
  verifyFileToken,
  basenameOf,
  isSafeName,
  fileOwnerId,
  callerOwnsFile,
  ownedRelPath,
  storedToRelPath,
};
