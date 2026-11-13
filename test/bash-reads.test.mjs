// bashReads (src/bash-writes.mjs): the files a `readfirst read` in a shell command asks for, from the folder it runs
// in, and whether its whole output came back to whoever ran it. The gate counts only those reads (test/gate-read.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashReads } from '../src/bash-writes.mjs';

test('bashReads: the files a readfirst read asks for, from where the command runs, and whether its output came back', () => {
  assert.deepEqual(bashReads('(cd sub && readfirst read ../a.js) && readfirst read --root /r c.js 1>&2', '/w'), [{ files: ['/w/a.js'], seen: true, why: null }, { files: ['/r/c.js'], seen: true, why: null }]);
  assert.deepEqual(bashReads('readfirst find read a.js; cat src/a.js | readfirst-other read x', '/w'), []);
  assert.deepEqual(bashReads('readfirst read -- --odd.js > out.txt', '/w'), [{ files: ['/w/--odd.js'], seen: false, why: 'its output was sent elsewhere' }]);
});

test('bashReads: output sent to a file, /dev/null or a pipe, or a list cut by --limit, is not seen', () => {
  const seen = (command) => bashReads(command, '/w').map((r) => r.seen);
  assert.deepEqual(seen('readfirst read a.js 2>/dev/null; readfirst read a.js >&2'), [true, true]);
  assert.deepEqual(seen('readfirst read a.js >/dev/null; readfirst read a.js >> log; readfirst read a.js &> x; readfirst read a.js 1> x'), [false, false, false, false]);
  assert.deepEqual(seen('readfirst read a.js | head -5; readfirst read a.js 2>&1 | grep Risk; readfirst read a.js --limit=2'), [false, false, false]);
});
