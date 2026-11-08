import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook, runStopHook } from '../src/cli.mjs';
import { MAP_FORMAT } from '../src/map.mjs';

// A repository reached through a symlinked folder: git gives the physical top level, the agent gives the link's path.
const MAP = {
  format: MAP_FORMAT,
  groups: [{ id: 'app', title: 'app', files: ['src/**'], checks: [{ run: 'node -e 0', why: 'app' }], risks: [{ text: 'amounts are in cents' }] }, { id: 'map', title: 'm', files: ['other.txt'] }],
};

function linked() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-link-')));
  const root = join(base, 'r');
  const files = { 'src/a.js': 'export const a = 1;\n', 'other.txt': 'x', '.readfirst/map.json': JSON.stringify(MAP) };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'work');
  const link = join(base, 'lnk');
  symlinkSync(root, link);
  return { root, link };
}

const edit = (link, file, stateDir, opts = {}) => runHook(JSON.stringify({ session_id: 'ln', cwd: link, tool_name: 'Edit', tool_input: { file_path: join(link, file) } }), { stateDir, ...opts });

test('hook: a file reached through a symlinked folder gets its notes, as by its real path', () => {
  const { link } = linked();
  const out = edit(link, 'src/a.js', mkdtempSync(join(tmpdir(), 'readfirst-link-state-')));
  assert.ok(out, 'the hook said nothing for the linked path');
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /amounts are in cents/u);
  assert.ok(edit(link, 'src/new.js', mkdtempSync(join(tmpdir(), 'readfirst-link-state-'))), 'a new file in a linked folder too');
});

test('hook --gate: a file reached through a symlinked folder is held once', () => {
  const { link } = linked();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-link-state-'));
  const first = JSON.parse(edit(link, 'src/a.js', stateDir, { gate: true }) ?? 'null');
  assert.equal(first?.hookSpecificOutput.permissionDecision, 'deny');
});

test('Stop hook: a file edited through a symlinked folder is verified', () => {
  const { link } = linked();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-link-state-'));
  edit(link, 'src/a.js', stateDir);
  writeFileSync(join(link, 'src/a.js'), 'export const a = 2;\n');
  const stop = runStopHook(JSON.stringify({ session_id: 'ln', cwd: link, stop_hook_active: false }), { stateDir, timeout: 30 });
  assert.ok(stop, 'the Stop hook said nothing');
  assert.match(JSON.parse(stop).systemMessage, /1 check\(s\) passed for 1 edited file/u);
});
