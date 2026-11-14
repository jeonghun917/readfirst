// A function's body runs where the function is called, with the folder, the variables and the arguments there, and
// not at all if nothing calls it (2026-11-14). Until then shellWrites read the body where it was written: its writes
// were named though nothing called the function, in the folder of the definition, not of the call; a ( ) body ran
// where it was written; $1 was not known; and a call made every variable, and often the folder, not known.
// eachCommand now keeps a body with its definition and reads it again at each call, as a { } group or a ( ) subshell.
// Each command runs through bash in an empty folder holding the folders a and s, and the files it makes are what
// shellWrites must name.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';

const hasBash = spawnSync('bash', ['-c', 'true'], { env: {} }).status === 0;
// The files bash makes running the script in a new folder that holds the empty folders a and s, relative to it (as in
// test/here-docs.test.mjs: copied, since importing a test file runs its tests).
const bashMade = (script, dir) => {
  mkdirSync(join(dir, 'a'));
  mkdirSync(join(dir, 's'));
  spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 5000 });
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name)); else out.push(relative(dir, join(d, e.name))); } };
  walk(dir);
  return out.sort();
};
// What shellWrites names for the script run in dir: its files, and `?part` for each write it gives as not known.
const named = (script, dir) => { const r = shellWrites(script, dir); return [...r.files.map((f) => relative(dir, f)), ...r.unknown.map((u) => `?${u.part}`)].sort(); };

test('a function is read where it is called, with the state and the arguments there, and bash agrees', { skip: !hasBash && 'bash is not installed' }, () => {
  for (const [script, mainNamed] of [
    // Read where it is called: the folder and the here-document of the call.
    ['f() { cd s; cat <<E\n$(echo > f2)\nE\n}; f', ['f2']],
    ['f() { echo > g2; }; cd s; f', ['g2']],
    ['f() ( cd s; echo > g8 ); f; echo > g9', ['g8', 'g9']],
    // Not called: nothing it holds is written.
    ['f() { echo > g; }', ['g']],
    ['f() { cat <<E\n$(echo > g4)\nE\n}', ['g4']],
    // What it changes is followed after the call, and its arguments are the call's.
    ['f() { cd s; }; f; echo > g3', ['?f']],
    ['f() { echo > $1; }; f a1', ['?$1']],
    ['f() { echo > "$1/$2"; }; f a "b c"', ['?$1']],
    ['run() { "$@"; }; run cd a; echo > h', ['?run']],
    ['run() { $@; }; run cd a; echo > h', ['?run']],
    ['run() { "$@"; }; run cp /dev/null "x y"', []],
    ['f() { true; }; f() { cd s; }; f; echo > h', ['?f']],
    ['f() { g; }; g() { cd s; }; f; echo > h', ['?f']],
    // Review of #217: a call inside ( ) or a pipeline runs as a subshell; a ( ) before the body's } ended nothing, so
    // nothing after it was read; return ends the body; unset -f takes the function away.
    ['f() { cd a; }; (f); echo > h', null],
    ['f() { cd a; echo > g; }; f | cat; echo > h', ['g', 'h']],
    ['f() { cd a; ( echo ) }; f; echo > h', ['h']],
    // A block inside a { } body does not end it (the body was taken to end at the fi, and its cd was lost).
    ['f() { if true; then :; fi; cd s; }; f; echo > h', ['?f']],
    ['f() { cd a; return; cd s; }; f; echo > h', ['?f']],
    ['f() { cd a; }; unset -f f; f; echo > h', ['?f']],
    // The ledger's rows: a body run where it was written, a group in the background or a pipeline, a ( after a {, a
    // group's redirect, a body that is an if.
    ['f() { cd a; echo > g; }; (f); echo > h', ['g', 'h']],
    ['f() { cd a; echo > g; }; x=$(f); echo > h', ['g', 'h']],
    ['f() if true; then cd a; fi; echo > h', ['a/h']],
    ['f() { { cd a; }; echo > g; }; f; echo > h', ['?f', 'g']],
    ['{ cd a; } & wait; echo > h', ['a/h']],
    ['{ cd a; } | cat; echo > h', ['a/h']],
    ['{ { cd a; }; }; echo > h', null],
    ['{ ( cd a; echo > g); }; echo > h', ['a/g', 'a/h']],
    ['{ cd a; }>o; echo>h', ['a/h', 'a/o']],
    ['f(){ echo {>x; }', ['x']],
    ['f () { cd a; }; f; echo > h', ['?f']],
    ['f ()\n{\n cd a\n}\necho > h', null],
    // As before.
    ['f() { echo > g1; }; f', null],
    ['f() { g() { echo > g5; }; }; f; g', null],
    ['f() { echo > g6; }; f; f', null],
    ['function f { echo > g7; }; f', null],
    ['f ()\n{ cd a\n}\nf\necho > h', null],
    ['f ( ) { cd a; }; f; echo > h', null],
    ['run() { "$@"; }; run ls >/dev/null; echo > h', null],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-functions-'));
    const made = bashMade(script, dir);
    assert.deepEqual(named(script, dir), made, script);
    if (mainNamed) assert.notDeepEqual(mainNamed, made, `what main named is not what bash makes: ${script}`);
  }
});

// A return that may not run (after && or ||, in an if) leaves the rest of the body read, and what it changed is not
// known after the call; one that surely runs ends the body, also inside a function called by another.
test('a return on some paths makes what follows it not known; a return on every path ends the body', () => {
  const s = (c) => { const r = shellWrites(c, '/r'); return [...r.files, ...r.unknown.map((u) => u.part)]; };
  assert.deepEqual(s('f() { cd /a; [ -e x ] && return; cd b; }; f; echo > h'), ['cd b']);
  assert.deepEqual(s('f() { if x; then return; fi; cd /b; }; f; echo > h'), ['cd /b']);
  assert.deepEqual(s('f() { if x; then :; fi; cd /b; }; f; echo > h'), ['/b/h'], 'no return: the cd is sure');
  assert.deepEqual(s('f() { g; cd c; }; g() { cd /a; return; cd b; }; f; echo > h'), ['/a/c/h']);
});

// A function that calls itself, directly or through another, is read once for the call it is in: the call inside is
// given as not known, with why. bash would run until it runs out of stack.
test('a function that calls itself is read once, and the call inside is given as not known', () => {
  for (const script of ['f() { echo > r1; f; }; f', 'f() { g; }; g() { echo > r2; f; }; f']) {
    const r = shellWrites(script, '/r');
    assert.equal(r.files.length, 1, script);
    assert.match(r.unknown[0]?.why ?? '', /calls itself/u, script);
  }
});

// A count, which no load changes: each body read at a call is put in front of eachCommand's list. Put there with
// unshift(), everything waiting moved each time, the end of each call it is inside included: a chain of 2,000 calls
// moved 20,030,022 elements (a stack moves 8,016). The elements unshift() and shift() move are counted.
test('a chain of calls puts each body in front of the list without moving the rest', () => {
  const n = 2000;
  let text = 'f0() { echo > deep; }\n';
  for (let i = 1; i <= n; i++) text += `f${i}() { f${i - 1}; }\n`;
  const { unshift, shift } = Array.prototype;
  let moved = 0;
  Array.prototype.unshift = function counted(...a) { moved += this.length; return unshift.apply(this, a); };
  Array.prototype.shift = function counted() { moved += Math.max(0, this.length - 1); return shift.call(this); };
  try {
    assert.deepEqual(shellWrites(`${text}f${n}`, '/r').files, ['/r/deep']);
  } finally {
    Array.prototype.unshift = unshift;
    Array.prototype.shift = shift;
  }
  assert.ok(moved < 10 * n, `${moved} elements moved for ${n} calls`);
});

// A call tree that doubles at each level reads 2^n bodies: the bodies read for one command stop at a budget, and each
// call past it is given as not known, with the number, never dropped.
test('bodies past the budget are given as not known, and the reading stays short', () => {
  let script = 'f0() { echo > leaf; }\n';
  for (let i = 1; i <= 30; i++) script += `f${i}() { f${i - 1}; f${i - 1}; }\n`;
  const t = performance.now();
  const r = shellWrites(`${script}f30`, '/r');
  assert.ok(performance.now() - t < 5000, `read in ${performance.now() - t} ms`);
  assert.deepEqual(r.files, ['/r/leaf']);
  assert.ok(r.unknown.length > 0 && r.unknown.every((u) => /commands of function bodies would be read/u.test(u.why)));
});
