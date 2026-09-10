/* One-shot patch. Deleted after it runs. */
const fs = require('fs');
const p = 'routes/notepadHub.js';
let s = fs.readFileSync(p, 'utf8');
const fail = [];
const BT = String.fromCharCode(96);
function rep(a, b) { const t = s.replace(a, b); if (t === s) { fail.push(String(a).slice(0, 55)); return; } s = t; }

// 1. Mark the pads that RECEIVED delegated work, so the client can treat them
//    as somebody else's list rather than the user's own.
rep(`          if (!bySection.has(target)) bySection.set(target, []);`,
`          receivedPads.add(target);
          if (!bySection.has(target)) bySection.set(target, []);`);

rep(`      if (borrowed.length) {
        const padForJob = new Map();`,
`      // C26: which of MY pads are showing somebody else's delegated work. A
      // pad in that state is a RECEIVED list — the company owns what is on
      // it, so it is read-only apart from check off, note and photo.
      const receivedPads = new Set();
      if (borrowed.length) {
        const padForJob = new Map();`);

// 2. A received pad also shows the PLANS the company put on the company pad
//    for the same job — the sub needs the drawings, not just the task.
rep(`      const allowlist = await listAllowlist(connection, owner);`,
`      // C26: a received pad inherits the company pad's PLANS for the same
      // job. The sub cannot see the company notepad, but the drawings are
      // exactly what they need to do the work, so the link travels with the
      // task rather than the pad.
      if (receivedPads.size) {
        try {
          const jobIds = sections
            .filter((x) => receivedPads.has(Number(x.id)) && x.job_id != null)
            .map((x) => Number(x.job_id));
          if (jobIds.length) {
            const jph = jobIds.map(() => '?').join(',');
            const [inherited] = await connection.query(
              ${BT}SELECT s2.job_id, COUNT(*) AS n
                 FROM checklist_section_files f
                 JOIN checklist_sections s2 ON s2.id = f.section_id
                WHERE s2.job_id IN (\${jph}) AND s2.scope = 'company'
                GROUP BY s2.job_id${BT},
              jobIds,
            );
            for (const r of inherited) inheritedPlanCount.set(Number(r.job_id), Number(r.n || 0));
          }
        } catch (e) {
          logger.error('notepad hub inherited-plan read failed: ' + e.message);
        }
      }

      const allowlist = await listAllowlist(connection, owner);`);

rep(`      const planCount = new Map();`, `      const planCount = new Map();
      const inheritedPlanCount = new Map();`);

// 3. Surface both flags on the section payload.
rep(`          plan_count: planCount.get(Number(s.id)) || 0,`,
`          plan_count: planCount.get(Number(s.id)) || 0,
          // C26: this pad is showing work delegated to me by the company.
          // Check off, note and photo only — no new tasks, no editing theirs.
          received: receivedPads.has(Number(s.id)),`);

if (fail.length) { console.log('NO MATCH:', fail); process.exit(1); }
fs.writeFileSync(p, s);
console.log('received flag + inherited plans wired');
