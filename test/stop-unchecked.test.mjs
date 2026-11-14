// A stop that cannot check a repository says so (the bug ledger: broken-index-silences-stop, 2026-11-14). stopFor runs
// `git status` first; with a broken .git/index git fails there, and the catch returned null: no checks ran, no answer
// was compared, and the stop said nothing at all, as if there were nothing to check. Now it names the repository and
// git's error, refuses the stop once for that kind of error, and the session's line and `hook --report` count it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ACTED_LOG, hookReport, runHook, runStopHook } from '../src/cli.mjs';

test('a broken index makes the stop say it could not check the repository, refused once, counted in the report', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-unchecked-'));
  const files = {
    'src/a.js': 'export function alpha(x) {\n  return x + 1;\n}\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], checks: [{ run: 'true', why: 'always' }], risks: [{ text: '`alpha` is old' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-unchecked-state-'));
  const id = `unchecked-${process.pid}`;
  runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js'), old_string: 'x + 1', new_string: 'x + 2' } }), { stateDir, now: Date.now() + 5000 });
  writeFileSync(join(root, 'src/a.js'), 'export function alpha(x) {\n  return x + 2;\n}\n');
  writeFileSync(join(root, '.git/index'), 'garbage');
  const stop = () => { const out = runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 }); return out ? JSON.parse(out) : null; };
  const first = stop();
  assert.equal(first?.decision, 'block', `the stop said nothing: ${JSON.stringify(first)}`);
  assert.match(first.reason, /readfirst: the stop could not check this repository \(Error: .*index.*\), so the checks the map lists for the files you edited did not run and no answer was compared with the change\./u);
  assert.match(first.reason, /the stop could not check 1 repository\(ies\), so their checks did not run\./u);
  const again = stop();
  assert.notEqual(again?.decision, 'block', 'refused once for the same kind of error, so a stop cannot loop');
  assert.match(String(again?.systemMessage ?? ''), /the stop could not check this repository/u, 'still said');
  const mine = readFileSync(join(stateDir, ACTED_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.session === id).at(-1);
  assert.equal(mine.unchecked, 1);
  assert.match(hookReport({ stateDir }), /- repositories the stop could not check \(its checks did not run\): [1-9]\d*, in [1-9]\d* session\(s\)/u);
});
