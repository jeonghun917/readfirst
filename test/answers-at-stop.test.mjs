// The Stop hook compares the session's answers with what it changed (plan of 2026-11-13, step 3). The gate takes an
// answer as it is given; at the stop, each item's last answer is checked against the change: a not-this whose item the
// final diff touches by a name outside its symbols, and a done whose item's checks did not pass, are named and refuse
// the stop once. `hook --report` adds up, per item id, how often it was asked, each kind of answer and how many the stop
// found not borne out; `audit` names the rules and risks most sessions answered not-this, as too wide.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ACTED_LOG, hookReport, itemId, main, runHook, runStopHook } from '../src/cli.mjs';

const A = 'export function alpha(x) {\n  const one = 1;\n  return x + one;\n}\n\nexport function beta(y) {\n  const two = 2;\n  return y * two;\n}\n';
const BOTH = '`alpha` and `beta` share one cache';
const PROSE = 'this module is old and fragile; go slowly';
const RULE = '`beta` never opens a socket';
const ID = { both: itemId('risk', 'src', BOTH), prose: itemId('risk', 'src', PROSE), rule: 'rule:no-net' };
let n = 0;
function session({ checks = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-stop-answers-'));
  const files = {
    'src/a.js': A,
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], checks, risks: [{ text: BOTH }, { text: PROSE }] }], rules: [{ id: 'no-net', rule: RULE, files: ['src/**'] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-stop-answers-state-'));
  const id = `stop-answers-${process.pid}-${++n}`;
  // After the commit: the Stop hook runs only checks the map had before the session's first mark (trustedRuns).
  let now = Date.now() + 5000;
  const call = (tool, input) => { const out = runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) }); return out ? JSON.parse(out).hookSpecificOutput : null; };
  const stop = () => { const out = runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 }); return out ? JSON.parse(out) : null; };
  const answer = (list) => call('Bash', { command: `npx readfirst answer '${JSON.stringify(list).replace(/'/gu, "'\\''")}'` });
  return { root, stateDir, call, stop, answer };
}
const inBeta = (root) => ({ file_path: join(root, 'src/a.js'), old_string: '  return y * two;', new_string: '  return y * two * 1;' });
const keeps = (...ids) => ids.map((item) => ({ item, answer: 'keeps', because: 'the arithmetic only' }));
// The file as the session leaves it: beta changed, and alpha too when `alpha` is set (a change no answer covered).
const leave = (root, { alpha = false } = {}) => writeFileSync(join(root, 'src/a.js'), A.replace('  return y * two;', '  return y * two * 1;').replace('  return x + one;', alpha ? '  return x + one + 0;' : '  return x + one;'));

test('a not-this the final diff does not bear out refuses the stop once, naming it; one it bears out does not', () => {
  const s = session();
  assert.equal(s.call('Edit', inBeta(s.root)).permissionDecision, 'deny');
  assert.equal(s.answer([{ item: ID.both, answer: 'not-this', because: 'the cache is about the results of beta only here', symbols: ['beta'] }, ...keeps(ID.prose, ID.rule)]), null);
  assert.equal(s.call('Edit', inBeta(s.root)), null, 'answered: the edit goes through');
  leave(s.root);
  const fine = s.stop();
  assert.ok(!fine || fine.decision !== 'block', `the diff touches the shared-cache risk by beta alone: ${JSON.stringify(fine)}`);
  // Then alpha changes too (a command the gate could not judge, a script): the risk is touched by alpha, outside the
  // not-this's symbols.
  leave(s.root, { alpha: true });
  const out = s.stop();
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, new RegExp(`1 answer\\(s\\) of this session the change does not bear out:\\n- \`${ID.both}\` was answered not-this \\(\`beta\`\\), but the change touches it by \`alpha\``, 'u'));
  assert.match(out.reason, /readfirst, this session: .*; 1 answer\(s\) the change does not bear out\./u);
  assert.notEqual(s.stop()?.decision, 'block', 'once for the same items, so a stop cannot loop');
});

test('a not-this is judged on the session\'s own diff: a commit on the branch before the session does not count against it', () => {
  const s = session();
  // The branch already changed alpha before the session began, in a commit main does not have.
  const git = (...a) => execFileSync('git', ['-C', s.root, ...a], { encoding: 'utf8' });
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(s.root, 'src/a.js'), A.replace('  return x + one;', '  return x + one + 0;'));
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'alpha, before the session');
  s.call('Edit', inBeta(s.root));
  s.answer([{ item: ID.both, answer: 'not-this', because: 'this session changes beta only', symbols: ['beta'] }, ...keeps(ID.prose, ID.rule)]);
  writeFileSync(join(s.root, 'src/a.js'), A.replace('  return x + one;', '  return x + one + 0;').replace('  return y * two;', '  return y * two * 1;'));
  const out = s.stop();
  assert.doesNotMatch(String(out?.reason ?? out?.systemMessage ?? ''), /does not bear out/u, 'alpha changed before the session: against main the branch touches it by alpha, against the session start it does not');
});

test('a state with no starting commit (an older readfirst) compares no not-this, and says so', () => {
  const s = session();
  s.call('Edit', inBeta(s.root));
  s.answer([{ item: ID.both, answer: 'not-this', because: 'only beta', symbols: ['beta'] }, ...keeps(ID.prose, ID.rule)]);
  leave(s.root, { alpha: true });
  // Take the head: mark out, as a state file an older readfirst wrote has none.
  const file = readdirSync(s.stateDir).find((f) => f.endsWith('.lines'));
  const at = join(s.stateDir, file);
  writeFileSync(at, readFileSync(at, 'utf8').split('\n').filter((l) => !l.startsWith('["head:')).join('\n'));
  const out = s.stop();
  const said = String(out?.reason ?? out?.systemMessage ?? '');
  assert.doesNotMatch(said, /does not bear out/u);
  assert.match(said, /1 not-this answer\(s\) were not compared with the change: this session's starting commit was not recorded \(a state from an older readfirst\)\./u);
});

test('a done whose item\'s check did not pass refuses the stop once; once it passes, nothing is said', () => {
  const s = session({ checks: [{ run: 'test -f ok.flag', why: 'the flag' }] });
  s.call('Edit', inBeta(s.root));
  assert.equal(s.answer([{ item: ID.prose, answer: 'done', because: 'went slowly, ran the check' }, ...keeps(ID.both, ID.rule)]), null);
  assert.equal(s.call('Edit', inBeta(s.root)), null);
  leave(s.root);
  const out = s.stop();
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, new RegExp(`\`${ID.prose}\` was answered done, but \`test -f ok\\.flag\` fail`, 'u'));
  // The rule has no check of its own and was answered keeps: nothing to compare.
  assert.doesNotMatch(out.reason, /`rule:no-net` was answered/u);
  writeFileSync(join(s.root, 'ok.flag'), '');
  const passed = s.stop();
  assert.doesNotMatch(String(passed?.reason ?? passed?.systemMessage ?? ''), /does not bear out/u);
});

test('hook --report adds up each item: asked, each kind of answer, and how many the stop did not find borne out', () => {
  const s = session();
  s.call('Edit', inBeta(s.root));
  s.answer([{ item: ID.both, answer: 'not-this', because: 'only beta', symbols: ['beta'] }, { item: ID.prose, answer: 'unsure', because: 'cannot tell' }, ...keeps(ID.rule)]);
  s.answer(keeps(ID.prose));
  leave(s.root, { alpha: true });
  s.stop();
  const report = hookReport({ stateDir: s.stateDir });
  assert.match(report, /- answers the change did not bear out at the stop: 1, in 1 session\(s\)/u);
  assert.match(report, /Items the gate asked, most asked first:/u);
  assert.match(report, new RegExp(`- \`${ID.both}\`: asked 1 time\\(s\\) in 1 session\\(s\\); keeps 0, not-this 1, done 0, unsure 0; not borne out 1`, 'u'));
  assert.match(report, new RegExp(`- \`${ID.prose}\`: asked 1 time\\(s\\) in 1 session\\(s\\); keeps 1, not-this 0, done 0, unsure 1; not borne out 0`, 'u'));
});

test('audit names the rules and risks most sessions answered not-this, as too wide', () => {
  const s = session();
  const tally = (kind) => ({ asked: 1, keeps: 0, 'not-this': 0, done: 0, unsure: 0, false: 0, [kind]: 1 });
  // Three sessions on this machine: the shared-cache risk answered not-this in two of them, the rule in one only.
  const lines = [['a', 'not-this', 'keeps'], ['b', 'not-this', 'keeps'], ['c', 'keeps', 'not-this']].map(([session, kind, rule]) => JSON.stringify({ session, at: 1, items: { [ID.both]: tally(kind), [ID.rule]: tally(rule), 'risk:elsewhere:00000000': tally('not-this') } }));
  writeFileSync(join(tmpdir(), ACTED_LOG), `${lines.join('\n')}\n`);
  let out = '';
  assert.equal(main(['--root', s.root, 'audit'], { out: (t) => { out += t; }, err: () => {} }), 0);
  assert.match(out, /## Rules and risks most sessions answered not-this at the gate \(narrow each to the symbols it is about; by each session's last answer, in 3 sessions or more; a session asked and giving no answer is not counted\)\n\n- `risk:src:[0-9a-f]{8}` \(not-this in 2 of the 3 sessions that answered it\): risk in group src: `alpha` and `beta` share one cache\n/u);
  assert.doesNotMatch(out, /rule:no-net` \(not-this/u, 'not-this in 1 of 3 sessions: not most');
  assert.doesNotMatch(out, /risk:elsewhere/u, 'an item of another map is not this map\'s');
});

test('audit counts each session by its last answer, and only from 3 sessions answered', () => {
  const s = session();
  // The shared-cache risk: answered not-this and then keeps in two sessions (last answer keeps), not-this in one.
  // The rule: not-this in both of only two sessions.
  const row = (counts, last) => ({ asked: 1, keeps: 0, 'not-this': 0, done: 0, unsure: 0, false: 0, ...counts, last });
  const lines = [
    { session: 'a', items: { [ID.both]: row({ 'not-this': 1, keeps: 1 }, 'keeps'), [ID.rule]: row({ 'not-this': 1 }, 'not-this') } },
    { session: 'b', items: { [ID.both]: row({ 'not-this': 1, keeps: 1 }, 'keeps'), [ID.rule]: row({ 'not-this': 1 }, 'not-this') } },
    { session: 'c', items: { [ID.both]: row({ 'not-this': 1 }, 'not-this') } },
  ].map((l) => JSON.stringify({ at: 1, ...l }));
  writeFileSync(join(tmpdir(), ACTED_LOG), `${lines.join('\n')}\n`);
  let out = '';
  assert.equal(main(['--root', s.root, 'audit'], { out: (t) => { out += t; }, err: () => {} }), 0);
  assert.doesNotMatch(out, /answered not-this at the gate/u, 'the risk: last answer not-this in 1 of 3; the rule: 2 of only 2 sessions');
});

test('a starting commit no longer under HEAD (a branch switch) compares no not-this, and says so', () => {
  const s = session();
  const git = (...a) => execFileSync('git', ['-C', s.root, ...a], { encoding: 'utf8' });
  git('checkout', '-q', '-b', 'work');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'on work');
  s.call('Edit', inBeta(s.root));
  s.answer([{ item: ID.both, answer: 'not-this', because: 'only beta', symbols: ['beta'] }, ...keeps(ID.prose, ID.rule)]);
  // Back to main: the session's start (on work) is not under it.
  git('checkout', '-q', 'main');
  leave(s.root, { alpha: true });
  const out = s.stop();
  const said = String(out?.reason ?? out?.systemMessage ?? '');
  assert.doesNotMatch(said, /does not bear out/u);
  assert.match(said, /1 not-this answer\(s\) were not compared with the change: this session started at [0-9a-f]{12}, which is not under the commit checked out now \(a branch switch or a rebase\)\./u);
});

const said = (out) => String(out?.reason ?? out?.systemMessage ?? '');
const notThisBeta = (s) => s.answer([{ item: ID.both, answer: 'not-this', because: 'this session changes beta only', symbols: ['beta'] }, ...keeps(ID.prose, ID.rule)]);
// A file git does not track, in the risk's files, that touches the shared-cache risk by `alpha`.
const ALPHA_TOO = 'export function alpha(z) {\n  return z;\n}\n';

test('a change already uncommitted when the session began is not the session\'s', () => {
  const s = session();
  // Before the session's first call: alpha changed, not committed.
  writeFileSync(join(s.root, 'src/a.js'), A.replace('  return x + one;', '  return x + one + 0;'));
  s.call('Edit', inBeta(s.root));
  notThisBeta(s);
  writeFileSync(join(s.root, 'src/a.js'), A.replace('  return x + one;', '  return x + one + 0;').replace('  return y * two;', '  return y * two * 1;'));
  assert.doesNotMatch(said(s.stop()), /does not bear out|were not compared/u, 'from the working tree at the start, the session touched beta only');
});

test('a file git did not track before the session is not counted whole, and the stop says it was not compared; one made in it counts whole', () => {
  const before = session();
  writeFileSync(join(before.root, 'src/b.js'), `${ALPHA_TOO}\nexport const note = 1;\n`);
  before.call('Edit', inBeta(before.root));
  notThisBeta(before);
  leave(before.root);
  // The session changes the untracked file too, away from alpha.
  before.call('Edit', { file_path: join(before.root, 'src/b.js'), old_string: 'note = 1', new_string: 'note = 2' });
  writeFileSync(join(before.root, 'src/b.js'), `${ALPHA_TOO}\nexport const note = 2;\n`);
  const out = said(before.stop());
  assert.doesNotMatch(out, /does not bear out/u, 'src/b.js was there before the session: its alpha is not the session\'s');
  assert.match(out, /`src\/b\.js` was not tracked by git when the session began; anything changed there since was not compared with its 1 not-this answer\(s\)\./u);
  const during = session();
  during.call('Edit', inBeta(during.root));
  notThisBeta(during);
  leave(during.root);
  // Made by a script after the session began: its time is after the session's first call.
  writeFileSync(join(during.root, 'src/b.js'), ALPHA_TOO);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(during.root, 'src/b.js'), later, later);
  assert.match(said(during.stop()), new RegExp(`\`${ID.both}\` was answered not-this \\(\`beta\`\\), but the change touches it by \`alpha\``, 'u'), 'src/b.js made in the session counts whole');
});

test('a file untracked at the start that the session then adds to git is not judged as new from its first line', () => {
  const s = session();
  writeFileSync(join(s.root, 'src/b.js'), `${ALPHA_TOO}\nexport const note = 1;\n`);
  s.call('Edit', inBeta(s.root));
  notThisBeta(s);
  leave(s.root);
  s.call('Edit', { file_path: join(s.root, 'src/b.js'), old_string: 'note = 1', new_string: 'note = 2' });
  writeFileSync(join(s.root, 'src/b.js'), `${ALPHA_TOO}\nexport const note = 2;\n`);
  // Added: `git diff <snapshot>` now shows all of it as added, alpha included.
  execFileSync('git', ['-C', s.root, 'add', 'src/b.js']);
  const out = said(s.stop());
  assert.doesNotMatch(out, /does not bear out/u, 'alpha in src/b.js was there before the session');
  assert.match(out, /`src\/b\.js` was not tracked by git when the session began; anything changed there since was not compared/u);
});

test('the first call leaves the index as it was: the snapshot is taken on a copy, and git status takes no optional lock', () => {
  const s = session();
  writeFileSync(join(s.root, 'src/a.js'), A.replace('  return x + one;', '  return x + one + 0;'));
  // An index older than the files: a refresh would rewrite it.
  const index = join(s.root, '.git/index');
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(index, past, past);
  const bytes = readFileSync(index);
  // Read back, not past.getTime(): the file system keeps it as a float that can differ in the last digit.
  const was = statSync(index).mtimeMs;
  s.call('Edit', inBeta(s.root));
  assert.equal(statSync(index).mtimeMs, was, 'the index was rewritten');
  assert.deepEqual(readFileSync(index), bytes);
  assert.equal(execFileSync('git', ['-C', s.root, 'stash', 'list'], { encoding: 'utf8' }), '', 'no stash entry');
});

test('a repository with no commit yet and files already added says why its start was not recorded', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-stop-answers-nocommit-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.readfirst'));
  writeFileSync(join(root, 'src/a.js'), A);
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: BOTH }, { text: PROSE }] }], rules: [{ id: 'no-net', rule: RULE, files: ['src/**'] }] }));
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '.']);
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-stop-answers-state-'));
  const id = `stop-answers-nocommit-${process.pid}`;
  let now = Date.now() + 5000;
  const call = (tool, input) => runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) });
  call('Edit', inBeta(root));
  const base = readFileSync(join(stateDir, readdirSync(stateDir).find((f) => f.endsWith('.lines'))), 'utf8').split('\n').find((l) => l.startsWith('["base:'));
  assert.match(base, /the repository had no commit yet and files were already added/u);
  assert.doesNotMatch(base, /stash create failed/u);
});

test('more untracked files at the start than readfirst records compares no not-this, and says how many', () => {
  const s = session();
  mkdirSync(join(s.root, 'scratch'));
  for (let i = 0; i <= 2000; i++) writeFileSync(join(s.root, 'scratch', `f${i}.txt`), '');
  s.call('Edit', inBeta(s.root));
  notThisBeta(s);
  leave(s.root, { alpha: true });
  const out = said(s.stop());
  assert.doesNotMatch(out, /does not bear out/u);
  assert.match(out, /1 not-this answer\(s\) were not compared with the change: the session started with 2001 untracked files, more than the 2000 readfirst records, so its starting point is only partly known\./u);
});

test('a diff git cannot give compares no not-this, and names git\'s error', () => {
  const s = session();
  s.call('Edit', inBeta(s.root));
  notThisBeta(s);
  leave(s.root, { alpha: true });
  // The snapshot of the start is gone (pruned by gc): `merge-base --is-ancestor` on the starting commit still works,
  // `diff` from the snapshot does not. (A broken .git/index fails the stop's `git status` before this, so it says nothing.)
  const file = readdirSync(s.stateDir).find((f) => f.endsWith('.lines'));
  const at = join(s.stateDir, file);
  writeFileSync(at, readFileSync(at, 'utf8').split('\n').map((l) => (l.startsWith('["base:') ? l.replace(/\\"[0-9a-f]{40}\\"/u, `\\"${'f'.repeat(40)}\\"`) : l)).join('\n'));
  const out = said(s.stop());
  assert.doesNotMatch(out, /does not bear out/u);
  assert.match(out, /1 not-this answer\(s\) were not compared with the change: the session's diff could not be read \(Error: /u);
});

test('a not-this not compared and a done not borne out are both said', () => {
  const s = session({ checks: [{ run: 'test -f ok.flag', why: 'the flag' }] });
  s.call('Edit', inBeta(s.root));
  s.answer([{ item: ID.both, answer: 'not-this', because: 'only beta', symbols: ['beta'] }, { item: ID.prose, answer: 'done', because: 'ran the check' }, ...keeps(ID.rule)]);
  leave(s.root, { alpha: true });
  const file = readdirSync(s.stateDir).find((f) => f.endsWith('.lines'));
  const at = join(s.stateDir, file);
  writeFileSync(at, readFileSync(at, 'utf8').split('\n').filter((l) => !l.startsWith('["head:')).join('\n'));
  const out = s.stop();
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, new RegExp(`\`${ID.prose}\` was answered done, but \`test -f ok\\.flag\` fail`, 'u'));
  assert.match(out.reason, /1 not-this answer\(s\) were not compared with the change: this session's starting commit was not recorded/u);
});
