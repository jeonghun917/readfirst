// `readfirst find` before new code (2026-11-10): the notes files asked for it, and a session wrote seven new functions
// without it, because read was enforced by the gate and find only written. With --gate, an edit that declares a function
// its file did not have, in a repository with a map, before find ran there, is refused once with the names and the
// command; made again it goes through and is counted at the stop. Running find first lets it through at once.
// Which find: until the release after 0.31.0 any find, once, opened the gate for the whole session, so one search at
// the start covered every function written afterwards. A find counts for a new name when its query shares a word with
// the name, or when it ran after the gate asked about that name.
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
  assert.match(refused.hookSpecificOutput.permissionDecisionReason, /adds `betaHelper` to src\/a\.js, and no `readfirst find` in this session asked about it\. Run `npx readfirst find "<what it does>"` first/u);
  const again = JSON.parse(call(root, stateDir, 'Edit', add, 4000));
  assert.equal(again.hookSpecificOutput.permissionDecision, undefined, 'made again: through, with the line as context');
  writeFileSync(file, 'export function alpha() {\n  return 1;\n}\nexport function betaHelper() {\n  return 2;\n}\n');
  const stop = JSON.parse(runStopHook(JSON.stringify({ session_id: 's', cwd: root }), { stateDir, timeout: 30 }));
  assert.match(stop.systemMessage, /1 edit\(s\) added new functions without `readfirst find` first/u);
});

test('a find that asked about the new name lets it through; no map, or no new names, says nothing', () => {
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-find-state-'));
  const file = join(root, 'src/a.js');
  call(root, stateDir, 'Edit', { file_path: file, old_string: 'return 1;', new_string: 'return 2;' }, 1000);
  call(root, stateDir, 'Bash', { command: 'npx readfirst find "retry a payment that failed" --json' }, 2000);
  assert.equal(String(call(root, stateDir, 'Write', { file_path: join(root, 'src/b.js'), content: 'export function retryPayment() {}\n' }, 3000)).includes('readfirst find'), false);
  const bare = repo({ map: false });
  const bareState = mkdtempSync(join(tmpdir(), 'readfirst-find-state-'));
  assert.equal(String(call(bare, bareState, 'Write', { file_path: join(bare, 'src/c.js'), content: 'export function delta() {}\n' }, 1000)).includes('readfirst find'), false, 'a repository with no map is not readfirst\'s to gate');
});

test('a find about something else does not open the gate for every later function', () => {
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-find-state-'));
  call(root, stateDir, 'Bash', { command: 'node bin/readfirst.mjs find "retry a payment that failed"' }, 1000);
  const write = { file_path: join(root, 'src/b.js'), content: 'export function retryPayment() {}\nexport function parseInvoice() {}\n' };
  const refused = JSON.parse(call(root, stateDir, 'Write', write, 2000));
  assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
  const reason = refused.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /adds `parseInvoice` to src\/b\.js, and no `readfirst find` in this session asked about it/u, 'only the name no find asked about');
  assert.equal(reason.includes('`retryPayment`'), false);
  // An option's name is not a word of the query: --json does not cover parseJson.
  call(root, stateDir, 'Bash', { command: 'npx readfirst find "retry a payment" --json --limit=5' }, 2500);
  const json = JSON.parse(call(root, stateDir, 'Write', { file_path: join(root, 'src/c.js'), content: 'export function parseJson() {}\n' }, 2600));
  assert.match(json.hookSpecificOutput.permissionDecisionReason, /adds `parseJson` to src\/c\.js/u);
});

test('after the gate asked, any find lets the same call through, and it is not counted at the stop', () => {
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-find-state-'));
  const file = join(root, 'src/b.js');
  const write = { file_path: file, content: 'export function unjoin() {}\n' };
  assert.equal(JSON.parse(call(root, stateDir, 'Write', write, 1000)).hookSpecificOutput.permissionDecision, 'deny');
  // The query shares no word with the name: it still answers the ask, because it ran after it.
  call(root, stateDir, 'Bash', { command: 'npx readfirst find "split names written with a slash between them"' }, 2000);
  const again = call(root, stateDir, 'Write', write, 3000);
  assert.equal(String(again).includes('readfirst find'), false, String(again));
  writeFileSync(file, write.content);
  const stop = runStopHook(JSON.stringify({ session_id: 's', cwd: root }), { stateDir, timeout: 30 });
  assert.equal(String(stop).includes('without `readfirst find`'), false, String(stop));
  // The same file given another new name later is asked again: the first ask does not cover it.
  const more = { file_path: file, content: 'export function unjoin() {}\nexport function parseInvoice() {}\n' };
  const asked = JSON.parse(call(root, stateDir, 'Write', more, 4000));
  assert.equal(asked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(asked.hookSpecificOutput.permissionDecisionReason, /adds `parseInvoice` to src\/b\.js/u);
});
