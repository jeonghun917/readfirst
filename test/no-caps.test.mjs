// 0.27.1: nothing readfirst finds is cut to look shorter, and no check is skipped without a word (the owner's rule,
// 2026-11-09). Each case was reproduced on 0.27.0 first: a cap that dropped files, lines, tests, users or comment text,
// or a Stop hook that let a turn end with checks that never ran.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main, runHook, runStopHook } from '../src/cli.mjs';
import { MARKER, commentBody, runAction } from '../src/action.mjs';
import { MAP_FORMAT } from '../src/map.mjs';
import { importEdges } from '../src/imports.mjs';
import { viewData } from '../src/view.mjs';

const OLD = '2020-01-01T00:00:00Z';
function repo(files, { branch = 'main' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-caps-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (args, when = OLD) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
  git(['init', '-q', '-b', branch]);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return { root, git };
}
const run = (root, ...argv) => {
  let out = '';
  let err = '';
  let code;
  try { code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: (s) => { err += s; } }); } catch (e) { code = 2; err += e.message; }
  return { code, out, err };
};
const MAP = (group, more = {}) => JSON.stringify({ format: MAP_FORMAT, groups: [{ id: 'src', title: 'src', files: ['src/**', 'test/**', '.readfirst/**', 'gen.mjs'], ...group }], ...more });
const range = (n) => [...Array(n).keys()];
const context = (out) => JSON.parse(out).hookSpecificOutput;
const state = () => mkdtempSync(join(tmpdir(), 'readfirst-caps-state-'));

test('hook: a Bash command writing 12 files gets the notes of all 12, and the Stop hook checks all 12', () => {
  const files = Object.fromEntries(range(12).map((i) => [`src/f${i}.js`, 'a\n']));
  const risks = range(12).map((i) => ({ text: `risk only about f${i}`, files: [`src/f${i}.js`] }));
  const { root } = repo({ ...files, '.readfirst/map.json': MAP({ risks, checks: [{ run: 'node -e "process.exit(0)"', why: 'passes' }] }) });
  const stateDir = state();
  const command = `sed -i 's/a/b/' ${range(12).map((i) => `src/f${i}.js`).join(' ')}`;
  const out = runHook(JSON.stringify({ session_id: 'c1', cwd: root, tool_name: 'Bash', tool_input: { command } }), { stateDir, now: Date.now() - 5000 });
  const said = context(out).additionalContext;
  for (const i of range(12)) assert.match(said, new RegExp(`risk only about f${i}\\b`, 'u'), `notes for src/f${i}.js`);
  for (const i of range(12)) writeFileSync(join(root, `src/f${i}.js`), 'b\n');
  const stop = JSON.parse(runStopHook(JSON.stringify({ session_id: 'c1', cwd: root }), { stateDir, timeout: 30 }));
  assert.match(stop.systemMessage, /1 check\(s\) passed for 12 edited file\(s\)/u);
});

test('hook: every note line is given, in order, with no "N more" pointer', () => {
  const risks = range(15).map((i) => ({ text: `risk number ${i}`, files: ['src/a.js'] }));
  const { root } = repo({ 'src/a.js': 'x\n', '.readfirst/map.json': MAP({ risks, checks: [{ run: 'npm test', why: 'the tests' }] }) });
  const said = context(runHook(JSON.stringify({ session_id: 'c2', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), { stateDir: state() })).additionalContext;
  for (const i of range(15)) assert.match(said, new RegExp(`Risk: risk number ${i}$`, 'mu'));
  assert.doesNotMatch(said, /more in `npx readfirst read/u);
  // What to do comes before what to know.
  assert.ok(said.indexOf('Check to run after the change: npm test') < said.indexOf('Risk: risk number 0'), said);
});

test('read: every test and user is listed unless --limit is given, and a cut list says how many it left out', () => {
  const tests = Object.fromEntries(range(35).map((i) => [`test/t${i}.test.js`, "import '../src/a.js';\n"]));
  const { root } = repo({ 'src/a.js': 'export const a = 1;\n', ...tests, '.readfirst/map.json': MAP({}) });
  const list = JSON.parse(run(root, 'read', 'src/a.js', '--json').out);
  assert.equal(list.tests.length, 35);
  assert.deepEqual(list.truncated, { tests: 0, usedBy: 0 });
  const cut = JSON.parse(run(root, 'read', 'src/a.js', '--json', '--limit', '5').out);
  assert.equal(cut.tests.length, 5);
  assert.equal(cut.truncated.tests, 30);
  assert.match(run(root, 'read', 'src/a.js', '--limit', '5').out, /…and 30 more/u);
});

test('a deleted file names every file that still imports it', () => {
  const users = Object.fromEntries(range(7).map((i) => [`src/b${i}.js`, "import { u } from './lib/util.js';\n"]));
  const { root, git } = repo({ 'src/lib/util.js': 'export const u = 1;\n', ...users, '.readfirst/map.json': MAP({}) });
  git(['checkout', '-q', '-b', 'work']);
  git(['rm', '-q', 'src/lib/util.js']);
  git(['commit', '-q', '-m', 'rm']);
  const why = JSON.parse(run(root, 'diff', '--base', 'main', '--json').out).notCovered[0].why;
  for (const i of range(7)) assert.match(why, new RegExp(`src/b${i}\\.js`, 'u'));
  assert.doesNotMatch(why, /more/u);
});

test('view: a file used by more than five files counts all of them', () => {
  const files = ['src/a.js', ...range(8).map((i) => `src/u${i}.js`)];
  const text = (f) => (f === 'src/a.js' ? 'export const a = 1;\n' : "import { a } from './a.js';\n");
  const map = { format: MAP_FORMAT, groups: [{ id: 'src', title: 'src', files: ['src/**'] }] };
  const data = viewData({ map, files, imports: importEdges(files, text) });
  const row = data.groups ? JSON.stringify(data) : '';
  assert.match(row, /"users":8\b/u, 'eight direct users');
});

test('PR comment: problems, fixes and placed files are listed whole', () => {
  const problems = range(25).map((i) => `problem ${i}`);
  const fixes = range(12).map((i) => `groups.src: added fix${i}.js`);
  const body = commentBody({ list: null, problems, removed: [], commit: null, fixes });
  for (const p of problems) assert.ok(body.includes(`- ${p}\n`), p);
  for (const f of fixes) assert.ok(body.includes(`- ${f}\n`), f);
  assert.doesNotMatch(body, /…and \d+ more/u);
  const settled = range(25).map((i) => `groups.src: added new${i}.js`);
  const placed = commentBody({ list: null, problems: [], removed: [], commit: null, settled });
  for (const s of settled) assert.ok(placed.includes(`- ${s}\n`), s);
});

test('PR comment: a read list over one comment\'s size goes on in a second comment, never cut, each updated in place', async () => {
  const risks = range(40).map((i) => ({ text: `R${i}: ${'long words about this one file '.repeat(60)}`, files: ['src/a.js'] }));
  const { root } = repo({ 'src/a.js': 'x\n', '.readfirst/map.json': MAP({ risks }) });
  const event = join(root, '..', `${root.split('/').pop()}-event.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567' } } }));
  let comments = [];
  let nextId = 1;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
    calls.push(`${init.method} ${u.pathname}`);
    if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? [{ filename: 'src/a.js', status: 'modified' }] : []);
    if (init.method === 'GET' && u.pathname.endsWith('/issues/7/comments')) return json(u.searchParams.get('page') === '1' ? comments : []);
    const body = JSON.parse(init.body).body;
    if (init.method === 'POST') { const c = { id: nextId++, body, user: { type: 'Bot' } }; comments.push(c); return json(c, 201); }
    if (init.method === 'PATCH') { const id = Number(u.pathname.split('/').pop()); comments.find((c) => c.id === id).body = body; return json({ id }); }
    return json({}, 404);
  };
  const env = { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't', GITHUB_API_URL: 'https://api.example' };
  await runAction({ env, fetchImpl, log: () => {} });
  assert.equal(comments.length, 2, 'two comments');
  assert.ok(comments[0].body.startsWith(MARKER));
  assert.ok(comments.every((c) => c.body.length <= 65536), 'each under GitHub\'s limit');
  const all = comments.map((c) => c.body).join('\n');
  for (const i of range(40)) assert.equal(all.split(`R${i}: `).length - 1, 1, `risk R${i} once, whole`);
  assert.doesNotMatch(all, /cut here/u);
  // The next push edits both in place.
  calls.length = 0;
  await runAction({ env, fetchImpl, log: () => {} });
  assert.equal(comments.length, 2);
  assert.equal(calls.filter((c) => c.startsWith('POST')).length, 0, 'no new comment on a push');
  // A shorter list: the second comment is emptied with a line saying so, not left stale.
  writeFileSync(join(root, '.readfirst/map.json'), MAP({ risks: risks.slice(0, 2) }));
  await runAction({ env, fetchImpl, log: () => {} });
  assert.equal(comments.length, 2);
  assert.doesNotMatch(comments[1].body, /R39: /u);
  assert.match(comments[1].body, /fits in the first comment/u);
});

test('Stop hook: checks that did not run block the stop once and say to run readfirst verify', () => {
  const { root, git } = repo({ 'src/a.js': 'x\n', '.readfirst/map.json': MAP({ checks: [] }) });
  git(['checkout', '-q', '-b', 'pr']);
  // The branch adds a check the base branch's map does not have: it is never run by the hook.
  writeFileSync(join(root, '.readfirst/map.json'), MAP({ checks: [{ run: 'node -e "process.exit(0)"', why: 'new' }] }));
  const stateDir = state();
  runHook(JSON.stringify({ session_id: 's7', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), { stateDir, now: Date.now() - 5000 });
  writeFileSync(join(root, 'src/a.js'), 'y\n');
  const stop = (over = {}) => runStopHook(JSON.stringify({ session_id: 's7', cwd: root, ...over }), { stateDir, timeout: 30 });
  const first = JSON.parse(stop());
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /not run/iu);
  assert.match(first.reason, /npx readfirst verify/u);
  assert.equal(stop({ stop_hook_active: true }), null, 'the second stop of the turn lets go');
  // Same tree, later turn: said, not blocked again.
  const again = JSON.parse(stop());
  assert.equal(again.decision, undefined);
  assert.match(again.systemMessage, /Not run/u);
  // The tree changed: the checks have not run on it either.
  writeFileSync(join(root, 'src/a.js'), 'z\n');
  assert.equal(JSON.parse(stop()).decision, 'block');
});

test('Stop hook: a file a script changed during the session is checked, even if no tool named it', () => {
  const { root } = repo({ 'src/a.js': 'x\n', 'src/b.js': 'fine\n', 'gen.mjs': '', '.readfirst/map.json': MAP({ checks: [{ run: 'node -e "process.exit(require(\'fs\').readFileSync(\'src/b.js\',\'utf8\').includes(\'bad\')?1:0)"', why: 'b is fine' }] }) });
  const stateDir = state();
  // Only a Bash call readfirst cannot read the writes of: the session still starts here.
  assert.equal(runHook(JSON.stringify({ session_id: 's8', cwd: root, tool_name: 'Bash', tool_input: { command: 'node gen.mjs' } }), { stateDir, now: Date.now() - 5000 }), null);
  writeFileSync(join(root, 'src/b.js'), 'bad\n');
  const out = JSON.parse(runStopHook(JSON.stringify({ session_id: 's8', cwd: root }), { stateDir, timeout: 30 }));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /src\/b\.js/u);
});

test('hook: files it had no time for are named, checked at the stop, and looked up on the next call', () => {
  const { root } = repo({ 'src/a.js': 'x\n', 'src/b.js': 'x\n', '.readfirst/map.json': MAP({ risks: [{ text: 'about a', files: ['src/a.js'] }, { text: 'about b', files: ['src/b.js'] }], checks: [{ run: 'node -e "process.exit(0)"', why: 'passes' }] }) });
  const stateDir = state();
  const call = (opts) => runHook(JSON.stringify({ session_id: 's9', cwd: root, tool_name: 'Bash', tool_input: { command: "sed -i 's/x/y/' src/a.js src/b.js" } }), { stateDir, now: Date.now() - 5000, ...opts });
  const late = context(call({ budget: 0 })).additionalContext;
  assert.match(late, /src\/a\.js/u);
  assert.match(late, /src\/b\.js/u);
  assert.match(late, /no time/u);
  writeFileSync(join(root, 'src/a.js'), 'y\n');
  writeFileSync(join(root, 'src/b.js'), 'y\n');
  assert.match(JSON.parse(runStopHook(JSON.stringify({ session_id: 's9', cwd: root }), { stateDir, timeout: 30 })).systemMessage, /for 2 edited file\(s\)/u);
  const next = context(call({})).additionalContext;
  assert.match(next, /about a/u);
  assert.match(next, /about b/u);
  // gate: a call with files it had no time for is refused, so it is made again and they are looked up.
  const gated = JSON.parse(runHook(JSON.stringify({ session_id: 's10', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), { stateDir, gate: true, budget: 0 }));
  assert.equal(gated.hookSpecificOutput.permissionDecision, 'deny');
});

test('hook: the import graph it keeps between calls follows edits, new files and commits', () => {
  const { root, git } = repo({ 'src/a.js': 'export const a = 1;\n', 'test/t1.test.js': "import '../src/a.js';\n", '.readfirst/map.json': MAP({}) });
  const stateDir = state();
  let n = 0;
  const tests = () => {
    const out = runHook(JSON.stringify({ session_id: `g${n++}`, cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), { stateDir });
    return out ? (context(out).additionalContext.match(/Tests that reach this file: (.*)/u)?.[1] ?? '') : '';
  };
  assert.equal(tests(), 'test/t1.test.js');
  writeFileSync(join(root, 'test/t1.test.js'), '// no import any more\n');
  assert.equal(tests(), '', 'an edited file is read again');
  writeFileSync(join(root, 'test/t2.test.js'), "import '../src/a.js';\n");
  assert.equal(tests(), 'test/t2.test.js', 'a new file is read');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'tests'], new Date().toISOString());
  writeFileSync(join(root, 'test/t1.test.js'), "import '../src/a.js';\n");
  assert.equal(tests(), 'test/t1.test.js, test/t2.test.js', 'after a commit');
});
