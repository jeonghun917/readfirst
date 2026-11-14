// Which new names the find-first gate asks about (ledger, 2026-11-14): it asked for a find before a name local to a
// function (`const hit = named.find((p) => p)`, `const open = ws.findIndex(...)`, a function declared inside another)
// and before a test file's own helper, though neither can be used from another file. It asks only about names another
// file could use again: the file's top level, a class's members, what a module exports; in a test file, only what it
// exports. Where a name is declared is read from the file's structure (declarations), never guessed from its shape.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { newCode, runHook } from '../src/cli.mjs';

let n = 0;
function session() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-findscope-'));
  const files = {
    'src/a.js': 'export function alpha(ws) {\n  return ws;\n}\n',
    'test/a.test.js': 'import { alpha } from \'../src/a.js\';\nalpha([]);\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', 'test/**', '.readfirst/**'], checks: [{ run: 'true', why: 'nothing' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-findscope-state-'));
  const id = `findscope-${process.pid}-${++n}`;
  let now = Date.now() + 2000;
  const call = (tool, input) => {
    const out = runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) });
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };
  // Each file's notes are shown once first (a Write of what it already holds), so each edit below is judged only for
  // its new names.
  for (const f of ['src/a.js', 'test/a.test.js']) call('Write', { file_path: join(root, f), content: files[f] });
  const edit = (file, from, to) => call('Edit', { file_path: join(root, file), old_string: from, new_string: to });
  return { edit };
}
// The gate's line on new names (`this adds `x`, `y` to f, and no readfirst find ... asked about them`), or ''.
const asked = (out) => (/^.*no `readfirst find` in this session asked about.*$/mu.exec(out?.permissionDecisionReason ?? out?.additionalContext ?? '') ?? [''])[0];

test('a name local to a function is not asked about: a const holding an arrow\'s result, a number, an inner function', () => {
  const { edit } = session();
  const out = edit('src/a.js', '  return ws;\n', '  const named = [];\n  const hit = named.find((p) => p);\n  const open = ws.findIndex((w) => w > 1);\n  function inner() { return open; }\n  return hit ?? inner();\n');
  assert.equal(asked(out), '', 'nothing of it can be used from another file');
});

test('a name of the file\'s top level, a class member or an export is still asked about', () => {
  const { edit } = session();
  const out = edit('src/a.js', '  return ws;\n}\n', '  return ws;\n}\nconst retryPayment = (p) => p;\nclass Ledger {\n  settleAccount() { return 1; }\n}\n');
  assert.match(asked(out), /retryPayment/u);
  assert.match(asked(out), /Ledger/u);
  assert.match(asked(out), /settleAccount/u);
});

// Review of 8666556, each a whole new file written (newCode on a Write).
const added = (rel, content) => newCode('Write', { file_path: join(tmpdir(), 'no-such-dir', rel), content }, join(tmpdir(), 'no-such-dir', rel), rel);

test('a test helper file other tests import from is asked about: Python\'s top level, CommonJS exports', () => {
  assert.deepEqual(added('tests/conftest.py', '@pytest.fixture\ndef db_session():\n    pass\n'), ['db_session'], 'a fixture conftest.py shares');
  assert.deepEqual(added('tests/helpers.py', 'def make_user(name):\n    return name\n'), ['make_user']);
  assert.deepEqual(added('test/helpers.js', 'function makeUser(n) { return n; }\nmodule.exports = { makeUser };\n'), ['makeUser']);
  assert.deepEqual(added('test/a.test.js', 'function rowsFor(n) { return n; }\nrowsFor(1);\n'), [], 'not exported: this test\'s own');
});

test('a method of an exported object is asked about; a method of a class local to a function is not', () => {
  assert.deepEqual(added('src/api.js', 'export const api = {\n  fetchUser() {},\n};\n'), ['fetchUser'], 'used elsewhere as api.fetchUser');
  assert.deepEqual(added('src/outer.js', 'export function outer() {\n  class Local { localMethod() {} }\n}\n'), ['outer'], 'Local and its method are outer\'s');
});

// Review of 86b02f2: what a later statement exports, and its members, were no longer asked about (main asked them all).
test('a name exported by a later statement is exported, and so are its members', () => {
  assert.deepEqual(added('test/h.js', 'function makeUser() {}\nmodule.exports = makeUser;\n'), ['makeUser']);
  assert.deepEqual(added('test/c.js', 'function makeUser() {}\nexport { makeUser };\n'), ['makeUser']);
  assert.deepEqual(added('test/d.js', 'function makeUser() {}\nexport default makeUser;\n'), ['makeUser']);
  assert.deepEqual(added('test/f.js', 'function makeUser() {}\nfunction keep() {}\nexport { makeUser as user };\n'), ['makeUser'], 'keep is this test\'s own');
  assert.deepEqual(added('test/e.js', 'const api = {\n  fetchUser() {},\n};\nmodule.exports = api;\n'), ['fetchUser']);
  assert.deepEqual(added('src/a.js', 'const api = {\n  fetchUser() {},\n};\nexport default api;\n'), ['fetchUser']);
  assert.deepEqual(added('src/b.js', 'const api = {\n  fetchUser() {},\n};\nexport { api };\n'), ['fetchUser']);
});

test('a local of an unnamed default function is not asked about', { todo: 'declarations reads the body of `export default function () {}` as the top level' }, () => {
  assert.deepEqual(added('src/d.js', 'export default function () {\n  const computeTotal = () => 1;\n}\n'), []);
});

test('a test file\'s helper is not asked about unless the file exports it', () => {
  const { edit } = session();
  assert.equal(asked(edit('test/a.test.js', 'alpha([]);\n', 'function makeRows() { return []; }\nalpha(makeRows());\n')), '', 'a helper of this test alone');
  const { edit: again } = session();
  assert.match(asked(again('test/a.test.js', 'alpha([]);\n', 'export function sharedRows() { return []; }\nalpha(sharedRows());\n')), /sharedRows/u, 'exported: another test can use it');
});
