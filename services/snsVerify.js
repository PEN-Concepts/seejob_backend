'use strict';

/**
 * AMAZON SNS MESSAGE SIGNATURE VERIFICATION.
 *
 * WHY THIS IS THE POINT OF THE FEATURE. The endpoint that consumes these
 * messages is public and unauthenticated — SNS cannot present a credential. Its
 * effect is to SUPPRESS AN EMAIL ADDRESS, permanently, so that the platform
 * never mails it again. An unverified endpoint therefore lets any caller on the
 * internet name any address and cut that person off from their login codes.
 * That is a silent, permanent account lockout delivered by an anonymous POST.
 *
 * So verification is unconditional, and every failure REJECTS. There is no
 * log-and-continue path in this file, deliberately.
 *
 * NO NEW DEPENDENCY. Node's crypto.X509Certificate (Node 15+) parses the PEM
 * and yields the public key, and crypto.createVerify('RSA-SHA1') checks the
 * signature. `sns-validator` would do the same thing with more supply chain.
 */

const crypto = require('crypto');
const https = require('https');
const logger = require('../common/logger');

// The fields SNS signs, in this exact order, for each message type. Order and
// membership are part of the signature — this is not a convenience list.
const SIGNABLE = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

/**
 * Is this a URL we are willing to fetch?
 *
 * THE ATTACK THIS STOPS. SigningCertURL arrives INSIDE the untrusted message.
 * Fetching it blindly means an attacker supplies their own certificate, signs
 * their own forged message with the matching private key, and it verifies
 * perfectly — the maths is fine, the trust is not. It is also a server-side
 * request forgery primitive: we would fetch whatever host they name.
 *
 * So the host is checked BEFORE any network call, against the exact SNS
 * pattern, over https only. An `endsWith` check would accept
 * `evil-sns.us-west-1.amazonaws.com.attacker.com`; this does not.
 */
function isTrustedCertUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  // sns.<region>.amazonaws.com — region is letters, digits and hyphens.
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) return false;
  if (!/\.pem$/i.test(u.pathname)) return false;
  return true;
}

// Certificates are fetched once and kept. SNS rotates them rarely; fetching per
// request would put an outbound HTTPS call in the path of every notification and
// hand anyone who can reach the endpoint a way to make us generate traffic.
const certCache = new Map();

function fetchCert(certUrl) {
  if (certCache.has(certUrl)) return Promise.resolve(certCache.get(certUrl));
  return new Promise((resolve, reject) => {
    const req = https.get(certUrl, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('cert fetch HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      res.on('end', () => {
        if (!/-----BEGIN CERTIFICATE-----/.test(body)) return reject(new Error('not a PEM certificate'));
        certCache.set(certUrl, body);
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('cert fetch timeout')));
    req.on('error', reject);
  });
}

/** The exact byte string SNS signed: key\nvalue\n for each present field. */
function canonicalString(msg) {
  const fields = SIGNABLE[msg.Type];
  if (!fields) return null;
  let out = '';
  for (const f of fields) {
    // Absent fields are SKIPPED, not emitted empty. Subject is the usual case.
    if (msg[f] === undefined || msg[f] === null) continue;
    out += f + '\n' + String(msg[f]) + '\n';
  }
  return out;
}

/**
 * Verify an SNS message. Resolves true only on a good signature.
 *
 * @param {object} msg parsed SNS envelope
 * @param {{fetch?:Function}} [deps] injection point for tests — the real fetch
 *        is never called in a test, so no test can reach the network.
 */
async function verifySnsMessage(msg, deps = {}) {
  const get = deps.fetch || fetchCert;

  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'not an object' };
  if (!SIGNABLE[msg.Type]) return { ok: false, reason: 'unknown Type' };
  if (!msg.Signature) return { ok: false, reason: 'no Signature' };

  // SignatureVersion 1 = RSA-SHA1, 2 = RSA-SHA256. Anything else is refused
  // rather than guessed at.
  const ver = String(msg.SignatureVersion || '');
  const algo = ver === '1' ? 'RSA-SHA1' : ver === '2' ? 'RSA-SHA256' : null;
  if (!algo) return { ok: false, reason: 'unsupported SignatureVersion' };

  // HOST CHECK BEFORE ANY NETWORK CALL. Nothing is fetched from an untrusted
  // host, so a hostile SigningCertURL costs us not even a DNS lookup.
  if (!isTrustedCertUrl(msg.SigningCertURL)) {
    return { ok: false, reason: 'untrusted SigningCertURL' };
  }

  const canonical = canonicalString(msg);
  if (canonical === null) return { ok: false, reason: 'no canonical form' };

  let pem;
  try {
    pem = await get(msg.SigningCertURL);
  } catch (err) {
    return { ok: false, reason: 'cert unavailable: ' + (err && err.message) };
  }

  try {
    const cert = new crypto.X509Certificate(pem);
    const verifier = crypto.createVerify(algo);
    verifier.update(canonical, 'utf8');
    verifier.end();
    const good = verifier.verify(cert.publicKey, Buffer.from(String(msg.Signature), 'base64'));
    return good ? { ok: true } : { ok: false, reason: 'signature mismatch' };
  } catch (err) {
    return { ok: false, reason: 'verify threw: ' + (err && err.message) };
  }
}

/** Confirm a subscription, but only to a host we trust. */
function confirmSubscription(subscribeUrl) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(String(subscribeUrl || '')); } catch (_) { return reject(new Error('bad SubscribeURL')); }
    // SAME HOST RULE as the certificate. A verified message could still carry a
    // SubscribeURL pointing anywhere, and following it would be a request we
    // made on an attacker's behalf.
    if (u.protocol !== 'https:' || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) {
      return reject(new Error('untrusted SubscribeURL host'));
    }
    https.get(subscribeUrl, { timeout: 8000 }, (res) => {
      res.resume();
      logger.info('SES SNS: subscription confirmation fetched, HTTP ' + res.statusCode);
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

module.exports = { verifySnsMessage, isTrustedCertUrl, canonicalString, confirmSubscription, certCache };
