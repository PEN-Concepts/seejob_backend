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
// Revised distinct 35-colour pool (2026-08-27, Poul-approved): removed the
// near-duplicate / too-pale / muddy tones from the old 46, added spread in
// rust / burnt-orange / royal-blue. #c1651d stays a normal pool colour.
// #FF4D00 is NOT in the pool — it is RESERVED as the GC-assigned signal (below).
const JOB_COLORS = [
  // Orange / rust / burnt (6) — #cc5500 burnt, #c1651d orange, #b7410e rust,
  // #a95e3b terracotta, #9e4624 deep rust, #b5794f camel (lightest)
  '#cc5500', '#c1651d', '#b7410e', '#a95e3b', '#9e4624', '#b5794f',
  // Gold / amber (3)
  '#d4a017', '#fdb813', '#d6c148',
  // Brown (3)
  '#6b4226', '#8f6a45', '#422619',
  // Tan / camel (3)
  '#c9a878', '#dcc39a', '#cbb573',
  // Green (6)
  '#4a7a3d', '#879c2e', '#8a9a7a', '#3ea88a', '#1f5c45', '#2fbab0',
  // Blue / teal (7) — #2c52a0 = deepened royal blue (true #4169e1 too bright here)
  '#2f7d7d', '#7fa8c9', '#3b6f9b', '#3d4a8a', '#4689b5', '#6a7c90', '#2c52a0',
  // Purple / pink (7)
  '#6b3b9b', '#7a3d6b', '#a83e7a', '#b5788a', '#aa91b6', '#866dd1', '#60294d',
];

// RESERVED — never auto-assigned to any job. Rendered at view time for a
// subcontractor/contractor on a job a GC assigned to them ("this came from a GC").
const RESERVED_GC_COLOR = '#ff4d00';

// Family index ranges within JOB_COLORS (46 colours after removing one rust),
// listed in a WARM/COOL-ALTERNATING traversal order so the round-robin picks a
// warm colour, then a cool one, then warm… — an account's first jobs land in
// visibly different families (orange → green → gold → blue → brown → purple →
// tan) instead of a run of warm tones. The JOB_COLORS list itself is unchanged;
// this is only the order families are visited when assigning.
const FAMILIES = [
  [0, 5],    // orange/rust/burnt (warm)
  [15, 20],  // green (cool)
  [6, 8],    // gold/amber (warm)
  [21, 27],  // blue/teal (cool)
  [9, 11],   // brown (warm)
  [28, 34],  // purple/pink (cool)
  [12, 14],  // tan/camel (warm)
];

// PICK_ORDER: the SAME 47 colours, but walked round-robin across families so
// consecutive assignments land in different families (orange → gold → brown →
// tan → green → blue → purple → next orange …). This keeps the approved list
// verbatim yet spreads an account's first several jobs across the spectrum, so
// they stay visually distinct instead of clustering in one family.
const PICK_ORDER = (() => {
  const buckets = FAMILIES.map(([a, b]) => {
    const arr = [];
    for (let i = a; i <= b; i++) arr.push(i);
    return arr;
  });
  const maxLen = Math.max(...buckets.map((b) => b.length));
  const order = [];
  for (let k = 0; k < maxLen; k++) {
    for (const bk of buckets) if (k < bk.length) order.push(JOB_COLORS[bk[k]]);
  }
  return order;
})();

/** First palette colour not held by this creator's active jobs, in family-spread
 *  PICK_ORDER; cycles when full. */
// ---- DIVERSITY-AWARE assignment (2026-08-28) ----
// Poul's 5 COARSE perceptual groups. Assigning by fine family (orange/gold/brown/tan)
// still clustered several jobs into the warm-earth neighbourhood; grouping coarsely and
// preferring an under-represented group spreads an account's jobs across yellow / green /
// blue / brown / red as intended.
const GROUPS = {
  red_orange:  ['#cc5500', '#c1651d', '#b7410e', '#a95e3b', '#9e4624'],
  yellow_gold: ['#d4a017', '#fdb813', '#d6c148'],
  brown_tan:   ['#6b4226', '#8f6a45', '#422619', '#b5794f', '#c9a878', '#dcc39a', '#cbb573'],
  green:       ['#4a7a3d', '#879c2e', '#8a9a7a', '#3ea88a', '#1f5c45', '#2fbab0'],
  blue_purple: ['#2f7d7d', '#7fa8c9', '#3b6f9b', '#3d4a8a', '#4689b5', '#6a7c90', '#2c52a0', '#6b3b9b', '#7a3d6b', '#a83e7a', '#b5788a', '#aa91b6', '#866dd1', '#60294d'],
};
// warm/cool-alternating so ties (first few jobs) still spread across the spectrum.
const GROUP_ORDER = ['red_orange', 'green', 'blue_purple', 'yellow_gold', 'brown_tan'];
const COLOR_GROUP = (() => { const m = new Map(); for (const g of Object.keys(GROUPS)) for (const c of GROUPS[g]) m.set(c.toLowerCase(), g); return m; })();
function groupOf(hex) { return COLOR_GROUP.get(String(hex || '').toLowerCase()) || null; }
function _rgb(h) { h = String(h).replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function _dist(a, b) { const [r1, g1, b1] = _rgb(a), [r2, g2, b2] = _rgb(b); return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2); }
// Distance in WASHED space (the improved FE boostForWash + 30% composite over #34291b) —
// this is what a viewer actually sees on a card, so it's the right metric for "too close".
// Kept in sync with fe job-color.service.ts boostForWash. CONSERVATIVE_T ≈ min washed
// distance below which two jobs read as the same colour (tuned on real data).
const CONSERVATIVE_T = 24;
function _hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; const l = (mx + mn) / 2; const s = d === 0 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); if (d) { if (mx === r) h = (g - b) / d + (g < b ? 6 : 0); else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; } return [h * 360, s, l]; }
function _hslRgb(H, s, l) { H = (((H % 360) + 360) % 360) / 360; const a = s * Math.min(l, 1 - l); const f = (n) => { const k = (n + H * 12) % 12; return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); }; return [f(0), f(8), f(4)]; }
function _boost(hex) { const [r, g, b] = _rgb(hex); const [H, s, l] = _hsl(r, g, b); let l2 = 0.16 + l * 0.78; l2 = 0.5 + (l2 - 0.5) * 1.35; l2 = Math.max(0.2, Math.min(0.82, l2)); return _hslRgb(H, Math.min(1, s * 1.6 + 0.18), l2); }
const _WASHBASE = _rgb('#34291b');
function _wash(hex, a = 0.30) { const [r, g, b] = _boost(hex); return [r * a + _WASHBASE[0] * (1 - a), g * a + _WASHBASE[1] * (1 - a), b * a + _WASHBASE[2] * (1 - a)]; }
function washDist(a, b) { const [r1, g1, b1] = _wash(a), [r2, g2, b2] = _wash(b); return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2); }
/** From `cands`, the colour whose nearest already-used colour is farthest (max-min) — keeps
 *  a repeated group's colours distinct instead of picking two near-identical oranges. */
function farthestFrom(cands, usedList) {
  if (!usedList.length) return cands[0];
  let best = cands[0], bestMin = -1;
  for (const c of cands) {
    let md = Infinity;
    for (const u of usedList) { const d = washDist(c, u); if (d < md) md = d; }
    if (md > bestMin) { bestMin = md; best = c; }
  }
  return best;
}
/** Pick a colour for one new job (or one job during a reassign) given the colours the
 *  account's other active jobs already hold: least-used group, then farthest within it. */
function pickDiverse(usedList) {
  const used = new Set(usedList.map((c) => String(c).toLowerCase()));
  const byGroup = { red_orange: 0, yellow_gold: 0, brown_tan: 0, green: 0, blue_purple: 0 };
  for (const c of used) { const g = groupOf(c); if (g) byGroup[g]++; }
  let best = GROUP_ORDER[0], bestN = Infinity;
  for (const g of GROUP_ORDER) { if (byGroup[g] < bestN) { bestN = byGroup[g]; best = g; } }
  const cands = GROUPS[best].filter((c) => !used.has(c.toLowerCase()));
  if (!cands.length) return PICK_ORDER.find((c) => !used.has(c.toLowerCase())) || PICK_ORDER[used.size % PICK_ORDER.length];
  return farthestFrom(cands, usedList);
}

/** Colour for a NEW job — diversity-aware over ALL the ACCOUNT's active jobs (not just this
 *  creator's), so the colour is chosen against exactly what shows together on the account's
 *  Jobs list / calendar / Task Manager. Existing jobs are never touched here. */
async function pickJobColor(connection, createdBy) {
  const [rows] = await connection.query(
    `SELECT j.color FROM job j LEFT JOIN \`user\` u ON u.id = j.created_by
      WHERE COALESCE(u.created_by, j.created_by) = (SELECT COALESCE(created_by, id) FROM \`user\` WHERE id = ?)
        AND j.status = 1 AND j.color IS NOT NULL`,
    [createdBy]
  );
  const usedList = (rows || []).map((r) => String(r.color || '')).filter(Boolean);
  return pickDiverse(usedList);
}

/** CONSERVATIVE reassignment of existing active jobs (per account, scoped to what shows
 *  together on the account's list). Two passes: KEEP every job whose current (valid pool)
 *  colour is >= CONSERVATIVE_T in WASHED space from all already-kept jobs; recolour ONLY the
 *  near-duplicates onto a distinct colour. So distinct jobs (e.g. Dumas purple, Kasberger
 *  teal, Mann green) are left alone and only true clashes move. Naturally minimal AND
 *  idempotent: after a run no two kept jobs are within T, so re-runs change nothing — safe
 *  on boot. `full:true` → aggressive reassign of every job (owner endpoint). Returns
 *  { apply, full, scanned, accountsTouched, changed, plan[] }; apply=false = dry run. */
async function reassignActiveDiverse(connection, opts = {}) {
  const apply = opts.apply === true;
  const full = opts.full === true;
  const [rows] = await connection.query(
    `SELECT j.id, j.color, COALESCE(u.created_by, j.created_by) AS account_root
       FROM job j LEFT JOIN \`user\` u ON u.id = j.created_by
      WHERE j.status = 1
      ORDER BY account_root ASC, j.id ASC`
  );
  const byAccount = new Map();
  for (const r of rows) { if (!byAccount.has(r.account_root)) byAccount.set(r.account_root, []); byAccount.get(r.account_root).push(r); }
  const plan = []; let changed = 0, accountsTouched = 0;
  for (const [account, jobs] of byAccount) {
    // decide new colour per job
    const assignments = new Map(); // jobId -> new colour
    if (full) {
      const placed = [];
      for (const j of jobs) { const c = pickDiverse(placed); placed.push(c); assignments.set(j.id, c); }
    } else {
      // Pass 1: keepers (distinct enough); Pass 2: reassign the rest against ALL keepers.
      const keptColors = [];
      const toReassign = [];
      for (const j of jobs) {
        const c = String(j.color || '');
        const valid = !!groupOf(c);
        let md = Infinity;
        for (const kc of keptColors) { const d = washDist(c, kc); if (d < md) md = d; }
        if (valid && (keptColors.length === 0 || md >= CONSERVATIVE_T)) { keptColors.push(c); assignments.set(j.id, c); }
        else toReassign.push(j);
      }
      const placed = [...keptColors];
      for (const j of toReassign) { const c = pickDiverse(placed) || String(j.color || ''); placed.push(c); assignments.set(j.id, c); }
    }
    let touched = false;
    for (const j of jobs) {
      const color = assignments.get(j.id);
      if (!color) continue;
      if (String(j.color || '').toLowerCase() !== color.toLowerCase()) {
        touched = true;
        plan.push({ jobId: j.id, account, from: j.color || null, to: color });
        if (apply) await connection.query('UPDATE job SET color = ? WHERE id = ?', [color, j.id]);
        changed++;
      }
    }
    if (touched) accountsTouched++;
  }
  return { apply, full, scanned: rows.length, accountsTouched, changed, plan };
}

/**
 * One-time BACKFILL for legacy jobs created before the pool system shipped
 * (active jobs with a NULL/empty color). Assigns from the SAME 47-colour pool in
 * family-spread PICK_ORDER, scoped PER ACCOUNT so an account's jobs stay visually
 * distinct on its shared calendar/Task Manager — each job takes the first pool
 * colour not already held by ANY active job on that account, cycling when full.
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
        PICK_ORDER.find((c) => !used.has(c.toLowerCase())) ||
        PICK_ORDER[used.size % PICK_ORDER.length];
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

const JOB_COLOR_SET = new Set(JOB_COLORS.map((c) => c.toLowerCase()));

/**
 * One-time-EFFECT, idempotent recolour for a pool revision (2026-08-27). Recolours
 * only ACTIVE jobs whose stored colour is no longer in the pool (removed in the
 * revision) onto a distinct current pool colour, per account. Jobs holding a
 * still-valid colour (e.g. Lynes #c1651d, Samuel #6b4226, Kasberger #2f7d7d) are
 * left untouched. Naturally idempotent: after one run no active job holds an
 * orphaned colour, so re-runs are no-ops; #ff4d00 is not in the pool so is never
 * assigned. Safe to wire into boot.
 */
async function repaletteOrphanedColors(connection) {
  const [rows] = await connection.query(
    `SELECT j.id, j.color, COALESCE(u.created_by, j.created_by) AS account_root
       FROM job j LEFT JOIN \`user\` u ON u.id = j.created_by
      WHERE j.status = 1 AND j.color IS NOT NULL AND j.color <> ''
      ORDER BY j.id ASC`
  );
  const byAccount = new Map();
  for (const r of rows) {
    if (!byAccount.has(r.account_root)) byAccount.set(r.account_root, []);
    byAccount.get(r.account_root).push(r);
  }
  let recolored = 0;
  for (const [, jobs] of byAccount) {
    const used = new Set(
      jobs.map((j) => String(j.color || '').toLowerCase()).filter((c) => JOB_COLOR_SET.has(c))
    );
    for (const j of jobs) {
      const c = String(j.color || '').trim().toLowerCase();
      if (JOB_COLOR_SET.has(c)) continue; // still a valid pool colour → keep it
      const color =
        PICK_ORDER.find((x) => !used.has(x.toLowerCase())) ||
        PICK_ORDER[used.size % PICK_ORDER.length];
      used.add(color.toLowerCase());
      await connection.query('UPDATE job SET color = ? WHERE id = ?', [color, j.id]);
      recolored++;
    }
  }
  return recolored;
}

module.exports = { JOB_COLORS, RESERVED_GC_COLOR, pickJobColor, pickDiverse, backfillJobColors, repaletteOrphanedColors, reassignActiveDiverse };
