// A declaration whose value runs over several lines with no block of its own (a const set to a multi-line template, or
// a call cut over lines) ended at the next block's closing brace: braceEnd looked for the first `{` it could find, and
// found the next function's. A change to that function then read as touching the const (a risk about a const holding
// a create-table statement, lines 8 to 12 of a file, read as touched by a change at line 20 of the function below it).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../src/trigger.mjs';

const REPORT = [
  'const ensureTable = (sql) => sql`create table if not exists watch_events (',
  '  repo text not null, rules text[] not null default \'{}\',',
  '  at timestamptz not null default now())`;',
  '',
  'const LIMITS = combine(1,',
  '  2);',
  'register(() => {',
  '  return LIMITS;',
  '});',
  '',
  'export function watchEvent(map, paths) {',
  '  const n = paths.length;',
  '  return { n };',
  '}',
  'const queryText = `select',
  '  1`',
  'function last() {',
  '  return 1',
  '}',
].join('\n');
const read = (p) => (p === 'lib/report.mjs' ? REPORT : null);
const files = ['lib/report.mjs'];
const change = (lines, text) => new Map([['lib/report.mjs', { lines: new Set(lines), text, hunks: [], whole: false }]]);
const one = (text, changes) => {
  const list = { rules: [], risks: [{ group: 'g', text, for: ['lib/report.mjs'] }] };
  judge(list, { changes, read, files, imports: [] });
  return list.risks[0].trigger;
};

test('a multi-line const with no block ends at its own statement, not at the next function', () => {
  const below = change([12], ['  const n = paths.length + 1;']);
  assert.equal(one('the DDL in `ensureTable` matches sql/', below).triggered, false, 'line 12 is in watchEvent');
  assert.equal(one('`LIMITS` is the cap', below).triggered, false, 'a call cut over lines ends at its semicolon');
  assert.equal(one('`LIMITS` is the cap', change([8], ['  return 2;'])).triggered, false, 'not at the braces of the top-level call after it');
  assert.equal(one('the DDL in `ensureTable` matches sql/', change([6], ['  3);'])).triggered, false, 'its semicolon sits in a template line, so it stops before LIMITS');
  assert.equal(one('the DDL in `ensureTable` matches sql/', change([2], ['  repo text not null,'])).triggered, true, 'its own lines still touch it');
  assert.equal(one('`watchEvent` counts files', below).triggered, true);
  assert.equal(one('`queryText` is the select', change([18], ['  return 2'])).triggered, false, 'with no semicolon, it stops before the next unindented declaration');
});
