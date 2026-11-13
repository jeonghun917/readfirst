// The hook's own failures (2026-11-13): a shell reader that throws made runHook's catch return null, so the command went
// through with no word, as if it wrote nothing. Now a reader that throws is a write readfirst cannot place (refused once
// with --gate, let through when made again), and any other error the hook meets is kept in its state; the Stop hook's
// line and `hook --report` count both.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACTED_LOG, hookReport, runHook, runStopHook } from '../src/cli.mjs';
import { bashReads, shellWrites } from '../src/bash-writes.mjs';

const boom = () => { throw new RangeError('Maximum call stack size exceeded'); };
const bash = (session, cwd, command) => JSON.stringify({ session_id: session, cwd, tool_name: 'Bash', tool_input: { command } });

test('a shell reader that throws: refused once as a write it cannot place, let through when made again, counted', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'readfirst-misread-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-misread-state-'));
  const readers = { shellWrites: boom, bashReads };
  const first = runHook(bash('m1', cwd, 'echo hi > out.txt'), { stateDir, gate: true, now: 1000, readers });
  assert.ok(first, 'the throw is not a silent pass');
  const out = JSON.parse(first).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /readfirst hit an error reading it \(RangeError: Maximum call stack size exceeded\)/u);
  assert.match(out.permissionDecisionReason, /`echo hi > out\.txt`/u, 'the whole command is named');
  assert.equal(runHook(bash('m1', cwd, 'echo hi > out.txt'), { stateDir, gate: true, now: 2000, readers }), null, 'made again, it goes through');

  const stop = JSON.parse(runStopHook(JSON.stringify({ session_id: 'm1', cwd, stop_hook_active: false }), { stateDir, timeout: 30 }));
  assert.match(stop.systemMessage, /readfirst hit an error reading 1 command\(s\), refused once as writes it could not place/u);
  const logged = readFileSync(join(stateDir, ACTED_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((r) => [r.session, r.misread, r.failed]), [['m1', 1, []]]);
  assert.match(hookReport({ stateDir }), /- commands readfirst hit an error reading \(refused once as writes it could not place\): 1, in 1 session\(s\)/u);
});

test('a long command is quoted in part, and the line says how much was left out', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'readfirst-misread-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-misread-state-'));
  const command = `echo "${'$(( '.repeat(8000)}"`;
  const out = JSON.parse(runHook(bash('m5', cwd, command), { stateDir, gate: true, now: 1000, readers: { shellWrites: boom, bashReads } })).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, new RegExp(`… \\(${command.length} characters, ${command.length - 200} left out\\)`, 'u'));
  assert.ok(out.permissionDecisionReason.length < 2000, `the refusal is ${out.permissionDecisionReason.length} characters`);
  assert.equal(runHook(bash('m5', cwd, command), { stateDir, gate: true, now: 2000, readers: { shellWrites: boom, bashReads } }), null, 'made again, it goes through');
});

test('bashReads that throws is the same; without --gate the line is context, never a refusal', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'readfirst-misread-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-misread-state-'));
  const gated = JSON.parse(runHook(bash('m2', cwd, 'cat a.txt'), { stateDir, gate: true, now: 1000, readers: { shellWrites, bashReads: boom } })).hookSpecificOutput;
  assert.equal(gated.permissionDecision, 'deny');
  assert.match(gated.permissionDecisionReason, /readfirst hit an error reading it/u);
  const plain = JSON.parse(runHook(bash('m3', cwd, 'cat a.txt'), { stateDir, now: 1000, readers: { shellWrites: boom, bashReads } })).hookSpecificOutput;
  assert.equal(plain.permissionDecision, undefined);
  assert.match(plain.additionalContext, /readfirst hit an error reading it/u);
});

test('a state folder that cannot be written: a reader that throws is passed as context, not refused forever', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'readfirst-misread-'));
  const stateDir = join(mkdtempSync(join(tmpdir(), 'readfirst-misread-state-')), 'a-file');
  writeFileSync(stateDir, '');
  const readers = { shellWrites: boom, bashReads };
  for (const now of [1000, 2000]) {
    const out = JSON.parse(runHook(bash('m4', cwd, 'echo hi > out.txt'), { stateDir, gate: true, now, readers })).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, 'never refused when the refusal cannot be remembered');
    assert.match(out.additionalContext, /readfirst hit an error reading it/u);
  }
});

test('any other error in the hook lets the call through and is kept: the Stop hook and the report name it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'readfirst-failed-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-failed-state-'));
  // A file_path that is not a string throws in the Edit path (path.isAbsolute).
  const edit = JSON.stringify({ session_id: 'f1', cwd, tool_name: 'Edit', tool_input: { file_path: 5 } });
  assert.equal(runHook(edit, { stateDir, gate: true, now: 1000 }), null, 'never fails closed');
  assert.equal(runHook(edit, { stateDir, gate: true, now: 2000 }), null, 'the same error again: one error, not two');
  const stop = JSON.parse(runStopHook(JSON.stringify({ session_id: 'f1', cwd, stop_hook_active: false }), { stateDir, timeout: 30 }));
  assert.match(stop.systemMessage, /the hook failed and let calls through unchecked, with 1 different error\(s\) \(Edit:TypeError: The "path" argument must be of type string/u);
  const report = hookReport({ stateDir });
  assert.match(report, /- errors the hook let calls through unchecked on: 1 different, in 1 session\(s\)/u);
  assert.match(report, /Hook errors, in most sessions first:\n- Edit:TypeError: The "path" argument must be of type string.* \(1\)$/mu);
});

test('report lines written before these fields count them as zero', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-failed-old-'));
  writeFileSync(join(stateDir, ACTED_LOG), `${JSON.stringify({ session: 'old', shown: 1, asked: 1, acted: 1, notActed: [], resent: 0 })}\n`);
  const report = hookReport({ stateDir });
  assert.match(report, /hit an error reading \(refused once as writes it could not place\): 0, in 0 session\(s\)/u);
  assert.match(report, /errors the hook let calls through unchecked on: 0 different, in 0 session\(s\)/u);
  assert.doesNotMatch(report, /Hook errors/u);
});
