-- ============================================================================
-- Plan-price single-source-of-truth fix — OWNER DB RUNBOOK
-- Run against the PRODUCTION MySQL (I have no DB/SSH access; hand-off only).
-- Prices confirmed by owner: Bid Pro $19, Basic $29, Bronze $59, Silver $99,
-- Gold $199 (all monthly). Platinum stays $250, off the public page, grandfathered.
--
-- SAFETY: this touches the `plans` catalog only. It does NOT touch
-- `subscriptions.amount` — existing subscribers keep the price they signed up at.
-- Steps 1 and 5 below prove that (before/after diff of `subscriptions`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 — BASELINE (run first, SAVE the output). Proves grandfathering later.
-- ---------------------------------------------------------------------------
SELECT id, name, amount, `interval`, is_active FROM plans ORDER BY id;

-- Grandfathering baseline: row count + amount distribution of live subscriptions.
SELECT COUNT(*) AS total_subscriptions FROM subscriptions;
SELECT amount, COUNT(*) AS n
  FROM subscriptions
 GROUP BY amount
 ORDER BY amount;
-- Expected (captured 2026-07-17 via API): Basic $25 x3, Gold $175 x3, Platinum $250 x12.


-- ---------------------------------------------------------------------------
-- STEP 2 — UPDATE existing plan prices (Basic / Bronze / Silver / Gold).
--          Platinum is deliberately NOT in this statement.
--          Update by NAME so it is correct regardless of id ordering.
-- ---------------------------------------------------------------------------
START TRANSACTION;

UPDATE plans SET amount = 29.00 WHERE name = 'Basic';
UPDATE plans SET amount = 59.00 WHERE name = 'Bronze';
UPDATE plans SET amount = 99.00 WHERE name = 'Silver';
UPDATE plans SET amount = 199.00 WHERE name = 'Gold';

-- ---------------------------------------------------------------------------
-- STEP 3 — ADD the Bid Pro plan row ($19/mo). It is an add-on tier, so level = NULL
--          (same as how add-ons are stored). is_active = 1 so it shows publicly.
--          The frontend now reads the id straight from GET /payments/plans, so any
--          auto-increment id is fine — no hardcoded id map to match anymore.
--          Guard against a double-run with the NOT EXISTS check.
-- ---------------------------------------------------------------------------
INSERT INTO plans (name, amount, `interval`, is_active, level, description)
SELECT 'Bid Pro', 19.00, 'monthly', 1, NULL,
       'Send & receive bid requests, share plans, digital subcontract e-signature'
 WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = 'Bid Pro');

-- ---------------------------------------------------------------------------
-- STEP 4 — VERIFY the catalog looks right BEFORE committing.
-- ---------------------------------------------------------------------------
SELECT id, name, amount, `interval`, is_active FROM plans ORDER BY amount;
-- Expect: Bid Pro 19, Basic 29, Bronze 59, Silver 99, Gold 199, Platinum 250.
-- Platinum still 250 and untouched. If anything is off: ROLLBACK; and stop.

-- ---------------------------------------------------------------------------
-- STEP 5 — PROVE subscriptions are untouched (compare to STEP 1 output).
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS total_subscriptions FROM subscriptions;      -- must equal STEP 1
SELECT amount, COUNT(*) AS n FROM subscriptions GROUP BY amount ORDER BY amount;
-- Must be IDENTICAL to STEP 1 (Basic $25 x3, Gold $175 x3, Platinum $250 x12).
-- The price change affects only NEW subscribe actions from here forward.

-- ---------------------------------------------------------------------------
-- If STEP 4 and STEP 5 both look right:
COMMIT;
-- Otherwise:
-- ROLLBACK;
-- ============================================================================
