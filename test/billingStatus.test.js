/* Pure unit test of computeBillingState() — the single source of truth for the
 * access tier + display label. Covers every transition the owner asked for, with
 * `now` controlled so time-based states (trial expiry, past-due grace) are exact.
 * CRITICAL invariant asserted: access is decided by having an active subscription /
 * live trial / grace — NEVER by paid_count. Run: node test/billingStatus.test.js
 */
'use strict';
const { computeBillingState, TRIAL_DAYS, PAST_DUE_GRACE_DAYS } = require('../utils/access');
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  ' + (x || '')}`); };

const NOW = 1_800_000_000_000; // fixed reference instant (ms)
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
// Base input = a nobody: not exempt, no sub, no trial, no grace.
const S = (over) => computeBillingState(Object.assign({
  ownerExempt: false, neverGated: false, hasActiveSubscription: false, paidCount: 0,
  createdAt: iso(NOW - 100 * DAY), firstLoginAt: null, pastDueSince: null, reverifyGraceUntil: null, now: NOW,
}, over));

// 1. Invited, never logged in → Pending, NOT blocked (no trial burned).
let r = S({ firstLoginAt: null });
ok(r.billingStatus === 'pending' && r.access === 'full' && r.mode !== 'expired_free', '1. invited/never-logged-in → pending, not blocked', JSON.stringify(r));

// 2. First login just happened → Trial starts now (~60 days left).
r = S({ firstLoginAt: iso(NOW) });
ok(r.billingStatus === 'trial' && r.access === 'full' && r.daysLeft === TRIAL_DAYS, '2. first login → trial starts (60d left)', JSON.stringify(r));

// 3. Mid-trial (logged in 30 days ago) → ~30 days left, full access.
r = S({ firstLoginAt: iso(NOW - 30 * DAY) });
ok(r.billingStatus === 'trial' && r.access === 'full' && r.daysLeft === TRIAL_DAYS - 30, '3. mid-trial → correct days left', JSON.stringify(r));

// 4. Trial elapsed (logged in 61 days ago, no payment) → Expired, read-only.
r = S({ firstLoginAt: iso(NOW - 61 * DAY) });
ok(r.billingStatus === 'expired' && r.access === 'readonly' && r.mode === 'expired_free', '4. trial elapsed → expired, read-only', JSON.stringify(r));

// 5. CRITICAL — brand-new subscriber, ZERO payments → Paying (Unverified) BUT full access.
r = S({ hasActiveSubscription: true, paidCount: 0, firstLoginAt: iso(NOW - 61 * DAY) });
ok(r.billingStatus === 'paying_unverified' && r.access === 'full' && r.mode === 'paid', '5. new subscriber 0 payments → Paying (Unverified) with FULL access', JSON.stringify(r));

// 6. Active sub with ≥1 real payment → Paying.
r = S({ hasActiveSubscription: true, paidCount: 2 });
ok(r.billingStatus === 'paying' && r.access === 'full', '6. active sub + real payment → Paying', JSON.stringify(r));

// 7. Renewal failed 2 days ago (had paid before) → Past Due, STILL full access in grace.
r = S({ pastDueSince: iso(NOW - 2 * DAY), paidCount: 3 });
ok(r.billingStatus === 'past_due' && r.access === 'full' && r.daysLeft === PAST_DUE_GRACE_DAYS - 2, '7. renewal failure → Past Due, full access during grace', JSON.stringify(r));

// 8. Past-due grace elapsed (failed 8 days ago) → read-only.
r = S({ pastDueSince: iso(NOW - 8 * DAY), paidCount: 3 });
ok(r.billingStatus === 'past_due' && r.access === 'readonly' && r.mode === 'expired_free', '8. past-due grace elapsed → read-only', JSON.stringify(r));

// 9. Payment resumes → active sub wins even if a stale past_due_since lingers → access restored.
r = S({ hasActiveSubscription: true, paidCount: 4, pastDueSince: iso(NOW - 8 * DAY) });
ok(r.billingStatus === 'paying' && r.access === 'full', '9. payment resumes → access restored (active overrides past-due)', JSON.stringify(r));

// 10. Owner-exempt → always full, regardless of everything.
r = S({ ownerExempt: true, firstLoginAt: iso(NOW - 900 * DAY) });
ok(r.billingStatus === 'paying' && r.access === 'full', '10. owner-exempt → full access', JSON.stringify(r));

// 11. Never-gated internal role → full.
r = S({ neverGated: true, firstLoginAt: iso(NOW - 900 * DAY) });
ok(r.access === 'full', '11. never-gated role → full access', JSON.stringify(r));

// 12. Sandbox→prod reverification grace (no sub) → Paying (Unverified), full.
r = S({ reverifyGraceUntil: iso(NOW + 5 * DAY), firstLoginAt: iso(NOW - 200 * DAY) });
ok(r.billingStatus === 'paying_unverified' && r.access === 'full', '12. reverify grace → Paying (Unverified), full access', JSON.stringify(r));

// 13. Reverify grace expired, trial long gone → Expired.
r = S({ reverifyGraceUntil: iso(NOW - 1 * DAY), firstLoginAt: iso(NOW - 200 * DAY) });
ok(r.billingStatus === 'expired' && r.access === 'readonly', '13. reverify grace expired → expired, read-only', JSON.stringify(r));

// 14. INVARIANT — access identical whether paidCount is 0 or 5 for an active sub.
const a0 = S({ hasActiveSubscription: true, paidCount: 0 });
const a5 = S({ hasActiveSubscription: true, paidCount: 5 });
ok(a0.access === 'full' && a5.access === 'full' && a0.access === a5.access, '14. access never depends on paid_count (0 vs 5 both full)', JSON.stringify({ a0: a0.access, a5: a5.access }));

console.log(rec.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
