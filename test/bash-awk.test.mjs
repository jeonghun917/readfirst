// An awk program writes files and runs commands of its own: `print ... > "f"` and `>> "f"`, `print ... | "cmd"`,
// system("cmd") and `"cmd" | getline` (awkOutputs in src/bash-writes.mjs). Until 2026-11-14 shellWrites did not read
// the program, so `awk '{print > "out"}' f` wrote out and readfirst named nothing. A > or | in a print statement
// outside ( ) is a redirect; elsewhere (`$1 > 5 {print}`, `print (1 > 2)`, a regex, a string, a comment) it compares
// or is text. Each command runs through bash with the awk installed here, in a folder holding an empty folder a, a
// file `in` and a program file `prog.awk`; the files it makes are what shellWrites must name. The helpers are copied
// from test/here-docs.test.mjs, since importing a test file runs its tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { awkOutputs, shellWrites } from '../src/bash-writes.mjs';

const hasAwk = spawnSync('bash', ['-c', 'awk "BEGIN{}"'], { env: { PATH: process.env.PATH } }).status === 0;
const GIVEN = new Set(['in', 'prog.awk']);
const setUp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-awk-'));
  mkdirSync(join(dir, 'a'));
  writeFileSync(join(dir, 'in'), 'q1 1 2\nq2 9 9\nq3 x\n');
  writeFileSync(join(dir, 'prog.awk'), 'BEGIN { print "p" > "o15" }\n');
  return dir;
};
// The files bash makes, besides the ones the folder starts with.
const bashMade = (script, dir) => {
  spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 5000 });
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name)); else if (!GIVEN.has(e.name)) out.push(relative(dir, join(d, e.name))); } };
  walk(dir);
  return out.sort();
};
const named = (script, dir) => { const r = shellWrites(script, dir); return [...r.files.map((f) => relative(dir, f)), ...r.unknown.map((u) => `?${u.part}`)].sort(); };

test('the files an awk program writes are named, and bash agrees', { skip: !hasAwk && 'bash or awk is not installed' }, () => {
  // Main (80931d8) named none of these: each made a file.
  for (const script of [
    `awk 'BEGIN{print "x" > "o1"}'`,
    `awk 'BEGIN{printf "x" >> "o2"}'`,
    `awk '{print > "o3"}' in`,
    `awk '{print $0 > ("o" "4")}' in`,
    `awk 'BEGIN{print 2 > "o" "5"}'`,
    `awk 'BEGIN{print "c" | "cat > o6"}'`,
    `awk 'BEGIN{system("echo > o7")}'`,
    `awk 'BEGIN{"echo > o8" | getline}'`,
    `cd a && awk 'BEGIN{print 1 > "o10"}'`,
    'awk -f prog.awk',
    `awk -F: -v k=1 'BEGIN{print k > "o11"}'`,
    'awk "BEGIN{print 1 > \\"o12\\"}"',
    'F=o13; awk "BEGIN{print 1 > \\"$F\\"}"',
    `mawk 'BEGIN { print "a" >"o14" }'`,
  ]) {
    const dir = setUp();
    const made = bashMade(script, dir);
    assert.ok(made.length > 0, `bash makes a file: ${script}`);
    assert.deepEqual(named(script, dir), made, script);
  }
});

test('a > or | in an awk program that compares, matches or is text writes nothing, and bash agrees', { skip: !hasAwk && 'bash or awk is not installed' }, () => {
  for (const script of [
    `awk '$1 > 5 {print}' in`,
    `awk '{ if (NF > 1) print }' in`,
    `awk 'BEGIN{print (1 > 2)}'`,
    `awk '/a>b/ {print}' in`,
    `awk 'BEGIN{x = 4 / 2 > 1; print x}'`,
    `awk 'BEGIN{print "a>b"}'`,
    `awk '{ getline line < "in"; print line }' in`,
    `awk 'BEGIN{print 1 || 0}'`,
    `awk '# print > "o20"\nBEGIN{print 1}'`,
    `awk 'NR>=2 && NR<=3' in`,
    `awk -v 'x=a>b' 'BEGIN{print x}'`,
    `awk 'BEGIN { while (("echo hi" | getline l) > 0) print l }'`,
    `awk 'BEGIN{print 1 > "/dev/stderr"}' 2>/dev/null`,
  ]) {
    const dir = setUp();
    assert.deepEqual(bashMade(script, dir), [], `bash makes nothing: ${script}`);
    assert.deepEqual(named(script, dir), [], script);
  }
});

// A file or a command the program makes only when it runs is not known, with why; bash makes one each time.
test('a file or command an awk program makes when it runs is given as not known', { skip: !hasAwk && 'bash or awk is not installed' }, () => {
  for (const [script, part] of [
    [`awk 'BEGIN{x="o9"; print 1 > x}'`, 'awk: > x'],
    [`awk '{print > $1}' in`, 'awk: > $1'],
    [`awk 'BEGIN{c="echo > p1"; system(c)}'`, 'awk: c'],
  ]) {
    const dir = setUp();
    assert.ok(bashMade(script, dir).length > 0, `bash makes a file: ${script}`);
    const r = shellWrites(script, dir);
    assert.deepEqual(r.files, [], script);
    assert.deepEqual(r.unknown.map((u) => u.part), [part], script);
    assert.match(r.unknown[0].why, /known only when it runs/u, script);
  }
});

// No gawk here to run them against: gawk's -i inplace writes each input file back; a program file whose path is
// known only when the command runs is not known; one that is not there runs nothing.
test('gawk -i inplace writes its input files; -f reads the program from its file', () => {
  const s = (c) => { const r = shellWrites(c, '/r'); return [...r.files, ...r.unknown.map((u) => `?${u.part}`)]; };
  assert.deepEqual(s(`gawk -i inplace '{sub(/a/,"b")}1' f1 f2 x=1`), ['/r/f1', '/r/f2']);
  assert.deepEqual(s(`gawk --include=inplace '{print}' g`), ['/r/g']);
  assert.deepEqual(s(`gawk -i lib '{print}' g`), []);
  assert.deepEqual(s('awk -f $P/x.awk'), ['?awk -f $P/x.awk']);
  assert.deepEqual(s('awk -f /nonexistent/x.awk'), []);
  assert.deepEqual(s(`awk 'BEGIN{system("cd /z; echo > q")}'; echo > h`), ['/z/q', '/r/h'], 'the command sh runs moves only itself');
  assert.deepEqual(s(`awk 'BEGIN{print "x" | "sort > /s/o"; close("sort > /s/o")}'`), ['/s/o']);
});

test('awkOutputs reads each redirect of a print statement, and only those', () => {
  assert.deepEqual(awkOutputs('{ print $1 > "a"; print $2 >> "b" }'), [{ file: 'a', expr: '"a"' }, { file: 'b', expr: '"b"' }]);
  assert.deepEqual(awkOutputs('{ printf("%s", $1) > out }'), [{ file: null, expr: 'out' }]);
  assert.deepEqual(awkOutputs('{ print "a\\"b>c" }'), [], 'a > inside a string with an escaped quote');
  assert.deepEqual(awkOutputs('$0 ~ /x[/>]y/ { print }'), [], 'a / inside a bracket of a regex');
  assert.deepEqual(awkOutputs('{ n = a / b; m = c / d > 0; print n }'), [], 'division is no regex');
  assert.deepEqual(awkOutputs('{ print a[$1 > 0] }'), [], 'inside [ ]');
  assert.deepEqual(awkOutputs('{ x = "ls" | getline y }'), [{ run: 'ls', expr: '"ls"' }]);
});
