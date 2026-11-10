// A name declared in a changed file of another group made a group's risk read as touched: on a rollout PR, a vendored
// copy of a CLI (its own NOT_CODE) was changed, and a risk about the scar rules (the package's NOT_CODE), shown for
// package.json, read as touched by `NOT_CODE`. A changed file now lends its names only to risks of its own group; the
// risk's own files, the files it names and what they import count as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../src/trigger.mjs';

const VENDOR = 'const NOT_CODE = /x/u;\nexport function judge() {\n  return NOT_CODE;\n}\n';
const WATCH = 'export function scarredFiles() {\n  return 1;\n}\n';
const read = (p) => ({ 'vendor/cli/trigger.mjs': VENDOR, 'lib/watch.mjs': WATCH })[p] ?? null;
const files = ['vendor/cli/trigger.mjs', 'lib/watch.mjs', 'package.json'];
const vendorChange = new Map([['vendor/cli/trigger.mjs', { lines: new Set([1]), text: ['const NOT_CODE = /y/u;'], hunks: [], whole: false }]]);
const one = (risk, changes, targets) => {
  const list = { targets, rules: [], risks: [risk] };
  judge(list, { changes, read, files, imports: [] });
  return list.risks[0].trigger;
};

test('a changed file of another group does not lend its names to a group risk', () => {
  const targets = [{ path: 'vendor/cli/trigger.mjs', group: 'vendor' }];
  const risk = { group: 'watch', text: 'the scar rules (NOT_CODE) come from the package', for: ['package.json'] };
  assert.equal(one(risk, vendorChange, targets).triggered, true, 'still shown for its files, but unjudged, not touched');
  assert.deepEqual(one(risk, vendorChange, targets).by, []);
  const same = { group: 'vendor', text: 'NOT_CODE is what the copy leaves out', for: ['package.json'] };
  assert.deepEqual(one(same, vendorChange, targets).by, ['`NOT_CODE`'], 'a risk of the changed file\'s group still sees it');
  const named = { group: 'watch', text: 'NOT_CODE in vendor/cli/trigger.mjs', for: ['package.json'] };
  assert.deepEqual(one(named, vendorChange, targets).by, ['`NOT_CODE`'], 'a file the risk names counts wherever it is');
});
