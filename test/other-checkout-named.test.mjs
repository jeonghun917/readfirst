// Files of another checkout are said with that checkout (2026-11-15): the hook said each file relative to its own
// checkout, so a copy from this checkout into a scratch worktree of the same repository was refused as "writing src,
// test, src/cli.mjs" and its notes came as "readfirst notes for src/cli.mjs": the very paths of this checkout, whose
// files the command only read. The refusal and the notes now name the checkout when it is not the one the session's
// folder is in; files in that one read as before.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook } from '../src/cli.mjs';

let n = 0;
function session() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-checkout-')));
  const files = {
    'src/a.js': 'export function alpha() {\n  return 1;\n}\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], checks: [], risks: [{ text: '`alpha` must return 1' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-checkout-wt-'))), 'wt');
  git('worktree', 'add', '-q', wt);
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-checkout-state-'));
  const id = `checkout-${process.pid}-${++n}`;
  let now = Date.now() + 2000;
  const call = (tool, input, cwd = root) => {
    const out = runHook(JSON.stringify({ session_id: id, cwd, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) });
    const h = out ? JSON.parse(out).hookSpecificOutput : null;
    return h?.permissionDecisionReason ?? h?.additionalContext ?? '';
  };
  const edit = (at) => call('Edit', { file_path: join(at, 'src/a.js'), old_string: '  return 1;', new_string: '  return 2;' });
  return { root, wt, call, edit };
}

test('an Edit of a file in another worktree is refused naming that worktree, and its notes say so', () => {
  const { wt, edit } = session();
  const text = edit(wt);
  assert.ok(text.includes(`readfirst refused this Edit of src/a.js in ${wt} (the edit of`), text.split('\n')[0]);
  assert.ok(text.includes(`readfirst notes for src/a.js in ${wt} (from .readfirst/map.json)`), text);
});

test('a Bash copy into another worktree is said as writing there', () => {
  const { wt, call } = session();
  const text = call('Bash', { command: `cp src/a.js ${wt}/src/a.js` });
  assert.ok(text.includes(`(writing src/a.js in ${wt})`), text.split('\n')[0]);
});

test('with the session in a folder in no repository, every checkout is named', () => {
  const { root, call } = session();
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-checkout-out-')));
  const text = call('Edit', { file_path: join(root, 'src/a.js'), old_string: '  return 1;', new_string: '  return 2;' }, out);
  assert.ok(text.includes(`readfirst refused this Edit of src/a.js in ${root} (the edit of`), text.split('\n')[0]);
  assert.ok(text.includes(`readfirst notes for src/a.js in ${root} (from .readfirst/map.json)`), text);
});

test('files of the checkout the session is in read as before', () => {
  const { root, edit } = session();
  const text = edit(root);
  assert.ok(text.includes('readfirst refused this Edit of src/a.js (the edit of'), text.split('\n')[0]);
  assert.ok(text.includes('readfirst notes for src/a.js (from .readfirst/map.json)'), text);
});
