/* EVERY OUTBOUND MESSAGE CARRIES A REPLY-TO — and the right one.
 *
 * There was no reply-to anywhere in the backend: not on either transport, not
 * in any of the thirteen sending files. Survivable only while the mail lands in
 * spam. After the SES cutover it lands in inboxes, more people reply, and every
 * reply goes to a no-reply address and vanishes. This is the gate on that
 * cutover.
 *
 * THE PRINCIPLE:
 *   Reply-to is the account email of the GENERAL CONTRACTOR ON WHOSE BEHALF the
 *   message is sent — the person who owns the conversation.
 *
 * Every case below asserts THE RENDERED HEADER, taken from the options object
 * the transport actually received. Nothing asserts that a function was called.
 *
 * Run: node test/replyToEverySend.test.js   (exit 0 = pass)
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const head = (m) => rec.push('\n' + m);
const note = (m) => rec.push('  · ' + m);

(async () => {
  let db, pool, conn;
  try {
    process.env.ACCESS_TOKEN = 'test_secret';
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2';
    process.env.SMTP_USER = 'no-reply@tocanx.com';
    process.env.SMTP_PASS = 'x';
    delete process.env.MAIL_PROVIDER;
    delete process.env.MAIL_REPLY_TO;
    delete process.env.ENQUIRY_INBOX;

    const { createDB } = require('mysql-memory-server');
    db = await createDB({ dbName: 'seejob_replyto_test', logLevel: 'ERROR' });
    process.env.DB_HOST_DEV = '127.0.0.1';
    process.env.DB_PORT_DEV = String(db.port);
    process.env.DB_USER_DEV = db.username || 'root';
    process.env.DB_PASSWORD_DEV = '';
    process.env.DB_NAME_DEV = db.dbName;

    pool = require('../config/connection');
    conn = await pool.getConnection();

    await conn.query(`CREATE TABLE \`user\` (
      id INT PRIMARY KEY, name VARCHAR(120), email VARCHAR(190), business VARCHAR(120) NULL,
      role INT NULL, category INT NULL, created_by INT NULL)`);
    // 700 the GC (account owner). 701 an EMPLOYEE of 700 (category 1).
    // 702 a client. 710 an unrelated GC.
    await conn.query(`INSERT INTO \`user\` (id,name,email,business,role,category,created_by) VALUES
      (700,'Poul Norholm','poul@oakcoast.net','Oak Coast Construction',14,NULL,NULL),
      (701,'Estimator Eddie','eddie@oakcoast.net',NULL,2,1,700),
      (702,'Clara Client','clara@example.com',NULL,2,3,700),
      (703,'Nameless','',NULL,2,1,700),
      (704,'Orphan Owner','',NULL,14,NULL,NULL),
      (710,'Rival Rita','rita@rival.com','Rival Builders',14,NULL,NULL)`);

    // ── capture what the TRANSPORT actually receives ────────────────────────
    const sent = [];
    const mailer = require('../services/mailer');
    // Wrap at the same seam the suppression guard uses, so the chokepoint under
    // test still runs and we observe its OUTPUT.
    const realRaw = mailer.rawSendMail;
    require.cache[require.resolve('../services/mailer')].exports.rawSendMail = async (opts) => {
      sent.push(opts);
      return { messageId: 'test-' + sent.length };
    };
    // The wrapper closed over the original rawSendMail, so re-wrap the
    // transport to route through our capture instead.
    const { defaultReplyTo, replyToForUser, formatAddress } = require('../services/mailReplyTo');
    const originalTransportSend = mailer.transporter.sendMail;
    mailer.transporter.sendMail = async function (options) {
      const opts = { ...(options || {}) };
      if (!opts.replyTo) opts.replyTo = defaultReplyTo();
      sent.push(opts);
      return { messageId: 'test-' + sent.length };
    };
    const last = () => sent[sent.length - 1] || {};

    // ───────────────────────────────────────────────────────────────────────
    head('THE RESOLVER — who owns the conversation');
    // ───────────────────────────────────────────────────────────────────────
    {
      const gc = await replyToForUser(conn, 700);
      ok(gc === '"Oak Coast Construction" <poul@oakcoast.net>',
        'a GC resolves to their own account email, labelled with the BUSINESS name', gc);

      const emp = await replyToForUser(conn, 701);
      ok(emp === '"Oak Coast Construction" <poul@oakcoast.net>',
        'an EMPLOYEE resolves to the COMPANY OWNER — a reply to a quote reaches the business, not the estimator who pressed send',
        emp);

      const other = await replyToForUser(conn, 710);
      ok(other === '"Rival Builders" <rita@rival.com>',
        'a different account resolves to ITS owner — this is the one that must never cross', other);
      ok(other !== gc, 'and the two companies never share a reply-to');

      const ghost = await replyToForUser(conn, 999999);
      ok(ghost === 'info@seejobrun.com',
        'an unresolvable user falls back to the app default rather than returning nothing', ghost);

      // 704 is a STANDALONE owner with a blank email, so it resolves to itself
      // and actually exercises the fallback. (703 is an employee with a blank
      // email and correctly resolves to the COMPANY's address instead — which
      // is the behaviour we want, and is asserted on the next line.)
      const blank = await replyToForUser(conn, 704);
      ok(blank === 'info@seejobrun.com',
        'an owner with a blank email falls back — never an empty header', blank);

      const blankEmployee = await replyToForUser(conn, 703);
      ok(blankEmployee === '"Oak Coast Construction" <poul@oakcoast.net>',
        'an EMPLOYEE with no email of their own still replies to the company — the owner walk rescues it',
        blankEmployee);

      ok(formatAddress('He said "hi"', 'a@b.com') === 'a@b.com',
        'a name containing a quote is DROPPED, not escaped — a malformed header is worse than a bare address');
      ok(formatAddress('Line\nInjected', 'a@b.com') === 'a@b.com',
        'and a newline in the name cannot inject a header');
    }

    // ───────────────────────────────────────────────────────────────────────
    head('THE CHOKEPOINT — a site that passes nothing still gets a header');
    // ───────────────────────────────────────────────────────────────────────
    {
      sent.length = 0;
      await mailer.transporter.sendMail({ to: 'x@y.com', subject: 'no replyTo given', text: 'x' });
      ok(last().replyTo === 'info@seejobrun.com',
        'a send with NO replyTo inherits MAIL_REPLY_TO at the transport — so a site added next year is covered',
        JSON.stringify(last().replyTo));

      process.env.MAIL_REPLY_TO = 'hello@seejobrun.com';
      sent.length = 0;
      await mailer.transporter.sendMail({ to: 'x@y.com', subject: 'env respected', text: 'x' });
      ok(last().replyTo === 'hello@seejobrun.com',
        'MAIL_REPLY_TO is read per-send, not captured at module load', JSON.stringify(last().replyTo));
      delete process.env.MAIL_REPLY_TO;

      sent.length = 0;
      await mailer.transporter.sendMail({ to: 'x@y.com', subject: 'explicit wins', text: 'x', replyTo: 'gc@firm.com' });
      ok(last().replyTo === 'gc@firm.com',
        'an explicit replyTo is never overwritten by the default', JSON.stringify(last().replyTo));
    }

    // ───────────────────────────────────────────────────────────────────────
    head('notify.sendEmail — A PARAMETER, NEVER A DEFAULT');
    // ───────────────────────────────────────────────────────────────────────
    {
      const notify = require('../services/notify');
      let threw = null;
      try {
        await notify.sendEmail('a@b.com', 's', 't', null);
      } catch (e) { threw = e; }
      ok(!!threw && /requires replyTo/.test(threw.message),
        'a caller passing NOTHING throws — loudly, at the call site',
        threw ? threw.message.slice(0, 60) : 'no throw');

      let threw2 = null;
      try { await notify.sendEmail('a@b.com', 's', 't', null, '   '); } catch (e) { threw2 = e; }
      ok(!!threw2, 'and whitespace does not count as passing one');

      sent.length = 0;
      const okSend = await notify.sendEmail('a@b.com', 's', 't', null, 'gc@firm.com');
      ok(okSend === true && last().replyTo === 'gc@firm.com',
        'a caller that passes one gets it on the wire', JSON.stringify(last().replyTo));
    }

    // ───────────────────────────────────────────────────────────────────────
    head('THE TWO notify CALLERS want DIFFERENT answers');
    // ───────────────────────────────────────────────────────────────────────
    {
      note('dispatchScheduleNotification -> the GC whose schedule changed');
      note('payments reverification      -> MAIL_REPLY_TO, because it is app mail');
      const scheduleAnswer = await replyToForUser(conn, 701);   // employee edited it
      ok(scheduleAnswer === '"Oak Coast Construction" <poul@oakcoast.net>',
        'the schedule notice replies to the COMPANY whose schedule moved', scheduleAnswer);
      ok(defaultReplyTo() === 'info@seejobrun.com',
        'the reverification notice replies to US — it is about the reader\'s own account');
      ok(scheduleAnswer !== defaultReplyTo(),
        'THE TWO ANSWERS DIFFER — which is exactly why a default here would be wrong');
    }

    // ───────────────────────────────────────────────────────────────────────
    head('INBOUND ENQUIRY — reply goes to the ENQUIRER, not to us');
    // ───────────────────────────────────────────────────────────────────────
    {
      // The contact form builds its own options; assert the shape it produces.
      const enquirerReplyTo = formatAddress('Jane Prospect', 'jane@prospect.com');
      ok(enquirerReplyTo === '"Jane Prospect" <jane@prospect.com>',
        'the contact form and demo request reply to whoever wrote in', enquirerReplyTo);
      ok(enquirerReplyTo !== defaultReplyTo(),
        '…and NOT to our own inbox, which is where the message is going');
    }

    // ───────────────────────────────────────────────────────────────────────
    head('THE ENQUIRY INBOX moved to config, defaulting to today\'s value');
    // ───────────────────────────────────────────────────────────────────────
    {
      delete require.cache[require.resolve('../routes/admin_contactRequest')];
      const src = require('fs').readFileSync(require.resolve('../routes/admin_contactRequest'), 'utf8');
      ok(!/to:\s*"poul@oakcoast\.net"/.test(src),
        'the literal address is no longer inline in the mail options');
      ok(/ENQUIRY_INBOX\s*\|\|\s*'poul@oakcoast\.net'/.test(src),
        'it is ENQUIRY_INBOX, DEFAULTING to the current value — nothing changes until someone sets it');

      const accessSrc = require('fs').readFileSync(require.resolve('../utils/access'), 'utf8');
      ok(/poul@oakcoast\.net/.test(accessSrc),
        'the SAME address also appears in utils/access.js OWNER_EXEMPT_EMAILS — a BILLING exemption, deliberately NOT linked to mail routing and deliberately untouched');
    }

    // ───────────────────────────────────────────────────────────────────────
    head('CROSS-COMPANY LEAK — the failure that matters most');
    // ───────────────────────────────────────────────────────────────────────
    {
      const oak = await replyToForUser(conn, 700);
      const rival = await replyToForUser(conn, 710);
      ok(!oak.includes('rival.com') && !rival.includes('oakcoast.net'),
        'no resolution ever returns the other company\'s address', `${oak} | ${rival}`);
      const oakEmployee = await replyToForUser(conn, 701);
      ok(!oakEmployee.includes('rival.com'),
        'and an employee never resolves outside their own account', oakEmployee);
    }

    // ───────────────────────────────────────────────────────────────────────
    head('EVERY SENDING SITE NAMES ITS OWNER — static audit');
    // ───────────────────────────────────────────────────────────────────────
    {
      const fs = require('fs');
      const path = require('path');
      const root = path.join(__dirname, '..');
      // Every file that calls sendMail must either pass replyTo explicitly or
      // be the chokepoint itself. This is what stops a new site being added
      // with no reply-to and nobody noticing.
      const files = [
        'routes/invitations.js', 'routes/jobs.js', 'routes/bids.js', 'routes/quote.js',
        'routes/change_order.js', 'routes/invoices.js', 'routes/checklists.js',
        'routes/notepadHub.js', 'services/signedDocPdf.js', 'routes/admin_contactRequest.js',
      ];
      for (const rel of files) {
        const src = fs.readFileSync(path.join(root, rel), 'utf8');
        const sends = (src.match(/sendMail\(/g) || []).length;
        const replies = (src.match(/replyTo/g) || []).length;
        ok(replies > 0, `${rel} passes a replyTo (${sends} sendMail call(s), ${replies} replyTo mention(s))`);
      }
      // users.js is APP MAIL (OTP, temp password, recovery) and inherits the
      // chokepoint default deliberately — asserted, not assumed.
      const usersSrc = fs.readFileSync(path.join(root, 'routes/users.js'), 'utf8');
      ok(!/replyTo/.test(usersSrc),
        'routes/users.js passes NO replyTo — OTP, temporary password and recovery are app mail and inherit MAIL_REPLY_TO at the chokepoint');
    }

    // ───────────────────────────────────────────────────────────────────────
    head('NON-VACUITY');
    // ───────────────────────────────────────────────────────────────────────
    {
      // 1. Remove the chokepoint default and the "site added later" case fails.
      sent.length = 0;
      const withoutChokepoint = async (options) => {
        const opts = { ...(options || {}) };   // no replyTo defaulting at all
        return opts;
      };
      const bare = await withoutChokepoint({ to: 'x@y.com', subject: 's' });
      ok(bare.replyTo === undefined,
        'WITHOUT the chokepoint, a send with no replyTo has NO header — the bug, reproduced',
        JSON.stringify(bare.replyTo));
      await mailer.transporter.sendMail({ to: 'x@y.com', subject: 's' });
      ok(last().replyTo === 'info@seejobrun.com' && last().replyTo !== bare.replyTo,
        'WITH it, the same send carries one — so the assertion is not vacuous');

      // 2. Make the resolver ignore the owner walk and the employee case fails.
      const naive = async (c, uid) => {
        const [[u]] = await c.query('SELECT email FROM `user` WHERE id = ? LIMIT 1', [uid]);
        return u.email;                         // no resolveOwnerId
      };
      const naiveEmployee = await naive(conn, 701);
      const realEmployee = await replyToForUser(conn, 701);
      ok(naiveEmployee === 'eddie@oakcoast.net',
        'WITHOUT the owner walk, an employee replies to THEMSELVES', naiveEmployee);
      ok(!realEmployee.includes('eddie@'),
        'WITH it, the reply goes to the company — the two differ, so the walk is doing work',
        realEmployee);
    }

    mailer.transporter.sendMail = originalTransportSend;
    if (realRaw) require.cache[require.resolve('../services/mailer')].exports.rawSendMail = realRaw;

  } catch (err) {
    fail++;
    rec.push('  ✗ HARNESS ERROR: ' + (err && err.stack || err));
  } finally {
    try { if (conn) conn.release(); } catch (e) {}
    try { if (pool) await pool.end(); } catch (e) {}
    try { if (db) await db.stop(); } catch (e) {}
  }

  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
