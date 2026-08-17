// Multi-assignee read helper. Attaches an `assignees` array to each task row so
// the frontend can render every assigned person + their PER-PERSON "seen" state.
// tasks.user_id stays the primary, so single-assignee clients are unaffected;
// this just adds the full list. One query for the whole page of tasks (no N+1).
//
// Each entry: { user_id, name, business_name, seen_at }  (seen_at = that person's
// own "opened it" stamp; null until they open the task).
async function attachAssignees(db, tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return tasks;
  const ids = [...new Set(tasks.map((t) => Number(t && t.id)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return tasks;
  const ph = ids.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT ta.task_id, ta.user_id, ta.seen_at, u.name, u.business_name
       FROM task_assignees ta
       JOIN \`user\` u ON u.id = ta.user_id
      WHERE ta.task_id IN (${ph})
      ORDER BY ta.id ASC`,
    ids
  );
  const byTask = new Map();
  for (const r of rows) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push({
      user_id: r.user_id,
      name: r.name,
      business_name: r.business_name || null,
      seen_at: r.seen_at,
    });
  }
  for (const t of tasks) {
    if (t && t.id != null) t.assignees = byTask.get(Number(t.id)) || [];
  }
  return tasks;
}

module.exports = { attachAssignees };
