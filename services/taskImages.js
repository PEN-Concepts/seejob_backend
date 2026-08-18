// Shared task-photo read helper. Attaches an `images` array to each task row so
// every task list (web + mobile) can render + count its photos. Photos live in
// tasks_images (multi-photo, uploaded via /upload-photos); one query for the whole
// page (no N+1). Moved out of routes/tasks.js so routes/jobs.js (/all-tasks — the
// MOBILE task list) can attach them too — previously it returned tasks with no
// `images`, so mobile-uploaded photos persisted but were never sent to the client.
//
// Each entry: { id, filename, created_at, kind, uploaded_by, uploaded_by_name }.
async function attachTaskImages(connectionOrPool, tasks) {
  if (!tasks || tasks.length === 0) return tasks;

  const ids = tasks
    .map((t) => t && t.id)
    .filter((id) => Number.isFinite(Number(id)));

  if (ids.length === 0) {
    tasks.forEach((t) => {
      if (t) t.images = [];
    });
    return tasks;
  }

  const [rows] = await connectionOrPool.query(
    `SELECT ti.id, ti.task_id, CONCAT(ti.file_path, ti.file_name) AS filename, ti.created_at,
            COALESCE(ti.kind, 'request') AS kind, ti.uploaded_by, u.name AS uploaded_by_name
     FROM tasks_images ti
     LEFT JOIN user u ON u.id = ti.uploaded_by
     WHERE ti.task_id IN (?)
     ORDER BY ti.created_at ASC`,
    [ids]
  );

  const byTaskId = new Map();
  for (const r of rows || []) {
    const key = Number(r.task_id);
    if (!byTaskId.has(key)) byTaskId.set(key, []);
    byTaskId.get(key).push({ id: r.id, filename: r.filename, created_at: r.created_at, kind: r.kind, uploaded_by: r.uploaded_by, uploaded_by_name: r.uploaded_by_name });
  }

  tasks.forEach((t) => {
    if (!t) return;
    const key = Number(t.id);
    t.images = byTaskId.get(key) || [];
  });

  return tasks;
}

module.exports = { attachTaskImages };
