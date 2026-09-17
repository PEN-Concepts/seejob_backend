/* A FAILED CUTOVER MUST BE IMPOSSIBLE TO MISS.
 *
 * services/mailer.js wraps its transport init in a try/catch that falls back to
 * SMTP. That fallback is right — a mis-configured provider must never take the
 * app down on boot, and login runs through this file.
 *
 * But it used to fall back QUIETLY, at error level with a message about the
 * symptom ("failed to init ses transport"). If SES init throws after the
 * cutover, the app keeps sending over Namecheap, mail still arrives, and
 * everything looks healthy. The cutover would be reported as done and would
 * not be.
 *
 * This asserts:
 *   - the fallback still happens (uptime is preserved)
 *   - it SHOUTS: error level, greppable marker, and the CONSEQUENCE named
 *   - the chosen transport is logged at info on every boot
 *   - ACTIVE_PROVIDER tells the truth when it differs from PROVIDER
 *
 * Logging only. No behaviour change: nothing about which transport is chosen,
 * or how mail is sent, is altered by this commit.
 *
 * Run: node test/mailerCutoverVisibility.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const head = (m) => rec.push('\n' + m);
const note = (m) => rec.push('  · ' + m);

const path = require('path');

/** Load services/mailer.js fresh, capturing every logger call it makes. */
function loadMailer({ provider, breakSes }) {
  const captured = { info: [], warn: [], error: [] };

  // Stub the logger BEFORE mailer requires it.
  const loggerPath = require.resolve('../common/logger');
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: {
      info: (m) => captured.info.push(String(m)),
      warn: (m) => captured.warn.push(String(m)),
      error: (m) => captured.error.push(String(m)),
      debug: () => {},
    },
  };

  // Make the SES SDK throw on require, which is exactly how a cutover fails on
  // a box where the dependency is missing or the region/credentials are wrong.
  if (breakSes) {
    const fakeId = path.join(path.dirname(require.resolve('../services/mailer')), '__ses_stub__.js');
    require.cache[fakeId] = { id: fakeId, filename: fakeId, loaded: true, exports: {} };
    const Module = require('module');
    if (!loadMailer._origResolve) loadMailer._origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === '@aws-sdk/client-ses') throw new Error("Cannot find module '@aws-sdk/client-ses'");
      return loadMailer._origResolve.call(this, request, ...rest);
    };
  } else if (loadMailer._origResolve) {
    require('module')._resolveFilename = loadMailer._origResolve;
  }

  for (const k of Object.keys(require.cache)) {
    if (/services[\\/](mailer|emailSuppression)\.js$/.test(k)) delete require.cache[k];
  }
  // DELETE, never assign undefined: process.env stringifies, so assigning
  // undefined sets the literal "undefined" and the unset case is never tested.
  if (provider === undefined) delete process.env.MAIL_PROVIDER;
  else process.env.MAIL_PROVIDER = provider;

  let mailer = null, threw = null;
  try { mailer = require('../services/mailer'); } catch (e) { threw = e; }

  if (loadMailer._origResolve) require('module')._resolveFilename = loadMailer._origResolve;
  return { mailer, threw, captured };
}

(async () => {
  try {
    process.env.SMTP_HOST = 'mail.tocanx.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'no-reply@tocanx.com';
    process.env.SMTP_PASS = 'x';
    process.env.AWS_REGION = 'us-west-1';

    // ───────────────────────────────────────────────────────────────────────
    head('DEFAULT BOOT — smtp, unset variable, nothing changes');
    // ───────────────────────────────────────────────────────────────────────
    {
      delete process.env.MAIL_PROVIDER;
      const { mailer, captured } = loadMailer({ provider: undefined, breakSes: false });
      ok(!!mailer, 'the mailer loads with MAIL_PROVIDER unset');
      ok(mailer.PROVIDER === 'smtp', 'PROVIDER defaults to smtp', mailer && mailer.PROVIDER);
      ok(mailer.ACTIVE_PROVIDER === 'smtp' && mailer.FELL_BACK === false,
        'ACTIVE_PROVIDER agrees and nothing fell back',
        JSON.stringify({ a: mailer.ACTIVE_PROVIDER, f: mailer.FELL_BACK }));
      ok(captured.info.some((l) => /\[mailer\] using smtp transport/.test(l)),
        'the chosen transport is logged at INFO on boot — positive confirmation',
        JSON.stringify(captured.info));
      ok(captured.error.length === 0, 'and nothing is logged at error', JSON.stringify(captured.error));
    }

    // ───────────────────────────────────────────────────────────────────────
    head('SUCCESSFUL CUTOVER — ses selected and it initialises');
    // ───────────────────────────────────────────────────────────────────────
    {
      const { mailer, captured } = loadMailer({ provider: 'ses', breakSes: false });
      if (!mailer) {
        note('SKIPPED: @aws-sdk/client-ses is not installed in this checkout, so a');
        note('genuine successful SES init cannot be exercised here. The FAILED');
        note('case below is the one this commit is about and it does run.');
      } else if (mailer.FELL_BACK) {
        note('@aws-sdk/client-ses not installed here, so this boot fell back;');
        note('covered by the FAILED-CUTOVER section below instead.');
      } else {
        ok(mailer.ACTIVE_PROVIDER === 'ses' && mailer.FELL_BACK === false,
          'ACTIVE_PROVIDER is ses and nothing fell back');
        ok(captured.info.some((l) => /\[mailer\] using ses transport/.test(l)),
          'boot logs "[mailer] using ses transport" at INFO — the line to grep for',
          JSON.stringify(captured.info));
        ok(captured.error.length === 0, 'and nothing at error');
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    head('FAILED CUTOVER — ses selected, init throws. THE CASE THAT MATTERS.');
    // ───────────────────────────────────────────────────────────────────────
    let failedBootLogs = null;
    {
      const { mailer, captured } = loadMailer({ provider: 'ses', breakSes: true });
      failedBootLogs = captured;

      ok(!!mailer, 'the app still boots — the fallback is KEPT, uptime preserved');
      ok(mailer.PROVIDER === 'ses', 'PROVIDER still reports what was ASKED for (ses)', mailer.PROVIDER);
      ok(mailer.ACTIVE_PROVIDER === 'smtp',
        'but ACTIVE_PROVIDER reports what is actually SENDING (smtp) — they now differ, visibly',
        mailer.ACTIVE_PROVIDER);
      ok(mailer.FELL_BACK === true, 'and FELL_BACK says so in one boolean');

      const shout = captured.error.join('\n');
      ok(captured.error.length > 0, 'the fallback logs at ERROR level', JSON.stringify(captured.error));
      ok(/MAIL_PROVIDER_FALLBACK/.test(shout),
        'it carries a GREPPABLE marker: MAIL_PROVIDER_FALLBACK', shout);
      ok(/DID NOT TAKE EFFECT/i.test(shout),
        'it names the CONSEQUENCE — the cutover did not take effect', shout);
      ok(/still going out over the OLD smtp sender/i.test(shout),
        '…and says mail is still going out over the old sender, in those words', shout);
      ok(/Cannot find module/.test(shout),
        'the underlying cause is still there for whoever fixes it', shout);

      // The old message said only this. Present alone, it is the bug.
      const onlySymptom = /failed to init/i.test(shout) && !/DID NOT TAKE EFFECT/i.test(shout);
      ok(!onlySymptom, 'it does NOT report only the symptom, the way the old line did');
    }

    // ───────────────────────────────────────────────────────────────────────
    head('NON-VACUITY — the OLD line must fail these assertions');
    // ───────────────────────────────────────────────────────────────────────
    {
      // Reconstruct the line services/mailer.js used to log, verbatim, and run
      // the same assertions against it. If they pass on the old line too, they
      // are asserting nothing.
      const PROVIDER = 'ses';
      const err = { message: "Cannot find module '@aws-sdk/client-ses'" };
      const oldLine = `[mailer] failed to init ${PROVIDER} transport; falling back to smtp: ${err.message}`;

      ok(!/MAIL_PROVIDER_FALLBACK/.test(oldLine),
        'the OLD line has no greppable marker — so that assertion is real', oldLine);
      ok(!/DID NOT TAKE EFFECT/i.test(oldLine),
        'the OLD line never names the consequence — so that assertion is real', oldLine);
      ok(!/still going out over the OLD smtp sender/i.test(oldLine),
        'the OLD line never says mail is still using the old sender — so that assertion is real', oldLine);

      // And the new line must actually differ from it.
      const newShout = failedBootLogs.error.join('\n');
      ok(newShout !== oldLine, 'and the new output is not simply the old line again');

      // The old module also exported no way to tell asked-for from actual.
      const oldExports = ['transporter', 'sendMail', 'verify', 'FROM', 'PROVIDER', 'rawSendMail'];
      ok(!oldExports.includes('ACTIVE_PROVIDER'),
        'the OLD module exported no ACTIVE_PROVIDER, so a caller could not tell the two apart');
    }

    // ───────────────────────────────────────────────────────────────────────
    head('NO BEHAVIOUR CHANGE');
    // ───────────────────────────────────────────────────────────────────────
    {
      const { mailer } = loadMailer({ provider: 'smtp', breakSes: false });
      ok(typeof mailer.transporter.sendMail === 'function'
        && mailer.transporter.sendMail.name === 'suppressionAwareSendMail',
        'the suppression chokepoint is still installed on the transport',
        mailer.transporter.sendMail.name);
      ok(typeof mailer.sendMail === 'function' && typeof mailer.verify === 'function'
        && typeof mailer.rawSendMail === 'function' && typeof mailer.FROM === 'string',
        'every previously exported name is still exported with the same type');
      note('Which transport is chosen, and how mail is sent, are untouched by');
      note('this commit. Only what is LOGGED, plus two new read-only exports.');
    }

  } catch (err) {
    fail++;
    rec.push('  ✗ HARNESS ERROR: ' + (err && err.stack || err));
  }

  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
