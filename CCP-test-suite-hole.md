# CCP — The test-suite hole, measured

**Status: MEASURED AND LOGGED. No repairs made. Not started.**

Split out of `CCP-deploy-npm-ci.md` rather than added to it as a section,
because the failures are **not one cause**. They fall into at least five
unrelated clusters (below), so one CCP to "fix the suite" would be five
CCPs wearing a trenchcoat.

## The measurement

Clean `origin/main` at `1d6b5fe6` (i.e. after #55, before #53 and #56),
every suite on disk run individually, `node test/<suite>.test.js`.
`@aws-sdk/client-ses` present in `node_modules`, which is faithful to what
`npm install --production` actually gives production.

| | |
|---|---|
| Suites on disk | **90** |
| Suites fully passing | **77** |
| Suites with failures | **13** (one of which crashes rather than failing) |
| Assertions | **1678 passed, 80 failed** |

**CI runs 15 of these 90.** So "CI is green" currently means "15 suites
are green", and the other 75 run only in a manual sweep.

## The failing suites

| suite | result | note |
|---|---|---|
| `jobSchedule.functional` | 9 / **20 failed** | largest single hole |
| `expiredLockout` | 18 / **19 failed** | trial/expiry cluster |
| `freeAccountBadge` | 0 / **11 failed** | trial/expiry cluster — nothing passes |
| `mailerCutoverVisibility` | 18 / **7 failed** | **ALREADY FIXED** by #53, now merged |
| `trialEntitlement` | 12 / **5 failed** | trial/expiry cluster |
| `clientAllTasksScope` | 0 / **4 failed** | nothing passes |
| `cslbBulkDedup` | 1 / **3 failed** | |
| `expiredDelegationLockout` | 2 / **3 failed** | trial/expiry cluster |
| `invoices.functional` | 26 / **3 failed** | |
| `clockinTimeTracking` | 10 / **2 failed** | |
| `jobColorPool` | 1 / **2 failed** | |
| `accountDelete` | 52 / **1 failed** | |
| `scheduleIntegration` | **CRASHES** | see below |

`scheduleIntegration` does not fail — it dies:

    FATAL TypeError: Cannot read properties of undefined
      (reading 'computed_end_date')
      at test/scheduleIntegration.test.js:173:58

It produces no pass/fail line at all, which is why the sweep records it
as `ERR`. A suite that crashes reports nothing, and a sweep that counts
summary lines will silently skip it.

## The clusters

These are guesses at grouping from the names and counts, not diagnoses —
nothing was investigated:

1. **Trial / expiry** — `expiredLockout`, `expiredDelegationLockout`,
   `freeAccountBadge`, `trialEntitlement`. 38 of the 80 failing
   assertions. Most likely one cause, and the best first pull.
2. **Scheduling** — `jobSchedule.functional`, `scheduleIntegration`.
   20 failures plus the crash.
3. **Tenant scope** — `clientAllTasksScope` (0/4, nothing passes).
4. **Money** — `invoices.functional`.
5. **Singletons** — `accountDelete`, `clockinTimeTracking`,
   `cslbBulkDedup`, `jobColorPool`.

Two suites pass **nothing at all** (`freeAccountBadge`, `clientAllTasksScope`).
A suite at 0 passed is usually a fixture that no longer matches the
schema rather than a hundred real defects — they are probably cheap, and
they are probably not telling anyone anything today.

## What is NOT claimed here

- That any of these represents a production defect. Several are likely
  stale fixtures. **Nothing was investigated.**
- That the count is stable. It was taken once, on one commit, on one
  machine.
- That fixing them is urgent. The point of the measurement is that the
  size of the hole is now written down while it was cheap to take.

## Suggested order, if this is ever picked up

1. `scheduleIntegration` — it crashes, so it is the one suite whose
   result nobody can even read.
2. The trial/expiry cluster — four suites, 38 assertions, plausibly one
   fix.
3. The two 0-pass suites — likely fixture drift, likely quick.
4. Everything else, individually.

Then, separately: decide whether CI should run more than 15 of 90. That
question belongs with `CCP-deploy-npm-ci.md`, which records the same
15-of-90 figure from the other direction.

## Status

Measured 2026-09-22 on `1d6b5fe6`. Logged, not repaired. Do not start
without a decision about priority — this is a known hole, not a fire.
