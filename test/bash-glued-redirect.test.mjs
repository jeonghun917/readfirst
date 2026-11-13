// A redirect glued to the word before it (2026-11-13): `echo hi>file`, `ls>out`, `cat a>b` and `x=1>f` write as surely
// as `echo hi > file`, but the reader took a > as a redirect only after a space or a digit, so it named nothing and
// gave no unknown either: the hook said nothing and the Stop hook did not check the file. Redirect operators are now
// tokens of their own wherever they stand, from one list that splitting words, finding redirects and dropping them
// from arguments all use. Each operator is tested glued and spaced, beside look-alikes that only compare or quote.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashReads, bashWrites } from '../src/bash-writes.mjs';

const writes = (command) => bashWrites(command, '/w');

test('each operator that writes, glued to the word before it or not', () => {
  for (const [op, glued, spaced] of [
    ['>', 'echo hi>f.txt', 'echo hi > f.txt'],
    ['>>', 'echo hi>>f.txt', 'echo hi >> f.txt'],
    ['>|', 'echo hi>|f.txt', 'echo hi >| f.txt'],
    ['&>', 'echo hi&>f.txt', 'echo hi &> f.txt'],
    ['&>>', 'echo hi&>>f.txt', 'echo hi &>> f.txt'],
    ['N>', 'echo hi 2>f.txt', 'echo hi 2> f.txt'],
    ['>&word', 'echo hi>&f.txt', 'echo hi >& f.txt'],
    ['<>', 'cat<>f.txt', 'cat <> f.txt'],
  ]) {
    assert.deepEqual(writes(glued), ['/w/f.txt'], `${op} glued: ${glued}`);
    assert.deepEqual(writes(spaced), ['/w/f.txt'], `${op} spaced: ${spaced}`);
  }
  assert.deepEqual(writes('echo hi>file'), ['/w/file']);
  assert.deepEqual(writes('ls>out'), ['/w/out']);
  assert.deepEqual(writes('cat a>b'), ['/w/b']);
  assert.deepEqual(writes('echo>f'), ['/w/f']);
  assert.deepEqual(writes('x=1>f'), ['/w/f'], 'after an assignment: the shell writes f');
  assert.deepEqual(writes('sed s/a/b/ in>out'), ['/w/out']);
  assert.deepEqual(writes('cd a; echo hi>file'), ['/w/a/file'], 'from the folder the cd moved to');
  assert.deepEqual(writes('echo a2>e'), ['/w/e'], 'a2 is a word, not a descriptor: stdout goes to e');
  assert.deepEqual(writes('echo a=>b; echo a->c'), ['/w/b', '/w/c'], 'the shell writes b and c');
  assert.deepEqual(writes('echo a>f3>f4'), ['/w/f3', '/w/f4'], 'a target ends at the next operator');
});

test('a descriptor copied or closed is no file, glued or not', () => {
  for (const c of ['echo hi>&2', 'echo hi >&2', 'echo hi 2>&1', 'echo hi 2>&1 | cat', 'echo hi 1>&2', 'echo hi>&-', 'exec 3<&0', 'cat<&3', 'echo hi >&"$fd"']) {
    assert.deepEqual(writes(c), [], c);
  }
  // A number before >& and a word after it: the shell stops with "ambiguous redirect" and makes no file.
  assert.deepEqual(writes('echo hi 2>&1echo'), []);
  assert.deepEqual(writes('echo hi 2>&1 >k'), ['/w/k']);
});

test('a segment the shell cannot parse writes nothing', () => {
  // bash 5.2: "syntax error near unexpected token `1'" (digits right after an operator are a descriptor) and `newline'.
  for (const c of ['echo a>1>f', 'cat<1>h', 'echo a>>1>i', 'echo a>']) assert.deepEqual(writes(c), [], c);
  // After >& the digits are the descriptor copied, and the next > writes: bash makes f and g.
  assert.deepEqual(writes('echo a 2>&1>f'), ['/w/f']);
  assert.deepEqual(writes('echo a>&1>g'), ['/w/g']);
  assert.deepEqual(writes('echo a >1 2>k'), ['/w/1', '/w/k'], 'spaced, 1 is a target');
});

test('look-alikes that only compare, quote or read write nothing', () => {
  for (const c of ['[[ a>b ]]', '[[ a > b ]]', 'if [[ a>b ]]; then :; fi', 'echo $((a>b))', 'echo $((a > b))', "echo 'a>b'", 'echo "a>b"', 'echo a\\>b', 'cat<in', 'cat <in', 'cat<<<x', 'diff <(sort a) <(sort b)', 'node -e "if(a>b)x()"', 'cat <<EOF\nx>y\nEOF']) {
    assert.deepEqual(writes(c), [], c);
  }
});

// Every command above that bash can run on its own, run by bash in an empty folder: the files it makes are the files
// readfirst names, no more and no fewer.
const AGAINST_BASH = [
  'echo hi>f.txt', 'echo hi > f.txt', 'echo hi>>f.txt', 'echo hi>|f.txt', 'echo hi&>f.txt', 'echo hi&>>f.txt',
  'echo hi 2>f.txt', 'echo hi>&f.txt', 'echo hi >& f.txt', 'cat<>f.txt', 'echo hi>file', 'ls>out', 'echo>f', 'x=1>f',
  'echo a2>e', 'echo a=>b; echo a->c', 'echo ->c', 'echo a>f3>f4', 'echo hi>&2', 'echo hi 2>&1', 'echo hi>&-',
  'echo hi 2>&1echo', 'echo hi 2>&1 >k', 'echo a>1>f', 'echo a>>1>i', 'echo a>', 'echo a 2>&1>f', 'echo a>&1>g',
  'echo a >1 2>k', '[[ a>b ]]', '[[ a > b ]]', 'if [[ a>b ]]; then :; fi', 'echo $((a>b))', 'echo $((a > b))',
  "echo 'a>b'", 'echo "a>b"', 'echo a\\>b', 'cat<<<x', 'cat <<EOF\nx>y\nEOF',
];
test('against bash: the files each command makes are the files readfirst names', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 && 'no bash here' }, () => {
  for (const c of AGAINST_BASH) {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-glued-'));
    spawnSync('bash', ['-c', c], { cwd: dir, stdio: 'ignore', timeout: 5000, env: { PATH: process.env.PATH } });
    assert.deepEqual(bashWrites(c, dir).map((f) => f.slice(dir.length + 1)).sort(), readdirSync(dir).sort(), c);
  }
});

test('a readfirst read whose output is sent to a file is not a read, glued or not', () => {
  assert.deepEqual(bashReads('npx readfirst read f.js>/dev/null', '/w').map((r) => [r.files, r.seen]), [[['/w/f.js'], false]]);
  assert.deepEqual(bashReads('npx readfirst read f.js', '/w').map((r) => [r.files, r.seen]), [[['/w/f.js'], true]]);
});
