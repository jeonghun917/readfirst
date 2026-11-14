// The gate judges each tool call on its own, but an agent sends several in one response and they run one after
// another: when the gate refuses one, those before it have already run and those after it are judged on their own.
// A definition refused while the edits that use it went in left a file half changed, and nothing said so (ledger
// gate-refuses-one-edit-of-a-batch: three sessions on 2026-11-14). The hook cannot see the other calls of a response,
// so the refusal names the call it refuses and says the others were not refused by it, and the stop names every
// refused call that was never made again, once.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { itemId, runHook, runStopHook } from '../src/cli.mjs';

const RISK = 'alpha returns 1 and callers rely on it';
let n = 0;
function session() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-batch-'));
  const files = {
    'src/a.js': 'export function alpha() {\n  return 1;\n}\n',
    'src/b.js': 'export const b = 1;\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: RISK, files: ['src/a.js'] }], checks: [{ run: 'true', why: 'nothing' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-batch-state-'));
  const id = `batch-${process.pid}-${++n}`;
  // After the repository's first commit, so the stop does not count that commit as the session's.
  let now = Date.now() + 2000;
  const call = (tool, input) => {
    const out = runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) });
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };
  const stop = () => { const out = runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 }); return out ? JSON.parse(out) : null; };
  return { root, call, stop };
}
const ALPHA = (root) => ({ file_path: join(root, 'src/a.js'), old_string: '  return 1;', new_string: '  return 2;' });
const B = (root) => ({ file_path: join(root, 'src/b.js'), old_string: 'export const b = 1;', new_string: 'export const b = alpha();' });

test('a refusal names the call it refuses and says the other calls of the response were not refused by it', () => {
  const { root, call } = session();
  const out = call('Edit', ALPHA(root));
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /^readfirst refused this Edit of src\/a\.js \(the edit of `  return 1;`\)\. If it was one of several calls in one response, the others were not refused by this: those before it ran, those after it are judged on their own\./u);
});

test('a call the gate refused and that was never made again is named at the stop, once', () => {
  const { root, call, stop } = session();
  // One response: the edit of a.js refused, the edit of b.js that uses it let through.
  assert.equal(call('Edit', ALPHA(root)).permissionDecision, 'deny');
  assert.notEqual(call('Edit', B(root))?.permissionDecision, 'deny');
  writeFileSync(join(root, 'src/b.js'), 'export const b = alpha();\n');
  const first = stop();
  assert.equal(first?.decision, 'block');
  assert.match(first.reason, /readfirst: the gate refused these calls and they were never made again:\n- Edit of src\/a\.js \(the edit of `  return 1;`\)\nIf one was among several calls of a response, the others went in without it/u);
  assert.doesNotMatch(stop()?.reason ?? '', /never made again/u, 'said once');
});

test('a refused call made again, as the refusal says, is not named', () => {
  const { root, call, stop } = session();
  assert.equal(call('Edit', ALPHA(root)).permissionDecision, 'deny');
  assert.equal(call('Bash', { command: `npx readfirst answer '${JSON.stringify([{ item: itemId('risk', 'src', RISK), answer: 'done', because: 'alpha now returns 2, as asked' }])}'` }), null);
  assert.notEqual(call('Edit', ALPHA(root))?.permissionDecision, 'deny');
  writeFileSync(join(root, 'src/a.js'), 'export function alpha() {\n  return 2;\n}\n');
  assert.doesNotMatch(String(stop()?.reason ?? ''), /never made again/u);
});
