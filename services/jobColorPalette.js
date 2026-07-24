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

module.exports = { JOB_COLORS, pickJobColor };
