// 0.27.0, from the 2026-11-09 four-area review: each case reproduced on 0.26.5 first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main, runHook, runStopHook } from '../src/cli.mjs';
import { runAction } from '../src/action.mjs';
import { MAP_FORMAT } from '../src/map.mjs';

const OLD = '2020-01-01T00:00:00Z';
function repo(files, { date, branch = 'main' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-27-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (args, when) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: when ? { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } : process.env });
  git(['init', '-q', '-b', branch]);
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
const MAP = (groups) => JSON.stringify({ format: MAP_FORMAT, groups });

test('diff, verify and the Action name the files that still import a deleted or moved file', async () => {
  const { root, git } = repo({
    'src/lib/util.js': 'export const u = 1;\n',
    'src/b.js': "import { u } from './lib/util.js';\nexport const b = u;\n",
    '.readfirst/map.json': MAP([{ id: 'src', title: 'src', files: ['src/**', '.readfirst/**'] }]),
  });
  git(['checkout', '-q', '-b', 'work']);
  git(['rm', '-q', 'src/lib/util.js']);
  git(['commit', '-q', '-m', 'rm']);
  const d = run(root, 'diff', '--base', 'main', '--json');
  const list = JSON.parse(d.out);
  assert.deepEqual(list.usedBy.map((u) => u.path), ['src/b.js']);
  assert.match(list.notCovered[0].why, /still imported by src\/b\.js: change them too/u);
  // The Action: removed and renamed (old path) files from the API.
  const event = join(root, '..', `${root.split('/').pop()}-event.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567' } } }));
  let body = '';
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
    if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? [{ filename: 'src/lib/util.js', status: 'removed' }] : []);
    if (init.method === 'GET') return json([]);
    body = JSON.parse(init.body).body;
    return json({ id: 1 }, 201);
  };
  await runAction({ env: { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't', GITHUB_API_URL: 'https://api.example' }, fetchImpl, log: () => {} });
  assert.match(body, /still imported by src\/b\.js/u);
});

test('verify runs the checks of the group a file was moved out of, even its last file', () => {
  const { root, git } = repo({
    'a/x.js': 'x\n', 'b/y.js': 'y\n',
    '.readfirst/map.json': MAP([{ id: 'a', title: 'a', files: ['a/**', '.readfirst/**'], checks: [{ run: 'echo CHECK-A' }] }, { id: 'b', title: 'b', files: ['b/**'] }]),
  });
  git(['checkout', '-q', '-b', 'work']);
  git(['mv', 'a/x.js', 'b/x.js']);
  git(['commit', '-q', '-m', 'mv']);
  const v = run(root, 'verify', '--base', 'main', '--dry-run');
  assert.match(v.out, /echo CHECK-A/u, v.out);
});

test('Stop hook after commit and push to main: the edited file is checked, and a check the session pushed is not run', () => {
  const remote = mkdtempSync(join(tmpdir(), 'readfirst-27-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const { root, git } = repo({ 'src/a.js': 'x\n', '.readfirst/map.json': MAP([{ id: 'src', title: 's', files: ['src/**', '.readfirst/**'], checks: [{ run: 'node -e "process.exit(3)"' }] }]) }, { date: OLD });
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-q', 'origin', 'main']);
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-27-state-'));
  const now = Date.now();
  runHook(JSON.stringify({ session_id: 'p', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), { stateDir, now });
  const map = JSON.parse(readFileSync(join(root, '.readfirst/map.json'), 'utf8'));
  map.groups[0].checks.push({ run: 'node -e "require(\'fs\').writeFileSync(\'PWNED\',\'\')"' });
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify(map));
  writeFileSync(join(root, 'src/a.js'), 'y\n');
  git(['commit', '-qam', 'edit'], new Date(now + 2000).toISOString());
  git(['push', '-q', 'origin', 'main']);
  const out = JSON.parse(runStopHook(JSON.stringify({ session_id: 'p', cwd: root }), { stateDir, timeout: 30 }));
  assert.equal(out.decision, 'block', 'the check from before the session ran and failed');
  assert.match(out.reason, /1 of 1 check\(s\).*failed.*Not run, because/su);
  assert.equal(existsSync(join(root, 'PWNED')), false);
});

test('hook --gate whose state cannot be saved passes the notes as context instead of refusing forever', () => {
  const { root } = repo({ 'src/a.js': 'x\n', '.readfirst/map.json': MAP([{ id: 'src', title: 's', files: ['src/**', '.readfirst/**'], checks: [{ run: 'npm test' }] }]) });
  for (let i = 0; i < 2; i++) {
    const out = JSON.parse(runHook(JSON.stringify({ session_id: 'g', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), { stateDir: join(root, 'no', 'such', 'dir'), gate: true }));
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
    assert.match(out.hookSpecificOutput.additionalContext, /npm test/u);
  }
});

test('Bash: numbered and >| redirects, subshell and pushd folders, globs and ~ are writes; arithmetic, comments, patch -p and remote rsync are not', async () => {
  const { bashWrites } = await import('../src/bash-writes.mjs');
  const { homedir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-27-bash-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'd'));
  for (const f of ['src/a.js', 'src/b.js', 'real.js']) writeFileSync(join(dir, f), '');
  const at = (c) => bashWrites(c, dir).map((p) => (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p)).sort();
  for (const [c, want] of [
    ['npm test 2> err.log', ['err.log']], ['cmd > out.txt 2> err.txt', ['err.txt', 'out.txt']], ['exec 2> e.log', ['e.log']],
    ['echo x >| a.txt', ['a.txt']], ['echo x |& tee t.txt', ['t.txt']],
    ['(cd d && echo x > a.txt)', ['d/a.txt']], ['pushd d && echo x > p.txt', ['d/p.txt']], ['cd - && echo x > m.txt', []],
    ['sed -i s/a/b/ src/*.js', ['src/a.js', 'src/b.js']], ['echo x > ~/x.txt', [join(homedir(), 'x.txt')]],
    ['git -C d checkout -- f.js', ['d/f.js']], ['git -c core.x=1 checkout -- real.js', ['real.js']],
    ['(( x > 0 ))', []], ['echo a # b > c.txt', []], ['cp a b.txt # c d', ['b.txt']], ['patch -p 1 < a.patch', []],
    ['rsync -a a host:b', []], ['rsync -n a b', []], ['npm test 2>&1 | tail', []], ['echo x >&2', []], ['cmd 2>/dev/null', []],
  ]) assert.deepEqual(at(c), want, c);
});

test('imports: tsconfig baseUrl, package.json #imports, index.jsx/.cjs folders and Python below a pyproject.toml resolve', async () => {
  const { importEdges } = await import('../src/imports.mjs');
  const T = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }), 'src/components/ui/Button.tsx': '', 'src/app.tsx': "import {B} from 'components/ui/Button';\nimport x from 'react';",
    'package.json': JSON.stringify({ imports: { '#internal/*': './src/lib/*.js' } }), 'src/lib/helper.js': '', 'src/use.js': "import h from '#internal/helper';",
    'web/components/ui/index.jsx': '', 'web/page.js': "import ui from './components/ui';", 'lib/dir/index.cjs': '', 'lib/m.js': "require('./dir')",
    'backend/pyproject.toml': '', 'backend/app/__init__.py': '', 'backend/app/models/__init__.py': '', 'backend/app/models/user.py': '', 'backend/app/main.py': 'from app.models.user import User\n', 'backend/tests/test_main.py': 'from app.main import x\n',
  };
  const edges = importEdges(Object.keys(T).sort(), (f) => T[f] ?? null).map((e) => `${e.from} -> ${e.to}`).sort();
  assert.deepEqual(edges, [
    'backend/app/main.py -> backend/app/models/user.py', 'backend/tests/test_main.py -> backend/app/main.py', 'lib/m.js -> lib/dir/index.cjs',
    'src/app.tsx -> src/components/ui/Button.tsx', 'src/use.js -> src/lib/helper.js', 'web/page.js -> web/components/ui/index.jsx',
  ]);
});
