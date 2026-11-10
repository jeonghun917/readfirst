// Step 4 (2026-11-10): whether the notes were acted on. The hook keeps every call it sees; a call the gate refused and
// then got again with no other edit or command in between counts as "resent" (the notes were likely not read). The
// Stop hook's last line says what the map asked for the files edited, what was done and what was not, and keeps one
// line per session for `readfirst hook --report`, which adds them up and names every item not done.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ACTED_LOG, actedLine, hookReport, runHook, runStopHook } from '../src/cli.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-acted-'));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': 'export const b = 2;\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], checks: [{ run: 'test -f ok.flag', why: 'the flag' }], risks: [{ text: 'a and b move together' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  return root;
}

test('a refused edit made again at once is counted; one with another call in between is not', () => {
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-acted-state-'));
  const edit = (file, now, session = 's1') => runHook(JSON.stringify({ session_id: session, cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, file) } }), { stateDir, gate: true, now });
  assert.match(edit('src/a.js', 1000), /"permissionDecision":"deny"/u, 'first edit refused with its notes');
  assert.equal(edit('src/a.js', 2000), null, 'the same edit again goes through');
  assert.match(edit('src/b.js', 3000), /deny/u);
  runHook(JSON.stringify({ session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command: 'cat src/b.js' } }), { stateDir, gate: true, now: 4000 });
  assert.equal(edit('src/b.js', 5000), null, 'made again after a command in between');
  writeFileSync(join(root, 'src/a.js'), 'export const a = 3;\n');
  writeFileSync(join(root, 'src/b.js'), 'export const b = 4;\n');
  const out = JSON.parse(runStopHook(JSON.stringify({ session_id: 's1', cwd: root, stop_hook_active: false }), { stateDir, timeout: 30 }));
  assert.equal(out.decision, 'block', 'the check fails: ok.flag is missing');
  assert.match(out.reason, /readfirst, this session: notes shown for 2 file\(s\); asked 1 \(checks to run, files that change together\), done 0, not done: `test -f ok\.flag` fail; 1 refused edit\(s\) made again at once/u);
  const logged = readFileSync(join(stateDir, ACTED_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((r) => [r.session, r.shown, r.asked, r.acted, r.resent]), [['s1', 2, 1, 0, 1]]);

  writeFileSync(join(root, 'ok.flag'), '');
  const passed = JSON.parse(runStopHook(JSON.stringify({ session_id: 's1', cwd: root, stop_hook_active: false }), { stateDir, timeout: 30 }));
  assert.match(passed.systemMessage, /done 1; 1 refused edit/u, 'the last stop of the session: the check ran and passed');
  const report = hookReport({ stateDir });
  assert.match(report, /^readfirst hook --report: 1 session\(s\)$/mu, 'one line per session: the last stop counts');
  assert.match(report, /- asked 1, done 1, not done 0/u);
  assert.match(report, /made again at once with nothing in between: 1, in 1 session\(s\)/u);
});

test('the report names every item not done, most often first; with nothing kept it says so', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-acted-report-'));
  assert.match(hookReport({ stateDir }), /no session has been recorded yet/u);
  const rows = [
    { session: 'a', shown: 3, asked: 2, acted: 0, notActed: ['`npm test` not run', 'b.js not changed with a.js'], resent: 0 },
    { session: 'b', shown: 1, asked: 1, acted: 0, notActed: ['`npm test` not run'], resent: 2 },
  ];
  writeFileSync(join(stateDir, ACTED_LOG), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n{cut`);
  const report = hookReport({ stateDir });
  assert.match(report, /2 session\(s\)/u);
  assert.match(report, /Not done, most often first:\n- `npm test` not run \(2\)\n- b\.js not changed with a\.js \(1\)/u);
  assert.equal(actedLine({ shown: 4, asked: 0, resent: 0 }), null, 'notes shown and nothing asked: quiet');
});
