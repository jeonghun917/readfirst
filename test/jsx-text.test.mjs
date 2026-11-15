// JSX text read where a file's lines are lexed apart from codeRows: a removed line of a .jsx file (changedCode in
// src/trigger.mjs) and a table's entries (entryAt in src/code.mjs) are lexed in the file's own language (lexLang), so
// `/*` in an element's text opens no comment there either.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarations, entryAt } from '../src/code.mjs';
import { judge } from '../src/trigger.mjs';

test('jsx: a removed line holding JSX text with /* still shows the call after the element', () => {
  const app = ['const App = () => <div>ok</div>;', 'const z = 1;', 'function doThing2() {', '  return 2;', '}'].join('\n');
  const list = { rules: [], risks: [{ group: 'g', text: '`doThing2` must stay pure', for: ['src/app.jsx'] }] };
  const changes = new Map([['src/app.jsx', { lines: new Set(), text: ['const old = <p>see /* x</p>; doThing2();'], at: [-2], hunks: [], whole: false }]]);
  judge(list, { changes, read: (p) => (p === 'src/app.jsx' ? app : null), files: ['src/app.jsx'], imports: [] });
  assert.deepEqual(list.risks[0].trigger, { triggered: true, about: ['`doThing2`'], by: ['`doThing2`'] });
});

test('jsx: a table entry after one whose JSX text holds /* is found by its key', () => {
  const body = ['const ROUTES = [', "  { path: 'a', el: <p>see /* x</p> },", "  { path: 'b', el: <p>b</p> },", '];', 'const z = 1;'].join('\n');
  const d = declarations('a.jsx', body)[0];
  assert.deepEqual([d.name, d.line, d.end], ['ROUTES', 1, 4]);
  assert.deepEqual(entryAt('a.jsx', body, d, 3), { line: 3, end: 3, key: 'b' });
});
