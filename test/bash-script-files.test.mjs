// A script file run by python, node, ruby, perl, deno or bun is read as code from -c or -e is (runScript in
// src/bash-writes.mjs): the targets of its write calls are named, a write whose target is known only when it runs is
// not known, with why, and a file with no write call is quiet. Until 2026-11-14 `node build.mjs` and `python3 gen.py`
// were read as writing nothing. Only code counts: a write call inside a string or a comment is data (a test file
// holds commands as data). Each command runs through bash, in a folder holding an empty folder a and the files of
// FILES; the files it makes are what shellWrites must name. The helpers are copied from test/here-docs.test.mjs,
// since importing a test file runs its tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';

const has = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`], { env: { PATH: process.env.PATH } }).status === 0;
const hasBoth = has('python3') && has('node');
const FILES = {
  'w.py': "open('pw1', 'w').write('x')\n",
  'argv.py': "import sys\nopen(sys.argv[1], 'w').write('x')\n",
  'dyn.py': "open('d-%d' % 1, 'w').write('x')\n",
  'read.py': "print(open('in').read())\n",
  'data.py': "s = \"open('q1', 'w')\"  # open('q2', 'w')\nprint(s)\n",
  'w.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('nw1', 'x');\n",
  'argv.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'x');\n",
  'dyn.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync(`n-${1}`, 'x');\n",
  'read.mjs': "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('in', 'utf8'));\n",
  'data.mjs': "const t = \"writeFileSync('q3', '')\"; // writeFileSync('q4', '')\nconsole.log(t);\n",
  // A write in a template's ${ } or an f-string's { } is code (missed until the review of #222).
  'tpl.mjs': "import fs from 'node:fs';\nconst s = `${fs.writeFileSync('tpl.txt', 'x')}`;\n",
  'fstr.py': "x = f'{open(\"infstr.txt\", \"w\")}'\n",
  // Writes into a temporary folder are left out; a write into the folder the script runs in next to them is still
  // named (review of #222: the gate refused 44 of this repository's 75 test files).
  'tmp.mjs': "import { mkdtempSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst root = mkdtempSync(join(tmpdir(), 'rf-t-'));\nconst event = join(root, '..', 'rf-ev.json');\nwriteFileSync(join(root, 'a.txt'), 'x');\nwriteFileSync(`${root}/b.txt`, 'x');\nwriteFileSync(event, 'x');\n",
  'mix.mjs': "import { mkdtempSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst root = mkdtempSync(join(tmpdir(), 'rf-m-'));\nwriteFileSync(join(root, 'a.txt'), 'x');\nwriteFileSync('repo.txt', 'x');\n",
  'tmp.py': "import tempfile, os\nfrom pathlib import Path\nd = tempfile.mkdtemp()\nopen(os.path.join(d, 'a'), 'w').write('x')\n(Path(d) / 'b').write_text('x')\nwith tempfile.TemporaryDirectory() as t:\n    open(f'{t}/c', 'w').write('x')\n",
  'mix.py': "import tempfile, os\nd = tempfile.mkdtemp()\nopen(os.path.join(d, 'a'), 'w').write('x')\nopen('repo2.txt', 'w').write('x')\n",
  // open's mode decides: a second argument or mode= that writes; one with brackets in its target is still found.
  'kw.py': "open('kw.txt', mode='w').write('x')\nopen(os.path.join('a', 'r.txt')) if False else None\n",
  'nested.py': "import os\nopen(os.path.join(os.getcwd(), 'n.txt'), 'w').write('x')\n",
  // A name is a temporary folder where the binding it refers to is one (review of 6094077: told by the name alone,
  // these went silent): one bound again to a repository path, a parameter beside a temporary name, a variable mode,
  // and Path('.') / 'x' are not known.
  'reuse.mjs': "import { mkdtempSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nlet p = mkdtempSync(join(tmpdir(), 'rf-r-'));\nwriteFileSync(join(p, 'a.txt'), 'x');\np = 'reused.txt';\nwriteFileSync(p, 'x');\n",
  'after.py': "import tempfile, os\nwith tempfile.TemporaryDirectory() as d:\n    open(os.path.join(d, 'x'), 'w').write('x')\nd = '.'\nopen(os.path.join(d, 'after.txt'), 'w').write('x')\n",
  'param.py': "import tempfile, os\nd = tempfile.mkdtemp()\ndef f(d):\n    open(os.path.join(d, 'param.txt'), 'w').write('x')\nf('.')\n",
  'varmode.py': "mode = 'w'\nopen('varmode.txt', mode).write('x')\n",
  'slash.py': "import tempfile\nfrom pathlib import Path\nd = Path(tempfile.mkdtemp())\n(d / 'x.txt').write_text('x')\n(Path('.') / 'slash.txt').write_text('x')\n",
  'opened.mjs': "import fs from 'node:fs';\nfs.closeSync(fs.openSync('opened.txt', 'w'));\n",
  in: 'x\n',
};
const setUp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-scripts-'));
  mkdirSync(join(dir, 'a'));
  for (const [f, t] of Object.entries(FILES)) writeFileSync(join(dir, f), t);
  return dir;
};
// The files bash makes, besides the ones the folder starts with (and python's cache).
const bashMade = (script, dir) => {
  // TMPDIR: the test process's own folder (test/setup.mjs removes it), where the scripts' temporary folders go.
  spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, stdio: 'ignore', timeout: 10000 });
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { if (e.name !== '__pycache__') walk(join(d, e.name)); } else if (!(e.name in FILES)) out.push(relative(dir, join(d, e.name))); } };
  walk(dir);
  return out.sort();
};
const named = (script, dir) => { const r = shellWrites(script, dir); return [...r.files.map((f) => relative(dir, f)), ...r.unknown.map((u) => `?${u.part}`)].sort(); };

test('the files a python or node script writes are named, and bash agrees', { skip: !hasBoth && 'python3 or node is not installed' }, () => {
  // Main (80931d8) named none of these: each made a file.
  for (const script of [
    'python3 w.py', 'python3 -B w.py', 'python3 -W ignore w.py', 'python3 argv.py pa1', 'cd a && python3 ../w.py',
    'node w.mjs', 'node --no-warnings w.mjs', 'node argv.mjs na1', 'P=w.mjs; node $P', 'node tpl.mjs', 'python3 fstr.py',
    'node mix.mjs', 'python3 mix.py', 'python3 kw.py', 'node opened.mjs',
  ]) {
    const dir = setUp();
    const made = bashMade(script, dir);
    assert.ok(made.length > 0, `bash makes a file: ${script}`);
    assert.deepEqual(named(script, dir), made, script);
  }
});

test('a script that only reads, holds writes as data, or runs no file is quiet, and bash agrees', { skip: !hasBoth && 'python3 or node is not installed' }, () => {
  for (const script of [
    'python3 read.py', 'python3 data.py', 'node read.mjs', 'node data.mjs', 'python3 -c "print(1)"', 'python3 -m json.tool in',
    'python3 nothere.py', 'python3 - <<E\nprint(1)\nE', 'node -e "1"', 'node --input-type module -e "1"', 'node nothere.mjs',
    'node --check w.mjs', 'node tmp.mjs', 'python3 tmp.py',
  ]) {
    const dir = setUp();
    assert.deepEqual(bashMade(script, dir), [], `bash makes nothing: ${script}`);
    assert.deepEqual(named(script, dir), [], script);
  }
});

test('a script that writes where it is known only when it runs is given as not known', { skip: !hasBoth && 'python3 or node is not installed' }, () => {
  for (const [script, files] of [
    ['python3 dyn.py', []], ['node dyn.mjs', []], ['python3 nested.py', []],
    ['python3 after.py', []], ['python3 param.py', []], ['python3 varmode.py', []], ['python3 slash.py', []],
    // `p = 'reused.txt'` is a literal: named; the write through p, bound to a temporary folder too, is not known.
    ['node reuse.mjs', ['reused.txt']],
  ]) {
    const dir = setUp();
    const made = bashMade(script, dir);
    assert.ok(made.length > 0, `bash makes a file: ${script}`);
    const r = shellWrites(script, dir);
    assert.deepEqual(r.files.map((f) => relative(dir, f)), files, script);
    assert.deepEqual(r.unknown.map((u) => u.part), [script], script);
    assert.match(r.unknown[0].why, /names are known only when it runs/u, script);
  }
});

// A literal is a write call's target only when it is the whole argument; code from -c with a target known only when
// it runs, that the fallback names nothing for, is not known. Main named e for `open('e' + 'x', 'w')`, which writes ex.
test('code from -c names a literal only when it is the whole target, and is not known otherwise', { skip: !hasBoth && 'python3 or node is not installed' }, () => {
  for (const script of [`python3 -c "open('e' + 'x', 'w')"`, `python3 -c "open('d-%d' % 1, 'w')"`]) {
    const dir = setUp();
    assert.ok(bashMade(script, dir).length > 0, `bash makes a file: ${script}`);
    const r = shellWrites(script, dir);
    assert.deepEqual(r.files, [], script);
    assert.deepEqual(r.unknown.map((u) => u.part), ['python3 -c'], script);
  }
  const dir = setUp();
  assert.deepEqual(named(`node -e "const s = \\"open('e', 'w')\\"; console.log(s)"`, dir), [], 'a write call inside a string of -e code is data');
});

// Each file is read once per command, and the files one command reads come to 4 MiB at most (SCRIPTS_BUDGET): past
// it a script is not known, with why, never left out. Review of #222: a 750 KB script run 60 times took 7.9 s.
test('a command reads each script once, and gives the scripts past its budget as not known', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-scripts-big-'));
  const body = `import { writeFileSync } from 'node:fs';\n${'const a = 1;\n'.repeat(57000)}writeFileSync('bw', '');\n`;
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, `s${i}.mjs`), body);
  const t = performance.now();
  const same = shellWrites(Array(60).fill('node s0.mjs').join('; '), dir);
  assert.ok(performance.now() - t < 3000, `read in ${performance.now() - t} ms`);
  assert.deepEqual([same.files, same.unknown], [[join(dir, 'bw')], []]);
  const many = shellWrites(Array.from({ length: 8 }, (_, i) => `node s${i}.mjs`).join('; '), dir);
  assert.deepEqual(many.files, [join(dir, 'bw')]);
  assert.deepEqual(many.unknown.map((u) => u.part), ['node s5.mjs', 'node s6.mjs', 'node s7.mjs'], '5 files of 741,066 bytes fit in 4 MiB');
  assert.ok(many.unknown.every((u) => /more than readfirst reads for one command/u.test(u.why)));
});

test('the script a runner runs is found after its options, and none where it runs code or a module', () => {
  const s = (c) => { const r = shellWrites(c, '/r'); return [...r.files, ...r.unknown.map((u) => `?${u.part}`)]; };
  assert.deepEqual(s('node $D/x.mjs'), ['?node $D/x.mjs'], 'a path known only when the command runs');
  assert.deepEqual(s('python3 -mjson.tool f'), []);
  assert.deepEqual(s('perl -ne "print" f'), []);
  assert.deepEqual(s('perl -l /nonexistent/x.pl'), [], 'perl -l takes no next word: the file is /nonexistent/x.pl, not there');
  assert.deepEqual(s('ruby -e "1"'), []);
  assert.deepEqual(s('deno fmt x.ts'), []);
  assert.deepEqual(s('bun install'), []);
  assert.deepEqual(s('node --version'), []);
});
