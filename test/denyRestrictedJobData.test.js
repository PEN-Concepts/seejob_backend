/* denyRestrictedJobData: blocks Subcontractors (cat 2) and Clients (cat 3) from
 * within-job data (Documents/Pictures/Contracts/Budget/Billing/Stages/full Task
 * list/Gantt); owner (4), employees (1), and owner-exempt accounts pass.
 * Run: NODE_PATH=<backend>/node_modules node test/denyRestrictedJobData.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}`); };

const { denyRestrictedJobData } = require('../utils/access');

function run(user) {
  let status = 200, blocked = false, nexted = false;
  const req = { user };
  const res = { status(s) { status = s; return this; }, json() { blocked = true; return this; } };
  denyRestrictedJobData(req, res, () => { nexted = true; });
  return { status, blocked, nexted };
}

// Subcontractor (2) and Client (3) are blocked with 403.
let r = run({ id: 400, category: 2, email: 'sub@x.co' });
ok(r.blocked && r.status === 403 && !r.nexted, 'Subcontractor (category 2) is BLOCKED with 403');
r = run({ id: 376, category: 3, email: 'client@x.co' });
ok(r.blocked && r.status === 403 && !r.nexted, 'Client (category 3) is BLOCKED with 403');

// Owner (4) and Employee (1) pass through.
r = run({ id: 74, category: 4, email: 'owner@x.co' });
ok(r.nexted && !r.blocked, 'Owner (category 4) passes');
r = run({ id: 86, category: 1, email: 'emp@x.co' });
ok(r.nexted && !r.blocked, 'Employee (category 1) passes');

// Owner-exempt platform accounts pass even if stored oddly.
r = run({ id: 86, category: 3, email: 'admin@oakcoast.net' });
ok(r.nexted && !r.blocked, 'Owner-exempt email passes regardless of category');
r = run({ id: 74, category: 2, email: 'poul@oakcoast.net' });
ok(r.nexted && !r.blocked, 'Owner-exempt poul@ passes regardless of category');

rec.forEach((l) => console.log(l));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
