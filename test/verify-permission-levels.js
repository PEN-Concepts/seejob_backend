'use strict';
// Pure-logic test of the Level→rights preset. node test/verify-permission-levels.js
const P = require('../services/permissionLevels');
let pass=0, fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(`${c?'  ✓':'  ✗ FAIL'} ${m}`);};
const has=(o,k)=>o&&Object.prototype.hasOwnProperty.call(o,k);

const L=[null,P.rightsForLevel(1),P.rightsForLevel(2),P.rightsForLevel(3),P.rightsForLevel(4),P.rightsForLevel(5)];

// Universal floor at every level
for(let n=1;n<=5;n++){ ok(has(L[n],'dashboard')&&has(L[n],'profile')&&has(L[n],'support')&&L[n].subscription.read, `L${n} keeps the universal floor`); }
ok(L[1].subscription.create===false && L[1].support.create===true, 'L1: subscription view-only, can file support ticket');

// Cumulative module set
for(let n=2;n<=5;n++){ const prev=Object.keys(L[n-1]); const cur=new Set(Object.keys(L[n])); ok(prev.every(k=>cur.has(k)), `L${n} module set ⊇ L${n-1}`); }

// L1 has nothing job-ish
ok(!has(L[1],'job')&&!has(L[1],'task')&&!has(L[1],'contact')&&!has(L[1],'lead'), 'L1: no job/task/contact/lead');

// L2 view-only job/contact, check-off task, own time
ok(L[2].job.read&&!L[2].job.create&&!L[2].job.update, 'L2: job read-only (view tabs, no manage)');
ok(L[2].contact.read&&!L[2].contact.create, 'L2: contact view-only');
ok(L[2].task.read&&L[2].task.update&&!L[2].task.create, 'L2: task check-off (update), no create');
ok(L[2].timecard.read&&L[2].timecard.create, 'L2: log own time');
ok(!has(L[2],'calendar')&&!has(L[2],'quote')&&!has(L[2],'lead'), 'L2: no calendar/quote/lead');

// L3 manage-within-job, assign tasks, foreman modules, equipment check-out/in only
ok(L[3].job.create&&L[3].job.update&&L[3].job.delete, 'L3: job full CRUD (manage docs/pics/materials)');
ok(L[3].task.create, 'L3: assign tasks (task.create)');
ok(L[3].contact.create&&!L[3].contact.delete, 'L3: contact add/edit, no company-wide delete');
ok(L[3].equipment.update&&!L[3].equipment.create, 'L3: equipment check-out/in only (no inventory CRUD)');
ok(L[3].dailysheet.create&&L[3].jobanalysis.create&&L[3].calendar.create, 'L3: daily production / safety / calendar');
ok(!has(L[3],'lead')&&!has(L[3],'quote')&&!has(L[3],'team')&&!has(L[3],'user'), 'L3: no lead/quote/team/employees');

// L4 pipeline + money + company-wide
ok(L[4].lead.create&&L[4].quote.create&&L[4].team.create&&L[4].changeorder.create, 'L4: leads/quote/team/change-orders');
ok(L[4].contact.delete&&L[4].calendar.delete&&L[4].equipment.create, 'L4: company-wide contacts/calendar + equipment inventory');
ok(!has(L[4],'user'), 'L4: NOT employees');

// L5 employees + billing
ok(L[5].user.create&&L[5].user.delete, 'L5: employees full CRUD');
ok(L[5].subscription.create&&L[5].subscription.update, 'L5: manage billing');

// Fail closed
ok(P.rightsForLevel(null)===null&&P.rightsForLevel(0)===null&&P.rightsForLevel(6)===null&&P.rightsForLevel('x')===null, 'off-ladder/invalid level → null (fail closed)');

// LEVEL_MIN actions
ok(!P.levelAllows(3,'createNewJob')&&P.levelAllows(4,'createNewJob'), 'createNewJob: L3 no, L4 yes');
ok(!P.levelAllows(3,'editGanttSchedule')&&P.levelAllows(4,'editGanttSchedule'), 'editGanttSchedule: L3 no, L4 yes');
ok(!P.levelAllows(3,'manualLicenseImport')&&P.levelAllows(4,'manualLicenseImport'), 'manualLicenseImport: L3 no, L4 yes');
ok(!P.levelAllows(4,'bogusAction'), 'unknown action → deny');

// Subcontractor
const S=P.SUBCONTRACTOR_RIGHTS;
ok(S.job.read&&!S.job.create, 'SUB: job read-only');
ok(S.task.update&&has(S,'bid-requests'), 'SUB: task check-off + bid respond');
ok(!has(S,'contact')&&!has(S,'calendar')&&!has(S,'timecard')&&!has(S,'user'), 'SUB: no contacts/calendar/timecard/employees');

console.log(`\n${fail===0?'PASS ✅':'FAIL ❌'}: ${pass} passed, ${fail} failed`);
process.exitCode=fail===0?0:1;
