/* NO TRACKED SOURCE FILE MAY CONTAIN A BYTE THAT MAKES GIT CALL IT BINARY.
 *
 * WHY THIS EXISTS. services/budgetWorkbook.js reached a pull request carrying a
 * single NUL byte: the control-character class in its filename sanitiser had
 * been written with LITERAL control bytes instead of the escape sequences that
 * were meant. The code ran correctly and its own suite was green — but git
 * applies a binary heuristic, saw the NUL, and rendered the whole file as
 *
 *     services/budgetWorkbook.js | Bin 0 -> 26964 bytes
 *
 * So 667 lines of a RED payments path arrived for review as a black box. Nobody
 * could have reviewed it, and nothing in the suite would ever have said so.
 *
 * WHAT IT CHECKS. Every TRACKED text-shaped file, for the control bytes that
 * have no business in source:
 *
 *   rejected   0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F
 *   allowed    0x09 TAB, 0x0A LF, 0x0D CR
 *
 * That is stricter than git's own rule (git only needs a NUL in the first 8000
 * bytes) on purpose: a vertical tab in a source file is a mistake whether or not
 * it happens to trip the heuristic.
 *
 * The whole tracked tree is scanned rather than services/ alone — the defect is
 * not specific to that directory and the wider scan costs nothing. It passes on
 * origin/main today, so it starts green and only ever goes red on a new one.
 *
 * Run: node test/noBinarySourceFiles.test.js
 */
'use strict';
let pass = 0, fail = 0; const rec = [];
const ok = (c, m, x) => { c ? pass++ : fail++; rec.push(`${c ? '  ✓' : '  ✗'} ${m}${c ? '' : '  -> ' + (x || '')}`); };
const note = (m) => rec.push('  · ' + m);

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/** The rule, as one function, so the tree scan and the self-test below cannot
 *  drift apart. Returns null when clean, or a description of the first offender. */
function firstBadByte(buf) {
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    const bad = c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f);
    if (bad) {
      // Line number makes the failure actionable rather than an offset nobody
      // can find — this is the difference between "there is a NUL somewhere in
      // 667 lines" and "line 71".
      let line = 1;
      for (let j = 0; j < i; j++) if (buf[j] === 0x0a) line++;
      return { offset: i, byte: c, line };
    }
  }
  return null;
}

const TEXT_EXT = /\.(js|cjs|mjs|json|md|yml|yaml|sql|txt|html|css|scss|ts)$/i;

(() => {
  // ── 1. the detector itself, on synthetic buffers ────────────────────────────
  // Without this the suite could pass because the detector is broken rather than
  // because the tree is clean. A guard that cannot fail is not a guard.
  ok(firstBadByte(Buffer.from('clean source\n\twith a tab\r\n')) === null,
    'the detector passes ordinary source — tabs, LF and CRLF are all allowed');

  const withNul = Buffer.concat([Buffer.from('line one\nline '), Buffer.from([0x00]), Buffer.from('two\n')]);
  const hit = firstBadByte(withNul);
  ok(hit !== null && hit.byte === 0x00, 'the detector catches a NUL byte', JSON.stringify(hit));
  ok(hit && hit.line === 2, 'and reports the LINE it is on, not just an offset', JSON.stringify(hit));

  ok(firstBadByte(Buffer.from([0x41, 0x0b, 0x42])) !== null, 'it catches a vertical tab (0x0B)');
  ok(firstBadByte(Buffer.from([0x41, 0x1f, 0x42])) !== null, 'it catches a unit separator (0x1F)');
  ok(firstBadByte(Buffer.from([0x41, 0x09, 0x0a, 0x0d, 0x42])) === null,
    'and does NOT flag the three whitespace controls that belong in source');

  // A real UTF-8 file with accents and em dashes must not trip it — every comment
  // in this codebase has them.
  ok(firstBadByte(Buffer.from('an em dash — and an arrow → and Σ\n', 'utf8')) === null,
    'multi-byte UTF-8 is not mistaken for a control byte');

  // ── 2. the tracked tree ─────────────────────────────────────────────────────
  let files = [];
  let listed = true;
  try {
    files = execSync('git ls-files', { cwd: path.join(__dirname, '..'), maxBuffer: 1e8 })
      .toString().split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => TEXT_EXT.test(f));
  } catch (e) {
    listed = false;
    note('git ls-files failed: ' + e.message);
  }
  ok(listed, 'the tracked file list is obtainable');
  ok(files.length > 50, 'and it actually found the source tree — not an empty list passing trivially',
    String(files.length));
  note(`${files.length} tracked text files scanned`);

  const offenders = [];
  for (const f of files) {
    const abs = path.join(__dirname, '..', f);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) { continue; } // deleted-but-tracked
    const bad = firstBadByte(buf);
    if (bad) {
      offenders.push(`${f}:${bad.line} — byte 0x${bad.byte.toString(16).padStart(2, '0')} at offset ${bad.offset}`);
    }
  }

  ok(offenders.length === 0,
    'no tracked source file contains a byte that makes git treat it as binary',
    offenders.join(' | '));

  console.log(rec.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
