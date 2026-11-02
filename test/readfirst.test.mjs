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
  const settled = run(root, 'check');
  assert.equal(settled.code, 0, 'a new file beside placed ones passes');
  assert.match(settled.out, /settled without writing[\s\S]*stray\.txt/u);
  const strict = run(root, 'check', '--strict');
  assert.equal(strict.code, 1, '--strict still fails on it');
  assert.match(strict.out, /stray\.txt/u);
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'tools/gen.ts'), 'export {};\n');
  const top = run(root, 'check');
  assert.equal(top.code, 1);
  assert.match(top.out, /new top-level folder tools\/ is in no group/u);
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
  assert.equal(run(root, 'check').code, 0, 'both new files have placed neighbours');
  assert.equal(run(root, 'check', '--strict').code, 1);
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

test('hook: the read list goes to Claude Code as context once per file per session; it never blocks', async () => {
  const { runHook, installHook, HOOK_COMMAND } = await import('../src/cli.mjs');
  const { root } = repo(FIXTURE);
  run(root, 'init');
  const mapAt = join(root, '.readfirst/map.json');
  const map = JSON.parse(readFileSync(mapAt, 'utf8'));
  map.groups.find((g) => g.id === 'src-billing').risks = [{ text: 'amounts are in cents' }];
  map.rules = [{ id: 'no-double-charge', rule: 'a charge runs once per order', why: 'refunds are manual', files: ['src/billing/**'] }];
  writeFileSync(mapAt, JSON.stringify(map));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-hook-'));
  const ev = (over = {}) => JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, 'src/billing/charge.ts') }, ...over });

  const out = JSON.parse(runHook(ev(), { stateDir, now: 1000 }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'it informs, it does not decide');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^readfirst notes for src\/billing\/charge.ts/u);
  assert.match(ctx, /Rule no-double-charge: a charge runs once per order \(why: refunds are manual\)/u);
  assert.match(ctx, /Risk: amounts are in cents/u);
  assert.match(ctx, /Check to run after the change: npm test/u);

  assert.equal(runHook(ev(), { stateDir, now: 2000 }), null, 'the same file in the same session is not repeated');
  assert.ok(runHook(ev({ session_id: 's2' }), { stateDir, now: 2000 }), 'a new session hears it again');
  assert.ok(runHook(ev({ tool_name: 'Write', tool_input: { file_path: 'src/billing/new.ts' }, session_id: 's3' }), { stateDir }), 'a new file in a mapped folder');
  assert.equal(runHook(ev({ tool_name: 'Bash', tool_input: { command: 'ls' } }), { stateDir }), null);
  assert.equal(runHook(ev({ tool_input: { file_path: '/elsewhere/x.ts' }, session_id: 's4' }), { stateDir }), null, 'outside the repository');
  assert.equal(runHook('not json', { stateDir }), null);

  // install keeps what is there and adds the hook once
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  assert.equal(installHook(root), true);
  assert.equal(installHook(root), false);
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 15 }] }]);

  // through main: stdin in, JSON out, exit 0
  let printed = '';
  assert.equal(main(['hook'], { out: (s) => { printed += s; }, err: () => {} }, () => ev({ session_id: `s5-${process.pid}-${Date.now()}` })), 0);
  assert.match(printed, /additionalContext/u);
});

test('view and labels: the page is written under .readfirst/local, which this clone keeps out of git; labels are read only from there', () => {
  const { root, git } = repo({ 'src/a.js': "import './b.js'\n", 'src/b.js': '', 'test/a.test.js': "import '../src/a.js'\n" });
  assert.equal(run(root, 'init').code, 0);
  const map = JSON.parse(readFileSync(join(root, '.readfirst/map.json'), 'utf8'));
  map.groups[0].risks = [{ text: 'b is generated', files: ['src/b.js'] }];
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify(map));

  const brief = run(root, 'prompt', '--labels', 'ko');
  assert.equal(brief.code, 0);
  assert.match(brief.out, /\.readfirst\/local\/labels\/ko\.json/u);
  assert.match(brief.out, /No metaphors, analogies/u);
  assert.match(brief.out, /"b is generated"/u);
  assert.match(brief.out, /"text": \{ "<string from the map/u);
  assert.doesNotMatch(run(root, 'prompt', '--labels', 'en').out, /faithful English translation/u);
  assert.throws(() => run(root, 'prompt', '--labels', '../x'), /language code/u);
  // prompt never writes: the exclude line comes from view
  assert.doesNotMatch(readFileSync(join(root, '.git/info/exclude'), 'utf8'), /readfirst/u);
  assert.equal(run(root, 'view').code, 0);
  assert.equal(run(root, 'view').code, 0);
  const exclude = readFileSync(join(root, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '/.readfirst/local/').length, 1);

  mkdirSync(join(root, '.readfirst/local/labels'), { recursive: true });
  writeFileSync(join(root, '.readfirst/local/labels/ko.json'), JSON.stringify({ format: 'readfirst/labels@1', lang: 'ko', text: { 'b is generated': 'b는 생성 파일' }, plain: { groups: { [map.groups[0].id]: { name: '소스', about: '앱 코드' } } } }));
  writeFileSync(join(root, '.readfirst/local/labels/broken.json'), '{');
  const view = run(root, 'view');
  assert.equal(view.code, 0);
  assert.match(view.out, /with labels: ko/u);
  const html = readFileSync(join(root, '.readfirst/local/view.html'), 'utf8');
  assert.match(html, /b는 생성 파일/u);
  assert.match(html, /"edges":\[\["src\/a\.js","src\/b\.js"\]/u);
  // nothing personal shows up as a change or breaks the check
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '?? .readfirst/map.json\n');
  assert.equal(run(root, 'check').code, 0);
});

test('verify: runs the checks for the changed files once each, reports pass, fail and timeout, and exits 1 on a failure', () => {
  const { root } = repo({ 'a/x.js': '', 'a/y.js': '', 'b/z.js': '', 'c/w.js': '' });
  const map = {
    format: MAP_FORMAT,
    groups: [
      { id: 'a', title: 'a', files: ['a/**'], checks: [{ run: 'node -e "process.exit(0)"', why: 'a works' }] },
      { id: 'b', title: 'b', files: ['b/**'], checks: [{ run: 'node -e "console.log(\'boom\');process.exit(3)"', why: 'b works' }, { run: 'node -e "process.exit(0)"' }] },
      { id: 'c', title: 'c', files: ['c/**'], checks: [{ run: 'node -e "setTimeout(()=>{},20000)"' }] },
    ],
  };
  mkdirSync(join(root, '.readfirst'), { recursive: true });
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify(map));
  // nothing changed but the map itself, which no group covers: the map's own file is not a code change with checks
  writeFileSync(join(root, 'a/x.js'), '1');
  writeFileSync(join(root, 'a/y.js'), '2');
  let r = run(root, 'verify');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pass {2}node -e "process\.exit\(0\)"/u);
  assert.equal(r.out.match(/running /gu).length, 1); // two changed files in a, one check

  writeFileSync(join(root, 'b/z.js'), '3');
  const dry = run(root, 'verify', '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.out, /checks for \d changed file/u);
  assert.doesNotMatch(dry.out, /running /u);

  r = run(root, 'verify', '--json');
  assert.equal(r.code, 1);
  const report = JSON.parse(r.out);
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.map((c) => c.status), ['pass', 'fail']); // the shared command runs once
  assert.match(report.checks[1].output, /boom/u);
  assert.equal(report.checks[1].code, 3);

  writeFileSync(join(root, 'c/w.js'), '4');
  r = run(root, 'verify', '--json', '--timeout', '1');
  assert.equal(JSON.parse(r.out).checks.at(-1).status, 'timeout');
});

test('verify: no changes means nothing to run', () => {
  const { root } = repo({ 'a/x.js': '', '.readfirst/map.json': JSON.stringify({ format: MAP_FORMAT, groups: [{ id: 'a', title: 'a', files: ['a/**', '.readfirst/**'], checks: [{ run: 'exit 1' }] }] }) });
  const r = run(root, 'verify');
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to verify/u);
});

test('mcp: initialize, tools/list and tools/call over stdio answer from the checkout as it is', async () => {
  const { root } = repo({ 'src/a.js': "import './b.js'\n", 'src/b.js': '' });
  run(root, 'init');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(dirname(new URL(import.meta.url).pathname), '../bin/readfirst.mjs'), 'mcp', '--root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = []; let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_list', arguments: { files: ['src/b.js'] } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_list', arguments: { files: [] } } });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_map', arguments: {} } });
  send({ jsonrpc: '2.0', id: 6, method: 'nope' });
  child.stdin.write('not json\n');
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`only ${lines.length} answers`)), 10000); const iv = setInterval(() => { if (lines.length >= 7) { clearInterval(iv); clearTimeout(t); resolve(); } }, 20); });
  child.kill();
  const by = Object.fromEntries(lines.filter((l) => l.id != null).map((l) => [l.id, l]));
  assert.equal(by[1].result.protocolVersion, '2025-03-26');
  assert.equal(by[1].result.serverInfo.name, 'readfirst');
  assert.deepEqual(by[2].result.tools.map((t) => t.name), ['read_list', 'changed_read_list', 'check_map']);
  assert.match(by[3].result.content[0].text, /Read first: `src\/b\.js`/u);
  assert.match(by[3].result.content[0].text, /src\/a\.js/u); // a uses b
  assert.equal(by[3].result.isError, false);
  assert.equal(by[4].result.isError, true);
  assert.match(by[5].result.content[0].text, /is good/u);
  assert.equal(by[6].error.code, -32601);
  assert.equal(lines.find((l) => l.id === null).error.code, -32700);
  assert.equal(lines.length, 7); // the notification got no answer
});

test('diff and verify explain a shallow clone instead of failing with a git error', () => {
  const { root, git } = repo({ 'a.js': '' });
  git('checkout', '-q', '--orphan', 'other');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'unrelated');
  run(root, 'init');
  assert.throws(() => run(root, 'diff', '--base', 'main'), /shallow[\s\S]*--base/u);
});

test('server.json (MCP Registry) names the same package, version and mcpName as package.json, and runs `readfirst mcp`', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.deepEqual(server.packages[0].packageArguments, [{ type: 'positional', value: 'mcp' }]);
  assert.ok(server.description.length <= 100);
});

test('mcp: starts and lists its tools outside a git repository; a tool call there says where to start it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-nogit-'));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(dirname(new URL(import.meta.url).pathname), '../bin/readfirst.mjs'), 'mcp'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  for (const m of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_map', arguments: {} } },
  ]) child.stdin.write(`${JSON.stringify(m)}\n`);
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`only ${lines.length} answers`)), 10000); const iv = setInterval(() => { if (lines.length >= 3) { clearInterval(iv); clearTimeout(t); resolve(); } }, 20); });
  child.kill();
  assert.equal(lines[0].result.serverInfo.name, 'readfirst');
  assert.equal(lines[1].result.tools.length, 3);
  assert.equal(lines[2].result.isError, true);
  assert.match(lines[2].result.content[0].text, /not inside a git repository/u);
});

test('hook --stop: before Claude Code finishes, the checks for files it edited run; a failure blocks once', async () => {
  const { runHook, runStopHook, installHook, STOP_HOOK_COMMAND } = await import('../src/cli.mjs');
  const { root, git } = repo(FIXTURE);
  run(root, 'init');
  const mapAt = join(root, '.readfirst/map.json');
  const map = JSON.parse(readFileSync(mapAt, 'utf8'));
  for (const g of map.groups) g.checks = g.id === 'src-billing' ? [{ run: 'test -f ok.flag', why: 'the flag' }] : [];
  writeFileSync(mapAt, JSON.stringify(map));
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'map');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-stop-'));
  const stop = (over = {}) => runStopHook(JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'Stop', stop_hook_active: false, ...over }), { stateDir, timeout: 30 });

  assert.equal(stop(), null, 'nothing edited in this session');
  runHook(JSON.stringify({ session_id: 's1', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/billing/charge.ts') } }), { stateDir });
  assert.equal(stop(), null, 'seen but not changed');
  writeFileSync(join(root, 'src/billing/charge.ts'), `${readFileSync(join(root, 'src/billing/charge.ts'), 'utf8')}\n// edited\n`);
  const blocked = JSON.parse(stop());
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /1 of 1 check\(s\).*failed/u);
  assert.match(blocked.reason, /test -f ok\.flag \(fail, exit 1\) covers the flag/u);
  assert.equal(stop({ stop_hook_active: true }), null, 'the second stop of the turn lets go');
  writeFileSync(join(root, 'ok.flag'), '');
  assert.match(JSON.parse(stop()).systemMessage, /1 check\(s\) passed for 1 edited file/u);
  assert.equal(stop({ session_id: 'other' }), null, 'another session edited nothing');

  assert.equal(installHook(root, { verify: true }), true);
  assert.equal(installHook(root, { verify: true }), false);
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: STOP_HOOK_COMMAND, timeout: 1800 }] }]);
});
