# CCP — Make the lockfile load-bearing: `npm install` → `npm ci` on deploy

**Status: NOT STARTED. Written up for after launch. Do not begin this
during a go-live week.**

**Tier: RED.** It changes how production gets its dependency tree. The
failure mode is a deploy that stops rather than a deploy that misbehaves,
which is the right way round — but it is still a deploy that stops.

## The problem

`.github/workflows/deploy.yml:23` runs:

    npm install --production

`npm install` resolves from **package.json**, not from the lockfile. Every
dependency in package.json is a caret range:

    "@aws-sdk/client-ses": "^3.658.0"
    "socket.io": "^4.7.5"
    "firebase-admin": "^13.5.0"
    "googleapis": "^171.4.0"
    ... and the rest

So **production resolves fresh versions on every deploy.** A deploy next
month can pull a different minor of every dependency with no commit to
explain it. A deploy can break for reasons no diff will show, and the
bisect you would reach for does not contain the change.

The lockfile is currently decorative. Nothing reads it.

### How this was found

Not by looking for it. `npm install exceljs` for the Budget export added
`@aws-sdk/client-ses` and `socket.io` to the lockfile — both of which
package.json had required all along and the lockfile had never contained.
Chasing whether that would flip production mail to SES led to reading the
deploy workflow, which answered the question (it would not, because
`npm install` had been installing both all along) and exposed this one.

## What must be true before switching

`npm ci` **deletes `node_modules` and installs strictly from the
lockfile.** If the lockfile is wrong in any way it fails the deploy
outright. That is exactly why it is safer, and exactly why it must not be
switched on the day of a go-live.

Preconditions, in order:

1. **#53 is merged** — the lockfile must actually match package.json
   first. Without it `npm ci` would install a tree with no SES SDK and no
   socket.io, silently killing live chat and any SES cutover. This is the
   step that makes the switch safe rather than dangerous.

2. **A clean `npm ci` produces a tree that boots.** Verified off the
   production path: fresh clone, `npm ci --omit=dev`, start the app,
   confirm it serves and that `[realtime] Socket.IO initialized` and
   `[mailer] using <provider> transport` both appear at INFO.

3. **The full suite passes against that tree**, not against a tree grown
   by `npm install`. 89 suites on disk; CI currently runs 15 (see below).

4. **A rollback is written down before the switch**, not discovered
   during it: revert the workflow line, redeploy, done.

## The change itself

One line:

    -            npm install --production
    +            npm ci --omit=dev

`--omit=dev` is the modern spelling of `--production`; both
`mysql-memory-server` and `supertest` are devDependencies and must stay
out of the production tree.

## A second finding, worth its own decision

**CI runs 15 of the 89 suites on disk** (`.github/workflows/test.yml`).
`mailerCutoverVisibility` is not among them — which is why nothing caught
that it had been passing for an environmental reason rather than a real
one, and why a full local sweep is currently the only place the other 74
suites run at all.

That is a separate question from `npm ci` and should not be bundled into
it. But whoever picks this up should know that "CI is green" currently
means "15 suites are green".

## Explicitly out of scope

- Pinning the caret ranges to exact versions. `npm ci` makes the lockfile
  authoritative, which is the actual fix; rewriting every range is a
  different and much larger argument.
- Adding the missing 74 suites to CI.
- Anything about `MAIL_PROVIDER`. By the evidence above it has no bearing
  on any of this: the SES SDK is already installed in production by
  `npm install`, so whatever that variable is set to is already in effect
  and has been.

## Verification checklist

1. Confirm #53 is on `main` and `package-lock.json` contains
   `@aws-sdk/client-ses` and `socket.io`.
2. In a scratch clone: `npm ci --omit=dev`, then start the app against a
   throwaway database. Paste the boot log showing the realtime and mailer
   INFO lines.
3. Run the full suite against that tree. Report the count and diff it
   against the last full sweep.
4. Confirm `node_modules` after `npm ci --omit=dev` contains neither
   `mysql-memory-server` nor `supertest`.
5. Make the one-line change, deploy to production, and confirm the app
   comes back and the bundle/boot log is clean.
6. Report the rollback command used to verify the escape hatch works,
   having actually run it once.

## Status

Not started. Logged 2026-09-22 out of the Budget-export work. Do not
begin during a launch window.
