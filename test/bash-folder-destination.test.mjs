// What lands in a folder destination (src/bash-writes.mjs: copies, the rsync and git mv branches). Until 2026-11-16 a
// cp, mv, install, rsync or git mv into a folder named the folder, not the file it writes there, so `cp a.js src/`
// over a file the map holds went through the gate unread while `cp a.js src/a.js` was refused. Each command runs
// through bash in a fresh folder; the files it makes, changes or takes away are what shellWrites must name. The
// helpers follow test/bash-moves.test.mjs, since importing a test file runs its tests.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';
import { itemId, runHook } from '../src/cli.mjs';

const hasTools = spawnSync('bash', ['-c', 'cp --version && install --version && git --version'], { env: { PATH: process.env.PATH }, stdio: 'ignore' }).status === 0;
const hasRsync = spawnSync('bash', ['-c', 'rsync --version'], { env: { PATH: process.env.PATH }, stdio: 'ignore' }).status === 0;
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
// A folder d holding a.txt, so a copy into d lands on a file there; each file holds its own name.
const setUp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-into-'));
  for (const f of ['a.txt', 'b.txt', 'd/a.txt', 'sub/f.txt']) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), `one ${f}\n`); }
  return dir;
};
const snap = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};
const bashChanged = (script, dir) => {
  const before = snap(dir);
  spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV }, stdio: 'ignore', timeout: 10000 });
  const after = snap(dir);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();
};
const named = (script, dir) => { const r = shellWrites(script, dir); return [...r.files.map((f) => relative(dir, f) || '.'), ...r.unknown.map((u) => `?${u.part}`)].sort(); };
// Named before bash runs, as the hook does. A folder named (a copied folder, `cp -r sub d`) stands for the files bash
// changes below it.
const agrees = (scripts, prepare = () => {}) => {
  for (const script of scripts) {
    const dir = setUp();
    prepare(dir);
    const want = named(script, dir);
    const made = want.filter((w) => !existsSync(join(dir, w)));
    const changed = [...new Set(bashChanged(script, dir).map((f) => (want.includes(f) ? f : made.find((w) => f.startsWith(`${w}/`)) ?? f)))].sort();
    assert.ok(changed.length > 0, `bash changes a file: ${script}`);
    assert.deepEqual(want, changed, script);
  }
};

test('cp, mv and install into a folder name the file that lands there, and bash agrees', { skip: !hasTools && 'bash, GNU cp, install or git is not installed' }, () => {
  agrees([
    'cp a.txt d', 'cp a.txt d/', 'cp b.txt d', 'mv a.txt d', 'mv b.txt d/', 'cp a.txt b.txt d', 'mv -t d a.txt b.txt', 'cp --target-directory=d b.txt',
    'install b.txt d/', 'cp -r sub d', 'cp -b a.txt d',
  ]);
  // The look-alikes: a destination that is no folder is the file written, and -T makes a folder's name the file.
  agrees(['cp a.txt n.txt', 'mv a.txt n.txt']);
  const dir = setUp();
  assert.deepEqual(named('cp -T a.txt d', dir), ['d'], '-T: d is the file, whatever is there');
  assert.deepEqual(named('cp --no-target a.txt d', dir), ['d'], 'a unique prefix of --no-target-directory');
  assert.deepEqual(named('install -d n1 n2', dir), ['n1', 'n2'], 'install -d makes each folder');
  assert.deepEqual(named('cp a.txt $D/', dir), ['?$D'], 'a folder not known: the write is not known');
  // rsync, named without running it (the test below runs it where rsync is installed): a source ending in / copies what
  // is in it, which is not looked up, so the folder is named.
  assert.deepEqual(named('rsync b.txt d/', dir), ['d/b.txt']);
  assert.deepEqual(named('rsync a.txt b.txt d', dir), ['d/a.txt', 'd/b.txt']);
  assert.deepEqual(named('rsync sub/ d', dir), ['d']);
  assert.deepEqual(named('rsync b.txt n.txt', dir), ['n.txt']);
});

test('git mv into a folder names the file that lands there, and bash agrees', { skip: !hasTools && 'bash, GNU cp, install or git is not installed' }, () => {
  const init = (dir) => {
    const git = (...a) => execFileSync('git', a, { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV }, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'one');
  };
  agrees(['git mv b.txt d', 'git mv b.txt sub/', 'git mv -- b.txt d'], init);
  agrees(['git mv b.txt n.txt'], init);
});

test('rsync into a folder names the file that lands there, and bash agrees', { skip: !hasRsync && 'rsync is not installed' }, () => {
  agrees(['rsync b.txt d/', 'rsync b.txt d', 'rsync a.txt b.txt d', 'rsync b.txt n.txt']);
});

// The gate end to end: a copy into the folder of a file the map holds, over that file, is refused until its items are
// answered, as a copy naming the file was.
test('hook --gate refuses a copy into a folder over a file the map holds', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-into-gate-'));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    'a.js': 'export const a = 2;\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: 'callers import a from here', files: ['src/a.js'] }], checks: [{ run: 'true', why: 'nothing' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-into-gate-state-'));
  let n = 0;
  const call = (command, session = `into-${process.pid}-${n++}`) => { const out = runHook(JSON.stringify({ session_id: session, cwd: root, tool_name: 'Bash', tool_input: { command } }), { stateDir, gate: true }); return out ? JSON.parse(out).hookSpecificOutput : null; };
  for (const command of ['cp a.js src/', 'cp a.js src', 'cp -t src a.js', 'mv a.js src/']) {
    const told = call(command);
    assert.equal(told?.permissionDecision, 'deny', command);
    assert.match(told.permissionDecisionReason, /callers import a from here/u, command);
  }
  const session = `into-${process.pid}-answered`;
  assert.equal(call('cp a.js src/', session)?.permissionDecision, 'deny');
  const id = itemId('risk', 'src', 'callers import a from here');
  assert.equal(call(`npx readfirst answer '${JSON.stringify([{ item: id, answer: 'done', because: 'a.js replaces it on purpose' }])}'`, session), null);
  assert.notEqual(call('cp a.js src/', session)?.permissionDecision, 'deny', 'answered: the same call goes through');
});
