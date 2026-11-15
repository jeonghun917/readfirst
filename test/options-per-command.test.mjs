// Options a command does not read (ledger, 2026-11-14): parse() took every flag for every command, so
// `readfirst fix --dry-run` wrote the map, and `check --dry-run` or `find --strict` did what they always do, with no
// word. Each command now takes only the options it reads (`COMMAND_OPTIONS` in src/cli.mjs); any other is an error that
// names it, and fix reads --dry-run: it says what it would change and writes nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';

// A repository whose map has an evidence line the code moved away from, so `fix` has a change to make.
function drifted() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-options-'));
  const code = 'export function alpha() {\n  return 1;\n}\n';
  const files = {
    'src/a.js': code,
    '.readfirst/map.json': `${JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], risks: [{ text: '`alpha` returns one - src/a.js:2' }] }] }, null, 2)}\n`,
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  writeFileSync(join(root, 'src/a.js'), `${'\n'.repeat(10)}${code}`);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'move');
  return root;
}
const run = (argv) => { let out = ''; const code = main(argv, { out: (s) => { out += s; }, err: (s) => { out += s; } }); return { code, out }; };

test('fix --dry-run says what it would change and writes nothing', () => {
  const root = drifted();
  const map = join(root, '.readfirst/map.json');
  const before = readFileSync(map, 'utf8');
  const dry = run(['--root', root, 'fix', '--dry-run']);
  assert.match(dry.out, /would update \.readfirst\/map\.json:\n- groups\.src\.risks\[0\]: src\/a\.js:2 -> src\/a\.js:12/u);
  assert.equal(readFileSync(map, 'utf8'), before, 'the map is as it was');
  run(['--root', root, 'fix']);
  assert.notEqual(readFileSync(map, 'utf8'), before, 'without --dry-run fix writes it');
});

test('an option the command does not read is an error that names it', () => {
  const root = drifted();
  for (const [argv, option] of [[['check', '--dry-run'], 'dry-run'], [['find', 'alpha', '--strict'], 'strict'], [['init', '--dry-run'], 'dry-run'], [['read', 'src/a.js', '--record'], 'record']]) {
    assert.throws(() => run(['--root', root, ...argv]), new RegExp(`--${option} does nothing for readfirst ${argv[0]}`, 'u'), argv.join(' '));
  }
  assert.doesNotThrow(() => run(['--root', root, 'check', '--strict']), 'an option it reads still works');
});
