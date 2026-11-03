import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { audit, auditText, parseBlame, parseLog, PRO_LINE, STALE_COMMITS } from '../src/audit.mjs';
import { main } from '../src/cli.mjs';
import { readList, toMarkdown, unseenIn } from '../src/readlist.mjs';

const MAP = (extra = {}) => ({
  format: 'readfirst/map@1',
  groups: [
    { id: 'core', title: 'the core', files: ['src/**'], risks: [{ text: 'money is in cents' }] },
    { id: 'tests', title: 'TODO: what tests/** is for', files: ['tests/**'] },
  ],
  rules: [{ id: 'cents', rule: 'amounts are integers in cents', files: ['src/money.js'], checks: [{ run: 'npm test' }] }, { id: 'no-net', rule: 'no network calls', files: ['src/**'] }],
  ...extra,
});

test('parseBlame keeps each line\'s commit and time, and marks lines not committed yet', () => {
  const a = 'a'.repeat(40);
  const z = '0'.repeat(40);
  const text = `${a} 1 1 2\nauthor x\ncommitter-time 100\n\tline one\n${a} 2 2\ncommitter-time 100\n\tline two\n${z} 3 3 1\ncommitter-time 300\n\tline three\n`;
  assert.deepEqual(parseBlame(text), [{ hash: a, time: 100 }, { hash: a, time: 100 }, null]);
});

test('parseLog reads commits with the files each changed', () => {
  assert.deepEqual(parseLog('\x01h2 20\n\nsrc/a.js\nsrc/b.js\n\x01h1 10\n\nREADME.md\n'), [
    { hash: 'h2', time: 20, files: ['src/a.js', 'src/b.js'] },
    { hash: 'h1', time: 10, files: ['README.md'] },
  ]);
});

test('audit lists a rule whose files changed in many commits since its line was written, not one that did not', () => {
  const map = MAP();
  const text = JSON.stringify(map, null, 2);
  const lines = text.split('\n');
  const blame = lines.map(() => ({ hash: 'm'.repeat(40), time: 100 }));
  const history = [
    ...Array.from({ length: STALE_COMMITS }, (_, i) => ({ hash: `c${i}`, time: 200 + i, files: ['src/money.js'] })),
    { hash: 'm'.repeat(40), time: 100, files: ['.readfirst/map.json'] },
  ];
  const files = ['.readfirst/map.json', 'src/money.js', 'src/net.js', 'tests/money.test.js'];
  const read = (p) => (p === '.readfirst/map.json' ? text : '');
  const a = audit({ map, files, imports: [], read, blame, history });
  const stale = a.stale.map((s) => s.id ?? s.group);
  assert.ok(stale.includes('cents'), 'cents: its file changed 10 times');
  assert.ok(stale.includes('no-net'), 'no-net covers src/** too');
  assert.ok(stale.includes('core'), 'the risk of group core covers src/**');
  assert.equal(a.stale.find((s) => s.id === 'cents').commits, STALE_COMMITS);
  const fresh = audit({ map, files, imports: [], read, blame, history: history.slice(1) });
  assert.equal(fresh.stale.length, 0, 'one commit fewer is under the bar');
  const uncommitted = audit({ map, files, imports: [], read, blame: lines.map(() => null), history });
  assert.equal(uncommitted.stale.length, 0, 'lines not committed yet are not stale');
});

test('audit finds hot spots that moved or are gone, placeholder titles and rules with no check', () => {
  const map = MAP({ hotspots: [
    { file: 'src/money.js', symbol: 'charge', line: 1, labels: ['money'] },
    { file: 'src/money.js', symbol: 'refund', line: 2, labels: ['money'] },
    { file: 'src/money.js', symbol: 'gone', line: 3, labels: ['money'] },
  ] });
  const body = '// money\nexport function refund() {}\n\nexport function charge() {}\n';
  const a = audit({ map, files: ['src/money.js'], imports: [], read: (p) => (p === 'src/money.js' ? body : null) });
  assert.deepEqual(a.hotspots, [
    { file: 'src/money.js', symbol: 'charge', line: 1, status: 'MOVED', now: 4 },
    { file: 'src/money.js', symbol: 'gone', line: 3, status: 'GONE', now: null },
  ]);
  assert.deepEqual(a.placeholders, ['tests']);
  assert.deepEqual(a.unchecked, ['no-net']);
});

test('audit lists code no test reaches, most used first, and counts a Go test beside its package', () => {
  const files = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'tests/a.test.js', 'go/pkg/x.go', 'go/pkg/x_test.go', 'go/other/y.go', 'docs/conf.py', 'src/types.d.ts', 'conftest.py'];
  const imports = [
    { from: 'tests/a.test.js', to: 'src/a.js', line: 1 },
    { from: 'src/a.js', to: 'src/b.js', line: 1 },
    { from: 'src/a.js', to: 'src/c.js', line: 2 },
    { from: 'src/d.js', to: 'src/c.js', line: 1 },
    { from: 'src/b.js', to: 'src/d.js', line: 1 },
  ];
  const map = { format: 'readfirst/map@1', groups: [{ id: 'all', title: 'all', files: ['**'] }] };
  const a = audit({ map, files, imports });
  // src/d.js is reached through a.test -> a -> b -> d; go/pkg/x.go by its _test.go; docs, .d.ts and conftest are skipped.
  assert.deepEqual(a.untested.files.map((f) => f.path), ['go/other/y.go']);
  assert.equal(a.untested.code, 6);
  assert.equal(a.untested.reached, 5);
  const none = audit({ map, files, imports: imports.slice(1) });
  assert.deepEqual(none.untested.files.map((f) => [f.path, f.usedBy]).slice(0, 2), [['src/c.js', 2], ['src/b.js', 1]], 'most used first');
});

test('audit and the read list say what readfirst could not see', () => {
  const read = (p) => ({ 'src/plugins.js': "const name = cfg.plugin;\nconst p = await import(`./plugins/${name}.js`);\n", 'app/load.py': 'import importlib\nmod = importlib.import_module(settings.BACKEND)\n', 'src/ok.js': "import('./x.js');\nrequire('./y');\n" })[p] ?? null;
  assert.deepEqual(unseenIn('src/plugins.js', read).map((u) => u.line), [2]);
  assert.deepEqual(unseenIn('app/load.py', read).map((u) => u.line), [2]);
  assert.deepEqual(unseenIn('src/ok.js', read), [], 'string specifiers are followed');
  assert.match(unseenIn('ios/App.swift')[0].why, /unknown, not none/u);
  const map = { format: 'readfirst/map@1', groups: [{ id: 'all', title: 'all', files: ['**'] }] };
  const files = ['src/plugins.js', 'app/load.py', 'src/ok.js', 'ios/App.swift', 'ios/View.swift'];
  const a = audit({ map, files, imports: [], read });
  assert.deepEqual(a.unseen.languages, [{ ext: 'swift', count: 2 }]);
  assert.equal(a.unseen.computedCount, 2);
  const list = readList({ map, files, imports: [], targets: ['src/plugins.js'], read });
  assert.equal(list.unseen.length, 1);
  assert.match(toMarkdown(list), /## Not seen by readfirst[^\n]*\n\n- `src\/plugins.js`: line 2 loads a module by a computed name/u);
  assert.match(auditText(a), /2 \.swift file\(s\): imports in this language are not read/u);
  assert.ok(auditText(a).endsWith(`${PRO_LINE}\n`));
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-audit-'));
  const write = (all) => { for (const [path, body] of Object.entries(all)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); } };
  write(files);
  const at = '2026-01-01T00:00:00Z';
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { root, write };
}
const run = (root, ...argv) => { let out = ''; const code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: () => {} }); return { code, out }; };

test('readfirst audit reads git blame and history: a rule goes stale after enough commits change its files', () => {
  const map = MAP();
  const { root, write } = repo({ '.readfirst/map.json': `${JSON.stringify(map, null, 2)}\n`, 'src/money.js': 'export const x = 1;\n', 'src/net.js': '', 'tests/money.test.js': "import '../src/money.js';\n" });
  let first = JSON.parse(run(root, 'audit', '--json').out);
  assert.equal(first.format, 'readfirst/audit@1');
  assert.deepEqual(first.stale, []);
  for (let i = 0; i < STALE_COMMITS; i++) {
    write({ 'src/money.js': `export const x = ${i + 2};\n` });
    // Commit times must be after the map's: give each its own date.
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', `change ${i}`], { env: { ...process.env, GIT_COMMITTER_DATE: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`, GIT_AUTHOR_DATE: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z` } });
  }
  const { code, out } = run(root, 'audit', '--json');
  assert.equal(code, 0);
  first = JSON.parse(out);
  const cents = first.stale.find((s) => s.id === 'cents');
  assert.equal(cents.commits, STALE_COMMITS);
  assert.equal(cents.written.date, '2026-01-01');
  assert.deepEqual(first.untested.files.map((f) => f.path), ['src/net.js']);
  assert.match(run(root, 'audit').out, /rule \*\*cents\*\*: "amounts are integers in cents" — written 2026-01-01/u);
});

test('readfirst audit stops on a broken map and reports it', () => {
  const { root } = repo({ '.readfirst/map.json': '{"format":"readfirst/map@1","groups":[]}', 'a.js': '' });
  const { code, out } = run(root, 'audit');
  assert.equal(code, 1);
  assert.match(out, /has problems; fix them first/u);
});
