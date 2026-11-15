// A file a Bash command writes has no edit to judge, so the gate asks every item of it (not judged: no edit). An agent
// that changed code with sed was asked 23 items at once and did not know why (2026-11-15). The refusal now says that
// the same change made with an edit tool is judged and asks only what it touches; an Edit's refusal does not say it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';
import { runHook } from '../src/cli.mjs';

// noEditTool is not the files removed: mv's destination is in it (written, by a move), its source in no list.
test('shellWrites gives the files a command writes only by removing or moving them as noEditTool', () => {
  const at = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-noedit-')));
  const r = (c) => shellWrites(c, at).noEditTool.map((f) => f.slice(at.length + 1)).sort();
  assert.deepEqual(r('rm a b; unlink c'), ['a', 'b', 'c']);
  assert.deepEqual(r('git mv a b'), ['a', 'b']);
  assert.deepEqual(r('mv a d/b'), ['d/b']);
  assert.deepEqual(r('mv -t d a'), ['d']);
  assert.deepEqual(r('rm a; echo x > a; touch t; cp a c'), []);
  assert.deepEqual(r("bash -c 'rm a'"), ['a']);
  assert.deepEqual(r('sed -i s/x/y/ a'), []);
});

let n = 0;
function session() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-bashhint-')));
  const files = {
    'src/a.js': 'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], checks: [], risks: [{ text: '`alpha` must return 1' }, { text: '`beta` must return 2' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-bashhint-state-'));
  const id = `bashhint-${process.pid}-${++n}`;
  let now = Date.now() + 2000;
  const call = (tool, input) => {
    const out = runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) });
    const h = out ? JSON.parse(out).hookSpecificOutput : null;
    return { refused: h?.permissionDecision === 'deny', text: h?.permissionDecisionReason ?? h?.additionalContext ?? '' };
  };
  return { root, call };
}
const HINT = /the same change made with Edit, MultiEdit or Write is judged, and asks only the items it touches/u;

test('a Bash write asks every item, and the refusal says an edit tool would ask only what it touches', () => {
  const { call } = session();
  const r = call('Bash', { command: 'sed -i s/1/9/ src/a.js' });
  assert.ok(r.refused);
  assert.match(r.text, /not judged: no edit to judge it against/u);
  assert.match(r.text, HINT);
});

// No edit tool removes or moves a file, so a command that only does that is not told to use one (review of #243: the
// hint was on `rm src/a.js` and `git mv src/a.js src/x.js`).
for (const command of ['rm src/a.js', 'unlink src/a.js', 'git rm -q src/a.js', 'git mv src/a.js src/x.js', 'mv src/a.js src/x.js']) {
  test(`a command that only removes or moves a file is asked without the hint: ${command}`, () => {
    const { call } = session();
    const r = call('Bash', { command });
    assert.ok(r.refused, r.text);
    assert.match(r.text, /not judged: no edit to judge it against/u);
    assert.doesNotMatch(r.text, HINT);
  });
}

// A command that writes a file's content keeps the hint, also beside a removal, and a file removed then written again
// is a content write.
for (const command of ['cp src/a.js src/b.js', 'echo x > src/a.js', 'rm src/b.js; sed -i s/1/9/ src/a.js', 'rm src/a.js && echo x > src/a.js']) {
  test(`a command that writes a file's content keeps the hint: ${command}`, () => {
    const { root, call } = session();
    writeFileSync(join(root, 'src/b.js'), 'export const b = 1;\n');
    const r = call('Bash', { command });
    assert.ok(r.refused, r.text);
    assert.match(r.text, HINT);
  });
}

test('an Edit of the same file asks only the item it touches, and says nothing of it', () => {
  const { root, call } = session();
  const r = call('Edit', { file_path: join(root, 'src/a.js'), old_string: '  return 1;', new_string: '  return 9;' });
  assert.ok(r.refused);
  assert.match(r.text, /touched by `alpha`/u);
  assert.doesNotMatch(r.text, /`risk:src:[0-9a-f]{8}` \(not touched/u);
  assert.doesNotMatch(r.text, HINT);
});
