// A file the session edited whose folder is gone at the stop (2026-11-15). Until then runStopHook placed such a file by
// the session's folder: started outside every repository, a worktree removed in the session was said as not checked on
// every stop of the session (13 files, each turn), and a folder deleted inside a repository that is still there
// (`rm -rf src`) was said the same, so that deletion was never checked. Now the file is placed by its nearest existing
// folder: a deletion inside a live repository is checked, and a path no repository holds any more is said once, then
// left out. Each case: a repository, two worktrees, one Edit in each through the hook from a folder in no repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook, runStopHook } from '../src/cli.mjs';

let n = 0;
// `inside`: the worktrees are made in the repository's own .claude/worktrees, which its .gitignore leaves out.
function session({ inside = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-gone-'));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    '.gitignore': '.claude/\nvendor/\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], checks: [{ run: 'test -d src', why: 'the code is there' }] }, { id: 'rest', title: 'the rest', files: ['.gitignore'] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const trees = [1, 2].map((i) => { const w = inside ? join(root, '.claude/worktrees', `w${i}`) : join(mkdtempSync(join(tmpdir(), 'readfirst-gone-wt-')), `w${i}`); git('worktree', 'add', '-q', '--detach', w); return w; });
  const outside = mkdtempSync(join(tmpdir(), 'readfirst-gone-cwd-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-gone-state-'));
  const id = `gone-${process.pid}-${++n}`;
  let now = Date.now() + 5000;
  const edit = (file) => {
    runHook(JSON.stringify({ session_id: id, cwd: outside, tool_name: 'Edit', tool_input: { file_path: file, old_string: '1', new_string: '2' } }), { stateDir, now: (now += 1000) });
    writeFileSync(file, 'export const a = 2;\n');
  };
  for (const w of trees) edit(join(w, 'src/a.js'));
  const stop = (cwd = outside) => { const out = runStopHook(JSON.stringify({ session_id: id, cwd }), { stateDir, timeout: 30 }); return out ? JSON.parse(out) : null; };
  return { root, git, trees, edit, stop };
}
const text = (r) => String(r?.reason ?? r?.systemMessage ?? '');

test('a worktree removed in the session is said once, then left out of every later stop', () => {
  const s = session();
  for (const w of s.trees) rmSync(w, { recursive: true, force: true });
  const first = s.stop();
  assert.equal(first?.decision, 'block', `the stop said nothing: ${JSON.stringify(first)}`);
  assert.match(first.reason, /the stop could not check `[^`]*w1\/src\/a\.js`, `[^`]*w2\/src\/a\.js`|the stop could not check `[^`]*w2\/src\/a\.js`, `[^`]*w1\/src\/a\.js`/u);
  assert.match(first.reason, /their folders are gone/u);
  for (const k of [1, 2]) {
    const later = s.stop();
    assert.notEqual(later?.decision, 'block', `stop ${k + 1}: ${text(later)}`);
    assert.doesNotMatch(text(later), /could not check/u, `stop ${k + 1} said it again`);
  }
});

test('a folder deleted inside a repository that is still there is a change of that repository, and is checked', () => {
  const s = session();
  rmSync(join(s.trees[0], 'src'), { recursive: true, force: true });
  const first = s.stop();
  assert.doesNotMatch(text(first), /could not check/u, 'the deletion was taken for a repository not found');
  assert.equal(first?.decision, 'block', `the check that fails on the deletion did not run: ${text(first)}`);
  assert.match(first.reason, /test -d src/u);
});

// Review of #247: the gone mark left a worktree added again at the same path unchecked, and a worktree or a nested
// repository kept inside another repository (ignored there) was placed in that repository, which tracks none of it.
test('a worktree added again where one was removed is checked, though the first was said gone', () => {
  const s = session();
  const [w] = s.trees;
  s.git('worktree', 'remove', '--force', w);
  assert.equal(s.stop()?.decision, 'block', 'said once');
  s.git('worktree', 'prune');
  s.git('worktree', 'add', '-q', '--detach', w);
  s.edit(join(w, 'src/a.js'));
  rmSync(join(w, 'src'), { recursive: true, force: true });
  const again = s.stop();
  assert.equal(again?.decision, 'block', `the check that fails on the deletion did not run: ${text(again)}`);
  assert.match(again.reason, /test -d src/u);
});

test('a worktree inside the repository, removed, is said once, not dropped into the repository that holds its folder', () => {
  const s = session({ inside: true });
  for (const w of s.trees) s.git('worktree', 'remove', '--force', w);
  const first = s.stop();
  assert.equal(first?.decision, 'block', `the stop said nothing: ${text(first)}`);
  assert.match(first.reason, /the stop could not check `[^`]*\.claude\/worktrees\/w[12]\/src\/a\.js`/u);
  assert.doesNotMatch(text(s.stop()), /could not check/u, 'said once');
  // The same with the session in the repository itself: main and the first draft said nothing at all there.
  const t = session({ inside: true });
  for (const w of t.trees) t.git('worktree', 'remove', '--force', w);
  const here = t.stop(t.root);
  assert.equal(here?.decision, 'block', `the stop said nothing: ${text(here)}`);
  assert.match(here.reason, /\.claude\/worktrees\/w[12]\/src\/a\.js/u);
});

test('a nested repository inside the repository, removed, is said once', () => {
  const s = session();
  const nested = join(s.root, 'vendor/x');
  mkdirSync(join(nested, 'src'), { recursive: true });
  writeFileSync(join(nested, 'src/a.js'), 'export const a = 1;\n');
  execFileSync('git', ['-C', nested, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
  s.edit(join(nested, 'src/a.js'));
  rmSync(nested, { recursive: true, force: true });
  const first = s.stop();
  assert.equal(first?.decision, 'block', `the stop said nothing: ${text(first)}`);
  assert.match(first.reason, /the stop could not check `[^`]*vendor\/x\/src\/a\.js`/u);
});

test('a file deleted in a folder that is still there is checked, as before', () => {
  const s = session();
  rmSync(join(s.trees[0], 'src/a.js'));
  const first = s.stop();
  assert.doesNotMatch(text(first), /could not check/u);
  assert.notEqual(first?.decision, 'block', text(first));
  assert.match(text(first), /check\(s\) passed/u);
});
