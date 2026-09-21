/* EVERY JOB READ ON THE DASHBOARD GOES THROUGH THE SHARED SCOPE.
 *
 * WHY THIS TEST EXISTS. `attachAccountScope` puts the account on
 * res.locals and fails closed, but nothing COMPELS a handler to use it. A
 * route added next year can query freely — which is exactly how
 * routes/dashboard.js came to disagree with routes/jobs.js and hand a
 * subcontractor the inviting contractor's job names.
 *
 * WHY IT IS A SOURCE ASSERTION AND NOT SOMETHING CLEVERER. Three guards
 * were tried, in the order agreed:
 *
 *   1. STRUCTURAL, walking the router stack. The stack does expose every
 *      layer and its handler, but a handler's SQL is not reachable from
 *      it — and `handler.toString()` only shows the handler's own body, so
 *      a bypass moved one call deep into a helper would sail through. It
 *      can enumerate the routes; it cannot see what they query.
 *
 *   2. THIS ONE. Every job read in dashboard.js is supposed to go through
 *      the shared helper, so a raw job query IN THAT FILE is by definition
 *      a bypass. Deterministic, needs no database, no server and no route
 *      to be exercised.
 *
 *   3. A RUNTIME ASSERTION was the fallback and is not needed. It would
 *      only trip when a test happens to exercise the offending route, so
 *      its coverage depends on the very thing it is meant to guarantee.
 *
 * THE FILE NOW CONTAINS NO UNSCOPED JOB QUERY AT ALL. The one legitimate
 * exception — the snooze ownership probe, which reads a single owner
 * column to answer 403-or-not — was MOVED into accountScope.js precisely
 * so this rule needs no exemption. A rule with an exemption is one someone
 * widens later.
 *
 * Run: node test/dashboardScopeGuard.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'routes', 'dashboard.js');

/**
 * Split source into SQL-bearing statements. A "statement" here is any
 * template literal or quoted string containing FROM or JOIN — which is how
 * every query in this file is written.
 */
function sqlFragments(src) {
  const out = [];
  // COMMENTS FIRST. This file is heavily commented, and an apostrophe in
  // prose ("Poul's ruling") opens a quote as far as a naive scanner is
  // concerned — the first version of this test swallowed a whole docblock
  // as one "string literal" and reported it as an unscoped query. Blank
  // them out, preserving newlines so reported line numbers stay true.
  const blanked = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  const re = /`([^`\\]|\\[\s\S])*`|'([^'\\]|\\[\s\S])*'/g;
  let m;
  while ((m = re.exec(blanked)) !== null) {
    const body = m[0];
    if (/\b(FROM|JOIN)\b/i.test(body)) out.push({ text: body, index: m.index });
  }
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/** Does this fragment read the `job` table (not job_schedules etc.)? */
function readsJobTable(sql) {
  // `job` backticked, or bare FROM/JOIN job followed by alias or whitespace —
  // but NOT job_schedules / job_schedule_items / job_id.
  return /(FROM|JOIN)\s+\\?`job\\?`/i.test(sql) || /(FROM|JOIN)\s+job\b(?!_)/i.test(sql);
}

(() => {
  const src = fs.readFileSync(DASH, 'utf8');
  const frags = sqlFragments(src);
  ok(frags.length > 0, 'the parser actually found SQL in dashboard.js', String(frags.length));
  note(`${frags.length} SQL-bearing string literals scanned`);

  const jobReads = frags.filter((f) => readsJobTable(f.text));
  note(`${jobReads.length} of them read the job table`);

  // ── the rule ────────────────────────────────────────────────────────
  const unscoped = jobReads.filter((f) => !/Scope\.sql/.test(f.text));
  ok(unscoped.length === 0,
    'EVERY job read in routes/dashboard.js carries the shared scope predicate',
    unscoped.map((f) => `line ${lineOf(src, f.index)}: ${f.text.replace(/\s+/g, ' ').slice(0, 120)}`).join(' | '));

  // ── and the rule is not vacuous by accident ─────────────────────────
  // If the file stopped reading job entirely the check above would pass
  // trivially. It must be exercising something.
  ok(jobReads.length > 0,
    'and there IS at least one job read for the rule to apply to — not vacuous',
    String(jobReads.length));

  // ── the helper is actually imported and used ────────────────────────
  ok(/require\(['"]\.\.\/services\/accountScope['"]\)/.test(src),
    'dashboard.js imports the shared scope helper');
  ok(/jobScopeWhere\(/.test(src),
    'and calls jobScopeWhere() rather than hand-rolling a predicate');

  // ── the old resolver is not used as a selector here any more ────────
  // accountOwnerOf is still imported for the NOTEPAD owner (padOwner),
  // which is correct — but it must never be the value a job query keys on.
  const selectorMisuse = frags.filter(
    (f) => readsJobTable(f.text) && /created_by\s*=\s*\?/.test(f.text),
  );
  ok(selectorMisuse.length === 0,
    'no job read keys on a bare `created_by = ?` — that was the original defect',
    selectorMisuse.map((f) => `line ${lineOf(src, f.index)}`).join(', '));

  // ── every route on the router is accounted for ──────────────────────
  // The structural half that DOES hold: enumerate the routes, so a new one
  // is visible here even though this test cannot read its SQL.
  const router = require('../routes/dashboard');
  const routes = router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`)
    .sort();
  const EXPECTED = [
    'GET /day', 'GET /exceptions', 'GET /item-review', 'GET /stalled',
    'POST /item-review', 'POST /stall-snooze',
    // ADDED DELIBERATELY, §4b. The bulk snooze takes one date and applies it
    // to several ticked rows. It writes EXACTLY what POST /stall-snooze
    // writes — the same upsert into dashboard_stall_snooze, per row, under
    // the same validation — and it accepts job and lead targets only. It is
    // not a delete and it touches nothing outside the caller's own view.
    // This line is the acknowledgement the guard exists to force.
    'POST /stall-snooze/bulk',
  ].sort();
  ok(JSON.stringify(routes) === JSON.stringify(EXPECTED),
    'the dashboard router has exactly the seven known routes — a new one lands here first',
    JSON.stringify(routes));

  // ── the guard runs before every one of them ─────────────────────────
  const middleware = router.stack.filter((l) => !l.route).map((l) => l.name);
  ok(middleware.includes('attachAccountScope'),
    'attachAccountScope is mounted router-wide, not per route', JSON.stringify(middleware));
  ok(middleware.indexOf('authenticateToken') < middleware.indexOf('attachAccountScope'),
    'and it runs AFTER authentication, so it has an identity to resolve',
    JSON.stringify(middleware));

  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
