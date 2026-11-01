import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { importEdges } from '../src/imports.mjs';
import { draftChecks, draftMap, fixMap, MAP_FORMAT, mapProblems, patternToRegExp } from '../src/map.mjs';
import { readList, toMarkdown } from '../src/readlist.mjs';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-'));
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

const FIXTURE = {
  'package.json': '{"scripts":{"test":"node --test"}}',
  'README.md': '# app',
  'src/billing/charge.ts': "import { money } from '../util/money.js';\nexport const charge = () => money(1);\n",
  'src/billing/index.ts': "export * from './charge';\n",
  'src/util/money.ts': 'export const money = (n: number) => n;\n',
  'src/api/route.js': "const { charge } = require('../billing');\nmodule.exports = charge;\n",
  'src/main.js': "import './api/route.js';\n",
  'test/charge.test.ts': "import { charge } from '../src/billing/charge';\n",
  'test/route.test.js': "import '../src/api/route.js';\n",
  'img/logo.png': 'x',
  'py/app/__init__.py': '',
  'py/app/db.py': 'X = 1\n',
  'py/app/views.py': 'from .db import X\nfrom . import db\n',
  'py/test_views.py': 'import app.views\nfrom app import db\n',
  'py/app/multi.py': 'from . import (\n    db,  # the store\n    views,\n)\n',
};

test('patterns: paths, folders and one-segment globs', () => {
  assert.ok(patternToRegExp('src/**').test('src/a/b.js'));
  assert.ok(!patternToRegExp('src/**').test('srcx/a.js'));
  assert.ok(patternToRegExp('src/*.js').test('src/a.js'));
  assert.ok(!patternToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(patternToRegExp('**/*.md').test('docs/x/y.md'));
  assert.ok(patternToRegExp('README.md').test('README.md') && !patternToRegExp('README.md').test('xREADME.md'));
  assert.ok(patternToRegExp('src/?/**').test('src/a/x.js') && !patternToRegExp('src/?/**').test('src/abc/x.js'), '? is one character, also before /**');
  assert.ok(!patternToRegExp('a.b/**').test('axb/c.js'), 'dots are literal');
});

test('imports: JS/TS (import, export from, require, .js for .ts, folder index) and Python (relative, absolute, sub-modules)', () => {
  const files = Object.keys(FIXTURE).sort();
  const edges = importEdges(files, (p) => FIXTURE[p]).map((e) => `${e.from} -> ${e.to}:${e.line}`);
  for (const e of ['src/billing/charge.ts -> src/util/money.ts:1', 'src/billing/index.ts -> src/billing/charge.ts:1', 'src/api/route.js -> src/billing/index.ts:1',
    'src/main.js -> src/api/route.js:1', 'test/charge.test.ts -> src/billing/charge.ts:1', 'py/app/views.py -> py/app/db.py:1',
    'py/app/multi.py -> py/app/db.py:1', 'py/app/multi.py -> py/app/views.py:1'])
    assert.ok(edges.includes(e), `missing ${e}: ${edges.join('; ')}`);
});

test('draft: one group per folder (sub-folders under src), tests together, media-only folders as their own group; it passes the check', () => {
  const files = Object.keys(FIXTURE).sort();
  const map = draftMap(files);
  assert.equal(map.format, MAP_FORMAT);
  assert.deepEqual(map.groups.map((g) => g.id), ['img', 'py', 'root', 'src', 'src-api', 'src-billing', 'src-util', 'tests']);
  assert.deepEqual(map.groups.find((g) => g.id === 'src').files, ['src/main.js']);
  assert.deepEqual(map.ignore, [], 'media folders get a group, not ignore: code loads them');
  assert.match(map.groups.find((g) => g.id === 'img').title, /media files in img\/\*\* \(binary, not read\)/u);
  assert.deepEqual(mapProblems(map, files), []);
});

test('check: unplaced, twice-placed, dead patterns, unknown fields and bad rules are named', () => {
  const files = Object.keys(FIXTURE).sort();
  const map = draftMap(files);
  const p = (m) => mapProblems(m, files).join('\n');
  assert.match(p({ ...map, groups: map.groups.filter((g) => g.id !== 'img') }), /1 file\(s\) in no group and not ignored: img\/logo.png/u);
  assert.match(p({ ...map, groups: [...map.groups, { id: 'all-src', title: 'x', files: ['src/main.js'] }] }), /src\/main.js: in more than one group/u);
  assert.match(p({ ...map, groups: [...map.groups, { id: 'gone', title: 'x', files: ['nope/**'] }] }), /nope\/\*\* matches no tracked file/u);
  assert.match(p({ ...map, extra: 1 }), /map.extra: unknown field/u);
  assert.match(p({ ...map, rules: [{ id: 'r', rule: 'x', files: ['nope.js'] }] }), /rules\[0\].files: nope.js matches no tracked file/u);
  assert.match(p({ ...map, rules: [{ id: 'r', rule: 'x', files: ['src/**'] }, { id: 'r', rule: 'y', files: ['src/**'] }] }), /r is used twice/u);
});

test('read list: rules, risks, checks, tests (direct first, then through other files), users and what the map does not cover', () => {
  const files = Object.keys(FIXTURE).sort();
  const map = draftMap(files);
  const billing = map.groups.find((g) => g.id === 'src-billing');
  billing.title = 'charging cards';
  billing.checks = [{ run: 'npm test -- billing', why: 'charges' }];
  billing.risks = [{ text: 'amounts are in cents' }, { text: 'index re-exports everything', files: ['src/billing/index.ts'] }];
  map.rules = [{ id: 'no-double-charge', rule: 'a charge runs once per order', why: 'refunds are manual', files: ['src/billing/**'], checks: [{ run: 'npm run e2e:pay' }] }];
  const imports = importEdges(files, (p) => FIXTURE[p]);
  const list = readList({ map, files, imports, targets: ['src/billing/charge.ts', 'nope.js'] });
  assert.deepEqual(list.targets, [{ path: 'src/billing/charge.ts', group: 'src-billing', status: 'IN_MAP' }, { path: 'nope.js', group: null, status: 'NOT_TRACKED' }]);
  assert.deepEqual(list.rules.map((r) => r.id), ['no-double-charge']);
  assert.deepEqual(list.risks.map((r) => r.text), ['amounts are in cents'], 'a risk tied to other files is left out');
  assert.deepEqual(list.checks.map((c) => c.run), ['npm test -- billing', 'npm run e2e:pay']);
  assert.deepEqual(list.tests.map((t) => [t.path, t.via]), [['test/charge.test.ts', null], ['test/route.test.js', 'src/api/route.js']]);
  assert.deepEqual(list.usedBy.map((u) => u.path), ['src/billing/index.ts']);
  assert.equal(list.usedByIndirectly, 2, 'route.js and main.js');
  assert.equal(list.notCovered[0].path, 'nope.js');
  const md = toMarkdown(list);
  for (const s of ['## Rules that must keep holding', 'refunds are manual', '`npm run e2e:pay`', '(through `src/api/route.js`)', '`src/billing/index.ts:1`', '2 more file(s)', '`nope.js`'])
    assert.ok(md.includes(s), `markdown lacks ${s}`);
  assert.throws(() => readList({ map, files, imports, targets: [] }), /at least one file/u);
  const withMap = readList({ map, files: [...files, '.readfirst/map.json'], imports, targets: ['.readfirst/map.json', 'src/billing/charge.ts'] });
  assert.deepEqual(withMap.targets[0], { path: '.readfirst/map.json', group: null, status: 'MAP' });
  assert.deepEqual(withMap.notCovered, [], 'the map itself is not reported as uncovered');
  assert.ok(toMarkdown(withMap).includes('- amounts are in cents _(group src-billing · src/billing/charge.ts)_'), toMarkdown(withMap));
});

test('cli: init, check, prompt, read and diff on a real git repository', () => {
  const { root, git } = repo(FIXTURE);
  assert.throws(() => run(root, 'read', 'src/main.js'), /run `readfirst init` first/u);
  assert.equal(run(root, 'init').code, 0);
  assert.throws(() => run(root, 'init'), /already exists/u);
  assert.equal(run(root, 'init', '--force').code, 0, '--force is a switch, not a value');
  assert.throws(() => run(root, 'read', '--limit', '0', 'src/main.js'), /--limit needs a whole number/u);
  assert.match(run(root, 'check').out, /is good/u);
  assert.match(run(root, 'prompt').out, /src-billing \(src\/billing\/\*\*\)/u);
  assert.match(run(root, 'read', 'src/util/money.ts').out, /`src\/billing\/charge.ts:1`/u);
  const json = JSON.parse(run(root, 'read', '--json', 'src/util/money.ts').out);
  assert.equal(json.format, 'readfirst/read-list@1');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'map');
  git('checkout', '-q', '-b', 'work');
  assert.deepEqual(JSON.parse(run(root, 'diff', '--json').out).targets, [], 'no changes is still JSON');
  writeFileSync(join(root, 'src/util/money.ts'), 'export const money = (n: number) => n * 100;\n');
  writeFileSync(join(root, 'src/util/new.ts'), 'export {};\n');
  const diff = JSON.parse(run(root, 'diff', '--json').out);
  assert.deepEqual(diff.targets.map((t) => t.path), ['src/util/money.ts', 'src/util/new.ts'], 'changed and new files');
  writeFileSync(join(root, 'stray.txt'), 'x');
  const bad = run(root, 'check');
  assert.equal(bad.code, 1);
  assert.match(bad.out, /stray.txt/u);
  assert.ok(JSON.parse(readFileSync(join(root, '.readfirst/map.json'), 'utf8')).groups.length > 0);
});

test('fix: new files join their nearest neighbour group, a new folder joins whole, dead patterns are dropped', () => {
  const map = {
    format: MAP_FORMAT,
    groups: [
      { id: 'billing', title: 'billing', files: ['src/billing/**', 'src/old.js'], risks: [{ text: 'cents', files: ['src/billing/gone.ts'] }] },
      { id: 'api', title: 'api', files: ['src/api/**'] },
      { id: 'root', title: 'root', files: ['README.md'] },
    ],
    rules: [{ id: 'r', rule: 'x', files: ['src/api/**', 'src/api/deleted.js'] }],
  };
  const files = ['README.md', 'src/api/route.js', 'src/billing/charge.ts', 'src/billing/refund/a.ts', 'src/billing/refund/b.ts', 'src/new.js', 'top.txt'].sort();
  // src/billing/refund/ is already matched by src/billing/**; src/new.js and top.txt are new.
  const { map: fixed, changes, problems } = fixMap(map, files);
  assert.deepEqual(problems, []);
  assert.deepEqual(fixed.groups[0].files, ['src/billing/**']);
  assert.equal(fixed.groups[0].risks[0].files, undefined, 'a risk whose files are all gone becomes a group-wide risk');
  assert.deepEqual(fixed.rules[0].files, ['src/api/**']);
  assert.ok(fixed.groups.some((g) => g.files.includes('top.txt')), 'a root file joins the root group');
  assert.ok(changes.some((c) => /added src\/new\.js/u.test(c)));
  assert.ok(changes.some((c) => /dropped src\/old\.js/u.test(c)));
  assert.deepEqual(map.groups[0].files, ['src/billing/**', 'src/old.js'], 'the input map is left alone');

  // A whole new folder becomes one pattern in the group of its parent's files.
  const m2 = { format: MAP_FORMAT, groups: [{ id: 'src', title: 'src', files: ['src/a.js'] }] };
  const r2 = fixMap(m2, ['src/a.js', 'src/feature/x.js', 'src/feature/deep/y.js']);
  assert.deepEqual(r2.map.groups[0].files, ['src/a.js', 'src/feature/**']);
  assert.deepEqual(r2.problems, []);

  // Nothing to go on: the file stays a problem for a person.
  const r3 = fixMap({ format: MAP_FORMAT, groups: [{ id: 'g', title: 'g', files: ['a/x.js'] }] }, ['a/x.js', 'b/y.js']);
  assert.match(r3.problems.join(), /in no group/u);
  // A group whose only pattern died is not emptied.
  const r4 = fixMap({ format: MAP_FORMAT, groups: [{ id: 'g', title: 'g', files: ['gone/**'] }, { id: 'h', title: 'h', files: ['a.js'] }] }, ['a.js']);
  assert.deepEqual(r4.map.groups[0].files, ['gone/**']);
  assert.match(r4.problems.join(), /gone\/\*\* matches no tracked file/u);
});

test('cli: fix writes the repaired map and says what is left', () => {
  const { root, git } = repo(FIXTURE);
  run(root, 'init');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'map');
  mkdirSync(join(root, 'src/billing/refunds'), { recursive: true });
  writeFileSync(join(root, 'src/billing/refunds/refund.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/brandnew.ts'), 'export {};\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  assert.equal(run(root, 'check').code, 1);
  const r = run(root, 'fix');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /added src\/brandnew\.ts/u);
  assert.match(run(root, 'check').out, /is good/u);
  assert.match(run(root, 'fix').out, /nothing to fix automatically/u);
});

test('draft checks come from the project build files; placeholders and media groups get none', () => {
  const read = (files) => (p) => files[p] ?? null;
  assert.deepEqual(draftChecks(['package.json'], read({ 'package.json': '{"scripts":{"test":"vitest","lint":"eslint .","typecheck":"tsc"}}' })),
    [{ run: 'npm test', why: 'the test suite' }, { run: 'npm run typecheck', why: 'types' }, { run: 'npm run lint', why: 'lint rules' }]);
  assert.deepEqual(draftChecks(['package.json', 'pnpm-lock.yaml'], read({ 'package.json': '{"scripts":{"test":"vitest"}}' })), [{ run: 'pnpm test', why: 'the test suite' }]);
  assert.deepEqual(draftChecks(['package.json'], read({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), []);
  assert.deepEqual(draftChecks(['Makefile', 'go.mod'], read({ Makefile: 'build:\n\tgo build\ntest:\n\tgo test ./...\n' })).map((c) => c.run), ['make test', 'go test ./...']);
  assert.deepEqual(draftChecks(['pyproject.toml', 'tests/test_app.py']).map((c) => c.run), ['pytest']);
  const map = draftMap(['package.json', 'src/a.js', 'img/x.png'], read({ 'package.json': '{"scripts":{"test":"node --test"}}' }));
  assert.deepEqual(map.groups.find((g) => g.id === 'src').checks, [{ run: 'npm test', why: 'the test suite' }]);
  assert.deepEqual(map.groups.find((g) => g.id === 'img').checks, []);
});

test('cli: init --agent adds the line once; read keeps working on a map that is only behind and names the group fix would use', () => {
  const { root } = repo({ ...FIXTURE, 'CLAUDE.md': '# notes\n' });
  const init = run(root, 'init', '--agent');
  assert.match(init.out, /checks found: npm test/u);
  assert.match(init.out, /added the read-first line to CLAUDE\.md/u);
  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /^# notes\n\nBefore changing a file, run `npx readfirst read <file>`/u);
  run(root, 'init', '--force', '--agent');
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8').match(/readfirst read/gu).length, 1, 'not added twice');

  writeFileSync(join(root, 'src/util/fresh.ts'), 'export {};\n');
  mkdirSync(join(root, 'brandnew'), { recursive: true });
  writeFileSync(join(root, 'brandnew/x.ts'), 'export {};\n');
  let err = '';
  const out = []; const code = main(['--root', root, 'read', '--json', 'src/util/fresh.ts'], { out: (s) => out.push(s), err: (s) => { err += s; } });
  assert.equal(code, 0);
  assert.match(err, /behind the code/u);
  const list = JSON.parse(out.join(''));
  assert.equal(list.targets[0].status, 'IN_MAP', 'a new file in a mapped folder is already covered by its folder pattern');
  const lone = JSON.parse((() => { let o = ''; main(['--root', root, 'read', '--json', 'brandnew/x.ts'], { out: (s) => { o += s; }, err: () => {} }); return o; })());
  assert.equal(lone.targets[0].status, 'NO_GROUP');
  assert.match(lone.notCovered[0].why, /in no group/u);

  // A map broken in itself still stops read.
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify({ format: 'readfirst/map@1', groups: [] }));
  assert.throws(() => run(root, 'read', 'src/main.js'), /has problems/u);
});

test('read: a file in no group names the group `readfirst fix` would put it in', async () => {
  const { readList } = await import('../src/readlist.mjs');
  const map = { format: MAP_FORMAT, groups: [{ id: 'core', title: 'core', files: ['src/a.js'] }] };
  const list = readList({ map, files: ['src/a.js', 'src/b.js'], imports: [], targets: ['src/b.js'] });
  assert.match(list.notCovered[0].why, /`readfirst fix` would add it to group core/u);
});
