/* One-shot patch. Deleted after it runs. */
const fs = require('fs');
const BT = String.fromCharCode(96);

// ── 1. schema: a link can point at a LEAD document too ───────────────────
{
  const p = 'services/notepadSchema.js';
  const L = fs.readFileSync(p, 'utf8').split('\n');
  const R = (x) => x.replace(/\r$/, '');
  const i = L.findIndex((l) => R(l).includes("await run('checklist_section_files'"));
  if (i < 0) throw new Error('anchor not found');
  let end = i;
  while (!R(L[end]).startsWith('  );')) end++;
  L.splice(end + 1, 0,
    '',
    '  // ── C35: a LEAD has files too, and a lead notepad needs its plans.',
    '  //',
    '  // Lead documents live in lead_documents, a different table from',
    '  // job_documents, so the link needs its own column rather than a shared',
    '  // id that could mean either. job_document_id becomes nullable: a row now',
    '  // carries exactly one of the two.',
    "  await run('checklist_section_files lead column', async () => {",
    "    await addColumn(connection, 'checklist_section_files', 'lead_document_id', 'INT NULL DEFAULT NULL');",
    '    try {',
    "      await connection.query('ALTER TABLE checklist_section_files MODIFY job_document_id INT NULL DEFAULT NULL');",
    '    } catch (e) {',
    '      /* already nullable */',
    '    }',
    '    await addIndex(connection, ' + BT + 'ALTER TABLE checklist_section_files ADD UNIQUE KEY uq_csf_lead (section_id, lead_document_id)' + BT + ');',
    '  });');
  fs.writeFileSync(p, L.join('\n'));
}

// ── 2. routes: read and link either kind ─────────────────────────────────
{
  const p = 'routes/notepadHub.js';
  let s = fs.readFileSync(p, 'utf8');
  const fail = [];
  const rep = (a, b) => { const t = s.replace(a, b); if (t === s) { fail.push(String(a).slice(0, 50)); return; } s = t; };

  rep(`/** The job behind a section, for scoping which documents may be offered. */
async function sectionJobId(connection, sectionId) {
  const [[r]] = await connection.query(
    'SELECT job_id FROM checklist_sections WHERE id = ? LIMIT 1',
    [Number(sectionId)],
  );
  return r && r.job_id ? Number(r.job_id) : null;
}`,
`/**
 * What a section hangs off, for scoping which documents may be offered.
 * A notepad belongs to a job OR a lead, never both, and each keeps its files
 * in its own table.
 */
async function sectionSource(connection, sectionId) {
  const [[r]] = await connection.query(
    'SELECT job_id, lead_id FROM checklist_sections WHERE id = ? LIMIT 1',
    [Number(sectionId)],
  );
  if (r && r.job_id) return { kind: 'job', id: Number(r.job_id) };
  if (r && r.lead_id) return { kind: 'lead', id: Number(r.lead_id) };
  return null;
}

/** The documents a source offers, normalised to one shape. */
async function sourceDocuments(connection, src) {
  if (!src) return [];
  const table = src.kind === 'lead' ? 'lead_documents' : 'job_documents';
  const col = src.kind === 'lead' ? 'lead_id' : 'job_id';
  const [rows] = await connection.query(
    \`SELECT id, name, path, type FROM \${table} WHERE \${col} = ? ORDER BY id DESC\`,
    [src.id],
  );
  return rows;
}`);

  // read
  rep(`      const jobId = await sectionJobId(connection, req.params.id);
      const [linked] = await connection.query(
        \`SELECT f.id, f.job_document_id, d.name, d.path, d.type
           FROM checklist_section_files f
           JOIN job_documents d ON d.id = f.job_document_id
          WHERE f.section_id = ?
          ORDER BY f.id ASC\`,
        [Number(req.params.id)],
      );
      let available = [];
      if (jobId) {
        const [rows] = await connection.query(
          'SELECT id, name, path, type FROM job_documents WHERE job_id = ? ORDER BY id DESC',
          [jobId],
        );
        available = rows;
      }
      res.json({ success: true, linked, available, reason: jobId ? '' : 'NO_JOB' });`,
`      const src = await sectionSource(connection, req.params.id);
      // One read per table, unioned in JS: a UNION in SQL would need both
      // tables to exist and match, and lead_documents is optional on some
      // installs.
      const [jobLinks] = await connection.query(
        \`SELECT f.id, f.job_document_id, NULL AS lead_document_id, d.name, d.path, d.type
           FROM checklist_section_files f
           JOIN job_documents d ON d.id = f.job_document_id
          WHERE f.section_id = ? AND f.job_document_id IS NOT NULL
          ORDER BY f.id ASC\`,
        [Number(req.params.id)],
      );
      let leadLinks = [];
      try {
        const [rows] = await connection.query(
          \`SELECT f.id, NULL AS job_document_id, f.lead_document_id, d.name, d.path, d.type
             FROM checklist_section_files f
             JOIN lead_documents d ON d.id = f.lead_document_id
            WHERE f.section_id = ? AND f.lead_document_id IS NOT NULL
            ORDER BY f.id ASC\`,
          [Number(req.params.id)],
        );
        leadLinks = rows;
      } catch (e) {
        /* no lead_documents table on this install */
      }
      const linked = [...jobLinks, ...leadLinks];
      const available = await sourceDocuments(connection, src);
      res.json({ success: true, linked, available, reason: src ? '' : 'NO_JOB' });`);

  // link
  rep(`      const jobId = await sectionJobId(connection, req.params.id);
      if (!jobId) {
        return res.status(400).json({ success: false, code: 'NO_JOB', message: 'This notepad has no job to take plans from.' });
      }`,
`      const src = await sectionSource(connection, req.params.id);
      if (!src) {
        return res.status(400).json({ success: false, code: 'NO_JOB', message: 'This notepad has no job or lead to take plans from.' });
      }`);

  rep(`      const ph = value.document_ids.map(() => '?').join(',');
      const [docs] = await connection.query(
        \`SELECT id FROM job_documents WHERE job_id = ? AND id IN (\${ph})\`,
        [jobId, ...value.document_ids],
      );
      if (docs.length !== value.document_ids.length) {
        return res.status(403).json({ success: false, message: 'Those files are not on this job.' });
      }
      for (const d of docs) {
        // UNIQUE(section_id, job_document_id) makes re-linking a no-op.
        await connection.query(
          'INSERT IGNORE INTO checklist_section_files (section_id, job_document_id, added_by) VALUES (?, ?, ?)',
          [Number(req.params.id), Number(d.id), uid],
        );
      }`,
`      // Only documents on THIS job or lead. An id from elsewhere is refused
      // outright rather than silently dropped.
      const offered = await sourceDocuments(connection, src);
      const allowed = new Set(offered.map((d) => Number(d.id)));
      if (!value.document_ids.every((id) => allowed.has(Number(id)))) {
        return res.status(403).json({ success: false, message: 'Those files are not on this job.' });
      }
      const col = src.kind === 'lead' ? 'lead_document_id' : 'job_document_id';
      for (const id of value.document_ids) {
        // The UNIQUE key on (section_id, <col>) makes re-linking a no-op.
        await connection.query(
          \`INSERT IGNORE INTO checklist_section_files (section_id, \${col}, added_by) VALUES (?, ?, ?)\`,
          [Number(req.params.id), Number(id), uid],
        );
      }`);

  rep(`      const [linked] = await connection.query(
        \`SELECT f.id, f.job_document_id, d.name, d.path, d.type
           FROM checklist_section_files f
           JOIN job_documents d ON d.id = f.job_document_id
          WHERE f.section_id = ?
          ORDER BY f.id ASC\`,
        [Number(req.params.id)],
      );
      res.status(201).json({ success: true, linked });`,
`      const [jl] = await connection.query(
        \`SELECT f.id, f.job_document_id, NULL AS lead_document_id, d.name, d.path, d.type
           FROM checklist_section_files f
           JOIN job_documents d ON d.id = f.job_document_id
          WHERE f.section_id = ? AND f.job_document_id IS NOT NULL
          ORDER BY f.id ASC\`,
        [Number(req.params.id)],
      );
      let ll = [];
      try {
        const [rows] = await connection.query(
          \`SELECT f.id, NULL AS job_document_id, f.lead_document_id, d.name, d.path, d.type
             FROM checklist_section_files f
             JOIN lead_documents d ON d.id = f.lead_document_id
            WHERE f.section_id = ? AND f.lead_document_id IS NOT NULL
            ORDER BY f.id ASC\`,
          [Number(req.params.id)],
        );
        ll = rows;
      } catch (e) { /* no lead_documents table */ }
      res.status(201).json({ success: true, linked: [...jl, ...ll] });`);

  if (fail.length) { console.log('NO MATCH:', fail); process.exit(1); }
  fs.writeFileSync(p, s);
}
console.log('lead plans wired');
