// Code run from -c, -e or a here-document is read as a script file is (codeWrites in src/bash-writes.mjs): a write
// whose target is not read is not known, whatever else the code names. Until 2026-11-15 such code fell back to the
// paths it names that exist, and the command's raw text had to match CODE_WRITES before the code was read at all:
// `python3 -c "open('$X','w')"` and `find . -exec python3 -c "open('{}','w')" \;` were silent, `node -e` code that
// imported one file and wrote computed paths named the imported file, `open(os.path.join(a, b), 'w')` in a
// here-document was silent, an assignment inside a string made a sure target not known, and in a here-document under
// a tag not quoted `'$E/x'` and a backtick were named as written though bash expands them first.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const B = String.fromCharCode(92);
const NL = '\n';
// What shellWrites gives, the files relative to dir and the not-known writes by their part.
const read = (command, dir) => { const r = shellWrites(command, dir); return { files: r.files.map((f) => relative(dir, f)), unknown: r.unknown.map((u) => u.part) }; };

test('a target known only when the command runs is not known, in -c, -e and under find', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-code-writes-'));
  for (const [command, part] of [
    [`python3 -c "open('$X','w')"`, '$X'],
    [`node -e "require('fs').writeFileSync('$X', '')"`, '$X'],
    [`find . -exec python3 -c "open('{}','w')" ${B};`, '{}'],
    [`find . -exec python3 -c "import sys; open(sys.argv[1],'w')" {} ${B};`, '{}'],
    [`python3 - <<EOF${NL}import os${NL}open(os.path.join('a', 'b.txt'), 'w')${NL}EOF`, 'python3 <<'],
  ]) assert.deepEqual(read(command, dir), { files: [], unknown: [part] }, command);
});

// A file the code names and does not write is not named for a write it cannot place (transcript, 2026-11-14: the
// imported module was named as written, and the computed writes were not said).
test('a write the code cannot place is not known, never one of the files it names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-code-writes-'));
  writeFileSync(join(dir, 'lib.mjs'), 'export const a = 1;\n');
  const command = `node --input-type=module -e "import { writeFileSync } from 'node:fs'; await import('./lib.mjs'); for (let i = 0; i < 3; i++) writeFileSync('out' + i + '.txt', '');"`;
  assert.deepEqual(read(command, dir), { files: [], unknown: ['node -e'] });
});

// An assignment inside a string is data: `p = parens(text)` in a JavaScript string the python code holds is not an
// assignment of p, so its write names p's one literal (transcript, 2026-11-14: it was not known).
test('an assignment inside a string is not one of the code, and python agrees', { skip: !hasPython && 'python3 is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-code-writes-'));
  const command = `python3 - <<'EOF'${NL}p='out.txt'${NL}js = """const p = parens(text, outer.length);"""${NL}open(p,'w').write(js)${NL}EOF`;
  assert.deepEqual(read(command, dir), { files: ['out.txt'], unknown: [] });
  spawnSync('bash', ['-c', command], { cwd: dir });
  assert.ok(existsSync(join(dir, 'out.txt')), 'python wrote out.txt');
  // The same code in a script file (read this way since #222, where the search found the string's `p = ...`).
  writeFileSync(join(dir, 's.py'), `p='out2.txt'${NL}js = """const p = parens(text, outer.length);"""${NL}open(p,'w').write(js)${NL}`);
  assert.deepEqual(read('python3 s.py', dir), { files: ['out2.txt'], unknown: [] });
});

// Under a tag not quoted bash expands `$E` and backticks in the body before python reads it, so a literal holding one
// is not that text; under a quoted tag it is.
test('a here-document target with $ or a backtick is not known under a tag not quoted, and is the text under a quoted one', { skip: !hasPython && 'python3 is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-code-writes-'));
  mkdirSync(join(dir, '$E'));
  assert.deepEqual(read(`E=/w; python3 - <<EOF${NL}p='$E/x.txt'${NL}open(p,'w')${NL}EOF`, dir), { files: [], unknown: ['python3 <<'] });
  assert.deepEqual(read(`python3 - <<EOF${NL}open('\`date\`.txt','w')${NL}EOF`, dir), { files: [], unknown: ['python3 <<'] });
  const quoted = `python3 - <<'EOF'${NL}p='$E/x.txt'${NL}open(p,'w')${NL}EOF`;
  assert.deepEqual(read(quoted, dir), { files: ['$E/x.txt'], unknown: [] });
  spawnSync('bash', ['-c', quoted], { cwd: dir });
  assert.ok(existsSync(join(dir, '$E/x.txt')), 'python wrote $E/x.txt');
});

// What was right stays right.
test('literal targets, sys.argv and names assigned one literal read as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-code-writes-'));
  assert.deepEqual(read(`python3 -c "open('a.txt','w')"`, dir), { files: ['a.txt'], unknown: [] });
  assert.deepEqual(read(`python3 -c "import sys; open(sys.argv[1], 'w')" out.txt`, dir), { files: ['out.txt'], unknown: [] });
  assert.deepEqual(read(`python3 -c "p='package.json'; open(p,'w')"`, dir), { files: ['package.json'], unknown: [] });
  assert.deepEqual(read(`python3 -c "open(p, 'w')"`, dir), { files: [], unknown: ['python3 -c'] });
  assert.deepEqual(read(`python3 -c "print(open('a.txt').read())"`, dir), { files: [], unknown: [] });
});
