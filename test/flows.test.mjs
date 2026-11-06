import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixMap, MAP_FORMAT, mapProblems } from '../src/map.mjs';
import { readList, toMarkdown } from '../src/readlist.mjs';

const files = ['src/routes/orders.js', 'src/billing/charge.js', 'src/web/page.js'];
const flow = () => ({ entry: 'POST /orders/:id/refund', file: 'src/routes/orders.js', line: 12, checks: [], reaches: [{ file: 'src/billing/charge.js', symbol: 'refund', line: 40, labels: ['db-write', 'money'] }] });
const base = () => ({
  format: MAP_FORMAT,
  groups: [{ id: 'app', title: 'the app', files: ['src/**'] }],
  flows: [flow(), { ...flow(), entry: 'POST /admin/orders/:id/refund', line: 30, checks: ['requireRole'] }],
});

test('a map with valid flows passes check; one without is unchanged', () => {
  assert.deepEqual(mapProblems(base(), files), []);
  const m = base();
  delete m.flows;
  assert.deepEqual(mapProblems(m, files), []);
});

test('flow problems: untracked file, no reaches, bad line, missing checks list, bad label, extra key', () => {
  const p = (f) => mapProblems({ ...base(), flows: [f] }, files).join('\n');
  assert.match(p({ ...flow(), file: 'src/gone.js' }), /not a tracked file/u);
  assert.match(p({ ...flow(), reaches: [] }), /at least one/u);
  assert.match(p({ ...flow(), line: 0 }), /line number/u);
  assert.match(p({ ...flow(), checks: undefined }), /checks: a list/u);
  assert.match(p({ ...flow(), reaches: [{ ...flow().reaches[0], labels: ['DB Write'] }] }), /lowercase/u);
  assert.match(p({ ...flow(), reaches: [{ ...flow().reaches[0], file: 'x.js' }] }), /x\.js is not a tracked file/u);
  assert.match(p({ ...flow(), owner: 'x' }), /owner/u);
});

test('fix drops flows whose entry file or every reached file is gone, and reached files that are gone', () => {
  const gone = fixMap(base(), ['src/billing/charge.js', 'src/web/page.js']);
  assert.equal(gone.map.flows, undefined);
  assert.ok(gone.changes.some((c) => /flows: dropped POST \/orders\/:id\/refund/u.test(c)));
  const m = base();
  m.flows[0].reaches.push({ file: 'src/old.js', symbol: 'x', line: 1, labels: ['exec'] });
  const kept = fixMap(m, files);
  assert.deepEqual(kept.map.flows[0].reaches.map((r) => r.file), ['src/billing/charge.js']);
});

test('read shows the flows through a file, from either end, with their checks or the lack of one', () => {
  for (const target of ['src/routes/orders.js', 'src/billing/charge.js']) {
    const list = readList({ map: base(), files, imports: [], targets: [target] });
    assert.deepEqual(list.flows.map((f) => [f.entry, f.checks]), [['POST /orders/:id/refund', []], ['POST /admin/orders/:id/refund', ['requireRole']]]);
  }
  const md = toMarkdown(readList({ map: base(), files, imports: [], targets: ['src/billing/charge.js'] }));
  assert.match(md, /## Outside input reaches this code/u);
  assert.match(md, /\*\*POST \/orders\/:id\/refund\*\* \(`src\/routes\/orders\.js:12`\) reaches `refund` \(`src\/billing\/charge\.js:40`: db-write, money\); no check of who may do it found on the way/u);
  assert.match(md, /checked by `requireRole`/u);
  assert.deepEqual(readList({ map: base(), files, imports: [], targets: ['src/web/page.js'] }).flows, []);
});
