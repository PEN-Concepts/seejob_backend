"use strict";
/**
 * AUTHENTICATED FILE SERVING. Replaces nginx serving /uploads/<name> straight
 * off disk with no login (a LIVE cross-tenant hole). Every file is now streamed
 * only after the caller's account is shown to own it — see services/fileAccess.
 *
 *   GET /files/token        -> a short-lived file token (Bearer-authed). The FE
 *                              appends it as ?t= on <img>/<audio> URLs, because
 *                              those tags can't send the Authorization header.
 *   GET /files/:name        -> the file, if the caller (from ?t= OR Bearer) owns
 *                              it. Path is built server-side from the basename;
 *                              a traversal attempt is refused before any disk hit.
 */
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const pool = require("../config/connection");
const logger = require("../common/logger");
const auth = require("../services/authentication");
const { signFileToken, verifyFileToken, isSafeName, basenameOf, ownedRelPath } = require("../services/fileAccess");

const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

// Mint a short-lived, caller-scoped token for <img> URLs. Bearer-authed, so
// only a logged-in session can get one.
router.get("/token", auth.authenticateToken, (req, res) => {
  const id = (req.user && req.user.id) || res.locals.id;
  if (!id) return res.status(401).json({ message: "Unauthorized" });
  return res.json({ token: signFileToken(id), expires_in: 900 });
});

// Resolve the caller from EITHER a ?t= file token (for <img src>) OR a Bearer
// header (for HttpClient). Returns the user id, or null.
function callerIdOf(req) {
  const t = req.query && req.query.t;
  if (t) {
    const id = verifyFileToken(t);
    if (id) return id;
  }
  const authHeader = req.headers["authorization"];
  const bearer = authHeader && authHeader.split(" ")[1];
  if (bearer) {
    try {
      const d = jwt.verify(bearer, process.env.ACCESS_TOKEN);
      if (d && d.id) return Number(d.id);
    } catch (_) {}
  }
  return null;
}

router.get("/:name", async (req, res) => {
  const name = basenameOf(req.params.name);
  // Traversal guard BEFORE any DB or disk work.
  if (!isSafeName(name)) return res.status(400).json({ message: "Invalid file name" });

  const callerId = callerIdOf(req);
  if (!callerId) return res.status(401).json({ message: "Sign in to view this file." });

  let connection;
  try {
    connection = await pool.getConnection();
    // The caller must own the file; we get back its REAL path under uploads
    // (a task image lives in tasks/<id>/, not the uploads root).
    const rel = await ownedRelPath(connection, callerId, name);
    if (!rel) return res.status(403).json({ message: "This file does not belong to your account." });

    const full = path.join(UPLOADS_DIR, rel);
    // Defence in depth: the resolved absolute path must still sit inside uploads.
    if (!full.startsWith(UPLOADS_DIR + path.sep) && full !== UPLOADS_DIR) {
      return res.status(400).json({ message: "Invalid file name" });
    }
    if (!fs.existsSync(full)) return res.status(404).json({ message: "File not found" });
    return res.sendFile(full);
  } catch (err) {
    logger.error("file serve error: " + (err && err.message));
    return res.status(500).json({ message: "Failed to serve file" });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
