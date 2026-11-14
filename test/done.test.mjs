import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main, runHook, runStopHook } from '../src/cli.mjs';
import { MAP_FORMAT, mapProblems } from '../src/map.mjs';
import { readList, toMarkdown } from '../src/readlist.mjs';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-done-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return { root, git };
}
const run = (root, ...argv) => {
  let out = '';
  const code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: () => {} });
  return { code, out };
};

const MAP = {
  format: MAP_FORMAT,
  groups: [
    { id: 'app', title: 'app', files: ['app/**'] },
    { id: 'db', title: 'migrations', files: ['migrations/**'] },
    { id: 'project', title: 'project', files: ['package.json', 'server.json', 'docs/**'] },
  ],
  rules: [{ id: 'versions-match', rule: 'server.json carries the package version', files: ['package.json', 'server.json'] }],
  requires: [
    { when: ['app/models.py'], also: ['migrations/**'], why: 'a model change needs a migration' },
    { when: ['package.json'], also: ['server.json'], why: 'the MCP registry reads the version from server.json' },
  ],
  dependents: [{ files: ['app/api.py'], repo: 'acme/web', paths: ['src/client.ts'], why: 'the web app calls this API' }],
};
const FILES = {
  'app/models.py': 'X = 1\n', 'app/api.py': 'Y = 1\n', 'migrations/0001.py': '', 'package.json': '{}', 'server.json': '{}', 'docs/a.md': '',
  '.readfirst/map.json': JSON.stringify(MAP),
};

test('map: requires and dependents are checked like the rest of the map', () => {
  const files = Object.keys(FILES);
  assert.deepEqual(mapProblems(MAP, files), []);
  const bad = { ...MAP, requires: [{ when: ['nope/**'], also: [], why: '' }, 'x'], dependents: [{ files: ['app/api.py'], repo: 'not a repo', why: 'w', extra: 1 }] };
  const p = mapProblems(bad, files);
  assert.ok(p.includes('requires[0].when: nope/** matches no tracked file'), p.join('\n'));
  assert.ok(p.includes('requires[0].also: at least one path or pattern'));
  assert.ok(p.includes('requires[0].why: text (empty)'), 'it says why (test/map-check-says-why.test.mjs)');
  assert.ok(p.includes('requires[1]: { when, also, why }'));
  assert.ok(p.includes('dependents[0].repo: owner/name'));
  assert.ok(p.includes('dependents[0].extra: unknown field'));
  // `also` may name what does not exist yet (the next migration)
  assert.deepEqual(mapProblems({ ...MAP, requires: [{ when: ['app/models.py'], also: ['migrations/9999_new.py'], why: 'w' }] }, files), []);
});

test('read: the files to change too and the repositories that depend on this', () => {
  const files = Object.keys(FILES);
  let list = readList({ map: MAP, files, imports: [], targets: ['app/models.py'] });
  assert.deepEqual(list.together.map((t) => [t.also, t.changed]), [[['migrations/**'], false]]);
  assert.match(toMarkdown(list), /## Change these too\n\n- `migrations\/\*\*` — a model change needs a migration/u);
  list = readList({ map: MAP, files, imports: [], targets: ['app/models.py', 'migrations/0001.py'] });
  assert.equal(list.together[0].changed, true);
  list = readList({ map: MAP, files, imports: [], targets: ['app/api.py'] });
  assert.deepEqual(list.dependents, [{ repo: 'acme/web', paths: ['src/client.ts'], why: 'the web app calls this API', for: ['app/api.py'] }]);
  assert.match(toMarkdown(list), /## Other repositories depend on this\n\n- \*\*acme\/web\*\* \(`src\/client\.ts`\)/u);
});

test('verify: fails when a file the map ties to the change was left out; says which rules nothing checks and who else depends', () => {
  const { root, git } = repo(FILES);
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'package.json'), '{"version":"2.0.0"}');
  let r = run(root, 'verify', '--json');
  assert.equal(r.code, 1, r.out);
  const report = JSON.parse(r.out);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.map((m) => m.also), [['server.json']]);
  assert.deepEqual(report.unverified, ['versions-match']);
  r = run(root, 'verify');
  assert.match(r.out, /NOT CHANGED TOGETHER: package\.json changed, but none of server\.json did/u);
  assert.match(r.out, /no check covers rule\(s\) versions-match/u);
  assert.match(r.out, /1 file\(s\) the map says change together were left out/u);
  writeFileSync(join(root, 'server.json'), '{"version":"2.0.0"}');
  r = run(root, 'verify');
  assert.equal(r.code, 0, r.out);
  writeFileSync(join(root, 'app/api.py'), 'Y = 2\n');
  r = run(root, 'verify');
  assert.equal(r.code, 0, 'a dependent repository is a reminder, not a failure');
  assert.match(r.out, /other repository: acme\/web \(src\/client\.ts\) depends on app\/api\.py/u);
});

test('hook: the agent hears what changes together; the Stop hook blocks once when it was left out', () => {
  const { root, git } = repo(FILES);
  git('checkout', '-q', '-b', 'work');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-done-stop-'));
  const pre = JSON.parse(runHook(JSON.stringify({ session_id: 's', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'app/models.py') } }), { stateDir }));
  assert.match(pre.hookSpecificOutput.additionalContext, /Change together: when this file changes, also change migrations\/\*\* \(a model change needs a migration\)/u);
  writeFileSync(join(root, 'app/models.py'), 'X = 2\n');
  const stop = (over = {}) => runStopHook(JSON.stringify({ session_id: 's', cwd: root, stop_hook_active: false, ...over }), { stateDir, timeout: 30 });
  const blocked = JSON.parse(stop());
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /app\/models\.py changed, but none of migrations\/\*\* did/u);
  assert.equal(stop({ stop_hook_active: true }), null, 'it lets go on the second stop');
  writeFileSync(join(root, 'migrations/0002.py'), '');
  assert.equal(stop(), null, 'no checks and nothing left out: no output');
});

// A session started in a folder above the repositories (2026-11-07: ours ran in /home/user above readfirst and
// readfirst-cloud, and the hook, which looked for a repository at the session's folder, said nothing).
test('hook: a session above several repositories gets each file\'s own repository, and Stop checks each', () => {
  const a = repo(FILES);
  const b = repo(FILES);
  a.git('checkout', '-q', '-b', 'work');
  b.git('checkout', '-q', '-b', 'work');
  const above = mkdtempSync(join(tmpdir(), 'readfirst-above-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-done-above-'));
  const edit = (root, file) => runHook(JSON.stringify({ session_id: 'up', cwd: above, tool_name: 'Edit', tool_input: { file_path: join(root, file) } }), { stateDir });
  assert.match(JSON.parse(edit(a.root, 'app/models.py')).hookSpecificOutput.additionalContext, /also change migrations/u);
  assert.match(JSON.parse(edit(b.root, 'app/models.py')).hookSpecificOutput.additionalContext, /also change migrations/u);
  writeFileSync(join(a.root, 'app/models.py'), 'X = 2\n');
  writeFileSync(join(b.root, 'app/models.py'), 'X = 3\n');
  writeFileSync(join(b.root, 'migrations/0002.py'), '');
  const stop = JSON.parse(runStopHook(JSON.stringify({ session_id: 'up', cwd: above, stop_hook_active: false }), { stateDir, timeout: 30 }));
  assert.equal(stop.decision, 'block');
  const name = (root) => root.split('/').pop();
  assert.match(stop.reason, new RegExp(`readfirst in ${name(a.root)}: app/models\\.py changed`, 'u'), 'the repository that left the migration out');
  assert.ok(!stop.reason.includes(name(b.root)), 'the other one did its part');
  assert.equal(runHook(JSON.stringify({ session_id: 'up', cwd: above, tool_name: 'Edit', tool_input: { file_path: join(above, 'notes.md') } }), { stateDir }), null, 'a file in no repository: nothing');
});
