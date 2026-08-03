/**
 * One-time backfill for LEGACY null-color jobs (created before the pool system).
 * Draws from the existing 30-colour pool via the shared backfillJobColors()
 * helper — same pickJobColor rule as new jobs, no separate palette.
 *
 * Dry-run by default (prints the plan only). Pass --apply to write.
 *   node scripts/backfillJobColors.js          # dry run
 *   node scripts/backfillJobColors.js --apply   # write
 */

const pool = require("../config/connection");
const { backfillJobColors } = require("../services/jobColorPalette");

const APPLY = process.argv.includes("--apply");

(async () => {
  let connection;
  try {
    connection = await pool.getConnection();
    const res = await backfillJobColors(connection, { apply: APPLY });
    for (const p of res.plan) {
      console.log(
        `${APPLY ? "SET " : "WOULD SET"} job ${p.jobId} (creator ${p.createdBy}) -> ${p.to}`
      );
    }
    console.log(
      `\n${APPLY ? "APPLIED" : "DRY RUN"} — active jobs scanned ${res.scanned}, ${APPLY ? "filled" : "would fill"} ${res.filled}`
    );
    if (!APPLY) console.log("Re-run with --apply to write.");
  } catch (err) {
    console.error("Backfill error:", err);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    try { await pool.end(); } catch (_) {}
  }
})();
