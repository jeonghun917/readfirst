import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixMap, MAP_FORMAT, mapProblems } from '../src/map.mjs';
import { readList, toMarkdown } from '../src/readlist.mjs';

const files = ['src/billing/charge.js', 'src/billing/index.js', 'src/web/page.js'];
const base = () => ({
  format: MAP_FORMAT,
  groups: [{ id: 'billing', title: 'charging cards', files: ['src/billing/**'] }, { id: 'web', title: 'pages', files: ['src/web/**'] }],
  rules: [{ id: 'no-double-charge', rule: 'a charge runs once per order', files: ['src/billing/**'] }],
  hotspots: [{ file: 'src/billing/charge.js', symbol: 'chargeCard', line: 42, labels: ['db-write', 'money'], rules: ['no-double-charge'], note: 'called from 12 places' }],
});

test('a map without hotspots is unchanged; with valid hotspots it passes check', () => {
  const m = base();
  delete m.hotspots;
  assert.deepEqual(mapProblems(m, files), []);
  assert.deepEqual(mapProblems(base(), files), []);
});

test('hotspot problems: untracked file, missing label, bad line, unknown rule, extra key', () => {
  const p = (h) => mapProblems({ ...base(), hotspots: [h] }, files).join('\n');
  const ok = base().hotspots[0];
  assert.match(p({ ...ok, file: 'src/gone.js' }), /not a tracked file/u);
  assert.match(p({ ...ok, labels: [] }), /at least one label/u);
  assert.match(p({ ...ok, labels: ['DB Write'] }), /lowercase/u);
  assert.match(p({ ...ok, line: 0 }), /line number/u);
  assert.match(p({ ...ok, rules: ['made-up'] }), /no rule made-up/u);
  assert.match(p({ ...ok, owner: 'x' }), /owner/u);
});

test('fix drops hotspots in files that are gone', () => {
  const { map, changes } = fixMap(base(), ['src/billing/index.js', 'src/web/page.js']);
  assert.equal(map.hotspots, undefined);
  assert.ok(changes.some((c) => /hotspots: dropped chargeCard/u.test(c)));
});

test('read lists the hot spots of the file being changed, and only that file', () => {
  const list = readList({ map: base(), files, imports: [], targets: ['src/billing/charge.js'] });
  assert.deepEqual(list.hotspots.map((h) => [h.symbol, h.line, h.labels, h.rules]), [['chargeCard', 42, ['db-write', 'money'], ['no-double-charge']]]);
  const md = toMarkdown(list);
  assert.match(md, /## Hot spots in this code/u);
  assert.match(md, /`chargeCard` \(`src\/billing\/charge\.js:42`\): db-write, money, under \*\*no-double-charge\*\*: called from 12 places/u);
  assert.deepEqual(readList({ map: base(), files, imports: [], targets: ['src/billing/index.js'] }).hotspots, []);
});
