// `readfirst find` before new code (2026-11-10): the notes files asked for it, and a session wrote seven new functions
// without it, because read was enforced by the gate and find only written. With --gate, an edit that declares a function
// its file did not have, in a repository with a map, before find ran there, is refused once with the names and the
// command; made again it goes through and is counted at the stop. Running find first lets it through at once.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook, runStopHook } from '../src/cli.mjs';

function repo({ map = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-find-'));
  const files = { 'src/a.js': 'export function alpha() {\n  return 1;\n}\n', ...(map ? { '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], checks: [{ run: 'true', why: 'nothing' }] }] }) } : {}) };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  return root;
}
const call = (root, stateDir, tool, input, now) => runHook(JSON.stringify({ session_id: 's', cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now });

test('an edit that adds a function before find ran is refused once, names it, and is counted at the stop', () => {
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-find-state-'));
  const file = join(root, 'src/a.js');
  assert.match(call(root, stateDir, 'Edit', { file_path: file, old_string: 'return 1;', new_string: 'return 2;' }, 1000), /deny/u, 'the first edit of the file: its notes');
  assert.equal(call(root, stateDir, 'Edit', { file_path: file, old_string: 'return 1;', new_string: 'return 2;' }, 2000), null, 'no new function: nothing to say');
  const add = { file_path: file, old_string: '  return 1;\n}\n', new_string: '  return 1;\n}\nexport function betaHelper() {\n  return 2;\n}\n' };
  const refused = JSON.parse(call(root, stateDir, 'Edit', add, 3000));
  assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(refused.hookSpecificOutput.permissionDecisionReason, /adds `betaHelper` to src\/a\.js, and `readfirst find` has not run in this session\. Run `npx readfirst find "<what it does>"` first/u);
  const again = JSON.parse(call(root, stateDir, 'Edit', add, 4000));
  assert.equal(again.hookSpecificOutput.permissionDecision, undefined, 'made again: through, with the line as context');
  writeFileSync(file, 'export function alpha() {\n  return 1;\n}\nexport function betaHelper() {\n  return 2;\n}\n');
  const stop = JSON.parse(runStopHook(JSON.stringify({ session_id: 's', cwd: root }), { stateDir, timeout: 30 }));
  assert.match(stop.systemMessage, /1 edit\(s\) added new functions without `readfirst find` first/u);
});

test('find run first lets new code through; no map, or no new names, says nothing', () => {
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-find-state-'));
  const file = join(root, 'src/a.js');
  call(root, stateDir, 'Edit', { file_path: file, old_string: 'return 1;', new_string: 'return 2;' }, 1000);
  call(root, stateDir, 'Bash', { command: 'npx readfirst find "a helper that adds one"' }, 2000);
  assert.equal(String(call(root, stateDir, 'Write', { file_path: join(root, 'src/b.js'), content: 'export function gamma() {}\n' }, 3000)).includes('readfirst find'), false);
  const bare = repo({ map: false });
  const bareState = mkdtempSync(join(tmpdir(), 'readfirst-find-state-'));
  assert.equal(String(call(bare, bareState, 'Write', { file_path: join(bare, 'src/c.js'), content: 'export function delta() {}\n' }, 1000)).includes('readfirst find'), false, 'a repository with no map is not readfirst\'s to gate');
});
