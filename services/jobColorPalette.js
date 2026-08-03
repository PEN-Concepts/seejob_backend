'use strict';
/**
 * Job color POOL. Leads are coloured from a separate grey ramp on the client;
 * this 30-colour pool is only for real jobs. A colour is ASSIGNED when a lead
 * converts to a job (or a job is created / reactivated), PERSISTED on
 * `job.color`, and RELEASED (set NULL) when the job is completed or archived so
 * the colour returns to the pool for reuse.
 *
 * Pool scope is per creator (job.created_by): pickJobColor returns the first
 * palette colour not currently held by that creator's ACTIVE jobs, so at any
 * time a creator's active jobs stay visually distinct until all 30 are taken.
 */
// Approved muted, RED-FREE 47-colour pool (task #53). Order is verbatim from the
// approved list — do not reorder/substitute. Sunflower #fdb813 intentionally
// matches the brand Sunflower (owner's explicit choice for this pool).
const JOB_COLORS = [
  // Orange / rust (5)
  '#a8461f', '#c1651d', '#8a4a2e', '#b5794f', '#a95e3b',
  // Gold / amber / yellow (6)
  '#c68a1f', '#c9a227', '#d4a017', '#a67c2e', '#fdb813', '#d6c148',
  // Brown (5)
  '#6b4226', '#4a3a2a', '#8f6a45', '#725649', '#422619',
  // Tan / camel (7)
  '#b8834f', '#c9a878', '#dcc39a', '#b8b08a', '#cbb573', '#d5d1b9', '#c1bda1',
  // Green (9)
  '#6b7a2e', '#4a7a3d', '#8a9a7a', '#3ea88a', '#1f5c45', '#9adcc2', '#879c2e', '#6fb89a', '#2fbab0',
  // Blue / teal (8)
  '#2f7d7d', '#7fa8c9', '#3b6f9b', '#3d4a8a', '#b3a6e6', '#4689b5', '#6a7c90', '#866dd1',
  // Purple / pink (7)
  '#6b3b9b', '#7a3d6b', '#a83e7a', '#b5788a', '#aa91b6', '#926ca4', '#60294d',
];

/** First palette colour not held by this creator's active jobs; cycles when full. */
async function pickJobColor(connection, createdBy) {
  const [rows] = await connection.query(
    'SELECT color FROM job WHERE created_by = ? AND status = 1 AND color IS NOT NULL',
    [createdBy]
  );
  const used = new Set((rows || []).map((r) => String(r.color || '').toLowerCase()));
  for (const c of JOB_COLORS) {
    if (!used.has(c.toLowerCase())) return c;
  }
  return JOB_COLORS[used.size % JOB_COLORS.length];
}

/**
 * One-time BACKFILL for legacy jobs created before the pool system shipped
 * (active jobs with a NULL/empty color). Assigns from the SAME 30-colour pool,
 * but scoped PER ACCOUNT so an account's jobs stay visually distinct on its
 * shared calendar/Task Manager — each null job takes the first pool colour not
 * already held by ANY active job on that account, cycling when all 30 are taken.
 * Non-destructive: jobs that already have a colour are never changed, and
 * completed/archived jobs are left NULL (they released their colour by design).
 *
 * The account key mirrors EXACTLY what the calendar / jobs-all list shows
 * together: COALESCE(creator.created_by, job.created_by) — i.e. the owner when
 * the creator is the owner or one of the owner's sub-users (employee/client),
 * else the creator itself. (New jobs still colour per-creator via pickJobColor;
 * this per-account scope applies to the one-time legacy backfill only.)
 *
 * The "used" set is tracked in memory and updated per assignment, so a DRY RUN
 * (apply=false) produces EXACTLY the colours a real apply would. Returns
 * { apply, scanned, filled, plan[] } where each plan row is { jobId, account, to }.
 */
async function backfillJobColors(connection, opts = {}) {
  const apply = opts.apply === true;
  // reassign=true → OVERWRITE every active job's colour from the (new) pool. Used
  // when the pool itself changes (task #53: mute + drop reds), so jobs holding an
  // old/removed colour are recoloured. reassign=false → original fill-only mode
  // (only NULL-colour legacy jobs, existing colours kept).
  const reassign = opts.reassign === true;
  // All ACTIVE jobs (color released on complete/archive, so only status=1 holds),
  // tagged with the account root they display under (same rule as /all-tasks).
  const [rows] = await connection.query(
    `SELECT j.id, j.color, COALESCE(u.created_by, j.created_by) AS account_root
       FROM job j
       LEFT JOIN \`user\` u ON u.id = j.created_by
      WHERE j.status = 1
      ORDER BY j.id ASC`
  );

  // Group jobs by account root (preserving global id order within each group).
  const byAccount = new Map();
  for (const r of rows) {
    const owner = r.account_root;
    if (!byAccount.has(owner)) byAccount.set(owner, []);
    byAccount.get(owner).push(r);
  }

  const plan = [];
  let filled = 0;
  for (const [owner, jobs] of byAccount) {
    // Fill mode seeds the used set from already-coloured jobs (so they're kept).
    // Reassign mode starts empty — every job is (re)assigned from the pool.
    const used = new Set();
    if (!reassign) {
      for (const j of jobs) {
        const c = String(j.color || '').trim().toLowerCase();
        if (c) used.add(c);
      }
    }
    for (const j of jobs) {
      if (!reassign && String(j.color || '').trim()) continue; // fill mode keeps existing
      const color =
        JOB_COLORS.find((c) => !used.has(c.toLowerCase())) ||
        JOB_COLORS[used.size % JOB_COLORS.length];
      used.add(color.toLowerCase());
      plan.push({ jobId: j.id, account: owner, from: j.color || null, to: color });
      if (apply) {
        await connection.query("UPDATE job SET color = ? WHERE id = ?", [color, j.id]);
      }
      filled++;
    }
  }

  return { apply, reassign, scanned: rows.length, filled, plan };
}

module.exports = { JOB_COLORS, pickJobColor, backfillJobColors };
