// A stop that cannot check a repository says so (the bug ledger: broken-index-silences-stop, 2026-11-14). stopFor runs
// `git status` first; with a broken .git/index git fails there, and the catch returned null: no checks ran, no answer
// was compared, and the stop said nothing at all, as if there were nothing to check. Now it names the repository and
// git's error, refuses the stop once for that kind of error, and the session's line and `hook --report` count it.
// The same for a marked file whose repository git no longer finds, and a base branch whose ref cannot be read.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ACTED_LOG, hookReport, runHook, runStopHook } from '../src/cli.mjs';

let n = 0;
// A repository with a map and a check, one Edit through the hook, the file then changed. initArgs go to `git init`.
function edited(initArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-unchecked-'));
  const files = {
    'src/a.js': 'export function alpha(x) {\n  return x + 1;\n}\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], checks: [{ run: 'true', why: 'always' }], risks: [{ text: '`alpha` is old' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main', ...initArgs);
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-unchecked-state-'));
  const id = `unchecked-${process.pid}-${++n}`;
  runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js'), old_string: 'x + 1', new_string: 'x + 2' } }), { stateDir, now: Date.now() + 5000 });
  writeFileSync(join(root, 'src/a.js'), 'export function alpha(x) {\n  return x + 2;\n}\n');
  const stop = () => { const out = runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 }); return out ? JSON.parse(out) : null; };
  const line = () => readFileSync(join(stateDir, ACTED_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.session === id).at(-1);
  return { root, stateDir, git, stop, line };
}

test('a broken index makes the stop say it could not check the repository, refused once, counted in the report', () => {
  const s = edited();
  writeFileSync(join(s.root, '.git/index'), 'garbage');
  const first = s.stop();
  assert.equal(first?.decision, 'block', `the stop said nothing: ${JSON.stringify(first)}`);
  assert.match(first.reason, /readfirst: the stop could not check this repository \(Error: .*index.*\), so the checks the map lists for the files you edited did not run and no answer was compared with the change\./u);
  assert.match(first.reason, /the stop could not check 1 repository\(ies\), so their checks did not run\./u);
  const again = s.stop();
  assert.notEqual(again?.decision, 'block', 'refused once for the same kind of error, so a stop cannot loop');
  assert.match(String(again?.systemMessage ?? ''), /the stop could not check this repository/u, 'still said');
  assert.equal(s.line().unchecked, 1);
  assert.match(hookReport({ stateDir: s.stateDir }), /- repositories the stop could not check \(its checks did not run\): [1-9]\d*, in [1-9]\d* session\(s\)/u);
});

test('a marked file whose repository git no longer finds (its .git points at a gitdir that is gone) is named, refused once', () => {
  const gitdir = mkdtempSync(join(tmpdir(), 'readfirst-unchecked-gitdir-'));
  const s = edited([`--separate-git-dir=${join(gitdir, 'g')}`]);
  rmSync(join(gitdir, 'g'), { recursive: true, force: true });
  const first = s.stop();
  assert.equal(first?.decision, 'block', `the stop said nothing: ${JSON.stringify(first)}`);
  assert.match(first.reason, /readfirst: the stop could not check `[^`]*src\/a\.js`: git finds no repository holding it now \(Error: .*\), so the checks the map lists for it did not run/u);
  const again = s.stop();
  assert.notEqual(again?.decision, 'block', 'refused once');
  assert.match(String(again?.systemMessage ?? ''), /the stop could not check `[^`]*src\/a\.js`/u);
  assert.ok(s.line().unchecked >= 1);
});

// A cut or damaged index: git 2.43 reads it without a word, and the stop's `git status` exits 0 with a wrong list
// (files deleted, a folder untracked). The index's own hash at its end tells it.
const STATUS = ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'];
for (const [what, damage] of [['cut to 38%', (b) => b.subarray(0, Math.floor(b.length * 0.38))], ['cut to 63%', (b) => b.subarray(0, Math.floor(b.length * 0.63))], ['one byte flipped', (b) => { const c = Buffer.from(b); c[40] ^= 0xff; return c; }]]) {
  test(`an index ${what} is a stop that could not check, though git status exits 0`, () => {
    const s = edited();
    writeFileSync(join(s.root, 'src/b.js'), 'export const b = 1;\n');
    s.git('add', 'src/b.js');
    s.git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b');
    const index = join(s.root, '.git/index');
    writeFileSync(index, damage(readFileSync(index)));
    // Without GIT_OPTIONAL_LOCKS=0 this git status writes the index back, refreshed, and the damage is gone.
    const r = spawnSync('git', ['-C', s.root, ...STATUS], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    assert.equal(r.status, 0, 'git itself says nothing is wrong (else this tests the other path)');
    const out = s.stop();
    const said = String(out?.reason ?? out?.systemMessage ?? '');
    assert.doesNotMatch(said, /check\(s\) passed/u);
    assert.equal(out?.decision, 'block');
    // readfirst's own sentence, whole (it was cut at 160 characters, mid-sentence).
    assert.match(said, /the stop could not check this repository \(Error: the index file \(\.git\/index\) does not match the hash at its end: it is cut or damaged, and git reads it without saying so, so its answers about this repository cannot be trusted\)/u);
  });
}

test('a git that exits 0 but says error: on stderr is a stop that could not check, with that line', () => {
  const s = edited();
  // The real git, run by a git found first on PATH that adds the line a cut index gave (review of readfirst#207)
  // to `git status`, its exit code kept.
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(join(tmpdir(), 'readfirst-unchecked-bin-'));
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n"${real}" "$@"\nrc=$?\ncase " $* " in *" status "*) echo "error: cache entry has null sha1: src/b.js" >&2 ;; esac\nexit $rc\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  let out;
  try { out = s.stop(); } finally { process.env.PATH = path; }
  const said = String(out?.reason ?? out?.systemMessage ?? '');
  assert.doesNotMatch(said, /check\(s\) passed/u);
  assert.equal(out?.decision, 'block');
  assert.ok(said.includes('error: cache entry has null sha1: src/b.js'), said);
});

test('a split index whose shared part has one byte flipped is a stop that could not check, though git says nothing', () => {
  const s = edited();
  s.git('update-index', '--split-index');
  const [f] = readdirSync(join(s.root, '.git')).filter((n) => n.startsWith('sharedindex.'));
  assert.ok(f, 'git made a shared index');
  const at = join(s.root, '.git', f);
  const bytes = Buffer.from(readFileSync(at));
  bytes[40] ^= 0xff;
  writeFileSync(at, bytes);
  const r = spawnSync('git', ['-C', s.root, ...STATUS], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  assert.equal(r.status, 0, 'git itself says nothing is wrong');
  const out = s.stop();
  const said = String(out?.reason ?? out?.systemMessage ?? '');
  assert.doesNotMatch(said, /check\(s\) passed/u);
  assert.equal(out?.decision, 'block');
  assert.ok(said.includes(`the shared index file .git/${f} does not match the hash at its end and in its name: it is cut or damaged, and git reads it without saying so, so its answers about this repository cannot be trusted`), said);
});

test('a damaged sharedindex.* the index does not use (an old one git left) does not refuse the stop', () => {
  const s = edited();
  s.git('update-index', '--split-index');
  // Beside the one the index names in its link extension: a file git does not read, damaged.
  writeFileSync(join(s.root, '.git', `sharedindex.${'ab'.repeat(20)}`), 'garbage, and not the hash it is named by');
  const out = s.stop();
  const said = String(out?.reason ?? out?.systemMessage ?? '');
  assert.doesNotMatch(said, /could not check/u, said);
  assert.match(said, /check\(s\) passed/u);
});

test('an index whose extensions cannot be read (its hash still right) is a stop that could not check, with why', () => {
  const s = edited();
  s.git('update-index', '--split-index');
  const index = join(s.root, '.git/index');
  const bytes = Buffer.from(readFileSync(index));
  const at = bytes.indexOf('link');
  assert.ok(at > 0, 'the split index has its link extension');
  bytes.writeUInt32BE(0x7fffffff, at + 4);
  createHash('sha1').update(bytes.subarray(0, bytes.length - 20)).digest().copy(bytes, bytes.length - 20);
  writeFileSync(index, bytes);
  const out = s.stop();
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /the index file \(\.git\/index\) could not be read to its extensions \(extension "link" runs past the end\), so whether it uses a shared index, and that file's state, are not known/u);
});

test('git\'s error: and fatal: lines are said whole, never cut mid-word', () => {
  const s = edited();
  // A split index whose shared part is gone: git fails with a fatal line naming the 40-hex file.
  s.git('update-index', '--split-index');
  const shared = readdirSync(join(s.root, '.git')).filter((f) => f.startsWith('sharedindex.'));
  assert.ok(shared.length, 'git made a shared index');
  for (const f of shared) rmSync(join(s.root, '.git', f));
  const r = spawnSync('git', ['-C', s.root, ...STATUS], { encoding: 'utf8' });
  const lines = String(r.stderr).split('\n').map((l) => l.trim()).filter((l) => /^(?:error|fatal): /u.test(l));
  assert.ok(lines.length, `git said no error: or fatal: line (rc ${r.status})`);
  const out = s.stop();
  const said = String(out?.reason ?? out?.systemMessage ?? '');
  assert.equal(out?.decision, 'block');
  for (const l of lines) assert.ok(said.includes(l), `git's line is said whole: ${l}\nin: ${said}`);
});

test('a sparse checkout that leaves the map out is a stop that could not check, not a quiet one', () => {
  const s = edited();
  s.git('sparse-checkout', 'set', 'src');
  assert.ok(!existsSync(join(s.root, '.readfirst/map.json')), 'the sparse checkout left the map out');
  const out = s.stop();
  assert.equal(out?.decision, 'block', `the stop said nothing: ${JSON.stringify(out)}`);
  assert.match(out.reason, /\.readfirst\/map\.json is in the commit checked out but not in the working tree \(a sparse checkout that leaves it out, or a map deleted in the session\)/u);
});

test('a base branch whose ref cannot be read is named as such, not as no base branch', () => {
  const s = edited();
  s.git('checkout', '-q', '-b', 'work');
  writeFileSync(join(s.root, '.git/refs/heads/main'), 'zzzz\n');
  const out = s.stop();
  const said = String(out?.reason ?? out?.systemMessage ?? '');
  assert.doesNotMatch(said, /there is no base branch/u);
  assert.match(said, /the base branch main is there but git cannot read it \(/u);
});
