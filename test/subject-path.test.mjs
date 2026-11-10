// A risk about a file was judged by a name instead of the file: "vendor/x/VERSION names the CLI commit..." changed in a
// pull request and read as "not triggered (the change does not touch `VERSION`)", because the capital word was found
// as a const of the same name in another file, and a path with no extension was not read as a path at all. A path
// named in a risk's first clause (its subject, as unshownRisks reads it) is what the risk is about: a change to it
// triggers the risk, extension or not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../src/trigger.mjs';

const CLI = 'export const VERSION = () => 1;\nexport function main() {\n  return VERSION();\n}\n';
const read = (p) => (p === 'vendor/x/src/cli.mjs' ? CLI : p === 'vendor/x/VERSION' ? 'abc123\n' : null);
const files = ['vendor/x/VERSION', 'vendor/x/src/cli.mjs', 'package.json'];
const change = (path, text) => new Map([[path, { lines: new Set([1]), text: [text], hunks: [], whole: false }]]);
const one = (text, changes, shown = ['vendor/x/VERSION', 'vendor/x/src/cli.mjs']) => {
  const list = { targets: [...changes.keys()].map((p) => ({ path: p, group: 'vendor' })), rules: [], risks: [{ group: 'vendor', text, for: shown }] };
  judge(list, { changes, read, files, imports: [] });
  return list.risks[0].trigger;
};

test('a change to the file a risk is about triggers it, whatever names its text also holds', () => {
  const t = one('vendor/x/VERSION names the commit the copy came from; a stale VERSION gives users an older CLI', change('vendor/x/VERSION', 'def456'));
  assert.equal(t.triggered, true);
  assert.ok(t.by.includes('vendor/x/VERSION'), JSON.stringify(t));
});

test('a path named later in the text, or a change elsewhere, does not trigger it', () => {
  const later = one('a stale copy gives users an older CLI; vendor/x/VERSION says which', change('vendor/x/VERSION', 'def456'));
  assert.equal(later.by.includes('vendor/x/VERSION'), false, 'not the subject: judged by its names as before');
  const elsewhere = one('vendor/x/VERSION names the commit the copy came from', change('package.json', '{}'), ['vendor/x/VERSION']);
  assert.equal(elsewhere.triggered, false);
});

test('a subject path does not widen a risk that already names code in that file', () => {
  // "ClassIndex in lib/flows.mjs keeps ..." is about ClassIndex: a change elsewhere in lib/flows.mjs is not a change to it.
  const t = one('`main` in vendor/x/src/cli.mjs reads the version', change('vendor/x/src/cli.mjs', 'export const VERSION = () => 2;'));
  assert.equal(t.by.includes('vendor/x/src/cli.mjs'), false, JSON.stringify(t));
  const map = one('.readfirst/map.json is read by vendor/x/src/cli.mjs', change('.readfirst/map.json', '{}'), ['vendor/x/src/cli.mjs']);
  assert.equal(map.about.includes('.readfirst/map.json'), false, "readfirst's own map is never what a risk is about");
});
