'use strict';

/**
 * BILLING RECONCILIATION — ask the processor what is true, instead of waiting
 * to be told.
 *
 * WHY THIS EXISTS. Local subscription status is maintained by exactly ONE
 * mechanism: the Authorize.Net webhook. There is no other writer and no
 * periodic check. Webhooks are best-effort, so a single missed delivery leaves
 * the local row saying `active` forever — and because the ACCESS GATE keys off
 * `subscriptions.status = 'active'` (utils/access.js), a row that never leaves
 * `active` is a customer using the product for free, indefinitely, with nothing
 * in the system aware of it.
 *
 * THE TWO HARD RULES, both enforced in classifyDivergence() below:
 *
 *   1. NEVER RESTRICT ON ABSENCE OF EVIDENCE. A timeout, a network error, a
 *      malformed response or a subscription the processor does not recognise
 *      all resolve to 'none'. Restriction may follow ONLY a positive, parsed
 *      answer from the processor saying the subscription has ended or is
 *      unpaid. Getting this backwards cuts off a paying customer because of a
 *      blip, which is worse than the problem being solved.
 *
 *   2. THIS VERSION REPORTS. IT DOES NOT ACT. Nothing here writes to
 *      `subscriptions`. The `action` field is a RECOMMENDATION for a human to
 *      read — it is deliberately not wired to anything. The version that acts
 *      is a separate, RED decision, to be taken after clean runs have been
 *      seen.
 *
 * The remote lookup is INJECTED rather than imported, so the decision logic can
 * be tested exhaustively — including every failure shape — without credentials
 * and without touching the processor. No key is read, stored or logged here.
 */

const logger = require('../common/logger');

/** Local statuses that grant or imply paid access. */
const LOCAL_LIVE = new Set(['active', 'past_due']);

/** Comped is deliberate free access. It is never compared against the processor. */
const LOCAL_COMPED = 'comped';

/**
 * Map a processor subscription status onto what it means for us.
 * Authorize.Net ARB reports: active, expired, suspended, canceled, terminated.
 */
function remoteMeaning(remoteStatus) {
  const s = String(remoteStatus || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s === 'active') return 'live';
  if (s === 'suspended') return 'unpaid';
  if (s === 'expired' || s === 'canceled' || s === 'cancelled' || s === 'terminated') return 'ended';
  return 'unknown';
}

/**
 * Compare one local row against one remote answer.
 *
 * @param {{id:number,user_id:number,status:string}} local
 * @param {{ok:boolean,status?:string,reason?:string}} remote
 * @returns {{action:'none'|'would_restrict'|'would_reactivate', diverged:boolean, why:string}}
 */
function classifyDivergence(local, remote) {
  const localStatus = String(local && local.status || '').trim().toLowerCase();

  // RULE 1, FIRST AND UNCONDITIONAL. Anything that is not a positive, parsed
  // answer from the processor produces no recommendation at all. This is the
  // branch that must never grow an exception.
  if (!remote || remote.ok !== true) {
    return {
      action: 'none',
      diverged: false,
      why: `no answer from the processor (${(remote && remote.reason) || 'unreachable'}) — absence of evidence is not evidence`,
    };
  }

  const meaning = remoteMeaning(remote.status);

  if (meaning === 'unknown') {
    return {
      action: 'none',
      diverged: false,
      why: `processor returned a status this code does not recognise — reported, never acted on`,
    };
  }

  const localLive = LOCAL_LIVE.has(localStatus);

  if (meaning === 'ended' && localLive) {
    return {
      action: 'would_restrict',
      diverged: true,
      why: `local says "${localStatus}" but the processor says the subscription has ended`,
    };
  }

  if (meaning === 'unpaid' && localStatus === 'active') {
    return {
      action: 'would_restrict',
      diverged: true,
      why: `local says "active" but the processor says the subscription is unpaid/suspended`,
    };
  }

  if (meaning === 'live' && !localLive) {
    // The kind direction: the processor says they ARE paying and we have them
    // shut out. Still only a recommendation, but this one is a customer being
    // wronged rather than a customer getting something free.
    return {
      action: 'would_reactivate',
      diverged: true,
      why: `local says "${localStatus}" but the processor says the subscription is ACTIVE — this customer may be paying and locked out`,
    };
  }

  return { action: 'none', diverged: false, why: 'local and processor agree' };
}

/**
 * Run a reconciliation pass.
 *
 * @param {object} connection            mysql2 connection or pool
 * @param {(remoteId:string)=>Promise<{ok:boolean,status?:string,reason?:string}>} fetchRemoteStatus
 * @param {{limit?:number}} [opts]
 * @returns {Promise<{checked:number,divergences:Array,unreachable:number,skipped:number,wouldRestrict:number,wouldReactivate:number,actedOn:number}>}
 */
async function reconcile(connection, fetchRemoteStatus, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 500;

  const [rows] = await connection.query(
    `SELECT id, user_id, status, authorize_subscription_id
       FROM subscriptions
      ORDER BY id
      LIMIT ?`,
    [limit]
  );

  const divergences = [];
  let unreachable = 0;
  let compedSkipped = 0;
  let unverifiable = 0;

  for (const local of rows) {
    // COMPED IS SKIPPED BECAUSE THE STATUS SAYS SO — never because no
    // processor record was found. The distinction is the whole point: a comped
    // account and a broken one look identical from the processor's side, and
    // skipping on "no record" would turn every data problem into silent free
    // access, which is precisely what this job exists to catch.
    if (String(local.status || '').trim().toLowerCase() === 'comped') {
      compedSkipped++;
      continue;
    }

    const remoteId = local.authorize_subscription_id;
    if (!remoteId) {
      // A NON-COMPED row with no processor reference is a DIVERGENCE, not a
      // free pass. Somebody is carrying a subscription we cannot verify, and
      // that is exactly the shape of the bug being hunted. Reported — and
      // still never acted on, because there is no positive processor answer.
      divergences.push({
        subscription_id: local.id,
        user_id: local.user_id,
        local_status: local.status,
        processor_status: null,
        action: 'none',
        why: 'no processor reference on a non-comped subscription — cannot be verified; '
           + 'reported rather than skipped, because "unverifiable" must never read as "free on purpose"',
      });
      unverifiable++;
      continue;
    }

    let remote;
    try {
      remote = await fetchRemoteStatus(String(remoteId));
    } catch (err) {
      remote = { ok: false, reason: 'threw: ' + (err && err.message) };
    }
    if (!remote || remote.ok !== true) unreachable++;

    const verdict = classifyDivergence(local, remote);
    if (verdict.diverged) {
      divergences.push({
        subscription_id: local.id,
        user_id: local.user_id,
        local_status: local.status,
        processor_status: (remote && remote.status) || null,
        action: verdict.action,
        why: verdict.why,
      });
    }
  }

  const summary = {
    checked: rows.length,
    compedSkipped,
    unverifiable,
    unreachable,
    divergences,
    wouldRestrict: divergences.filter((d) => d.action === 'would_restrict').length,
    wouldReactivate: divergences.filter((d) => d.action === 'would_reactivate').length,
    // Stated explicitly in the return value so a caller cannot mistake this for
    // a job that changed something.
    actedOn: 0,
    reportOnly: true,
  };

  // NO SUBSCRIPTION ID, NO CUSTOMER DETAIL, NO KEY in the log line — only counts.
  logger.info(
    `billing reconcile: checked=${summary.checked} comped=${summary.compedSkipped} unverifiable=${summary.unverifiable} ` +
    `unreachable=${summary.unreachable} divergences=${divergences.length} ` +
    `wouldRestrict=${summary.wouldRestrict} wouldReactivate=${summary.wouldReactivate} actedOn=0`
  );

  return summary;
}

module.exports = { reconcile, classifyDivergence, remoteMeaning, LOCAL_LIVE };
