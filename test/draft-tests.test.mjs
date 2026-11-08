import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { draftMap, mapProblems } from '../src/map.mjs';

// Paid review of ca6947a: with test/ and e2e/ both at the top, the drafted 'tests' group kept only test/**.
const FILES = ['src/a.js', 'test/a.test.js', 'tests/b.test.js', 'spec/c_spec.rb', 'e2e/d.spec.js', '__tests__/e.test.js'];

test('draftMap: every top-level tests folder is in the tests group', () => {
  const map = draftMap(FILES);
  assert.deepEqual(map.groups.find((g) => g.id === 'tests').files, ['test/**', 'tests/**', 'spec/**', 'e2e/**', '__tests__/**']);
  assert.deepEqual(mapProblems(map, FILES), []);
});

test('init then check: a repository with test/ and e2e/ gets a map that passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-draft-'));
  for (const f of ['src/a.js', 'test/a.test.js', 'e2e/b.spec.js']) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), '');
  }
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '.']);
  const io = { out: () => {}, err: () => {} };
  assert.equal(main(['--root', root, 'init'], io), 0);
  assert.equal(main(['--root', root, 'check'], io), 0);
});
