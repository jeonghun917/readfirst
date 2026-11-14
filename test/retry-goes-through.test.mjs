// Every refusal of `hook --gate` that says what to do and then "make the same call again" lets that call through when
// it is made again as told. Until this test the refusal for files the hook had no time to look up ("no time left in
// this call … Make the same call again and readfirst goes on with them") refused the call again each time the lookup
// ran out of time once more: in a repository too slow for the hook's budget the agent was told to make the same call
// forever. Each other refusal is checked here too, so a new one that cannot be passed fails.
// A different command is a different call: the unknown-write question is asked once per command and folder
// (commandKey), so a command changed between the two calls is asked again (the case that led here: the retry dropped
// a part of the first command, and was refused as a new one).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { bashReads } from '../src/bash-writes.mjs';
import { itemId, runHook, runStopHook } from '../src/cli.mjs';

const RISK = 'alpha returns 1 and callers rely on it';
let n = 0;
function session({ risk = RISK, a = 'export function alpha() {\n  return 1;\n}\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-retry-'));
  const files = {
    'src/a.js': a,
    'src/b.js': 'x\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: risk, files: ['src/a.js'] }], checks: [{ run: 'true', why: 'nothing' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-retry-state-'));
  const id = `retry-${process.pid}-${++n}`;
  let now = 1000;
  const call = (tool, input, opts = {}) => {
    const out = runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000), ...opts });
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };
  const stop = () => { const out = runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 }); return out ? JSON.parse(out) : null; };
  return { root, call, stop };
}
const refused = (out) => out?.permissionDecision === 'deny';

test('each refusal that says to make the same call again lets it through when made again', () => {
  // A write readfirst cannot place before the command runs.
  {
    const { call } = session();
    const c = { command: 'echo x > "$OUT/f.js"' };
    const first = call('Bash', c);
    assert.ok(refused(first));
    assert.match(first.permissionDecisionReason, /make the same call again/u);
    assert.ok(!refused(call('Bash', c)), 'unknown write: made again, through');
  }
  // A command the shell reader throws on.
  {
    const { call } = session();
    const readers = { shellWrites: () => { throw new Error('reader broke'); }, bashReads };
    const c = { command: 'echo hi' };
    assert.ok(refused(call('Bash', c, { readers })));
    assert.ok(!refused(call('Bash', c, { readers })), 'misread: made again, through');
  }
  // New code before `readfirst find`.
  {
    const { root, call } = session();
    const add = { file_path: join(root, 'src/b.js'), old_string: 'x\n', new_string: 'x\nexport function betaHelper() {\n  return 2;\n}\n' };
    call('Edit', { file_path: join(root, 'src/b.js'), old_string: 'x', new_string: 'y' });
    const first = call('Edit', add);
    assert.ok(refused(first));
    assert.match(first.permissionDecisionReason, /then make the same call again/u);
    assert.ok(!refused(call('Edit', add)), 'no find: made again, through');
  }
  // Files the hook had no time to look up: the lookup runs out of time again on the second call (budget 0), as it does
  // in a repository too slow for the hook's budget. The second call goes through, the files still marked for the stop.
  {
    const { root, call } = session();
    const c = { file_path: join(root, 'src/b.js'), old_string: 'x', new_string: 'y' };
    const first = call('Edit', c, { budget: 0 });
    assert.ok(refused(first));
    assert.match(first.permissionDecisionReason, /no time left in this call .*Make the same call again/su);
    const again = call('Edit', c, { budget: 0 });
    assert.ok(!refused(again), 'no time: made again, through');
    assert.match(again.additionalContext, /no time left in this call/u, 'still said, as context');
    assert.doesNotMatch(again.additionalContext, /Make the same call again/u, 'not told to make it again once more');
  }
  // An item to answer: answered as the refusal says, the same call goes through.
  {
    const { root, call } = session();
    const c = { file_path: join(root, 'src/a.js'), old_string: 'return 1;', new_string: 'return 2;' };
    const first = call('Edit', c);
    assert.ok(refused(first));
    assert.match(first.permissionDecisionReason, /answer each of these before this change, .*then make the same call again/su);
    const id = itemId('risk', 'src', RISK);
    assert.equal(call('Bash', { command: `npx readfirst answer '${JSON.stringify([{ item: id, answer: 'done', because: 'the change makes alpha return 2, as asked' }])}'` }), null);
    assert.ok(!refused(call('Edit', c)), 'answered: made again, through');
  }
});

// A file let through with no time to look it up had its rules and risks asked nowhere: in a repository always too slow
// for the budget, the gate's questions were off with no word (review of readfirst#208). The stop names them, once.
test('the items of a file the gate let through unlooked are named at the stop, once; the retry is not counted as resent', () => {
  const { root, call, stop } = session();
  const c = { file_path: join(root, 'src/a.js'), old_string: 'return 1;', new_string: 'return 2;' };
  assert.ok(refused(call('Edit', c, { budget: 0 })));
  assert.ok(!refused(call('Edit', c, { budget: 0 })));
  writeFileSync(join(root, 'src/a.js'), 'export function alpha() {\n  return 2;\n}\n');
  const first = stop();
  assert.equal(first.decision, 'block');
  assert.match(first.reason, new RegExp(`no time to look up src/a\\.js, so its rules and risks were never asked:\\n- \`${itemId('risk', 'src', RISK)}\`: Risk: ${RISK}`, 'u'));
  assert.doesNotMatch(first.reason, /refused edit\(s\) made again at once/u, 'a retry the refusal asked for is not a resend');
  const second = stop();
  assert.notEqual(second?.decision, 'block', 'said once');
  // Looked up on a later call (and so asked there): nothing to name.
  const s2 = session();
  const c2 = { file_path: join(s2.root, 'src/a.js'), old_string: 'return 1;', new_string: 'return 2;' };
  s2.call('Edit', c2, { budget: 0 });
  s2.call('Edit', c2, { budget: 0 });
  assert.ok(refused(s2.call('Edit', c2)), 'a later call with time asks the item');
  writeFileSync(join(s2.root, 'src/a.js'), 'export function alpha() {\n  return 2;\n}\n');
  assert.doesNotMatch(s2.stop()?.reason ?? '', /were never asked/u);
  // Looked up on a later call whose edit does not touch the item: shown, not asked, and not named at the stop either.
  const two = 'export function alpha() {\n  return 1;\n}\n\nexport function gamma() {\n  return 3;\n}\n';
  const s3 = session({ risk: '`alpha` must keep returning 1', a: two });
  const c3 = { file_path: join(s3.root, 'src/a.js'), old_string: 'return 3;', new_string: 'return 4;' };
  s3.call('Edit', c3, { budget: 0 });
  s3.call('Edit', c3, { budget: 0 });
  assert.match(s3.call('Edit', c3).additionalContext, /not touched/u, 'a later call with time shows the item as not touched');
  writeFileSync(join(s3.root, 'src/a.js'), two.replace('return 3;', 'return 4;'));
  assert.doesNotMatch(s3.stop()?.reason ?? '', /were never asked/u);
});

test('the same command that removes a folder and writes a checkout into it is asked once', () => {
  const { call } = session();
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-retry-made-'));
  const c = { command: `R=${dir}/w; rm -rf "$R"; mkdir -p "$R" && cd "$R" && git init -q && for i in 1 2; do echo $i >> d1/f.txt; git add d1/f.txt; done; cd /` };
  const first = call('Bash', c);
  assert.ok(refused(first));
  assert.match(first.permissionDecisionReason, /in a checkout this command makes, not there yet/u);
  assert.ok(!refused(call('Bash', c)), 'the same text: through');
  // Another command, though it writes the same file: asked again.
  assert.ok(refused(call('Bash', { command: c.command.replace('; cd /', '') })));
});
