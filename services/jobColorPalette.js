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
const JOB_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#008080', '#f032e6', '#9a6324', '#800000', '#808000',
  '#000075', '#46b3a0', '#e67e22', '#2e8b57', '#c71585',
  '#1e90ff', '#b8860b', '#6a5acd', '#20b2aa', '#cd5c5c',
  '#228b22', '#d2691e', '#4682b4', '#8b008b', '#ff6347',
  '#00868b', '#9932cc', '#556b2f', '#a0522d', '#2f4f9f',
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
 * (active jobs with a NULL/empty color). Assigns from the SAME 30-colour pool
 * using the exact pickJobColor rule — per creator, first colour not already held
 * by that creator's active jobs, cycling when all 30 are taken. Non-destructive:
 * jobs that already have a colour are never changed, and completed/archived jobs
 * are left NULL (they intentionally released their colour back to the pool).
 *
 * The "used" set is tracked in memory and updated per assignment, so a DRY RUN
 * (apply=false) produces EXACTLY the colours a real apply would — no duplicates
 * within one creator. Returns { apply, scanned, filled, plan[] }.
 */
async function backfillJobColors(connection, opts = {}) {
  const apply = opts.apply === true;
  // All ACTIVE jobs (color released on complete/archive, so only status=1 holds).
  const [rows] = await connection.query(
    "SELECT id, created_by, color FROM job WHERE status = 1 ORDER BY created_by ASC, id ASC"
  );

  // Seed each creator's used-colour set from jobs that ALREADY have a colour.
  const usedByCreator = new Map();
  for (const r of rows) {
    const c = String(r.color || '').trim().toLowerCase();
    if (!c) continue;
    if (!usedByCreator.has(r.created_by)) usedByCreator.set(r.created_by, new Set());
    usedByCreator.get(r.created_by).add(c);
  }

  const plan = [];
  let filled = 0;
  for (const r of rows) {
    if (String(r.color || '').trim()) continue; // keep existing colour
    if (!usedByCreator.has(r.created_by)) usedByCreator.set(r.created_by, new Set());
    const used = usedByCreator.get(r.created_by);
    const color =
      JOB_COLORS.find((c) => !used.has(c.toLowerCase())) ||
      JOB_COLORS[used.size % JOB_COLORS.length];
    used.add(color.toLowerCase());
    plan.push({ jobId: r.id, createdBy: r.created_by, to: color });
    if (apply) {
      await connection.query("UPDATE job SET color = ? WHERE id = ?", [color, r.id]);
    }
    filled++;
  }

  return { apply, scanned: rows.length, filled, plan };
}

module.exports = { JOB_COLORS, pickJobColor, backfillJobColors };
