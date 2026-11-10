// A const set to a template literal over many lines ended at the first line that held a `${...}` placeholder: braceEnd
// reads each line on its own, so the placeholder's braces opened and closed a block there, and a change further down
// the template read as "the change does not touch" the const (a prompt edited at its sixth line, judged untouched).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../src/trigger.mjs';

const BODY = [
  'export const OUT = "/out";',
  'export const RUBRIC = `# the rubric',
  '- ${OUT}/map.json exists',
  '- every group has a title',
  '- every risk keeps its line',
  '- a check that ends here;',
  '- and the last line`;',
  '',
  'export function after() {',
  '  return RUBRIC.length;',
  '}',
].join('\n');
const read = (p) => (p === 'lib/brief.mjs' ? BODY : null);
const trigger = (line) => {
  const list = { rules: [], risks: [{ group: 'g', text: 'a `RUBRIC` line can be met by deleting things', for: ['lib/brief.mjs'] }] };
  judge(list, { changes: new Map([['lib/brief.mjs', { lines: new Set([line]), text: ['x'], hunks: [], whole: false }]]), read, files: ['lib/brief.mjs'], imports: [] });
  return list.risks[0].trigger;
};

test('a change anywhere inside a multi-line template touches the const it is assigned to', () => {
  for (const line of [3, 5, 6, 7]) assert.equal(trigger(line).triggered, true, `line ${line}`);
});

test('the const ends with its template: a change in the next function does not touch it', () => {
  assert.equal(trigger(10).triggered, false);
});
