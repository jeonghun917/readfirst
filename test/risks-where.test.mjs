// A risk shows wherever its files point (0.27.2). Before, a risk whose files named a file of another group showed for
// no file at all, and check passed; readfirst's own map kept the Bash hook's risks on src/cli.mjs, so whoever changed
// src/bash-writes.mjs got none of them (bug ledger, 2026-11-09). check now says which risks are about, or mention, a
// file that does not show them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { MAP_FORMAT } from '../src/map.mjs';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-where-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '.']);
  return root;
}
const run = (root, ...argv) => {
  let out = '';
  let code;
  try { code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: () => {} }); } catch (e) { code = 2; out += e.message; }
  return { code, out };
};
const MAP = JSON.stringify({ format: MAP_FORMAT, groups: [
  { id: 'cli', title: 'cli', files: ['src/cli.mjs', '.readfirst/**'], risks: [
    { text: 'parse() lists its options in FLAGS', files: ['src/cli.mjs'] },
    { text: 'the hook reads shell commands through bashWrites: a syntax it misses is a write never checked', files: ['src/bash.mjs'] },
    { text: 'src/bash.mjs splits commands at ; && and |' },
    { text: 'runHook swallows errors, so a change here also changes src/bash.mjs callers' },
  ] },
  { id: 'core', title: 'core', files: ['src/bash.mjs'] },
] });

test('a risk shows for the files it names, also in another group', () => {
  const root = repo({ 'src/cli.mjs': 'x\n', 'src/bash.mjs': 'y\n', '.readfirst/map.json': MAP });
  const bash = JSON.parse(run(root, 'read', '--json', 'src/bash.mjs').out);
  assert.deepEqual(bash.risks.map((r) => r.text), ['the hook reads shell commands through bashWrites: a syntax it misses is a write never checked']);
  assert.equal(bash.risks[0].group, 'cli');
  const cli = JSON.parse(run(root, 'read', '--json', 'src/cli.mjs').out);
  assert.ok(!cli.risks.some((r) => r.text.startsWith('the hook reads shell')), 'a risk naming only src/bash.mjs is not shown on src/cli.mjs');
  // Cursor rules: the core group's file carries it too.
  run(root, 'export', '--cursor');
  assert.match(readFileSync(join(root, '.cursor/rules/readfirst-core.mdc'), 'utf8'), /the hook reads shell commands through bashWrites/u);
});

test('check says which risks are about a file that does not show them, and which only mention one; --strict fails on the first', () => {
  const root = repo({ 'src/cli.mjs': 'x\n', 'src/bash.mjs': 'y\n', '.readfirst/map.json': MAP });
  const plain = run(root, 'check');
  assert.equal(plain.code, 0);
  assert.match(plain.out, /risks about a file that does not show them[^\n]*:\n- groups\.cli\.risks\[2\] is about src\/bash\.mjs/u);
  assert.match(plain.out, /risks that mention a file which does not show them[^\n]*:\n- groups\.cli\.risks\[3\] mentions src\/bash\.mjs/u);
  const json = JSON.parse(run(root, 'check', '--json').out);
  assert.deepEqual(json.unshown.map((u) => [u.index, u.about]), [[2, true], [3, false]]);
  const strict = run(root, 'check', '--strict');
  assert.equal(strict.code, 1);
  assert.match(strict.out, /groups\.cli\.risks\[2\] is about src\/bash\.mjs/u);
  const [failures, said] = strict.out.split('risks that mention a file');
  assert.doesNotMatch(failures, /risks\[3\]/u, 'a mention is never a failure');
  assert.match(said, /risks\[3\] mentions src\/bash\.mjs/u, 'it is still said');
});
