import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runHook, runStopHook } from '../src/cli.mjs';
import { MAP_FORMAT } from '../src/map.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'readfirst.mjs');
const N = 8;
const MAP = { format: MAP_FORMAT, groups: [{ id: 'app', title: 'app', files: ['src/**'], checks: [{ run: 'node -e 0', why: 'app' }] }] };

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-state-')));
  const files = { '.readfirst/map.json': JSON.stringify(MAP) };
  for (let i = 0; i < N; i++) files[`src/f${i}.js`] = `export const f${i} = ${i};\n`;
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'work');
  return root;
}

const hookProcess = (stateDir, event) => new Promise((done, fail) => {
  const p = spawn(process.execPath, [BIN, 'hook'], { env: { ...process.env, TMPDIR: stateDir }, stdio: ['pipe', 'ignore', 'ignore'] });
  p.on('error', fail);
  p.on('exit', done);
  p.stdin.end(JSON.stringify(event));
});

test('hook state: PreToolUse hooks started at once all keep their file for the Stop hook', async () => {
  const root = repo();
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-state-dir-')));
  await Promise.all(Array.from({ length: N }, (_, i) => hookProcess(stateDir, { session_id: 'par', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, `src/f${i}.js`) } })));
  for (let i = 0; i < N; i++) writeFileSync(join(root, `src/f${i}.js`), `export const f${i} = ${i + 1};\n`);
  const stop = runStopHook(JSON.stringify({ session_id: 'par', cwd: root, stop_hook_active: false }), { stateDir, timeout: 30 });
  assert.match(JSON.parse(stop).systemMessage, new RegExp(`for ${N} edited file\\(s\\)`, 'u'));
});

test('hook state: a state file written by an older readfirst still reads, and is still added to', () => {
  const root = repo();
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-state-dir-')));
  // Older readfirst: one JSON object, keyed by absolute path (and before that, by path relative to the repository).
  writeFileSync(join(stateDir, 'readfirst-hook-old.json'), JSON.stringify({ [join(root, 'src/f0.js')]: Date.now(), 'src/f1.js': Date.now() }));
  assert.equal(runHook(JSON.stringify({ session_id: 'old', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/f0.js') } }), { stateDir }), null, 'shown already: said once per file');
  runHook(JSON.stringify({ session_id: 'old', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/f2.js') } }), { stateDir });
  for (const i of [0, 1, 2]) writeFileSync(join(root, `src/f${i}.js`), 'export {};\n');
  const stop = runStopHook(JSON.stringify({ session_id: 'old', cwd: root, stop_hook_active: false }), { stateDir, timeout: 30 });
  assert.match(JSON.parse(stop).systemMessage, /for 3 edited file\(s\)/u);
});
