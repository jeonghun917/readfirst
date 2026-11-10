// Step 2, the rest (2026-11-10): risks that name no symbol readfirst finds are shown unjudged on every change (26 of
// the open items on readfirst#143). Names written as calls (`main()`) and capital constants (`FLAGS`) now count where
// they are declared, a name declared in a file the item's files import counts too, and `audit` lists what is left so
// the map can be narrowed. Each new name still needs a declaration, and the common ones only in the item's own files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, unmatchedItems } from '../src/trigger.mjs';
import { auditText } from '../src/audit.mjs';
import { MAP_FORMAT } from '../src/map.mjs';

const CLI = [
  'const FLAGS = new Set([\'json\']);',
  'export function main(argv) {',
  '  return parse(argv);',
  '}',
  'function parse(argv) {',
  '  return argv.filter((a) => FLAGS.has(a));',
  '}',
  'function check(x) {',
  '  return x;',
  '}',
].join('\n');
const ACTION = "import { settleMap } from './map.mjs';\nexport function runAction() {\n  return settleMap();\n}\n";
const MAPJS = 'export function settleMap() {\n  return 1;\n}\n';
const TEST = 'const MAP = { groups: [] };\ntest(() => MAP);\n';
const read = (p) => ({ 'src/cli.mjs': CLI, 'src/action.mjs': ACTION, 'src/map.mjs': MAPJS, 'test/a.test.mjs': TEST })[p] ?? null;
const files = ['src/cli.mjs', 'src/action.mjs', 'src/map.mjs', 'test/a.test.mjs'];
const imports = [{ from: 'src/action.mjs', to: 'src/map.mjs' }];
const change = (path, lines, text) => new Map([[path, { lines: new Set(lines), text, hunks: [], whole: false }]]);
const one = (text, shown, changes) => {
  const list = { rules: [], risks: [{ group: 'g', text, for: shown }] };
  judge(list, { changes, read, files, imports });
  return list.risks[0].trigger;
};

test('a name written as a call, and a capital constant, count where they are declared', () => {
  const t = one('main() reads the options in FLAGS', ['src/cli.mjs'], change('src/cli.mjs', [6], ['  return argv.filter((a) => FLAGS.has(a) && a);']));
  assert.deepEqual(t.about, ['`main`', '`FLAGS`']);
  assert.deepEqual(t.by, ['`FLAGS`'], 'line 6 is in parse, not main: only FLAGS is touched');
  assert.equal(one('a file(s) count in check(s)', ['src/cli.mjs'], new Map()).why, 'names no symbol or line readfirst can find: shown for its files', 'a plural in brackets is not a call, though a function named check is declared');
});

test('a capital word declared only in a changed file the item is not about does not count', () => {
  const t = one('readfirst reports its own files as status MAP', ['src/cli.mjs'], change('test/a.test.mjs', [1], ['const MAP = { groups: [1] };']));
  assert.equal(t.why, 'names no symbol or line readfirst can find: shown for its files', 'the test\'s own MAP is not the MAP the risk means');
});

test('a name declared in a file the item\'s files import is judged, so an untouched one is not triggered', () => {
  const t = one('auto-fix commits only what settleMap settles', ['src/action.mjs'], change('src/action.mjs', [3], ['  return settleMap() + 0;']));
  assert.deepEqual(t.about, ['`settleMap`']);
  assert.deepEqual(t.by, ['`settleMap`'], 'the change names it in a line of code');
  const off = one('auto-fix commits only what settleMap settles', ['src/action.mjs'], change('src/cli.mjs', [2], ['export function main(argv, x) {']));
  assert.equal(off.triggered, false, 'before 0.30.0 this was shown unjudged: settleMap was declared nowhere it looked');
});

test('audit lists the rules and risks no change can judge, widest first, in full', () => {
  const map = { format: MAP_FORMAT, groups: [
    { id: 'cli', title: 'CLI', files: ['src/cli.mjs', 'src/action.mjs', 'src/map.mjs'], risks: [{ text: 'main() reads FLAGS' }, { text: 'keep the docs in step with the help text, every word of it' }, { text: 'the options are read here - src/cli.mjs:6' }] },
    { id: 'tests', title: 'Tests', files: ['test/**'], risks: [{ text: 'tests write to the temp folder' }] },
  ], rules: [{ id: 'no-deps', rule: 'no runtime dependencies', files: ['src/**'] }] };
  const u = unmatchedItems(map, { files, read, imports });
  assert.deepEqual(u.map((x) => [x.where, x.files]), [['groups.cli.risks[1]', 3], ['rules.no-deps', 3], ['groups.tests.risks[0]', 1]]);
  const text = auditText({ files: 4, commit: null, problems: [], stale: [], hotspots: [], unguarded: [], unmatched: u, replacing: [], held: null, placeholders: [], unchecked: [], brokeMost: [], untested: { files: [], groups: [] }, unused: [], unseen: { languages: [], computed: [] } });
  assert.match(text, /## Rules and risks no change can judge[^\n]*\n\n- groups\.cli\.risks\[1\] \(shown for 3 files\): keep the docs in step with the help text, every word of it\n/u);
});
