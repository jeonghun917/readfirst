import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { commentBody, runAction } from '../src/action.mjs';
import { audit, auditText } from '../src/audit.mjs';
import { mcpHandler } from '../src/mcp.mjs';
import { main, runHook, writeWorkflow, WORKFLOW_PATH } from '../src/cli.mjs';
import { brokeBefore, brokeMost, NOISE, NOT_CODE, NOT_TRAP, parseScarLog, scar, SIGNALS, spreadScars, summarizeScars, TEST } from '../src/history.mjs';
import { readList, toMarkdown } from '../src/readlist.mjs';

test('scar: the subject says something broke, noise does not count', () => {
  assert.equal(scar('Revert "cache totals"\n\nThis reverts commit abc1234.').kind, 'revert');
  assert.equal(scar('roll back the 0042 migration').kind, 'rollback');
  assert.equal(scar('hotfix: login loop').kind, 'hotfix');
  assert.equal(scar('fix(billing): amounts were in dollars').kind, 'fix');
  assert.equal(scar('Rewrite things\n\nThis reverts commit abc1234def.').weight, 3, 'git\'s own body line counts');
  for (const m of ['Bump express from 4.18 to 4.19', 'fix typo in README', 'add prefix to fixtures', 'Merge branch main',
    'feat: discounts', 'docs: fix typos in lib comments', 'fix(ci): update scorecard',
    'test: expand coverage\n\nguards against the regression in #4']) assert.equal(scar(m), null, m);
  assert.ok(SIGNALS.length && NOISE instanceof RegExp && NOT_CODE.test('package-lock.json') && TEST.test('src/a.test.ts'));
});

test('spreadScars: a commit\'s weight is spread over its code files, tests count half, big commits are skipped', () => {
  const exists = new Set(['src/a.js', 'src/b.js', 'test/a.test.js', 'README.md', 'gone.js']);
  const score = spreadScars([
    { weight: 2, files: ['src/a.js', 'src/b.js', 'README.md', 'removed.js'] },
    { weight: 3, files: ['src/a.js', 'test/a.test.js'] },
    { weight: 3, files: Array.from({ length: 26 }, (_, i) => `src/x${i}.js`) },
  ], new Set([...exists, ...Array.from({ length: 26 }, (_, i) => `src/x${i}.js`)]));
  assert.equal(score.get('src/a.js'), 2 / Math.sqrt(2) + 3 / Math.sqrt(2));
  assert.equal(score.get('test/a.test.js'), (3 / Math.sqrt(2)) * 0.5);
  assert.ok(!score.has('README.md') && !score.has('removed.js') && !score.has('src/x0.js'));
});

test('summarizeScars: shown from weight 2, strongest three newest first within equal weight, tests count half', () => {
  const c = (n, time, subject) => ({ sha: `${n}`.repeat(40), time, subject });
  assert.equal(summarizeScars('src/a.js', [c(1, 100, 'fix: a')]), undefined, 'one fix is weight 1');
  assert.equal(summarizeScars('README.md', [c(1, 100, 'revert x'), c(2, 200, 'revert y')]), undefined, 'not code never shows');
  assert.equal(summarizeScars('src/a.test.js', [c(1, 100, 'fix: a'), c(2, 200, 'fix: b'), c(3, 300, 'fix: c')]), undefined, 'three fixes in a test is 1.5');
  const got = summarizeScars('src/a.js', [c(1, 400, 'fix: newest'), c(2, 300, 'fix: second'), c(3, 200, 'Revert "x"'), c(4, 100, 'fix: oldest'), c(5, 500, 'feat: nothing')]);
  assert.equal(got.count, 4);
  assert.equal(got.weight, 6);
  assert.deepEqual(got.top.map((t) => t.subject), ['Revert "x"', 'fix: newest', 'fix: second']);
  assert.deepEqual(Object.keys(got.top[0]), ['sha', 'date', 'kind', 'subject']);
  assert.equal(got.last.subject, 'fix: newest');
});

// A repository with history: pay.js broke three times (and once more under its old name), the test beside it twice, the
// docs and a dependency bump are noise.
function history({ map = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-history-'));
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE } });
  git('init', '-q', '-b', 'main');
  let n = 0;
  const commit = (message, files) => {
    n += 1;
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), `${body}\n// ${n}\n`);
    }
    git('add', '-A');
    const when = new Date(Date.now() - (30 - n) * 86400_000).toISOString();
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message], { env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  };
  commit('feat: charge cards', { 'src/pay.js': 'export const pay = 1;', 'src/old.js': 'export const old = 1;', 'test/pay.test.js': "import '../src/pay.js';", 'README.md': '# app' });
  commit('fix: amounts were in dollars', { 'src/pay.js': 'v1', 'test/pay.test.js': 't1' });
  commit('docs: fix typos in README', { 'README.md': '# app 2' });
  commit('Bump express from 4.18 to 4.19', { 'package.json': '{}' });
  commit('Revert "cache totals"', { 'src/pay.js': 'v2' });
  commit('hotfix: webhook bind before queue', { 'src/pay.js': 'v3', 'test/pay.test.js': 't2' });
  commit('fix: broke the old thing', { 'src/old.js': 'old v2' });
  git('mv', 'src/old.js', 'src/renamed.js');
  commit('refactor: rename old', {});
  if (map) {
    mkdirSync(join(root, '.readfirst'), { recursive: true });
    writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: 'amounts are in cents', files: ['src/pay.js'] }] }, { id: 'tests', title: 'tests', files: ['test/**'] }, { id: 'project', title: 'docs', files: ['README.md', 'package.json'] }], rules: [] }));
    commit('chore: map', {});
  }
  return { root, git };
}

const run = (root, ...argv) => {
  let out = ''; let err = '';
  const code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
};

test('read with no map: a file that broke before says so, from git history alone', () => {
  const { root } = history();
  const r = run(root, 'read', 'src/pay.js');
  assert.equal(r.code, 0);
  assert.match(r.err, /no \.readfirst\/map\.json here/u);
  assert.match(r.out, /## Broke before/u);
  assert.match(r.out, /`src\/pay\.js`: broke before: 3 fixes, last \d{4}-\d{2}-\d{2} [0-9a-f]{7} "hotfix: webhook bind before queue"/u);
  const lines = r.out.split('\n').filter((l) => l.startsWith('  - '));
  assert.equal(lines.length, 3, 'the strongest three');
  assert.match(lines[0], /revert: "Revert "cache totals""/u, 'the revert (weight 3) first');
  assert.match(lines[1], /hotfix:/u);
  assert.match(lines[2], /fix: "fix: amounts were in dollars"/u);
  assert.ok(!r.out.includes('not covered'), 'no map, nothing is "not covered"');
});

test('read --json: brokeBefore is an optional field per target, only where there is something to show', () => {
  const { root } = history();
  const j = JSON.parse(run(root, 'read', '--json', 'src/pay.js', 'src/old.js', 'README.md', 'package.json', 'test/pay.test.js', 'src/renamed.js').out);
  const by = Object.fromEntries(j.targets.map((t) => [t.path, t]));
  assert.equal(j.format, 'readfirst/read-list@1');
  assert.equal(by['src/pay.js'].brokeBefore.count, 3);
  assert.equal(by['src/pay.js'].brokeBefore.weight, 6, 'a fix (1), a revert (3) and a hotfix (2)');
  assert.deepEqual(Object.keys(by['src/pay.js'].brokeBefore.top[0]), ['sha', 'date', 'kind', 'subject']);
  assert.ok(!('brokeBefore' in by['README.md']) && !('brokeBefore' in by['package.json']), 'not code never shows');
  assert.ok(!('brokeBefore' in by['test/pay.test.js']), 'a test with two fixes weighs 1, under the line');
  assert.ok(!('brokeBefore' in by['src/renamed.js']), 'no --follow: the history before a rename is not carried over');
  assert.ok(!('brokeBefore' in by['src/old.js']) , 'old.js no longer exists (not tracked)');
  // Without the field: the same list for a file with nothing to show is what it was before.
  const quiet = JSON.parse(run(root, 'read', '--json', 'README.md').out);
  assert.deepEqual(Object.keys(quiet.targets[0]), ['path', 'group', 'status']);
});

test('read with a map: broke before sits beside the map\'s risks, and the map still says what it said', () => {
  const { root } = history({ map: true });
  const r = run(root, 'read', 'src/pay.js');
  assert.equal(r.err, '');
  assert.match(r.out, /## Watch out[\s\S]*amounts are in cents[\s\S]*## Broke before/u);
  assert.ok(!r.out.includes('Nothing in the map is tied'));
});

test('diff and the MCP changed_read_list carry the section for every changed file', () => {
  const { root, git } = history({ map: true });
  git('checkout', '-q', '-b', 'feat');
  writeFileSync(join(root, 'src/pay.js'), 'changed\n');
  writeFileSync(join(root, 'README.md'), 'changed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'wip');
  const r = run(root, 'diff', '--base', 'main');
  assert.match(r.out, /`src\/pay\.js`: broke before: 3 fixes/u);
  assert.ok(!r.out.includes('`README.md`: broke before'));
  // The MCP tool runs the same command.
  const handle = mcpHandler({ version: 't', run: (argv) => { let out = ''; const code = main(['--root', root, ...argv], { out: (x) => { out += x; }, err: () => {} }); return { code, out, err: '' }; } });
  const res = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'changed_read_list', arguments: { base: 'main' } } });
  assert.match(res.result.content[0].text, /`src\/pay\.js`: broke before: 3 fixes/u);
});

test('a shallow clone says history not fetched; a clone with the history does not', () => {
  const { root } = history({ map: true });
  const shallow = mkdtempSync(join(tmpdir(), 'readfirst-shallow-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, shallow]);
  const r = run(shallow, 'read', 'src/pay.js');
  assert.match(r.out, /history not fetched for `src\/pay\.js`/u);
  assert.deepEqual(JSON.parse(run(shallow, 'read', '--json', 'src/pay.js').out).targets[0].brokeBefore, { notFetched: true });
  assert.ok(!r.out.includes('broke before:'));
  assert.ok(!run(shallow, 'read', 'README.md').out.includes('history not fetched'), 'not code: nothing');
  const full = mkdtempSync(join(tmpdir(), 'readfirst-full-'));
  execFileSync('git', ['clone', '-q', `file://${root}`, full]);
  assert.match(run(full, 'read', 'src/pay.js').out, /broke before: 3 fixes/u);
});

test('not a git repository or git failing: nothing, never an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-nogit-'));
  assert.deepEqual(brokeBefore(dir, ['src/a.js']), {});
  const empty = mkdtempSync(join(tmpdir(), 'readfirst-empty-'));
  execFileSync('git', ['-C', empty, 'init', '-q']);
  assert.deepEqual(brokeBefore(empty, ['src/a.js']), {}, 'a repository with no commits');
});

test('the Claude Code hook carries the line once per file, with or without a map', () => {
  for (const map of [false, true]) {
    const { root } = history({ map });
    const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-state-'));
    const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(root, 'src/pay.js') }, cwd: root, session_id: `hist-${map}-${Date.now()}` });
    const out = JSON.parse(runHook(input, { stateDir }));
    assert.match(out.hookSpecificOutput.additionalContext, /Broke before: 3 fixes in src\/pay\.js, last \d{4}-\d{2}-\d{2} [0-9a-f]{7} "hotfix: webhook bind before queue"/u, `map=${map}`);
    assert.equal(runHook(input, { stateDir }), null, 'once per file per session');
  }
});

test('audit lists where the code broke most with no map at all, and says which files the map covers with one', () => {
  const { root } = history();
  const r = run(root, 'audit');
  assert.equal(r.code, 0);
  assert.match(r.out, /## Broke most/u);
  assert.match(r.out, /`src\/pay\.js`: weight \d/u);
  assert.match(r.out, /3 fixes/u);
  assert.ok(!r.out.includes('`test/pay.test.js`'), 'two fixes spread over two files stay under the line');
  assert.match(r.out, /There is no \.readfirst\/map\.json/u);
  const j = JSON.parse(run(root, 'audit', '--json').out);
  assert.equal(j.format, 'readfirst/audit@1');
  assert.deepEqual(j.brokeMost.map((x) => x.path), ['src/pay.js']);
  const mapped = history({ map: true });
  const m = run(mapped.root, 'audit');
  assert.match(m.out, /`src\/pay\.js`: weight[^\n]*\(map: a risk\)/u);
  const rows = JSON.parse(run(mapped.root, 'audit', '--json').out).brokeMost;
  assert.deepEqual(rows[0].covered, { risk: true, rules: [] });
});

test('audit shows nothing rather than a weak list: files that sit at one or two fixes, and files that are not where the trap is', () => {
  const at = (files, subject, n = 0) => ({ sha: String(n).padStart(40, 'a'), time: 1_800_000_000 + n, subject, files });
  const exists = new Set(['src/a.js', 'src/b.js', 'package.json', 'Dockerfile']);
  assert.deepEqual(brokeMost([at(['src/a.js'], 'fix: a', 1), at(['src/b.js'], 'fix: b', 2)], exists), [], 'one fix each');
  assert.deepEqual(brokeMost([at(['src/a.js'], 'Revert "a"', 1)], exists), [], 'one revert is weight 3 but a single commit');
  assert.deepEqual(brokeMost([at(['package.json', 'Dockerfile'], 'fix: a', 1), at(['package.json', 'Dockerfile'], 'fix: b', 2), at(['package.json'], 'fix: c', 3)], exists), [], 'manifests and container files');
  assert.ok(NOT_TRAP.test('packages/x/package.json') && NOT_TRAP.test('src/locales/en.json') && NOT_TRAP.test('.devcontainer/x.yml') && !NOT_TRAP.test('src/app.ts'));
  assert.deepEqual(brokeMost([at(['src/a.js'], 'fix: a', 1), at(['src/a.js'], 'fix: b', 2)], exists).map((r) => [r.path, r.score, r.commits]), [['src/a.js', 2, 2]]);
  const noMap = audit({ map: null, files: ['src/a.js'], imports: [], broke: parseScarLog('\x01aaa\x001800000000\x00fix: a\n\nsrc/a.js\n') });
  assert.equal(noMap.noMap, true);
  assert.match(auditText(noMap), /No file broke often enough/u);
});

test('the Action comment lists the PR\'s files that broke before, and says when the checkout is too shallow', async () => {
  const send = (root, files) => {
    const event = join(root, '..', `${root.split('/').pop()}-event.json`);
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567' } } }));
    const posted = [];
    const fetchImpl = async (url, init) => {
      const u = new URL(url);
      const json = (v, status = 200) => ({ ok: true, status, json: async () => v, text: async () => '' });
      if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? files : []);
      if (init.method === 'GET') return json([]);
      posted.push(JSON.parse(init.body).body);
      return json({ id: 1 });
    };
    return runAction({ env: { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't', GITHUB_API_URL: 'https://api.example' }, fetchImpl, log: () => {} }).then(() => posted[0]);
  };
  const { root } = history({ map: true });
  const changed = [{ filename: 'src/pay.js', status: 'modified' }, { filename: 'README.md', status: 'modified' }];
  const body = await send(root, changed);
  assert.match(body, /## Files in this PR that broke before\n\n- `src\/pay\.js`: broke before: 3 fixes, last/u);
  assert.ok(!body.includes('README.md`: broke before'));
  // Depth 1, as actions/checkout does by default: the changed files still come from the API, the section says what is missing.
  const shallow = mkdtempSync(join(tmpdir(), 'readfirst-action-shallow-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, shallow]);
  const thin = await send(shallow, changed);
  assert.match(thin, /## Files in this PR that broke before\n\n- history not fetched for `src\/pay\.js` \(set fetch-depth: 200 on actions\/checkout\)/u);
  assert.match(thin, /## readfirst/u);
  assert.match(thin, /amounts are in cents/u, 'the rest of the comment is unchanged');
  // No history to speak of (a repository with no commits): no section.
  const bare = mkdtempSync(join(tmpdir(), 'readfirst-action-bare-'));
  execFileSync('git', ['-C', bare, 'init', '-q', '-b', 'main']);
  mkdirSync(join(bare, 'src'), { recursive: true });
  writeFileSync(join(bare, 'src/pay.js'), 'x\n');
  mkdirSync(join(bare, '.readfirst'), { recursive: true });
  writeFileSync(join(bare, '.readfirst/map.json'), JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'code', files: ['src/**'] }], rules: [] }));
  execFileSync('git', ['-C', bare, 'add', '.']);
  assert.ok(!(await send(bare, changed)).includes('broke before'));
  assert.ok(commentBody({ list: null, problems: [], removed: [], commit: null, broke: [] }).includes('No changed files to look up.'));
});

test('init --ci writes fetch-depth: 200 into the workflow it creates', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-ci-'));
  assert.equal(writeWorkflow(root), true);
  const yml = readFileSync(join(root, WORKFLOW_PATH), 'utf8');
  assert.match(yml, /actions\/checkout@[^\n]*\n        with:\n          fetch-depth: 200/u);
  assert.equal(writeWorkflow(root), false, 'never over an existing workflow');
});

test('the read list for no history is the read list it was: nothing renamed, nothing added', () => {
  const list = readList({ map: { format: 'readfirst/map@1', groups: [{ id: 'a', title: 'a', files: ['src/**'] }], rules: [] }, files: ['src/a.js'], imports: [], targets: ['src/a.js'] });
  assert.deepEqual(Object.keys(list.targets[0]), ['path', 'group', 'status']);
  assert.ok(!toMarkdown(list).includes('Broke before'));
});
