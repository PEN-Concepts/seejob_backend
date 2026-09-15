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
      // Three-step column probe. shut_off_at and token_version are both added by
      // migrations, so this must keep working against a database where either is
      // still absent — that is what lets the code ship before the ALTER TABLE.
      let row;
      try {
        [[row]] = await pool.query(
          "SELECT status, token_version, shut_off_at FROM `user` WHERE id = ? LIMIT 1",
          [decoded.id]
        );
      } catch (colErr) {
        try {
          [[row]] = await pool.query(
            "SELECT status, token_version FROM `user` WHERE id = ? LIMIT 1",
            [decoded.id]
          );
        } catch (colErr2) {
          [[row]] = await pool.query(
            "SELECT status FROM `user` WHERE id = ? LIMIT 1",
            [decoded.id]
          );
        }
      }

      if (row) {
        if (Number(row.status) === 0) {
          return res
            .status(401)
            .json({ code: "REVOKED", message: "Your access has been revoked." });
        }

        // EMPLOYEE SHUT-OFF. A boss has ended this person's access from the
        // employee file. Deliberately checked HERE, alongside status and ahead of
        // the sliding renewal below: a shut-off phone quietly refreshing its own
        // token is this feature failing silently, which is the worst shape the
        // failure could take. Because this runs on EVERY request, the worst-case
        // delay between the boss pressing the button and the next request being
        // refused is one request — the token's remaining lifetime is irrelevant.
        //
        // Same 401 REVOKED shape as the other two, so every client already knows
        // to clear the token and return to /login. No new client handling needed.
        if (row.shut_off_at) {
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
      /* TRANSIENT DB ERROR → FAIL OPEN, DELIBERATELY AND CONSISTENTLY.
       *
       * The status check has always failed open here: the token is still
       * cryptographically valid, and a DB blip that locked out every user on
       * every device is a worse outcome than a revoked session surviving a few
       * seconds longer. shut_off_at fails open THE SAME WAY, on purpose.
       *
       * A mix would be worse than either choice. If shut_off_at failed closed
       * while status failed open, a DB blip would sign out the whole company
       * while leaving genuinely revoked accounts working — the exact inverse of
       * what anyone would want, and impossible to reason about in an incident.
       *
       * The cost is bounded: revoke re-checks on the very next request, so a
       * shut-off person regains access only for as long as the database is
       * unreachable, during which almost nothing else works either. */
    }

    next();
  });
}

/**
 * Is this user row shut off? Used by every sign-in path, so all of them ask the
 * one question the same way and a new sign-in path has an obvious thing to call.
 *
 * Takes a row OR a user id. Tolerant of the un-migrated column: if shut_off_at
 * does not exist yet the query throws and this returns false, matching the
 * ship-before-the-ALTER-TABLE behaviour of getTokenVersion above.
 */
function rowIsShutOff(row) {
  return !!(row && row.shut_off_at);
}

async function isUserShutOff(userId, connection) {
  const q = connection || pool;
  try {
    const [[row]] = await q.query(
      "SELECT shut_off_at FROM `user` WHERE id = ? LIMIT 1",
      [userId]
    );
    return rowIsShutOff(row);
  } catch (_) {
    // Column not present, or a transient error. Fails OPEN, consistently with
    // the revoke check in authenticateToken — see the long note there.
    return false;
  }
}

// The one message every sign-in path gives a shut-off user. Deliberately says
// what happened rather than "wrong password": the person has not mistyped
// anything and retrying will never work. It does NOT name the company that did
// it — a user row can be linked to several companies.
const SHUT_OFF_MESSAGE =
  "Your access to See Job Run has been turned off. Contact your employer.";

module.exports = {
  authenticateToken,
  signSession,
  getTokenVersion,
  rowIsShutOff,
  isUserShutOff,
  SHUT_OFF_MESSAGE,
};
