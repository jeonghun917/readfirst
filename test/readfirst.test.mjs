import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { importEdges } from '../src/imports.mjs';
import { draftMap, MAP_FORMAT, mapProblems, patternToRegExp } from '../src/map.mjs';
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

test('draft: one group per folder (sub-folders under src), tests together, media-only folders ignored; it passes the check', () => {
  const files = Object.keys(FIXTURE).sort();
  const map = draftMap(files);
  assert.equal(map.format, MAP_FORMAT);
  assert.deepEqual(map.groups.map((g) => g.id), ['py', 'root', 'src', 'src-api', 'src-billing', 'src-util', 'tests']);
  assert.deepEqual(map.groups.find((g) => g.id === 'src').files, ['src/main.js']);
  assert.deepEqual(map.ignore, ['img/**']);
  assert.deepEqual(mapProblems(map, files), []);
});

test('check: unplaced, twice-placed, dead patterns, unknown fields and bad rules are named', () => {
  const files = Object.keys(FIXTURE).sort();
  const map = draftMap(files);
  const p = (m) => mapProblems(m, files).join('\n');
  assert.match(p({ ...map, ignore: [] }), /1 file\(s\) in no group and not ignored: img\/logo.png/u);
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
