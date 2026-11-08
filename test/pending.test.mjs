import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runHook } from '../src/cli.mjs';
import { pendingDue, pendingLine, pendingUpkeep } from '../src/pending.mjs';

const git = (root, env, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env } });

// A clone whose origin has main and an upkeep branch with map edits from three merges, the oldest on 2026-10-20.
function clone() {
  const root = mkdtempSync(join(tmpdir(), 'rf-pending-'));
  git(root, {}, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.js'), 'x\n');
  git(root, {}, 'add', '.'); git(root, {}, 'commit', '-q', '-m', 'start');
  git(root, {}, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, {}, 'checkout', '-q', '-b', 'up');
  mkdirSync(join(root, '.readfirst'), { recursive: true });
  for (const [n, day] of [[3, '2026-10-20'], [5, '2026-10-24'], [6, '2026-10-30']]) {
    writeFileSync(join(root, '.readfirst/map.json'), `{"n":${n}}\n`);
    git(root, { GIT_COMMITTER_DATE: `${day}T10:00:00Z`, GIT_AUTHOR_DATE: `${day}T10:00:00Z` }, 'add', '.');
    git(root, { GIT_COMMITTER_DATE: `${day}T10:00:00Z`, GIT_AUTHOR_DATE: `${day}T10:00:00Z` }, 'commit', '-q', '-m', `Update readfirst map after #${n}`);
  }
  git(root, {}, 'update-ref', 'refs/remotes/origin/readfirst/upkeep', 'HEAD');
  git(root, {}, 'checkout', '-q', 'main');
  return root;
}

test('pending: map edits waiting on the upkeep branch, from local refs only', () => {
  const root = clone();
  const now = Date.parse('2026-11-08T12:00:00Z');
  const p = pendingUpkeep(root, { now });
  assert.deepEqual(p, { branch: 'origin/readfirst/upkeep', merges: 3, commits: 3, since: '2026-10-20', days: 19 });
  assert.equal(pendingDue(p), true, 'waiting over a week');
  assert.match(pendingLine(p), /map edits from 3 merges have waited 19 days on origin\/readfirst\/upkeep \(since 2026-10-20/u);
  assert.equal(pendingDue(pendingUpkeep(root, { now: Date.parse('2026-10-22T00:00:00Z') })), false, 'two days and three merges: not yet');
  // Once merged, nothing is waiting.
  git(root, {}, 'update-ref', 'refs/remotes/origin/main', 'refs/remotes/origin/readfirst/upkeep');
  assert.equal(pendingUpkeep(root, { now }), null);
  assert.equal(pendingUpkeep(mkdtempSync(join(tmpdir(), 'rf-none-')), { now }), null, 'not a repository');
});

test('the hook says so once per session, and --gate never refuses for it', () => {
  const root = clone();
  const stateDir = mkdtempSync(join(tmpdir(), 'rf-state-'));
  const now = Date.parse('2026-11-08T12:00:00Z');
  const edit = (session, gate = false) => runHook(JSON.stringify({ session_id: session, cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, 'b.js') } }), { stateDir, now, gate });
  const first = JSON.parse(edit('s1', true));
  assert.equal(first.hookSpecificOutput.permissionDecision, undefined, 'no map, no notes: nothing to refuse');
  assert.match(first.hookSpecificOutput.additionalContext, /readfirst: map edits from 3 merges have waited 19 days/u);
  assert.equal(edit('s1'), null, 'once per session');
  assert.match(JSON.parse(edit('s2')).hookSpecificOutput.additionalContext, /waited 19 days/u, 'again in a new session');
});
