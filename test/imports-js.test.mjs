import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importEdges } from '../src/imports.mjs';

const edges = (files) => importEdges(Object.keys(files).sort(), (p) => files[p] ?? null).map((e) => `${e.from} -> ${e.to}`).sort();

// Paid review of ca6947a: '../' and './' became 'src//index.js', and import() with options was not read.
test('imports: a folder import with a trailing slash reaches its index file', () => {
  assert.deepEqual(edges({ 'src/index.js': '', 'src/a/b.js': "import x from '../';\n", 'src/c.js': "export * from './';\n" }), ['src/a/b.js -> src/index.js', 'src/c.js -> src/index.js']);
  assert.deepEqual(edges({ 'index.js': '', 'src/a.js': "import x from '../';\n", 'src/b.js': "import y from '..';\n" }), ['src/a.js -> index.js', 'src/b.js -> index.js'], 'up to the repository root');
});

test('imports: import() with an options argument is an edge', () => {
  assert.deepEqual(edges({ 'src/g.json': '{}', 'src/h.js': '', 'src/a.js': "const g = await import('./g.json', { with: { type: 'json' } });\nconst h = await import( './h.js' , {});\n" }), ['src/a.js -> src/g.json', 'src/a.js -> src/h.js']);
});
