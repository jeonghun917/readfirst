// What `readfirst fix` says moved (ledger, 2026-11-14): an evidence line git shows moving with the code is written
// where it is now, and the message named the first declaration the risk names, not the one the line moved with
// ("src/bash-writes.mjs:172 -> :220 (`unwrap` moved)" where line 220 is in gitPaths). Each moved line is named by the
// declaration that holds it now, and so is the line `check` gives.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';

// Ledger, 2026-11-14: a line counted as right while it sat in any declaration the item names, so evidence written for
// beta that the code pushed into alpha was never said. It is right only in the declaration git carries it with.
test('an evidence line pushed into another declaration the item names is said, and fix carries it on', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-fix-names-'));
  const code = 'export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n';
  const files = {
    'src/a.js': code,
    '.readfirst/map.json': `${JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], risks: [{ text: '`alpha` and `beta` keep their order - src/a.js:5' }] }] }, null, 2)}\n`,
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  // Three blank lines on top: line 5 (beta's return) is now at 8, and line 5 is alpha's return.
  writeFileSync(join(root, 'src/a.js'), `\n\n\n${code}`);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'header');
  let checked = '';
  main(['--root', root, 'check'], { out: (s) => { checked += s; }, err: (s) => { checked += s; } });
  assert.match(checked, /src\/a\.js:5 is in `alpha`, but the line it was written for moved with `beta` to src\/a\.js:8/u);
  let out = '';
  main(['--root', root, 'fix', '--json'], { out: (s) => { out += s; }, err: () => {} });
  assert.deepEqual(JSON.parse(out).changes.filter((c) => /src\/a\.js/u.test(c)), ['groups.src.risks[0]: src/a.js:5 -> src/a.js:8 (`beta` moved)']);
});

test('each evidence line fix moves is named by the declaration it moved with', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-fix-names-'));
  const code = 'export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n';
  const files = {
    'src/a.js': code,
    '.readfirst/map.json': `${JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], risks: [{ text: '`alpha` and `beta` keep their order - src/a.js:2, src/a.js:5' }] }] }, null, 2)}\n`,
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  // Ten blank lines above both functions (a comment would be alpha's own), so both lines fall outside what the risk
  // names: line 2 is now in alpha at 12, line 5 in beta at 15.
  writeFileSync(join(root, 'src/a.js'), `${'\n'.repeat(10)}${code}`);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'header');
  let checked = '';
  main(['--root', root, 'check'], { out: (s) => { checked += s; }, err: (s) => { checked += s; } });
  assert.match(checked, /src\/a\.js:2 is outside [^\n]*: it moved to src\/a\.js:12 with `alpha`/u);
  assert.match(checked, /src\/a\.js:5 is outside [^\n]*: it moved to src\/a\.js:15 with `beta`/u);
  let out = '';
  main(['--root', root, 'fix', '--json'], { out: (s) => { out += s; }, err: () => {} });
  const { changes } = JSON.parse(out);
  assert.deepEqual(changes.filter((c) => /src\/a\.js/u.test(c)), [
    'groups.src.risks[0]: src/a.js:2 -> src/a.js:12 (`alpha` moved)',
    'groups.src.risks[0]: src/a.js:5 -> src/a.js:15 (`beta` moved)',
  ]);
});
