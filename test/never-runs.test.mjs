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
  // Review of 05c537f: a redefinition readfirst cannot see.
  "eval 'true() { return 1; }'; true || ", 'enable -n exit; exit; ', "eval ':() { return 1; }'; : || ",
];
// Function names that are no identifiers (review of 05c537f: put in a RegExp, `[` threw and `p?` found no body).
const ODD_NAMES = ['[', 'p?', 'a*', 'x+', 'a.b', ':'];
const bash = spawnSync('bash', ['-c', 'true']).status === 0;
test('against bash: no write bash makes is missed, and none is named after a command that never runs', { skip: !bash && 'bash is not found here' }, () => {
  for (const before of [...NEVER, ...MAY]) {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-never-'));
    const script = `${before}echo x > f`;
    spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    // Named, or given as a write readfirst cannot place (after eval the folder is not known): the gate refuses both.
    const w = shellWrites(script, dir);
    const named = w.files.includes(join(dir, 'f')) || w.unknown.length > 0;
    if (existsSync(join(dir, 'f'))) assert.ok(named, `bash writes f after ${JSON.stringify(before)}, and readfirst does not name it`);
    if (NEVER.includes(before)) assert.equal(existsSync(join(dir, 'f')) || named, false, `never runs: ${JSON.stringify(before)}`);
    else assert.ok(named, `may run: ${JSON.stringify(before)}`);
  }
  for (const name of ODD_NAMES) {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-never-'));
    const script = `${name}() { echo x > f; }; ${name}`;
    spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.ok(existsSync(join(dir, 'f')), `bash runs the body of ${name}`);
    assert.ok(shellWrites(script, dir).files.includes(join(dir, 'f')), `the body of ${name} is read where it is called`);
  }
});

// The gate end to end: each write below, to a file whose notes were not read, is refused on main and must stay
// refused. The reviews of ae3fea9 and 05c537f found each let through (or, for `[`, the reader throwing). A change to
// what never runs passes this whole list.
const W = 'echo x >> src/a.js';
const GATE_DENY = [
  `true < missing || ${W}`, `true > nodir/x || ${W}`, `: > nodir/x || ${W}`, `exit < missing; ${W}`,
  `true() { return 1; }; true || ${W}`, `:() { return 1; }; : || ${W}`, `exit() { :; }; exit; ${W}`, `false() { :; }; false && ${W}`,
  `X=1 false && ${W}`, `env true || ${W}`, `[() { ${W}; }; [`, `p?() { ${W}; }; p?`, `a*() { ${W}; }; a*`,
  `eval 'true() { return 1; }'; true || ${W}`, `shopt -s expand_aliases\nalias true=false\ntrue || ${W}`, `enable -n exit; exit; ${W}`,
];
test('the gate refuses a write after a result that only looks constant, as on main', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-never-gate-'));
  const files = { 'src/a.js': 'export const a = 1;\n', '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: 'a changes with care' }] }] }) };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start']);
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-never-state-'));
  for (const [i, command] of GATE_DENY.entries()) {
    const out = runHook(JSON.stringify({ session_id: `never-${process.pid}-${i}`, cwd: root, tool_name: 'Bash', tool_input: { command } }), { stateDir, gate: true });
    assert.equal(out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'through', 'deny', command);
  }
});

test('readfirst options that take a value come from one list, which parse and every reader use', () => {
  assert.ok(bw.VALUES instanceof Set, 'exported from src/bash-writes.mjs');
  for (const name of bw.VALUES) assert.deepEqual(reads(`readfirst --${name} v read a.js`), [name === 'root' ? '/r/v/a.js' : '/r/a.js'], name);
});
