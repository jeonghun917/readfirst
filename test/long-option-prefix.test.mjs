// GNU getopt_long takes any unique prefix of a long option (`sed --in`, `sort --out=o`, `cp --t d`), and refuses one
// that starts more than one (`cp --p`: --parents or --preserve). options() in src/bash-writes.mjs read only whole long
// names: until 2026-11-15 `sed --in s/a/b/ f` was taken for a sed that writes nothing, `sort --out=o in` wrote
// nothing, `touch --r a.txt new.txt` named a.txt as written, and `cp --p a d` named d though cp refused it. Each shape
// runs with the real tool in a fresh folder, and what it changes is held against what shellWrites names. The helpers
// are written here, as in the other bash tests, since importing a test file runs its tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';

// GNU sed and coreutils: the names in OPTIONS are theirs (sed 4.9, coreutils 9.4).
const gnu = ['sed', 'sort', 'cp', 'touch', 'truncate', 'tee'].every((t) => /GNU/u.test(spawnSync(t, ['--version'], { encoding: 'utf8' }).stdout ?? ''));
const setUp = () => {
  const d = mkdtempSync(join(tmpdir(), 'readfirst-long-prefix-'));
  mkdirSync(join(d, 'd'));
  writeFileSync(join(d, 'a.txt'), 'one\n');
  writeFileSync(join(d, 'b.txt'), 'three\n');
  writeFileSync(join(d, 'in.txt'), 'b\na\n');
  return d;
};
const snap = (d) => { const o = {}; const w = (x) => { for (const e of readdirSync(x, { withFileTypes: true })) { const p = join(x, e.name); if (e.isDirectory()) w(p); else o[relative(d, p)] = readFileSync(p, 'utf8'); } }; w(d); return o; };
const run = (script, d) => {
  const before = snap(d);
  const r = spawnSync('bash', ['-c', script], { cwd: d, env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 5000 });
  const after = snap(d);
  return { status: r.status, changed: [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort() };
};
const named = (script, d) => { const w = shellWrites(script, d); return { files: w.files.map((f) => relative(d, f)).sort(), unknown: w.unknown.map((u) => u.part) }; };

test('a unique prefix of a long option is that option, and the tool agrees', { skip: !gnu && 'GNU sed and coreutils are not installed' }, () => {
  for (const script of [
    'sed --in s/one/x/ a.txt', 'sed --in-pl s/one/x/ a.txt', 'sort --out=o.txt in.txt', 'sort --o o.txt in.txt', 'sort --outp=o.txt in.txt',
    'touch --r a.txt new.txt', 'touch --d 2020-01-01 new.txt', 'truncate --s 0 a.txt', 'truncate --re a.txt b.txt', 'echo x | tee --a a.txt',
  ]) {
    const d = setUp();
    assert.deepEqual(named(script, d), { files: run(script, d).changed, unknown: [] }, script);
  }
  // -t DIR, as with -t: each file copied into the folder (test/bash-folder-destination.test.mjs).
  for (const script of ['cp --t d a.txt', 'cp --target=d a.txt b.txt']) {
    const d = setUp();
    const want = named(script, d);
    const { changed } = run(script, d);
    assert.ok(changed.length > 0 && changed.every((f) => f.startsWith('d/')), `${script}: ${changed}`);
    assert.deepEqual(want, { files: changed, unknown: [] }, script);
  }
});

test('a prefix of more than one long option is refused by the tool, and is not known', { skip: !gnu && 'GNU sed and coreutils are not installed' }, () => {
  for (const script of ['cp --p a.txt d', 'sort --s in.txt', 'sed --s s/one/x/ a.txt']) {
    const d = setUp();
    const { status, changed } = run(script, d);
    assert.ok(status !== 0 && changed.length === 0, `${script}: the tool refuses it (${status}, ${changed})`);
    const r = named(script, d);
    assert.deepEqual(r.files, [], `${script}: nothing named`);
    assert.equal(r.unknown.length, 1, `${script}: not known`);
  }
});

// A value a long option needs and readfirst does not keep is not a file: `touch --time mtime f` named mtime.
test('a long option that takes a value readfirst does not keep skips that value', { skip: !gnu && 'GNU sed and coreutils are not installed' }, () => {
  for (const script of ['touch --time mtime new.txt', 'touch --ti mtime new.txt', 'sort --sort numeric -o o.txt in.txt', 'cp --sparse never a.txt c.txt']) {
    const d = setUp();
    assert.deepEqual(named(script, d), { files: run(script, d).changed, unknown: [] }, script);
  }
});

// A whole name, and a tool whose names readfirst does not hold (rsync, perl), read as before.
test('whole long names, and tools with no list of names, read as before', () => {
  const d = setUp();
  assert.deepEqual(named('sed --in-place s/one/x/ a.txt', d).files, ['a.txt']);
  assert.deepEqual(named('sort --output=o.txt in.txt', d).files, ['o.txt']);
  assert.deepEqual(named('rsync --rsh ssh a.txt d', d).files, ['d/a.txt'], 'd is a folder here: the file that lands in it');
});

// GNU patch 2.7.6 (its names in OPTIONS since 2026-11-15; before, patch read whole names only): `--dir=sub` named a.txt
// where patch changed sub/a.txt, `--out=o.txt` named a.txt where it wrote o.txt, `--dry` named the file a dry run
// leaves alone, and `--d sub` named sub, though patch refuses it.
const gnuPatch = /GNU patch/u.test(spawnSync('patch', ['--version'], { encoding: 'utf8' }).stdout ?? '');
const withPatch = () => {
  const d = setUp();
  mkdirSync(join(d, 'sub'));
  writeFileSync(join(d, 'sub', 'a.txt'), 'one\n');
  writeFileSync(join(d, 'p.diff'), '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n');
  return d;
};
test('patch: a unique prefix of its long options is that option, and patch agrees', { skip: !gnuPatch && 'GNU patch is not installed' }, () => {
  for (const script of [
    'patch --dry -p1 < p.diff', 'patch --dry-ru -p1 < p.diff', 'patch --dir=sub -p1 < p.diff', 'patch --dire sub -p1 < p.diff',
    'patch --out=o.txt a.txt p.diff', 'patch --in=p.diff -p1', 'patch --st=1 < p.diff', 'patch --str 1 < p.diff', 'patch --qui -p1 < p.diff',
  ]) {
    const d = withPatch();
    assert.deepEqual(named(script, d), { files: run(script, d).changed, unknown: [] }, script);
  }
  for (const script of ['patch --d sub -p1 < p.diff', 'patch --s 1 < p.diff', 'patch --reject-f=r.rej -p1 < p.diff']) {
    const d = withPatch();
    const { status, changed } = run(script, d);
    assert.ok(status !== 0 && changed.length === 0, `${script}: patch refuses it (${status}, ${changed})`);
    assert.deepEqual(named(script, d), { files: [], unknown: [`patch ${script.split(' ')[1]}`] }, script);
  }
});
