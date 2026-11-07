import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { MAP_FORMAT } from '../src/map.mjs';
import { atLeast, pinFiles, pinnedReadfirst, pinProblems } from '../src/pins.mjs';

test('pins: the oldest readfirst a repository pins; a major tag or none is the newest', () => {
  const t = (o) => new Map(Object.entries(o));
  assert.deepEqual(pinnedReadfirst(t({ '.github/workflows/ci.yml': '      - uses: jeonghun917/readfirst@v0.13.0\n' })), { version: '0.13.0', at: '.github/workflows/ci.yml' });
  assert.equal(pinnedReadfirst(t({ '.github/workflows/a.yml': 'uses: jeonghun917/readfirst@v0.22.0', '.github/workflows/b.yml': 'run: npx --yes readfirst@0.17.2 check' })).version, '0.17.2');
  assert.equal(pinnedReadfirst(t({ 'package.json': JSON.stringify({ devDependencies: { readfirst: '^0.19.1' } }) })).version, '0.19.1');
  assert.equal(pinnedReadfirst(t({ '.github/workflows/ci.yml': 'uses: jeonghun917/readfirst@v0\nrun: npx readfirst check' })), null);
  assert.equal(pinnedReadfirst(t({ 'package.json': '{ not json' })), null);
  assert.ok(!atLeast('0.13.0', '0.18.0') && atLeast('0.18.0', '0.18.0') && atLeast(null, '0.18.0') && atLeast('0.18.10', '0.18.9') && !atLeast('0.9.0', '0.18.0'));
  assert.deepEqual(pinFiles(['.github/workflows/ci.yml', 'src/a.js', 'package.json', 'docs/package.json']), ['.github/workflows/ci.yml', 'package.json']);
  const map = { format: MAP_FORMAT, groups: [], models: [], flows: [], rules: [{ id: 'r', rule: 'x', files: ['a'], flow: { entry: 'GET /x', must: ['check'] } }] };
  assert.equal(pinProblems(map, { version: '0.13.0', at: 'ci.yml' }).length, 3);
  assert.deepEqual(pinProblems(map, { version: '0.22.0', at: 'ci.yml' }), []);
  assert.deepEqual(pinProblems(map, null), []);
});

test('check fails when the map uses a field the readfirst pinned in CI rejects', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-pins-'));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    '.github/workflows/ci.yml': 'jobs:\n  r:\n    steps:\n      - uses: jeonghun917/readfirst@v0.13.0\n',
    '.readfirst/map.json': JSON.stringify({ format: MAP_FORMAT, groups: [{ id: 'src', title: 'src', files: ['src/**', '.github/**'] }], models: [] }),
  };
  for (const [p, b] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), b); }
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', '.']);
  let out = '';
  const code = main(['--root', root, 'check'], { out: (s) => { out += s; }, err: () => {} });
  assert.equal(code, 1, out);
  assert.match(out, /models needs readfirst 0\.22\.0 or newer, and \.github\/workflows\/ci\.yml pins 0\.13\.0/u);
  writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs:\n  r:\n    steps:\n      - uses: jeonghun917/readfirst@v0.22.0\n');
  assert.equal(main(['--root', root, 'check'], { out: () => {}, err: () => {} }), 0);
});
