// Socket.IO real-time layer for chat. In-process (single PM2 fork), so no Redis
// adapter — all sockets live in this process's memory. Each authenticated socket
// joins its own `user:<id>` room; a new message is emitted to each member's user
// room, and members who are NOT currently connected get an FCM push instead
// (see services/chat.js). socket.io is required LAZILY inside init() so the rest
// of the app (and the test harness) can require this module without the dependency
// installed — emit* are safe no-ops until init() runs.
require("dotenv").config();
const jwt = require("jsonwebtoken");

let io = null;
// userId -> Set<socketId>
const presence = new Map();

function addPresence(userId, socketId) {
  const key = String(userId);
  if (!presence.has(key)) presence.set(key, new Set());
  presence.get(key).add(socketId);
}
function removePresence(userId, socketId) {
  const key = String(userId);
  const set = presence.get(key);
  if (!set) return;
  set.delete(socketId);
  if (!set.size) presence.delete(key);
}

/** True if the user has at least one live socket right now. */
function isUserOnline(userId) {
  const set = presence.get(String(userId));
  return !!(set && set.size);
}

/** Emit an event to every device the user currently has connected. No-op if the
 *  realtime server isn't initialized (e.g. in unit tests). */
function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

/** Attach a Socket.IO server to an existing http.Server. Best-effort: if socket.io
 *  isn't installed or init throws, logs and leaves io null (REST still works, just
 *  no live delivery — offline FCM still fires). */
function init(httpServer, logger) {
  try {
    const { Server } = require("socket.io");
    io = new Server(httpServer, {
      cors: { origin: true, credentials: true },
      // Allow the long-polling fallback so it works before nginx forwards the
      // WebSocket upgrade headers; upgrades to true WS once nginx does.
      transports: ["websocket", "polling"],
    });

    // JWT handshake auth (same ACCESS_TOKEN as the REST API).
    io.use((socket, next) => {
      try {
        const token =
          (socket.handshake.auth && socket.handshake.auth.token) ||
          (socket.handshake.query && socket.handshake.query.token) ||
          "";
        if (!token) return next(new Error("no token"));
        const decoded = jwt.verify(String(token), process.env.ACCESS_TOKEN);
        socket.userId = decoded.id;
        return next();
      } catch (e) {
        return next(new Error("auth failed"));
      }
    });

    io.on("connection", (socket) => {
      const uid = socket.userId;
      socket.join(`user:${uid}`);
      addPresence(uid, socket.id);
      socket.on("disconnect", () => removePresence(uid, socket.id));
    });

    if (logger) logger.info("[realtime] Socket.IO initialized");
  } catch (e) {
    io = null;
    if (logger) logger.error("[realtime] init failed (chat live delivery off): " + e.message);
  }
}

module.exports = { init, emitToUser, isUserOnline };
