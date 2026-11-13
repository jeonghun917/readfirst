// A single & ends a shell command (it runs the command before it in the background). Until this test the reader
// split commands at ; && || | and new lines only, so in `make & sed -i s/a/b/ f.js` sed was read as make's arguments
// and its write was not seen: the hook gave no notes for f.js and the Stop hook did not check it. The & of &&, >&2,
// 2>&1, &>, <&, |&, a quoted "a & b" and an escaped a\&b end nothing. A `readfirst read` sent to the background is
// not a read (its output need not come back with the call), and the command after its & is still read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashReads, bashWrites } from '../src/bash-writes.mjs';

const writes = (command) => bashWrites(command, '/w');

test('the command after a single & is read: its writes are seen', () => {
  assert.deepEqual(writes('make & sed -i s/a/b/ f.js'), ['/w/f.js']);
  assert.deepEqual(writes('make&sed -i s/a/b/ f.js'), ['/w/f.js'], 'no space around the &');
  assert.deepEqual(writes('sleep 1 & echo x > out.txt'), ['/w/out.txt']);
  assert.deepEqual(writes('npm run watch & cp a.js b.js'), ['/w/b.js']);
});

test('an & that does not end a command splits nothing', () => {
  assert.deepEqual(writes('make && sed -i s/a/b/ f.js'), ['/w/f.js'], '&& was already a separator');
  assert.deepEqual(writes('node x.mjs >&2; node x.mjs 2>&1; node x.mjs 1>&2'), [], 'a duplicated stream is no file');
  assert.deepEqual(writes('node x.mjs &> log.txt'), ['/w/log.txt'], '&> writes its target, as before');
  assert.deepEqual(writes('node x.mjs &>> log.txt'), ['/w/log.txt']);
  assert.deepEqual(writes('cat <&3 > g.txt'), ['/w/g.txt']);
  assert.deepEqual(writes('node x.mjs |& tee t.txt'), ['/w/t.txt']);
  assert.deepEqual(writes('echo "a & b" > q.txt'), ['/w/q.txt'], 'inside quotes');
  assert.deepEqual(writes("echo 'a & sed -i x f.js'"), [], 'a quoted & sed is text');
  assert.deepEqual(writes('echo a\\&b > e.txt'), ['/w/e.txt'], 'an escaped &');
  assert.deepEqual(writes('sleep 1&'), [], 'a background command that writes nothing');
});

test('readfirst read f & sed -i x f: the read is in the background and not a read, the sed is a write', () => {
  assert.deepEqual(bashReads('readfirst read f & sed -i s/a/b/ f', '/w'), [{ files: ['/w/f'], seen: false, why: 'its output was sent elsewhere' }]);
  assert.deepEqual(writes('readfirst read f & sed -i s/a/b/ f'), ['/w/f']);
  assert.deepEqual(bashReads('readfirst read f&', '/w').map((r) => r.seen), [false]);
  assert.deepEqual(bashReads('readfirst read f && readfirst read "a&b.js"', '/w').map((r) => [r.files, r.seen]), [[['/w/f'], true], [['/w/a&b.js'], true]]);
});
