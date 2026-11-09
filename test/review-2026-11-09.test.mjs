// The security findings and the Bash write gaps of the 2026-11-09 four-area review (readfirst 0.26.4), each
// reproduced on 0.26.4 first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main, runHook, runStopHook } from '../src/cli.mjs';
import { bashWrites } from '../src/bash-writes.mjs';
import { MARKER, runAction } from '../src/action.mjs';
import { draftMap, MAP_FORMAT } from '../src/map.mjs';

const OLD = '2020-01-01T00:00:00Z';
function repo(files, { date } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-r9-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (args, when) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', env: when ? { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } : process.env });
  git(['init', '-q', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init'], date);
  return { root, git };
}
const run = (root, ...argv) => {
  let out = '';
  let err = '';
  let code;
  try { code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: (s) => { err += s; } }); } catch (e) { code = 2; err += e.message; }
  return { code, out, err };
};
const MAP = (checks) => JSON.stringify({ format: MAP_FORMAT, groups: [{ id: 'src', title: 'src', files: ['src/**', '.readfirst/**'], checks }] });

test('Stop hook on main with no remote: a check the session committed to the map is not run; one from before is', () => {
  const now = Date.now();
  const later = new Date(now + 2000).toISOString();
  for (const [before, expectRun] of [[[], false], [[{ run: 'node -e "require(\'fs\').writeFileSync(\'RAN\',\'\')"' }], true]]) {
    const { root, git } = repo({ 'src/a.js': 'x\n', '.readfirst/map.json': MAP(before) }, { date: OLD });
    const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-r9-state-'));
    runHook(JSON.stringify({ session_id: 's', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), { stateDir, now });
    // The session adds its own command to the map and commits it with its edit.
    const map = JSON.parse(readFileSync(join(root, '.readfirst/map.json'), 'utf8'));
    map.groups[0].checks.push({ run: 'node -e "require(\'fs\').writeFileSync(\'PWNED\',\'\')"' });
    writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify(map));
    writeFileSync(join(root, 'src/a.js'), 'y\n');
    git(['commit', '-qam', 'edit'], later);
    const out = runStopHook(JSON.stringify({ session_id: 's', cwd: root }), { stateDir, timeout: 30 });
    assert.equal(existsSync(join(root, 'PWNED')), false, 'the session-committed command never runs');
    const said = out ? Object.values(JSON.parse(out)).join('\n') : '';
    assert.match(said, /Not run, because[^:]*: `node -e "require\('fs'\)\.writeFileSync\('PWNED'/u);
    assert.equal(existsSync(join(root, 'RAN')), expectRun, expectRun ? 'a command the map had before the session runs' : 'nothing else to run');
  }
});

test('drafted workspace checks quote a package name or folder that is not a plain word', () => {
  const pnpm = { 'pnpm-lock.yaml': '', 'package.json': '{"name":"root"}', 'packages/a/package.json': '{"name":"a; touch /tmp/PWNED","scripts":{"test":"x"}}', 'packages/a/i.js': '', 'packages/b/package.json': '{"name":"@acme/b","scripts":{"test":"x"}}', 'packages/b/i.js': '' };
  const m = draftMap(Object.keys(pnpm), (f) => pnpm[f] ?? null);
  const runs = m.groups.flatMap((g) => g.checks.map((c) => c.run));
  assert.ok(runs.includes("pnpm --filter 'a; touch /tmp/PWNED' test"), runs.join('\n'));
  assert.ok(runs.includes('pnpm --filter @acme/b test'), 'a plain name stays as it was');
  const npm = { 'package.json': '{"workspaces":["packages/*"]}', 'packages/my pkg/package.json': '{"scripts":{"test":"x"}}', 'packages/my pkg/i.js': '' };
  assert.ok(draftMap(Object.keys(npm), (f) => npm[f] ?? null).groups.flatMap((g) => g.checks.map((c) => c.run)).includes("npm test -w 'packages/my pkg'"));
});

test('export --cursor, init, fix and view write nothing through a symlink that leads outside the repository', () => {
  const outside = mkdtempSync(join(tmpdir(), 'readfirst-r9-out-'));
  writeFileSync(join(outside, 'victim.txt'), 'victim\n');
  const { root, git } = repo({ 'src/a.js': 'x\n' });
  run(root, 'init');
  const map = JSON.parse(readFileSync(join(root, '.readfirst/map.json'), 'utf8'));
  map.groups[0].risks = [{ text: 'r' }];
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify(map));
  git(['add', '.']);
  git(['commit', '-qm', 'map']);
  mkdirSync(join(root, '.cursor/rules'), { recursive: true });
  symlinkSync(join(outside, 'victim.txt'), join(root, `.cursor/rules/readfirst-${map.groups[0].id}.mdc`));
  const e = run(root, 'export', '--cursor');
  assert.equal(e.code, 2);
  assert.match(e.err, /leads outside the repository.*nothing was written/u);
  assert.equal(readFileSync(join(outside, 'victim.txt'), 'utf8'), 'victim\n');
  // A symlinked .readfirst folder: init and fix stop, view's default page too.
  const out2 = mkdtempSync(join(tmpdir(), 'readfirst-r9-out-'));
  const b = repo({ 'src/a.js': 'x\n' });
  symlinkSync(out2, join(b.root, '.readfirst'));
  assert.match(run(b.root, 'init').err, /\.readfirst\/map\.json leads outside the repository/u);
  assert.equal(existsSync(join(out2, 'map.json')), false);
  writeFileSync(join(out2, 'map.json'), MAP([]).replace('"src/**", ', '"src/**", "gone/**", '));
  assert.match(run(b.root, 'fix').err, /leads outside the repository/u);
  assert.match(run(b.root, 'view').err, /\.readfirst\/local\/view\.html leads outside the repository/u);
});

test('the Action posts its own comment when another user posted one that starts with its marker', async () => {
  const { root } = repo({ 'src/a.js': 'x\n', '.readfirst/map.json': MAP([]) });
  const event = join(root, '..', `${root.split('/').pop()}-event.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567' } } }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
    if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? [{ filename: 'src/a.js', status: 'modified' }] : []);
    if (init.method === 'GET' && u.pathname.endsWith('/issues/7/comments')) return json(u.searchParams.get('page') === '1' ? [{ id: 5, user: { login: 'someone', type: 'User' }, body: `${MARKER}\nnot ours` }] : []);
    if (init.method === 'PATCH') return json({ message: 'forbidden' }, 403);
    return json({ id: 9 }, 201);
  };
  const r = await runAction({ env: { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't', GITHUB_API_URL: 'https://api.example' }, fetchImpl, log: () => {} });
  assert.equal(r.ok, true);
  assert.ok(calls.includes('POST /repos/o/r/issues/7/comments'), calls.join('\n'));
  // With a personal token our own comment is a user's too: it is found and edited, not posted again at every push.
  const ours = [{ id: 5, user: { type: 'User' }, body: `${MARKER}\nnot ours` }, { id: 6, user: { type: 'User' }, body: `${MARKER}\nours` }];
  const seen = [];
  const fetch2 = async (url, init) => {
    const u = new URL(url);
    seen.push(`${init.method} ${u.pathname}`);
    const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
    if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? [{ filename: 'src/a.js', status: 'modified' }] : []);
    if (init.method === 'GET' && u.pathname.endsWith('/issues/7/comments')) return json(u.searchParams.get('page') === '1' ? ours : []);
    if (init.method === 'PATCH') return u.pathname.endsWith('/5') ? json({ message: 'forbidden' }, 403) : json({ id: 6 });
    return json({ id: 9 }, 201);
  };
  await runAction({ env: { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't', GITHUB_API_URL: 'https://api.example' }, fetchImpl: fetch2, log: () => {} });
  assert.ok(seen.includes('PATCH /repos/o/r/issues/comments/6'), seen.join('\n'));
  assert.ok(!seen.some((c) => c.startsWith('POST')), seen.join('\n'));
});

test('Bash: env assignments, wrappers, continued lines and shell -c strings do not hide a write', () => {
  const at = (c) => bashWrites(c, '/r').map((p) => p.slice(3));
  for (const [c, want] of [
    ['FOO=1 sed -i s/a/b/ f.txt', ['f.txt']], ['CI=1 cp a.txt b.txt', ['b.txt']], ['sudo tee out.txt < in', ['out.txt']],
    ['env X=1 Y=2 cp a b.txt', ['b.txt']], ['timeout 10 sed -i s/a/b/ g.txt', ['g.txt']], ['nohup cp a c.txt', ['c.txt']],
    ['nice -n 5 sed -i s/a/b/ n.txt', ['n.txt']], ['sudo -u bob cp a u.txt', ['u.txt']],
    ['sed -i \\\n  -e s/a/b/ \\\n  h.txt', ['h.txt']], ['cp a \\\n  i.txt', ['i.txt']],
    ["bash -c 'echo x > j.txt'", ['j.txt']], ['sh -c "cd d && cp a k.txt"', ['d/k.txt']], ["bash -lc 'sed -i s/a/b/ l.txt'", ['l.txt']],
    ["bash <<'E'\necho x > m.txt\nE", ['m.txt']],
  ]) assert.deepEqual(at(c), want, c);
  for (const c of ['FOO=1 npm test', 'time npm test', 'env', 'command -v node', "bash -c 'npm test'"]) assert.deepEqual(at(c), [], c);
});

test('Bash: a branch or tag name with a dot, and restore --staged, are not writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-r9-git-'));
  writeFileSync(join(dir, 'real.js'), '');
  writeFileSync(join(dir, 'Makefile'), '');
  const at = (c) => bashWrites(c, dir).map((p) => p.slice(dir.length + 1));
  for (const c of ['git checkout release-0.26', 'git checkout -B readfirst-0.26.5 origin/main', 'git checkout -q -b feat/x.y', 'git checkout v1.2.3', 'git restore --staged real.js', 'git restore -S real.js']) assert.deepEqual(at(c), [], c);
  for (const [c, want] of [['git checkout -- real.js', ['real.js']], ['git checkout HEAD real.js', ['real.js']], ['git restore real.js', ['real.js']], ['git restore -SW real.js', ['real.js']], ['git checkout -- Makefile', ['Makefile']], ['git restore gone.js', ['gone.js']]]) assert.deepEqual(at(c), want, c);
});
