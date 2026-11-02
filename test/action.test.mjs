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

function fakeGitHub({ comments = [], files, denyWrite = false, mapOnBranch = null }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
    const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
    if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? files : []);
    if (init.method === 'GET' && u.pathname.endsWith('/issues/7/comments')) return json(u.searchParams.get('page') === '1' ? comments : []);
    if (init.method === 'GET' && u.pathname.endsWith('/contents/.readfirst/map.json')) return json({ sha: 'blob1', content: Buffer.from(mapOnBranch ?? '').toString('base64') });
    if (init.method === 'PUT' && !denyWrite) return json({ commit: { sha: 'c0ffee1234567' } });
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

test('a new file beside mapped ones passes: the comment notes where it was placed, and strict fails on it', async () => {
  // The util group names its file, so a new file next to it is in no group until someone (or fix) adds it.
  const map = (m) => { m.groups.find((g) => g.id === 'src-util').files = ['src/util/cents.js']; return m; };
  const { root, event } = setup({ map, extra: { 'src/util/round.js': "import { cents } from './cents.js';\nexport const round = (n) => cents(Math.round(n));\n" } });
  const files = [{ filename: 'src/util/round.js', status: 'added' }];
  const r = await runAction({ env: envFor(root, event), fetchImpl: fakeGitHub({ files }).fetchImpl, log: () => {} });
  assert.equal(r.ok, true, r.body);
  assert.doesNotMatch(r.body, /no longer matches the code/u);
  assert.match(r.body, /New files placed by their neighbours/u);
  assert.match(r.body, /src-util: added src\/util\/round\.js/u);
  const strict = await runAction({ env: envFor(root, event, { INPUT_STRICT: 'true' }), fetchImpl: fakeGitHub({ files }).fetchImpl, log: () => {} });
  assert.equal(strict.ok, false);
  assert.match(strict.body, /not yet written in the map/u);
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

test('comment: when the map is stale, it says what `readfirst fix` would change', async () => {
  const { commentBody } = await import('../src/action.mjs');
  const body = commentBody({ list: null, problems: ['1 file(s) in no group and not ignored: src/new.js'], removed: [], commit: 'abc1234', fixes: ['groups.src: added src/new.js'] });
  assert.match(body, /`npx readfirst fix` would make these changes:\n- groups.src: added src\/new.js/u);
  assert.doesNotMatch(commentBody({ list: null, problems: ['x'], removed: [], commit: null }), /readfirst fix/u);
});

test('auto-fix: what fix settles is committed to the PR branch, only from this repository and only over the map it read', async () => {
  const map = (m) => { m.groups.find((g) => g.id === 'src-util').files = ['src/util/cents.js']; return m; };
  const { root, event } = setup({ map, extra: { 'src/util/round.js': "import { cents } from './cents.js';\n" } });
  const onBranch = readFileSync(join(root, '.readfirst/map.json'), 'utf8');
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567', ref: 'feat/round', repo: { full_name: 'o/r' } } } }));
  const files = [{ filename: 'src/util/round.js', status: 'added' }];
  const on = { INPUT_AUTO_FIX: 'true' };

  const gh = fakeGitHub({ files, mapOnBranch: onBranch });
  const r = await runAction({ env: envFor(root, event, on), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.equal(r.ok, true);
  const put = gh.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/repos/o/r/contents/.readfirst/map.json');
  assert.equal(put.body.branch, 'feat/round');
  assert.equal(put.body.sha, 'blob1');
  assert.match(put.body.message, /^readfirst fix: place 1 new file/u);
  const written = JSON.parse(Buffer.from(put.body.content, 'base64').toString('utf8'));
  assert.ok(written.groups.find((g) => g.id === 'src-util').files.includes('src/util/round.js'));
  assert.match(r.body, /placed 1 new file\(s\) in the map and committed it to this branch \(c0ffee1\)/u);

  // the branch moved on: nothing is overwritten
  const moved = fakeGitHub({ files, mapOnBranch: '{"format":"readfirst/map@1","groups":[]}' });
  const r2 = await runAction({ env: envFor(root, event, on), fetchImpl: moved.fetchImpl, log: () => {} });
  assert.equal(moved.calls.some((c) => c.method === 'PUT'), false);
  assert.match(r2.body, /New files placed by their neighbours/u);

  // off by default, and never on a fork's branch
  const off = fakeGitHub({ files, mapOnBranch: onBranch });
  await runAction({ env: envFor(root, event), fetchImpl: off.fetchImpl, log: () => {} });
  assert.equal(off.calls.some((c) => c.method === 'PUT' || c.path.includes('/contents/')), false);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567', ref: 'main', repo: { full_name: 'someone/fork' } } } }));
  const fork = fakeGitHub({ files, mapOnBranch: onBranch });
  await runAction({ env: envFor(root, event, on), fetchImpl: fork.fetchImpl, log: () => {} });
  assert.equal(fork.calls.some((c) => c.method === 'PUT'), false);
});
