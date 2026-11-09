import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { audit, auditText } from '../src/audit.mjs';
import { brief, main } from '../src/cli.mjs';
import { find, findText } from '../src/find.mjs';
import { HELD_FORMAT, heldInRun, parseHeld, recordHeld } from '../src/held.mjs';
import { mapProblems } from '../src/map.mjs';
import { readList, toMarkdown } from '../src/readlist.mjs';

const MAP = () => ({
  format: 'readfirst/map@1',
  groups: [
    { id: 'billing', title: 'billing', files: ['billing/**'] },
    { id: 'legacy', title: 'old billing', files: ['legacy/**'], deprecated: { why: 'moving to billing/ by Q1', use: 'billing' } },
    { id: 'app', title: 'app', files: ['app/**'] },
  ],
  rules: [
    { id: 'cents', rule: 'amounts are integers in cents', files: ['billing/**', 'legacy/**'], checks: [{ run: 'node -e "process.exit(0)"' }] },
    { id: 'no-net', rule: 'no network calls in billing', files: ['billing/**'], checks: [{ run: 'node -e "process.exit(1)"' }] },
    { id: 'words', rule: 'a rule with no check', files: ['app/**'] },
  ],
});
const FILES = ['billing/charge.js', 'legacy/charge.js', 'app/pay.js', 'app/pay.test.js'];

test('map: deprecated is optional, needs a why, and its use must be a group id or a tracked path', () => {
  assert.deepEqual(mapProblems(MAP(), FILES), []);
  const bad = MAP();
  bad.groups[1].deprecated = { use: 'billing' };
  assert.match(mapProblems(bad, FILES).join('\n'), /groups\[1\]\.deprecated: \{ why, use\? \}/u);
  bad.groups[1].deprecated = { why: 'x', use: 'nowhere/**', extra: 1 };
  const p = mapProblems(bad, FILES).join('\n');
  assert.match(p, /deprecated\.extra: unknown field/u);
  assert.match(p, /deprecated\.use: nowhere\/\*\* is no group id and matches no tracked file/u);
  const path = MAP();
  path.groups[1].deprecated.use = 'billing/charge.js';
  assert.deepEqual(mapProblems(path, FILES), [], 'a tracked path works as well as a group id');
});

test('read lists, the hook brief and find send people to the replacement', () => {
  const list = readList({ map: MAP(), files: FILES, imports: [], targets: ['legacy/charge.js'] });
  assert.deepEqual(list.deprecated, [{ group: 'legacy', why: 'moving to billing/ by Q1', use: 'billing', for: ['legacy/charge.js'] }]);
  assert.match(toMarkdown(list), /## Being replaced\n\n- group \*\*legacy\*\* is being replaced: use `billing` instead — moving to billing\/ by Q1/u);
  assert.equal(brief(list)[0], 'Being replaced: group legacy; use billing instead (moving to billing/ by Q1). Do not add to it.');
  const read = (p) => ({ 'billing/charge.js': 'export function charge() {}', 'legacy/charge.js': 'export function charge() {}' })[p] ?? null;
  const r = find({ query: 'charge', files: FILES, read, map: MAP() });
  const defs = r.code.filter((h) => h.name === 'charge');
  assert.deepEqual(defs.map((h) => h.file), ['billing/charge.js', 'legacy/charge.js'], 'the one being replaced comes last');
  assert.deepEqual(defs[1].deprecated, { use: 'billing' });
  assert.match(findText(r), /`charge` \(function\) in `legacy\/charge.js:1` — [^\n]*being replaced: use billing/u);
});

test('audit lists code being replaced that other code still imports', () => {
  const imports = [{ from: 'app/pay.js', to: 'legacy/charge.js', line: 1 }, { from: 'app/pay.test.js', to: 'legacy/charge.js', line: 1 }, { from: 'legacy/charge.js', to: 'billing/charge.js', line: 1 }];
  const a = audit({ map: MAP(), files: FILES, imports });
  assert.deepEqual(a.replacing.find((d) => d.group === 'legacy'), { group: 'legacy', use: 'billing', why: 'moving to billing/ by Q1', users: 1, files: ['app/pay.js'] });
  assert.match(auditText(a), /## Code being replaced that is still used\n\n- group \*\*legacy\*\* \(use `billing`\): imported by 1 file\(s\) outside it: `app\/pay.js`/u);
});

test('audit names every file still importing code being replaced (it named five and counted the rest)', () => {
  const users = Array.from({ length: 18 }, (_, i) => `app/u${String(i).padStart(2, '0')}.js`);
  const a = audit({ map: MAP(), files: [...FILES, ...users], imports: users.map((from) => ({ from, to: 'legacy/charge.js', line: 1 })) });
  const legacy = a.replacing.find((d) => d.group === 'legacy');
  assert.equal(legacy.files.length, legacy.users, '--json lists them all');
  assert.match(auditText(a), /imported by 18 file\(s\) outside it: `app\/u00\.js`[^\n]*, and 3 more: `app\/u15\.js`, `app\/u16\.js`, `app\/u17\.js`/u);
});

test('held: a rule holds when every check of it passed; the record keeps the commit and drops rules the map lost', () => {
  const results = [{ run: 'node -e "process.exit(0)"', status: 'pass' }, { run: 'node -e "process.exit(1)"', status: 'fail' }];
  assert.deepEqual(heldInRun(MAP(), ['billing/charge.js'], results), ['cents']);
  assert.deepEqual(heldInRun(MAP(), ['app/pay.js'], results), [], 'a rule with no check never holds by itself');
  const rec = recordHeld({ format: HELD_FORMAT, rules: { gone: { commit: 'x', date: '2026-01-01' } } }, ['cents'], { commit: 'c'.repeat(40), date: '2026-11-03', map: MAP() });
  assert.deepEqual(rec, { format: HELD_FORMAT, rules: { cents: { commit: 'c'.repeat(40), date: '2026-11-03' } } });
  assert.equal(parseHeld('{"format":"other"}'), null);
  assert.deepEqual(parseHeld(JSON.stringify(rec)), rec);
  const list = readList({ map: MAP(), files: FILES, imports: [], targets: ['billing/charge.js'], held: rec });
  assert.deepEqual(list.rules.map((r) => [r.id, r.held?.date ?? r.held]), [['cents', '2026-11-03'], ['no-net', null]]);
  assert.match(toMarkdown(list), /\*\*cents\*\*: amounts are integers in cents _\(held at ccccccc on 2026-11-03\)_/u);
  assert.match(toMarkdown(list), /\*\*no-net\*\*: no network calls in billing _\(never recorded as holding\)_/u);
  const plain = readList({ map: MAP(), files: FILES, imports: [], targets: ['billing/charge.js'] });
  assert.ok(!('held' in plain.rules[0]), 'no held.json, no held field');
});

test('audit: rules never recorded, and rules whose files changed after they held', () => {
  const held = { format: HELD_FORMAT, rules: { cents: { commit: 'h1', date: '2026-11-01' } } };
  const history = [{ hash: 'h3', time: 300, files: ['billing/charge.js'] }, { hash: 'h2', time: 200, files: ['app/pay.js'] }, { hash: 'h1', time: 100, files: ['billing/charge.js'] }];
  const a = audit({ map: MAP(), files: FILES, imports: [], history, held });
  assert.deepEqual(a.held, { never: ['no-net'], changed: [{ id: 'cents', commit: 'h1', date: '2026-11-01', commits: 1 }] });
  assert.match(auditText(a), /rule \*\*cents\*\*: held at h1 on 2026-11-01; 1 commit\(s\) changed its files since/u);
  assert.equal(audit({ map: MAP(), files: FILES, imports: [] }).held, null);
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-held-'));
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'init');
  return { root, git };
}
const run = (root, ...argv) => { let out = ''; const code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: () => {} }); return { code, out }; };

test('verify --record writes .readfirst/held.json for the rules that held, and check accepts the file', () => {
  const { root, git } = repo({ '.readfirst/map.json': JSON.stringify(MAP(), null, 2), 'billing/charge.js': 'export const c = 1;\n', 'legacy/charge.js': '', 'app/pay.js': '', 'app/pay.test.js': '' });
  git('checkout', '-q', '-b', 'feat');
  writeFileSync(join(root, 'billing/charge.js'), 'export const c = 2;\n');
  git('commit', '-q', '-am', 'change');
  const v = run(root, 'verify', '--base', 'main', '--record');
  assert.equal(v.code, 1, 'no-net fails, so verify fails');
  assert.match(v.out, /recorded in \.readfirst\/held\.json: cents held at [0-9a-f]{7}/u);
  const held = JSON.parse(readFileSync(join(root, '.readfirst/held.json'), 'utf8'));
  assert.deepEqual(Object.keys(held.rules), ['cents']);
  assert.equal(held.rules.cents.commit, git('rev-parse', 'HEAD').trim());
  git('add', '.readfirst/held.json'); git('commit', '-q', '-m', 'held');
  assert.equal(run(root, 'check', '--strict').code, 0, 'held.json belongs to no group and needs none');
  assert.match(run(root, 'read', 'billing/charge.js').out, /cents\*\*: amounts are integers in cents _\(held at/u);
  assert.ok(!existsSync(join(root, '.readfirst/held.json.tmp')));
  const dry = run(root, 'verify', '--base', 'main', '--record', '--dry-run');
  assert.doesNotMatch(dry.out, /recorded/u, 'a dry run records nothing');
});
