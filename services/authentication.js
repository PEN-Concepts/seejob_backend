require("dotenv").config();

const jwt = require("jsonwebtoken");
const pool = require("../config/connection");

// Session lifetimes. Web is unchanged (7 days). Mobile (/m) is long-lived because
// the mobile app has no logout — the product intent is "log in once per device" —
// and field crews are often out of cell range, so they can't receive a re-OTP.
// The safety valve for a long-lived token is the SERVER-SIDE revoke check below
// (status / token_version), so a lost phone or departed employee can be cut off
// immediately regardless of the token's expiry.
const MOBILE_TOKEN_TTL = "365d";
const WEB_TOKEN_TTL = "7d";
// Renew a mobile token once it's within its last 180 days, so any phone used at
// least once every ~6 months never sees an OTP prompt again ("renews on use").
const MOBILE_RENEW_BEFORE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Sign a session JWT. `platform:'mobile'` → 1-year token (silently renewed on use,
 * see authenticateToken); anything else → the unchanged 7-day web token. The
 * caller's current `tokenVersion` is embedded so a server-side bump instantly
 * invalidates every token that person holds.
 */
function signSession(payload, { platform, tokenVersion } = {}) {
  const plat = platform === "mobile" ? "mobile" : "web";
  const clean = { ...payload };
  delete clean.iat;
  delete clean.exp; // never carry a previous token's timestamps forward
  clean.plat = plat;
  clean.tv = Number(tokenVersion || 0);
  return jwt.sign(clean, process.env.ACCESS_TOKEN, {
    expiresIn: plat === "mobile" ? MOBILE_TOKEN_TTL : WEB_TOKEN_TTL,
  });
}

/**
 * A user's current token_version (0 if the column hasn't been migrated yet — so
 * this ships safely BEFORE the ALTER TABLE; the revoke check simply no-ops on
 * token_version until the column exists, while the status check works today).
 */
async function getTokenVersion(userId) {
  try {
    const [[row]] = await pool.query(
      "SELECT token_version FROM `user` WHERE id = ? LIMIT 1",
      [userId]
    );
    return row && row.token_version != null ? Number(row.token_version) : 0;
  } catch (_) {
    return 0;
  }
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null)
    return res.status(401).json({ message: "Access denied. No token provided." });

  jwt.verify(token, process.env.ACCESS_TOKEN, async (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: "Invalid or expired token." });
    }

    req.user = decoded;
    res.locals.id = decoded.id;

    // SERVER-SIDE REVOKE CHECK. Previously verification was pure jwt.verify, so a
    // deactivated (status=0) or even deleted user kept full access until their
    // token expired — deactivate/delete did NOT end a live session. Now a bumped
    // token_version OR status=0 invalidates a live token on its next request
    // (returned as 401 so the client clears it + returns to /login). Tolerant of a
    // not-yet-migrated token_version column, and fails OPEN on a transient DB error
    // (the token is still cryptographically valid) so a DB blip can't lock everyone
    // out — revoke simply re-checks on the next request.
    try {
      let row;
      try {
        [[row]] = await pool.query(
          "SELECT status, token_version FROM `user` WHERE id = ? LIMIT 1",
          [decoded.id]
        );
      } catch (colErr) {
        // token_version column not present yet → status-only check.
        [[row]] = await pool.query(
          "SELECT status FROM `user` WHERE id = ? LIMIT 1",
          [decoded.id]
        );
      }

      if (row) {
        if (Number(row.status) === 0) {
          return res
            .status(401)
            .json({ code: "REVOKED", message: "Your access has been revoked." });
        }
        if (
          row.token_version != null &&
          decoded.tv != null &&
          Number(row.token_version) !== Number(decoded.tv)
        ) {
          return res
            .status(401)
            .json({ code: "REVOKED", message: "Your access has been revoked." });
        }

        // Sliding renewal — keep an active mobile phone logged in indefinitely.
        if (decoded.plat === "mobile" && typeof decoded.exp === "number") {
          const remainingMs = decoded.exp * 1000 - Date.now();
          if (remainingMs < MOBILE_RENEW_BEFORE_MS) {
            const tv =
              row.token_version != null
                ? Number(row.token_version)
                : Number(decoded.tv || 0);
            const fresh = signSession(decoded, { platform: "mobile", tokenVersion: tv });
            res.set("X-Renewed-Token", fresh);
            res.set("Access-Control-Expose-Headers", "X-Renewed-Token");
          }
        }
      }
    } catch (_) {
      /* transient DB error → fail open; revoke re-checks on the next request */
    }

    next();
  });
}

module.exports = { authenticateToken, signSession, getTokenVersion };
