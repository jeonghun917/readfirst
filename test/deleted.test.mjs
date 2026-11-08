import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { MARKER, runAction } from '../src/action.mjs';
import { main } from '../src/cli.mjs';
import { draftMap } from '../src/map.mjs';
import { readList } from '../src/readlist.mjs';

// A change made only of deleted files still gets the deleted files' group checks, rules, risks and requires entries.
const FILES = {
  'src/pay/charge.js': 'export const charge = () => 1;\n',
  'src/pay/refund.js': 'export const refund = () => 1;\n',
  'docs/pay.md': '# pay\n',
};

function mapFor(files) {
  const m = draftMap(files);
  const pay = m.groups.find((g) => g.id === 'src-pay');
  pay.checks = [{ run: 'npm test -- pay', why: 'charges' }];
  pay.risks = [{ text: 'amounts are in cents' }];
  m.rules = [{ id: 'once', rule: 'a charge runs once', files: ['src/pay/**'], checks: [{ run: 'npm run e2e:pay' }] }];
  m.requires = [{ when: ['src/pay/**'], also: ['docs/pay.md'], why: 'the docs describe every payment call' }];
  m.dependents = [{ repo: 'o/other', files: ['src/pay/**'], why: 'vendors the pay code' }];
  return m;
}

test('readList: a file that is not tracked any more still gets its group, rules, requires and dependents', () => {
  const files = Object.keys(FILES).filter((f) => f !== 'src/pay/charge.js').sort();
  const list = readList({ map: mapFor(Object.keys(FILES).sort()), files, imports: [], targets: ['src/pay/charge.js'] });
  assert.equal(list.targets[0].status, 'NOT_TRACKED');
  assert.match(list.notCovered[0].why, /not a tracked file/u);
  assert.deepEqual(list.checks.map((c) => c.run), ['npm test -- pay', 'npm run e2e:pay']);
  assert.deepEqual(list.risks.map((r) => r.text), ['amounts are in cents']);
  assert.deepEqual(list.rules.map((r) => r.id), ['once']);
  assert.deepEqual(list.together.map((t) => t.also), [['docs/pay.md']]);
  assert.deepEqual(list.dependents.map((d) => d.repo), ['o/other']);
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-deleted-'));
  for (const [path, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  mkdirSync(join(root, '.readfirst'));
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify(mapFor(Object.keys(FILES).sort())));
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'work');
  git('rm', '-q', 'src/pay/charge.js');
  git('commit', '-q', '-m', 'drop charge');
  return root;
}

const run = (root, ...argv) => {
  let out = '';
  const code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: () => {} });
  return { code, out };
};

test('verify and diff on a change of deleted files only list the group checks and requires entries', () => {
  const root = repo();
  const v = run(root, 'verify', '--base', 'main', '--dry-run', '--json');
  const report = JSON.parse(v.out);
  assert.deepEqual(report.checks.map((c) => c.run), ['npm test -- pay', 'npm run e2e:pay']);
  assert.equal(report.missing.length, 1, 'docs/pay.md was not changed with it');
  assert.equal(v.code, 1);
  const d = run(root, 'diff', '--base', 'main');
  for (const s of ['not a tracked file', '`npm test -- pay`', 'amounts are in cents', '`docs/pay.md`']) assert.ok(d.out.includes(s), `diff lacks ${s}:\n${d.out}`);
});

test('the Action comment for a PR that only removes files lists their group checks', async () => {
  const root = repo();
  const event = join(root, '..', `${root.split('/').pop()}-event.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567' } } }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const json = (v, status = 200) => ({ ok: true, status, json: async () => v, text: async () => JSON.stringify(v) });
    if (u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? [{ filename: 'src/pay/charge.js', status: 'removed' }] : []);
    if (u.pathname.endsWith('/issues/7/comments')) return json([]);
    return json({ id: 1 }, 201);
  };
  const env = { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't', GITHUB_API_URL: 'https://api.example' };
  const r = await runAction({ env, fetchImpl, log: () => {} });
  const body = calls.find((c) => c.method === 'POST').body.body;
  assert.ok(body.startsWith(MARKER));
  assert.ok(!body.includes('No changed files to look up'), body);
  for (const s of ['- [ ] `npm test -- pay`', 'Removed in this PR: `src/pay/charge.js`']) assert.ok(body.includes(s), `comment lacks ${s}:\n${body}`);
  assert.equal(r.ok, true);
});
