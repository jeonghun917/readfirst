import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashWrites } from '../src/bash-writes.mjs';

test('bashWrites: where a command writes, not every file it names', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w(`sed -i 's/a/b/' src/x.mjs`), ['/r/src/x.mjs']);
  assert.deepEqual(w('perl -pi -e "s/a/b/" lib/y.pl'), ['/r/lib/y.pl']);
  assert.deepEqual(w('cat src/a.js > /tmp/out.txt && npm test'), ['/tmp/out.txt']);
  assert.deepEqual(w('cd /r/sub && echo hi >> notes.md'), ['/r/sub/notes.md']);
  assert.deepEqual(w("python3 - <<'E'\np='src/map.mjs'; s=open(p).read()\nopen(p,'w').write(s)\nE"), ['/r/src/map.mjs']);
  assert.deepEqual(w("python3 - <<'E'\nprint(open('src/map.mjs').read())\nE"), [], 'a script that only reads');
  assert.deepEqual(w("cat > test/x.test.mjs <<'E'\nimport fs from 'node:fs'; fs.writeFileSync('a.json', '')\nE"), ['/r/test/x.test.mjs'], 'a here-document fed to cat is data');
  assert.deepEqual(w('cp vendor/a.js lib/a.js'), ['/r/lib/a.js']);
  assert.deepEqual(w('echo x | tee -a log/a.txt b.txt'), ['/r/log/a.txt', '/r/b.txt']);
  assert.deepEqual(w('git checkout -- src/a.js'), ['/r/src/a.js']);
  assert.deepEqual(w('grep -n foo src/a.js 2>/dev/null | head'), []);
  assert.deepEqual(w('node --test test/a.test.mjs 2>&1 | tail -3'), []);
  assert.deepEqual(w('ls > $OUT'), [], 'a variable is not a path we can name');
});
