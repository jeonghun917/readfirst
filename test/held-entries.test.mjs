import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { HELD_FORMAT, parseHeld } from '../src/held.mjs';
import { MAP_FORMAT } from '../src/map.mjs';

// Paid review of ca6947a: a held.json rule entry without a commit crashed read, diff and the Action.
const BAD = { format: HELD_FORMAT, rules: { a: { date: '2026-11-01' }, b: { commit: 7, date: '2026-11-01' }, c: null, d: 'x', ok: { commit: 'abcdef1234567', date: '2026-11-02' } } };

test('parseHeld keeps only rule entries whose commit and date are strings', () => {
  assert.deepEqual(parseHeld(JSON.stringify(BAD)).rules, { ok: { commit: 'abcdef1234567', date: '2026-11-02' } });
});

test('read and diff with a held.json entry that has no commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-held-'));
  const map = { format: MAP_FORMAT, groups: [{ id: 'src', title: 's', files: ['src/**'] }], rules: [{ id: 'a', rule: 'x holds', files: ['src/**'], checks: [{ run: 'node -e 0' }] }] };
  const files = { 'src/a.js': '', '.readfirst/map.json': JSON.stringify(map), '.readfirst/held.json': JSON.stringify(BAD) };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'src/a.js'), 'x');
  for (const argv of [['read', 'src/a.js'], ['diff', '--base', 'main']]) {
    let out = '';
    const code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: () => {} });
    assert.equal(code, 0);
    assert.match(out, /\*\*a\*\*: x holds _\(never recorded as holding\)_/u, argv.join(' '));
  }
});
