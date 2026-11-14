// find runs the command after -exec, -execdir, -ok or -okdir for each file it finds, and -fprint / -fprintf / -fls
// write a file (findRun in src/bash-writes.mjs). Until 2026-11-14 none of it was read: `find . -name '*.md' -exec
// sed -i s/a/b/ {} \;` changed files and readfirst said nothing. A `{}` is a file under the folder find starts from,
// known only when it runs, so a write to it is not known, under that folder; a path the command names is named. An
// escaped `\;` (or `\|`, `\&`) is a word, not an operator: the second -exec of `find d -exec echo {} \; -exec cp a b
// \;` was read as a command of its own. Each command runs through bash in a folder holding d (x.txt, y.md, s/z.txt)
// and e (x.txt); the files it makes or changes are what shellWrites must name. The helpers are copied from
// test/here-docs.test.mjs, since importing a test file runs its tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { commandWords, shellWrites } from '../src/bash-writes.mjs';

const hasFind = spawnSync('bash', ['-c', 'find . -maxdepth 0'], { env: { PATH: process.env.PATH } }).status === 0;
const SEED = { 'd/x.txt': 'a\n', 'd/y.md': 'a\n', 'd/s/z.txt': 'a\n', 'e/x.txt': 'a\n' };
const setUp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-find-'));
  for (const d of ['d', 'd/s', 'e']) mkdirSync(join(dir, d));
  for (const [f, t] of Object.entries(SEED)) writeFileSync(join(dir, f), t);
  return dir;
};
// The files bash makes or changes.
const bashMade = (script, dir) => {
  spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 5000 });
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { const r = relative(dir, p); if (!(r in SEED) || readFileSync(p, 'utf8') !== SEED[r]) out.push(r); } } };
  walk(dir);
  return out.sort();
};
// The files shellWrites names, and `?part@folder` for each write it gives as not known under a folder.
const named = (script, dir) => { const r = shellWrites(script, dir); return [...r.files.map((f) => relative(dir, f)), ...r.unknown.map((u) => `?${u.part}@${u.prefix ? relative(dir, u.prefix) || '.' : ''}`)].sort(); };

test('a write to the files find finds is not known, under the folder it starts from, and bash writes there', { skip: !hasFind && 'bash or find is not installed' }, () => {
  // Main (80931d8) named nothing for each.
  for (const [script, want] of [
    ["find d -name '*.txt' -exec sed -i s/a/b/ {} \\;", ['?{}@d']],
    ["find d -name x.txt -exec cp {} {}.bak \\;", ['?{}@d']],
    ["find d -name '*.md' -execdir sed -i s/a/b/ {} \\;", ['?{}@d']],
    ['cd d && find . -name x.txt -exec cp {} {}.n \\;', ['?{}@d']],
    ['find d e -name x.txt -exec cp {} {}.m \\;', ['?{}@d', '?{}@e']],
    // Options before the starts (review of #223: the start was taken to be `.`).
    ['find -L d -name x.txt -exec cp {} {}.l \\;', ['?{}@d']],
    ['find -O3 -D tree d -name x.txt -exec cp {} {}.o \\;', ['?{}@d']],
  ]) {
    const dir = setUp();
    const made = bashMade(script, dir);
    assert.ok(made.length > 0, `bash writes: ${script}`);
    const roots = want.map((w) => w.split('@')[1]);
    assert.ok(made.every((f) => roots.some((r) => f.startsWith(`${r}/`))), `bash writes under ${roots}: ${made}`);
    assert.deepEqual(named(script, dir), want, script);
  }
});

test('a file find writes, or a path its command names, is named, and bash agrees', { skip: !hasFind && 'bash or find is not installed' }, () => {
  for (const script of [
    'find d -exec echo {} \\; -exec cp d/x.txt d/z \\;',
    'find d -fprint list.txt',
    'find d -type f -fprintf out.txt "%p\\n"',
    'find d -exec cat {} \\; > out',
    // A start that is a file: {} is that file (review of #223 named it as a folder, d/x.txt/).
    'find d/x.txt -exec cp {} {}.f \\;',
    'find d/x.txt -execdir cp {} {}.g \\;',
  ]) {
    const dir = setUp();
    assert.deepEqual(named(script, dir), bashMade(script, dir), script);
  }
});

test('find that only reads or lists writes nothing, and bash agrees', { skip: !hasFind && 'bash or find is not installed' }, () => {
  for (const script of [
    "find d -name '*.txt' -exec grep -l a {} \\;",
    'find d -name "*.txt" -print',
    'find d -newer d/x.txt',
    "find d -exec echo '{}' ';'",
  ]) {
    const dir = setUp();
    assert.deepEqual(bashMade(script, dir), [], `bash writes nothing: ${script}`);
    assert.deepEqual(named(script, dir), [], script);
  }
});

// bash reads `\;`, `\|` and `\&` as words: each line is one command. An escaped backslash before one does not escape
// it. Main split at `\;` and `\|`, so `echo a \; cp x y` named y; it kept `\\&` together.
test('an escaped ; | or & is a word, not an operator', () => {
  const words = (c) => commandWords(c, '/r').map((x) => x.words.map((w) => w.text));
  assert.deepEqual(words('echo a \\; cp x y'), [['echo', 'a', ';', 'cp', 'x', 'y']]);
  assert.deepEqual(words('echo a \\| cp x y'), [['echo', 'a', '|', 'cp', 'x', 'y']]);
  assert.deepEqual(words('echo \\& cp x y'), [['echo', '&', 'cp', 'x', 'y']]);
  assert.deepEqual(shellWrites('echo a \\; cp x y', '/r').files, []);
  assert.deepEqual(shellWrites('echo a \\\\; cp x y', '/r').files, ['/r/y'], 'an escaped backslash, then a ;');
  assert.deepEqual(shellWrites('echo \\\\& cp x y', '/r').files, ['/r/y'], 'an escaped backslash, then a &');
});
