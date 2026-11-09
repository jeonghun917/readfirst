// The Stop hook counted a file the session committed as edited (0.26.4/0.27.0), but looked for its "change together"
// partner only among uncommitted and branch changes: a pair committed together in the session was reported as left
// behind (readfirst's own session, 2026-11-09: package.json and server.json, src/agents.mjs and docs/guide.md, each
// pair in the same commits, all merged). Reproduced on 0.27.1 first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook, runStopHook } from '../src/cli.mjs';
import { MAP_FORMAT } from '../src/map.mjs';

const OLD = '2020-01-01T00:00:00Z';
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-together-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (args, when = OLD) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
  git(['init', '-q', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return { root, git };
}
const MAP = JSON.stringify({ format: MAP_FORMAT, groups: [{ id: 'all', title: 'all', files: ['**'] }], requires: [{ when: ['package.json'], also: ['server.json'], why: 'versions match' }] });

test('Stop hook: a "change together" pair committed in the session counts as changed together', () => {
  const { root, git } = repo({ 'package.json': '{"version":"1.0.0"}\n', 'server.json': '{"version":"1.0.0"}\n', '.readfirst/map.json': MAP });
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-together-state-'));
  const t = Date.now();
  runHook(JSON.stringify({ session_id: 't1', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'package.json') } }), { stateDir, now: t });
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.1"}\n');
  writeFileSync(join(root, 'server.json'), '{"version":"1.0.1"}\n');
  git(['commit', '-qam', 'bump both'], new Date(t + 2000).toISOString());
  const out = runStopHook(JSON.stringify({ session_id: 't1', cwd: root }), { stateDir, timeout: 30 });
  assert.ok(!out || JSON.parse(out).decision !== 'block', out ?? '');

  // Only one of the pair committed: still said.
  // A later session: the commit that bumped both is from before it and does not count for it.
  runHook(JSON.stringify({ session_id: 't2', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'package.json') } }), { stateDir, now: t + 4000 });
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.2"}\n');
  git(['commit', '-qam', 'bump one'], new Date(t + 6000).toISOString());
  const left = JSON.parse(runStopHook(JSON.stringify({ session_id: 't2', cwd: root }), { stateDir, timeout: 30 }));
  assert.equal(left.decision, 'block');
  assert.match(left.reason, /package\.json changed, but none of server\.json did/u);
});
