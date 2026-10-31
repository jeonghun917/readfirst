import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { MARKER, runAction } from '../src/action.mjs';
import { draftMap } from '../src/map.mjs';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-action-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '.']);
  return root;
}

const FILES = {
  'src/pay/charge.js': "import { cents } from '../util/cents.js';\nexport const charge = () => cents(1);\n",
  'src/util/cents.js': 'export const cents = (n) => n * 100;\n',
  'test/charge.test.js': "import '../src/pay/charge.js';\n",
};

function setup({ map = (m) => m, extra = {} } = {}) {
  const root = repo({ ...FILES, ...extra });
  const m = draftMap(Object.keys(FILES).sort());
  m.groups.find((g) => g.id === 'src-pay').checks = [{ run: 'npm test -- pay', why: 'charges' }];
  m.rules = [{ id: 'cents', rule: 'amounts are integers in cents', files: ['src/util/cents.js'] }];
  mkdirSync(join(root, '.readfirst'), { recursive: true });
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify(map(m)));
  execFileSync('git', ['-C', root, 'add', '.']);
  const event = join(root, '..', `${root.split('/').pop()}-event.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567' } } }));
  return { root, event };
}

function fakeGitHub({ comments = [], files, denyWrite = false }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
    const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
    if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? files : []);
    if (init.method === 'GET' && u.pathname.endsWith('/issues/7/comments')) return json(u.searchParams.get('page') === '1' ? comments : []);
    if (denyWrite) return json({ message: 'Resource not accessible by integration' }, 403);
    return json({ id: 1 }, init.method === 'POST' ? 201 : 200);
  };
  return { calls, fetchImpl };
}

const envFor = (root, event, more = {}) => ({ GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't0k', GITHUB_API_URL: 'https://api.example', ...more });

test('a PR gets one comment with the read list of its changed files, with checks as boxes', async () => {
  const { root, event } = setup();
  const gh = fakeGitHub({ files: [{ filename: 'src/util/cents.js', status: 'modified' }, { filename: 'old.js', status: 'removed' }] });
  const summary = join(root, '..', `${root.split('/').pop()}-summary.md`);
  const r = await runAction({ env: envFor(root, event, { GITHUB_STEP_SUMMARY: summary }), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.equal(r.ok, true);
  const post = gh.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/repos/o/r/issues/7/comments');
  assert.equal(post.auth, 'Bearer t0k');
  const body = post.body.body;
  assert.ok(body.startsWith(MARKER));
  for (const s of ['**cents**: amounts are integers in cents', '`test/charge.test.js` (through `src/pay/charge.js`)', 'Removed in this PR: `old.js`', 'at abcdef1'])
    assert.ok(body.includes(s), `comment lacks ${s}:\n${body}`);
  assert.ok(readFileSync(summary, 'utf8').includes('## readfirst'));
});

test('the comment is updated in place on the next push, not posted again', async () => {
  const { root, event } = setup();
  const gh = fakeGitHub({ comments: [{ id: 99, body: `${MARKER}\nold` }, { id: 5, body: 'lgtm' }], files: [{ filename: 'src/pay/charge.js', status: 'modified' }] });
  await runAction({ env: envFor(root, event), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.deepEqual(gh.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), ['PATCH /repos/o/r/issues/comments/99']);
  assert.ok(gh.calls.at(-1).body.body.includes('- [ ] `npm test -- pay` — charges'));
});

test('a map that no longer covers the code fails the check and says why in the comment', async () => {
  const { root, event } = setup({ extra: { 'src/pay/refund.js': 'export {};\n', 'stray.txt': 'x' } });
  const gh = fakeGitHub({ files: [{ filename: 'stray.txt', status: 'added' }] });
  const r = await runAction({ env: envFor(root, event), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.body, /no longer matches the code/u);
  assert.match(r.body, /stray.txt/u);
  const soft = await runAction({ env: envFor(root, event, { INPUT_FAIL_ON_MAP_PROBLEMS: 'false' }), fetchImpl: fakeGitHub({ files: [] }).fetchImpl, log: () => {} });
  assert.equal(soft.ok, true);
});

test('a read-only token (fork PR) keeps the list in the summary and does not fail', async () => {
  const { root, event } = setup();
  const logs = [];
  const r = await runAction({ env: envFor(root, event), fetchImpl: fakeGitHub({ files: [{ filename: 'src/pay/charge.js', status: 'modified' }], denyWrite: true }).fetchImpl, log: (s) => logs.push(s) });
  assert.equal(r.ok, true);
  assert.ok(logs.some((l) => l.includes('could not comment')));
});

test('off a pull request only the map is checked', async () => {
  const { root } = setup();
  const r = await runAction({ env: envFor(root, undefined, { GITHUB_EVENT_PATH: '' }), fetchImpl: async () => { throw new Error('no calls'); }, log: () => {} });
  assert.equal(r.ok, true);
});
