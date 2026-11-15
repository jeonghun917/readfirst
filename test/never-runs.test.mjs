// A command the shell never runs (review of #228, 2026-11-15): after `exit`, after `false &&`, after `true ||` or `: ||`.
// Until then every reader read it as run: `false && readfirst read a.js` counted as a read and opened the gate,
// `exit 0; readfirst answer '...'` as an answer, and shellWrites named the write of `true || echo > f` as certain. Now
// eachCommand decides it once, for every walk (shellWrites, bashReads, commandWords and the readers built on it): only a
// constant result counts (`true`, `false`, `:`, an `exit` at the top level); any other && or || may run, as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerRuns } from '../src/answers.mjs';
import * as bw from '../src/bash-writes.mjs';
import { findQueries, readfirstHookOf } from '../src/cli.mjs';

const { bashReads, shellWrites } = bw;
const CWD = '/r';
const reads = (command) => bashReads(command, CWD).flatMap((r) => r.files);

test('a read, answer, find or hook after exit, false && or true || is never run', () => {
  for (const before of ['exit 0; ', 'exit\n', 'false && ', 'true || ', ': || ', 'false && x && ', 'true || x || ', 'false && { ', 'true || if x; then ']) {
    const after = before.includes('{') ? '; }' : before.includes('then') ? '; fi' : '';
    assert.deepEqual(reads(`${before}readfirst read a.js${after}`), [], before);
    assert.deepEqual(answerRuns(`${before}readfirst answer '{}'${after}`, CWD), [], before);
    assert.deepEqual(findQueries(`${before}readfirst find x${after}`, CWD), [], before);
    assert.equal(readfirstHookOf(`${before}npx readfirst hook${after}`), null, before);
  }
  assert.deepEqual(reads('false && for f in a.js; do readfirst read $f; done'), [], 'a loop that never starts');
});

test('a command that may run is read as before', () => {
  for (const before of ['x && ', 'x || ', 'true && ', 'false || ', ': && ', 'false; ', 'false && x || ', 'false && true || ', '! true || ', '(exit 0); ', 'exit 0 | cat; ', 'exit 0 & ', 'if x; then exit; fi; ', '{ x; exit; } || ', 'false | true && ']) {
    assert.deepEqual(reads(`${before}readfirst read a.js`), ['/r/a.js'], before);
  }
  assert.deepEqual(reads('false && { x; }; readfirst read a.js'), ['/r/a.js'], 'after the block that never ran ends');
  assert.deepEqual(reads('false && { x; } || readfirst read a.js'), ['/r/a.js'], 'the || after a block skipped by false && runs');
});

test('shellWrites names no write the shell never runs, and a call that never runs reads no body', () => {
  const written = (command) => shellWrites(command, CWD).files;
  assert.deepEqual(written('true || echo x > f'), []);
  assert.deepEqual(written('false && echo x > f; exit; echo y > g'), []);
  assert.deepEqual(written('f() { echo x > f; }; true || f'), []);
  assert.deepEqual(written('x || echo x > f'), ['/r/f']);
  assert.deepEqual(written('false && cd /elsewhere; echo x > f'), ['/r/f'], 'a cd that never runs moves nothing');
});

test('readfirst options that take a value come from one list, which parse and every reader use', () => {
  assert.ok(bw.VALUES instanceof Set, 'exported from src/bash-writes.mjs');
  for (const name of bw.VALUES) assert.deepEqual(reads(`readfirst --${name} v read a.js`), [name === 'root' ? '/r/v/a.js' : '/r/a.js'], name);
});
