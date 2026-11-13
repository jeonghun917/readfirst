// A redirect glued to the word before it (2026-11-13): `echo hi>file`, `ls>out`, `cat a>b` and `x=1>f` write as surely
// as `echo hi > file`, but the reader took a > as a redirect only after a space or a digit, so it named nothing and
// gave no unknown either: the hook said nothing and the Stop hook did not check the file. Redirect operators are now
// tokens of their own wherever they stand, from one list that splitting words, finding redirects and dropping them
// from arguments all use. Each operator is tested glued and spaced, beside look-alikes that only compare or quote.
import assert from 'node:assert/strict';
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

test('look-alikes that only compare, quote or read write nothing', () => {
  for (const c of ['[[ a>b ]]', '[[ a > b ]]', 'if [[ a>b ]]; then :; fi', 'echo $((a>b))', 'echo $((a > b))', "echo 'a>b'", 'echo "a>b"', 'echo a\\>b', 'cat<in', 'cat <in', 'cat<<<x', 'diff <(sort a) <(sort b)', 'node -e "if(a>b)x()"', 'cat <<EOF\nx>y\nEOF']) {
    assert.deepEqual(writes(c), [], c);
  }
});

test('a readfirst read whose output is sent to a file is not a read, glued or not', () => {
  assert.deepEqual(bashReads('npx readfirst read f.js>/dev/null', '/w').map((r) => [r.files, r.seen]), [[['/w/f.js'], false]]);
  assert.deepEqual(bashReads('npx readfirst read f.js', '/w').map((r) => [r.files, r.seen]), [[['/w/f.js'], true]]);
});
