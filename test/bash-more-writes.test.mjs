// Commands that write files the reader did not read until 2026-11-14 (src/bash-writes.mjs): touch, rm and unlink,
// sort -o, git apply and patch (the files their patch names: diffPaths), npm / pnpm / yarn (their lock file and
// package.json), and git commands that change tracked files the command does not name (merge, rebase, pull,
// cherry-pick, a stash, reset --hard, clean -f, a checkout or switch to another commit: gitMoves), which are not
// known, under the repository. Each command runs through bash in a fresh git repository on main (a.txt, d/x.txt,
// in.txt and fix.diff, a branch `other` that changes a.txt); the files it makes, changes or takes away are what
// shellWrites must name. The helpers are copied from test/here-docs.test.mjs, since importing a test file runs its tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';
import { runHook, runStopHook } from '../src/cli.mjs';

const hasGit = spawnSync('bash', ['-c', 'git --version && patch --version'], { env: { PATH: process.env.PATH }, stdio: 'ignore' }).status === 0;
// Who commits, and no signing, for git run here and by bash (a cherry-pick commits).
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const git = (dir, ...a) => spawnSync('git', a, { cwd: dir, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV } });
const setUp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-more-'));
  mkdirSync(join(dir, 'd'));
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'd/x.txt'), 'x\n');
  writeFileSync(join(dir, 'in.txt'), 'b\na\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  git(dir, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git(dir, 'commit', '-q', '-am', 'two');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'fix.diff'), '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+fixed\n');
  return dir;
};
const snap = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};
// The files bash makes, changes or takes away.
const bashChanged = (script, dir) => {
  const before = snap(dir);
  spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV }, stdio: 'ignore', timeout: 10000 });
  const after = snap(dir);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();
};
// The files shellWrites names, and `?part@folder` for each write it gives as not known under a folder.
const named = (script, dir) => { const r = shellWrites(script, dir); return [...r.files.map((f) => relative(dir, f) || '.'), ...r.unknown.map((u) => `?${u.part}@${u.prefix ? relative(dir, u.prefix) || '.' : ''}`)].sort(); };

test('touch, rm, sort -o, git apply and patch name the files they write, and bash agrees', { skip: !hasGit && 'bash, git or patch is not installed' }, () => {
  // Main (80931d8) named none of these.
  for (const script of [
    'touch new.txt', 'touch -r a.txt b.txt', 'rm a.txt', 'rm -f d/x.txt', 'unlink a.txt',
    'sort -o out.txt in.txt', 'sort --output=o2.txt in.txt',
    'git apply fix.diff', 'git apply -p1 fix.diff', 'git apply < fix.diff', 'patch -p1 < fix.diff', 'patch -p1 -i fix.diff',
  ]) {
    const dir = setUp();
    const changed = bashChanged(script, dir);
    assert.ok(changed.length > 0, `bash changes a file: ${script}`);
    assert.deepEqual(named(script, dir), changed, script);
  }
  // rm -r names the folder it takes away.
  const dir = setUp();
  assert.deepEqual(bashChanged('rm -rf d', dir), ['d/x.txt']);
  assert.deepEqual(named('rm -rf d', dir), ['d']);
});

test('git commands that change tracked files they do not name are not known, under the repository, and bash changes files there', { skip: !hasGit && 'bash, git or patch is not installed' }, () => {
  for (const [script, part] of [
    ['git checkout -q other', 'git checkout'], ['git switch -q other', 'git switch'], ['git merge -q other', 'git merge'],
    ['git cherry-pick other', 'git cherry-pick'], ['echo z >> a.txt && git stash && git stash pop', 'git stash'],
    ['patch < fix.diff', 'patch'],
  ]) {
    const dir = setUp();
    assert.ok(bashChanged(script, dir).length > 0, `bash changes a file: ${script}`);
    assert.ok(named(script, dir).includes(`?${part}@.`), `${script}: ${named(script, dir)}`);
  }
  // A stash, reset --hard and clean -f put the files back or take them away: what they change is not known.
  for (const [script, part] of [['git stash', 'git stash'], ['git reset -q --hard', 'git reset'], ['git clean -fq', 'git clean']]) {
    const dir = setUp();
    assert.deepEqual(named(script, dir), [`?${part}@.`], script);
  }
});

test('git and sort that only read or make a branch where HEAD is write nothing, and bash agrees', { skip: !hasGit && 'bash, git or patch is not installed' }, () => {
  for (const script of [
    'git checkout -q -b feat', 'git switch -q -c feat2', 'git stash list', 'git apply --check fix.diff', 'git apply --stat fix.diff',
    'sort in.txt', 'git reset -q', 'git clean -n', 'git log --oneline',
  ]) {
    const dir = setUp();
    assert.deepEqual(bashChanged(script, dir), [], `bash changes nothing: ${script}`);
    assert.deepEqual(named(script, dir), [], script);
  }
});

// No registry here to run them against: what npm, pnpm and yarn write by what they are told to do. Installing is not
// known, with what it writes, under its folder, and marked `moves` (shown, not refused); npm version and npm pkg set
// name package.json.
test('npm, pnpm and yarn installs are not known, with what they write; npm version and pkg set name package.json', () => {
  const s = (c) => { const r = shellWrites(c, '/r'); return [...r.files, ...r.unknown.map((u) => `?${u.part}@${u.prefix}${u.moves ? ' moves' : ''}: ${u.why}`)]; };
  assert.deepEqual(s('npm install'), ['?npm install@/r/ moves: npm install writes package-lock.json and node_modules, as the packages it installs make it']);
  assert.deepEqual(s('npm i lodash'), ['?npm i@/r/ moves: npm i writes package-lock.json, package.json and node_modules, as the packages it installs make it']);
  assert.match(s('npm uninstall lodash')[0], /package-lock\.json, package\.json/u);
  assert.match(s('npm --prefix web install')[0], /^\?npm install@\/r\/web\/ moves/u);
  assert.match(s('npm -w pkg install x')[0], /^\?npm install@\/r\/ moves: npm install writes package-lock\.json, package\.json/u, 'the value of -w is no subcommand');
  assert.match(s('pnpm add x')[0], /pnpm-lock\.yaml, package\.json/u);
  assert.match(s('pnpm -C app install')[0], /^\?pnpm install@\/r\/app\/ moves/u);
  assert.match(s('yarn')[0], /^\?yarn@\/r\/ moves: yarn writes yarn\.lock and node_modules/u);
  assert.match(s('yarn add x --cwd w')[0], /^\?yarn add@\/r\/w\/ moves/u);
  assert.match(s('npm ci')[0], /^\?npm ci@\/r\/ moves: npm ci writes node_modules,/u);
  assert.deepEqual(s('npm version patch'), ['/r/package.json', '/r/package-lock.json']);
  assert.deepEqual(s('npm pkg set scripts.x=y'), ['/r/package.json']);
  assert.deepEqual(s('npm pkg get name'), []);
  assert.deepEqual(s('npm test'), []);
  assert.deepEqual(s('npm run build'), []);
});

// Review of e0a8185: a rename-only patch (no ---/+++), git rm and git mv, and patch -o were missed in silence.
test('a rename-only patch, git rm, git mv and patch -o name their files, and bash agrees', { skip: !hasGit && 'bash, git or patch is not installed' }, () => {
  const MV = 'diff --git a/a.txt b/moved.txt\nsimilarity index 100%\nrename from a.txt\nrename to moved.txt\n';
  for (const script of ['git apply mv.diff', 'git rm -q a.txt', 'git mv a.txt m.txt', 'patch -o out2 a.txt < fix.diff']) {
    const d = setUp();
    writeFileSync(join(d, 'mv.diff'), MV);
    const changed = bashChanged(script, d);
    assert.ok(changed.length > 0, `bash changes a file: ${script}`);
    assert.deepEqual(named(script, d), changed, script);
  }
  assert.deepEqual(named('git rm -q --cached a.txt', setUp()), [], 'the index only');
});

// The hook with --gate: a move between commits is shown, not refused (review of e0a8185: `git checkout -q main` and
// `git pull` were refused once each, naming no file to read); a write readfirst cannot place is still refused.
test('hook --gate shows a move between commits without refusing it, and still refuses a write it cannot place', { skip: !hasGit && 'bash, git or patch is not installed' }, () => {
  const root = setUp();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-more-state-'));
  const hook = (command, session) => { const out = runHook(JSON.stringify({ session_id: session, cwd: root, tool_name: 'Bash', tool_input: { command } }), { stateDir, gate: true }); return out ? JSON.parse(out).hookSpecificOutput : null; };
  for (const command of ['git checkout -q other', 'git pull -q', 'git stash', 'git merge -q other', 'npm install']) {
    const told = hook(command, `more-${process.pid}-${command}`);
    assert.equal(told?.permissionDecision, undefined, command);
    assert.match(told.additionalContext, /changes files readfirst cannot name before it runs/u, command);
  }
  const refused = hook('git clean -fq', `more-${process.pid}-clean`);
  assert.equal(refused.permissionDecision, 'deny', 'clean takes away files where they are: refused once');
});

test('a patch read from a pipe is not known, and one that makes or removes a file names it', () => {
  const s = (c) => { const r = shellWrites(c, '/r'); return [...r.files, ...r.unknown.map((u) => `?${u.part}`)]; };
  assert.deepEqual(s('git diff | git apply'), ['?git apply']);
  assert.deepEqual(s('git apply /nonexistent/x.diff'), ['?git apply'], 'a patch that is not there is not read');
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-more-diff-'));
  writeFileSync(join(dir, 'p.diff'), '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+n\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-o\n');
  assert.deepEqual(shellWrites('git apply p.diff', dir).files, [join(dir, 'new.txt'), join(dir, 'old.txt')]);
  assert.deepEqual(shellWrites('git apply --directory=sub p.diff', dir).files, [join(dir, 'sub/new.txt'), join(dir, 'sub/old.txt')]);
  assert.deepEqual(shellWrites('patch -p0 < p.diff', dir).files, [join(dir, 'b/new.txt'), join(dir, 'a/old.txt')]);
});

// A repository whose src/ check always fails, on main's map from before the session, and a branch `other` that changes
// src/a.js. What a move between commits brings is committed code: the Stop hook does not take it for this session's
// edit (its checks are the commit's), an edit on top of it is asked about, and what a move leaves changed in the
// working tree (a stash pop) is checked at the stop (review of readfirst#225).
const mapped = () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-more-moved-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.readfirst'));
  writeFileSync(join(root, 'src/a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: 'a moves with b' }], checks: [{ run: 'false', why: 'fails' }] }] }));
  const past = new Date(Date.now() - 120_000).toISOString();
  const at = (...a) => spawnSync('git', a, { cwd: root, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: root, ...GIT_ENV, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past } });
  at('init', '-q', '-b', 'main');
  at('add', '.');
  at('commit', '-q', '-m', 'one');
  at('checkout', '-q', '-b', 'other');
  writeFileSync(join(root, 'src/a.js'), 'export const a = 2;\n');
  at('commit', '-q', '-am', 'two');
  at('checkout', '-q', 'main');
  return root;
};

test('after a move between commits the Stop hook does not check what it brought, an edit on top is asked about, and a stash pop is checked', { skip: !hasGit && 'bash, git or patch is not installed' }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-more-state-'));
  const run = (root, command) => spawnSync('bash', ['-c', command], { cwd: root, env: { PATH: process.env.PATH, HOME: root, ...GIT_ENV }, stdio: 'ignore' });
  const hook = (root, id, tool, input) => { const out = runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true }); return out ? JSON.parse(out).hookSpecificOutput : null; };
  const stop = (root, id) => runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 });
  for (const command of ['git checkout -q other', 'git merge -q other', 'git reset -q --hard other']) {
    const root = mapped();
    const id = `more-moved-${process.pid}-${command}`;
    const told = hook(root, id, 'Bash', { command });
    assert.equal(told?.permissionDecision, undefined, command);
    assert.match(told.additionalContext, /not this session's edit/u, command);
    run(root, command);
    assert.equal(readFileSync(join(root, 'src/a.js'), 'utf8'), 'export const a = 2;\n', `${command}: bash brought the change`);
    assert.equal(stop(root, id), null, `${command}: what the move brought is not checked`);
    const edit = hook(root, id, 'Edit', { file_path: join(root, 'src/a.js'), old_string: '2', new_string: '3' });
    assert.equal(edit?.permissionDecision, 'deny', `${command}: an edit on top is asked about`);
    assert.match(edit.permissionDecisionReason, /a moves with b/u, `${command}: with the notes of src/a.js`);
  }
  const root = mapped();
  writeFileSync(join(root, 'src/a.js'), 'export const a = 4;\n');
  run(root, 'git stash -q');
  const id = `more-moved-${process.pid}-pop`;
  assert.equal(hook(root, id, 'Bash', { command: 'git stash pop -q' })?.permissionDecision, undefined, 'stash pop: shown, not refused');
  run(root, 'git stash pop -q');
  assert.match(String(stop(root, id)), /`false`/u, 'stash pop leaves src/a.js changed: its check is asked for');
});

// patch -d DIR (--directory) moves into DIR before anything else: the file it is given, -o, -i and the names in the
// patch are all under DIR, and a patch on stdin is opened by the shell where the command runs. Until 2026-11-15 -d was
// left out: `patch -d sub -p1 < fix.diff` named a.txt, where patch changed sub/a.txt, and `--directory sub` named sub.
test('patch -d DIR names the files under DIR, and bash agrees', { skip: !hasGit && 'bash, git or patch is not installed' }, () => {
  const p0 = '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-one\n+fixed\n';
  for (const [script, want] of [
    ['patch -s -d sub -p1 < fix.diff', ['sub/a.txt']],
    ['patch -s --directory=sub -p1 < fix.diff', ['sub/a.txt']],
    ['patch -s --directory sub -p1 < fix.diff', ['sub/a.txt']],
    ['patch -s -dsub -p1 < fix.diff', ['sub/a.txt']],
    ['patch -s -p1 -d sub < fix.diff', ['sub/a.txt']],
    ['patch -s -d sub -p1 -i in.diff', ['sub/a.txt']],
    ['patch -s -d sub -p1 -i ../fix.diff', ['sub/a.txt']],
    ['patch -s -d sub b.txt < fix0.diff', ['sub/b.txt']],
    ['patch -s -d sub -o out.txt a.txt < fix0.diff', ['sub/out.txt']],
    ['patch -s -d sub -p0 < fix0.diff', ['sub/a.txt']],
    ['patch -s --strip 1 -d sub < fix.diff', ['sub/a.txt']],
    // Each -d moves on from the one before (review of #236: only the last was taken).
    ['patch -s -d sub -d b -p0 < fix0.diff', ['sub/b/a.txt']],
    ['patch -s -d sub -d sub -p0 < fix0.diff', ['sub/sub/a.txt']],
    ['patch -s -d d -d ../sub -p0 < fix0.diff', ['sub/a.txt']],
    ['patch -s --directory=sub -d b -o o.txt a.txt < fix0.diff', ['sub/b/o.txt']],
  ]) {
    const dir = setUp();
    for (const f of ['sub/b', 'sub/sub']) mkdirSync(join(dir, f), { recursive: true });
    for (const f of ['sub/a.txt', 'sub/b.txt', 'sub/b/a.txt', 'sub/sub/a.txt']) writeFileSync(join(dir, f), 'one\n');
    writeFileSync(join(dir, 'sub/in.diff'), readFileSync(join(dir, 'fix.diff'), 'utf8'));
    writeFileSync(join(dir, 'fix0.diff'), p0);
    assert.deepEqual(named(script, dir), want, script);
    assert.deepEqual(bashChanged(script, dir).filter((f) => !/\.orig$/u.test(f)), want, `bash: ${script}`);
  }
  // A folder known only when the command runs: nothing is named, and the write is not known.
  const unplaced = named('patch -d $D -p1 < fix.diff', setUp());
  assert.ok(unplaced.length > 0 && unplaced.every((w) => w.startsWith('?')), unplaced.join(', '));
});

// A change-folder option whose value begins with a part known only when the command runs (`patch -d $X`, `git -C
// $X`) may be absolute: from there on the folder is under nothing known, and a `..` after it does not take the part
// away (review of #236: `-d sub -d $X` was placed under sub/, and `patch -d $X ../a.txt` named ./a.txt, as `git -C $X
// checkout -- ../f` named ./f on main).
test('a change-folder option known only when the command runs puts its writes under nothing known', () => {
  for (const [command, want] of [
    ['patch -d sub -d $X a.txt < fix0.diff', ['?$X/a.txt@']],
    ['patch -d $X -d sub a.txt < fix0.diff', ['?$X/sub/a.txt@']],
    ['patch -d $X ../a.txt < fix0.diff', ['?$X/../a.txt@']],
    ['patch -d sub/$X a.txt < fix0.diff', ['?sub/$X/a.txt@sub']],
    ['git -C a -C $X checkout -- f', ['?$X/f@']],
    ['git -C $X checkout -- ../f', ['?$X/../f@']],
    ['git -C $X -C .. checkout -- f', ['?$X/../f@']],
    ['git -C /w -C b checkout -- f', ['/w/b/f']],
    ['git -C a checkout -- f', ['a/f']],
  ]) {
    const dir = setUp();
    const r = shellWrites(command, dir);
    const got = [...r.files.map((f) => (f.startsWith(dir) ? relative(dir, f) : f)), ...r.unknown.map((u) => `?${u.word}@${u.prefix ? relative(dir, u.prefix) : ''}`)];
    assert.deepEqual(got, want, command);
  }
});

// A `..` after a part known only when the command runs climbs from the folder known before it, as the part may be
// empty: `sub/$X/../f` may be ./f. Until 2026-11-15 it was under sub/ (`within`), `patch -d sub/$X/.. a.txt` and `git -C
// sub/$X/.. checkout -- f` named sub/a.txt and sub/f as sure, and `$(mktemp -d)/../f` was a new name (review of #236).
test('a `..` after a part known only when the command runs climbs from what is known before it', () => {
  const dir = setUp();
  const at = (v) => (v ?? '').replace(dir, '<d>');
  for (const [command, want] of [
    ['echo x > sub/$X/../f', [['sub/$X/../f', '<d>/']]],
    ['echo x > /r/zz-$X/../f', [['/r/zz-$X/../f', '/']]],
    ['echo x > /r/s/$X/../../f', [['/r/s/$X/../../f', '/']]],
    ['echo x > $(mktemp -d -p /w)/../f', [['$(mktemp -d -p /w)/../f', '/w/']]],
    ['patch -d sub/$X/.. a.txt < fix.diff', [['sub/$X/../a.txt', '<d>/']]],
    ['git -C sub/$X/.. checkout -- f', [['sub/$X/../f', '<d>/']]],
    // No `..`: as before.
    ['echo x > sub/$X/f', [['sub/$X/f', '<d>/sub/']]],
    ['echo x > $(mktemp -d -p /w)/f', [['$(mktemp -d -p /w)/f', '/w/', 'fresh']]],
  ]) {
    const r = shellWrites(command, dir);
    assert.deepEqual(r.files, [], `${command}: nothing named`);
    assert.deepEqual(r.unknown.map((u) => [u.word, at(u.prefix), ...(u.fresh ? ['fresh'] : [])]), want, command);
  }
});
