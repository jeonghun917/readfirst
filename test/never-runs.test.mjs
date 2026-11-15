// A command the shell never runs (review of #228, 2026-11-15): after `exit`, after `false &&`, after `true ||` or `: ||`.
// Until then every reader read it as run: `false && readfirst read a.js` counted as a read and opened the gate,
// `exit 0; readfirst answer '...'` as an answer, and shellWrites named the write of `true || echo > f` as certain. Now
// eachCommand decides it once, for every walk (shellWrites, bashReads, commandWords and the readers built on it): only a
// constant result counts (`true`, `false`, `:`, an `exit` at the top level); any other && or || may run, as before.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { answerRuns } from '../src/answers.mjs';
import * as bw from '../src/bash-writes.mjs';
import { findQueries, readfirstHookOf, runHook } from '../src/cli.mjs';

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
  // Review of ae3fea9: a name alone is no constant result. A redirect can fail (`true < missing` fails, and bash goes
  // on after `exit < missing`), and a function can take the name (`true() { return 1; }`).
  for (const before of ['true < missing || ', 'true > nodir/x || ', ': > nodir/x || ', 'exit < missing; ', 'true() { return 1; }; true || ', ':() { return 1; }; : || ', 'exit() { :; }; exit; ', 'false() { :; }; false && ']) {
    assert.deepEqual(reads(`${before}readfirst read a.js`), ['/r/a.js'], before);
    assert.ok(shellWrites(`${before}echo x > f`, CWD).files.includes('/r/f'), before);
  }
  assert.deepEqual(reads('true < m || cd a; readfirst read y.md'), [], 'the cd may have run: the read is in a folder not known');
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

// Against bash itself: every script below writes f only through the command after its first part. Where bash writes f,
// shellWrites must name it (a write it misses is one the gate lets through); where it never runs, it names nothing.
// The forms that may run but do not here (`X=1 false &&`, `env true ||`) are named: readfirst reads no constant there.
const NEVER = ['true || ', ': || ', 'false && ', 'exit; ', 'exit 0\n', 'command true || ', 'builtin false && ', 'false && x && ', 'true || x || '];
const MAY = [
  'true < missing || ', 'true > nodir/x || ', ': > nodir/x || ', 'exit < missing; ', 'true() { return 1; }; true || ', ':() { return 1; }; : || ',
  'exit() { :; }; exit; ', 'false() { :; }; false && ', 'X=1 false && ', 'env true || ', 'true() { return 1; }; command true || ', '( exit ); ', '(exit 0); ',
  'exit | cat; ', 'x=$(exit); ', 'echo $(exit); ', 'exit 0 & wait; ', 'shopt -s expand_aliases\nalias true=false\ntrue || ', 'false && x || ', 'if x; then exit; fi; ',
];
const bash = spawnSync('bash', ['-c', 'true']).status === 0;
test('against bash: no write bash makes is missed, and none is named after a command that never runs', { skip: !bash && 'bash is not found here' }, () => {
  for (const before of [...NEVER, ...MAY]) {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-never-'));
    const script = `${before}echo x > f`;
    spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    const named = shellWrites(script, dir).files.includes(join(dir, 'f'));
    if (existsSync(join(dir, 'f'))) assert.ok(named, `bash writes f after ${JSON.stringify(before)}, and readfirst does not name it`);
    if (NEVER.includes(before)) assert.equal(existsSync(join(dir, 'f')) || named, false, `never runs: ${JSON.stringify(before)}`);
    else assert.ok(named, `may run: ${JSON.stringify(before)}`);
  }
});

// The gate end to end: a write to a file whose notes were not read, after a constant that is none, is refused on main
// and stays refused (review of ae3fea9: both went through).
test('the gate refuses a write after a result that only looks constant, as on main', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-never-gate-'));
  const files = { 'src/a.js': 'export const a = 1;\n', '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: 'a changes with care' }] }] }) };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start']);
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-never-state-'));
  for (const [i, command] of ['true < missing || echo x >> src/a.js', 'exit < missing; echo x >> src/a.js', 'true() { return 1; }; true || echo x >> src/a.js'].entries()) {
    const out = runHook(JSON.stringify({ session_id: `never-${process.pid}-${i}`, cwd: root, tool_name: 'Bash', tool_input: { command } }), { stateDir, gate: true });
    assert.equal(out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'through', 'deny', command);
  }
});

test('readfirst options that take a value come from one list, which parse and every reader use', () => {
  assert.ok(bw.VALUES instanceof Set, 'exported from src/bash-writes.mjs');
  for (const name of bw.VALUES) assert.deepEqual(reads(`readfirst --${name} v read a.js`), [name === 'root' ? '/r/v/a.js' : '/r/a.js'], name);
});
