import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashWrites } from '../src/bash-writes.mjs';

// Paid review of ca6947a: read-only commands taken for writes, and option values taken for the files written.
test('bashWrites: perl -M<module> and -I<dir> are not in-place edits', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w(`perl -Mstrict -ne 'print if /x/' f.txt`), []);
  assert.deepEqual(w(`perl -MFile::Basename -e 'print basename($ARGV[0])' f.txt`), []);
  assert.deepEqual(w(`perl -Ilib -ne 'print' f.txt`), []);
  assert.deepEqual(w(`perl -i.bak -pe 's/a/b/' f.txt`), ['/r/f.txt'], '-i<suffix> still is');
  assert.deepEqual(w(`perl -pi -e 's/a/b/' f.txt`), ['/r/f.txt']);
  assert.deepEqual(w(`sed --in-place 's/a/b/' f.txt`), ['/r/f.txt']);
  assert.deepEqual(w(`sed -Ei 's/a/b/' f.txt`), ['/r/f.txt'], 'a cluster of flag letters ending in i');
});

test('bashWrites: option values and < redirects are not files written', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w('truncate -s 0 f.log'), ['/r/f.log']);
  assert.deepEqual(w('tee -a log.txt < x'), ['/r/log.txt']);
  assert.deepEqual(w('cp -t dest src.txt'), ['/r/dest']);
  assert.deepEqual(w('cp --target-directory=out a.txt b.txt'), ['/r/out']);
  assert.deepEqual(w('mv -t /tmp/d a.txt'), ['/tmp/d']);
  assert.deepEqual(w(`sed -i -e 's/a/b/' -e 's/c/d/' f.txt`), ['/r/f.txt']);
  assert.deepEqual(w(`sed -i -f fix.sed f.txt`), ['/r/f.txt']);
});

test('bashWrites: perl -l and -0 take only digits, so the letters after them are still read', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w(`perl -i -lne 'print' -e 'print 2' f.txt`), ['/r/f.txt']);
  assert.deepEqual(w(`perl -0777 -i -pe 's/a/b/' f.txt`), ['/r/f.txt']);
  assert.deepEqual(w(`perl -lne 'print' f.txt`), []);
});
