// What the gate (`hook --gate`) counts as read. Until this test, a `readfirst read` run in Bash was not counted, so a
// file read that way was refused all the same; and a file shown on one branch stayed shown for six hours, so after a
// switch to another branch its edits went through without the notes that branch's map gives. Now a CLI read counts
// for the branch it ran on, and only when its whole output came back: sent to /dev/null, a file or a pipe, or cut by
// --limit, it is not a read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook, runStopHook } from '../src/cli.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-gate-read-'));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': 'export const b = 1;\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: 'a and b move together' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  return { root, git };
}
let n = 0;
const session = () => `gate-read-${process.pid}-${++n}`;
const hook = (root, stateDir, id, tool, input, now) => runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now });
const decision = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision ?? 'context' : 'through');
const edit = (root) => ({ file_path: join(root, 'src/a.js'), old_string: '= 1', new_string: '= 2' });

test('a readfirst read run in Bash counts as read: the edit after it goes through', () => {
  for (const command of ['npx readfirst read src/a.js', 'node bin/readfirst.mjs read src/a.js --json', 'cd src && npx --yes readfirst read a.js 2>/dev/null', 'npx readfirst read src/b.js src/a.js']) {
    const { root } = repo();
    const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-gate-read-state-'));
    const id = session();
    hook(root, stateDir, id, 'Bash', { command }, 1000);
    assert.equal(decision(hook(root, stateDir, id, 'Edit', edit(root), 2000)), 'through', command);
  }
});

test('a read whose output is thrown away, piped or cut is not a read: the edit is refused with the notes', () => {
  for (const command of ['npx readfirst read src/a.js > /dev/null', 'npx readfirst read src/a.js >/dev/null 2>&1', 'npx readfirst read src/a.js &> /tmp/x.txt', 'npx readfirst read src/a.js | head -3', 'npx readfirst read src/a.js 2>&1 | tail -n 5', 'npx readfirst read src/a.js --limit 1', 'npx readfirst read src/a.js &', 'echo npx readfirst read src/a.js']) {
    const { root } = repo();
    const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-gate-read-state-'));
    const id = session();
    hook(root, stateDir, id, 'Bash', { command }, 1000);
    const out = hook(root, stateDir, id, 'Edit', edit(root), 2000);
    assert.equal(decision(out), 'deny', command);
    assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /a and b move together/u);
  }
});

test('notes shown or read on another branch do not count on this one', () => {
  const { root, git } = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-gate-read-state-'));
  const id = session();
  assert.equal(decision(hook(root, stateDir, id, 'Edit', edit(root), 1000)), 'deny', 'first edit: the notes');
  assert.equal(decision(hook(root, stateDir, id, 'Edit', edit(root), 2000)), 'through', 'made again on the same branch');
  git('checkout', '-q', '-b', 'next');
  assert.equal(decision(hook(root, stateDir, id, 'Edit', edit(root), 3000)), 'deny', 'another branch: the notes again');
  // A CLI read on one branch, an edit on another.
  hook(root, stateDir, id, 'Bash', { command: 'npx readfirst read src/b.js' }, 4000);
  git('checkout', '-q', 'main');
  const other = { file_path: join(root, 'src/b.js'), old_string: '= 1', new_string: '= 2' };
  assert.equal(decision(hook(root, stateDir, id, 'Edit', other, 5000)), 'deny');
  git('checkout', '-q', 'next');
  assert.equal(decision(hook(root, stateDir, id, 'Edit', other, 6000)), 'through', 'back on the branch it was read on');
});

test('the Stop hook does not take a read for an edit, and still checks a file edited after a read', () => {
  const { root, git } = repo();
  // A failing check for src/, on main's map, and a change to src/a.js this session did not make.
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], checks: [{ run: 'false', why: 'fails' }] }] }));
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'a check');
  writeFileSync(join(root, 'src/a.js'), 'export const a = 3;\n');
  utimesSync(join(root, 'src/a.js'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // changed before the session began
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-gate-read-state-'));
  const id = session();
  hook(root, stateDir, id, 'Bash', { command: 'npx readfirst read src/a.js' }, Date.now());
  assert.equal(runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 }), null, 'only read: nothing to check');
  hook(root, stateDir, id, 'Edit', edit(root), Date.now());
  assert.match(String(runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 })), /`false`/u, 'edited after the read: its check is asked for');
});
