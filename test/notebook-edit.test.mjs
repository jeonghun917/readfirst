// NotebookEdit is a write (ledger, 2026-11-14): the PreToolUse hook read only Edit, Write, MultiEdit and Bash, and
// `hook --install` matched only those, so a notebook cell changed with NotebookEdit got no notes, the gate never asked,
// and the Stop hook never checked the notebook. The hook now takes NotebookEdit's notebook_path as the file it writes
// (no edit text to judge: its items are not judged, as for a file a command writes), and install puts NotebookEdit in
// the matcher, adding it to an older readfirst entry's matcher as it adds Bash.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { installHook, runHook } from '../src/cli.mjs';

const NOTEBOOK = `${JSON.stringify({ cells: [{ cell_type: 'code', id: 'c1', metadata: {}, source: ['x = 1\n'], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 })}\n`;
let n = 0;
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-notebook-'));
  const files = {
    'nb/a.ipynb': NOTEBOOK,
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'nb', title: 'the notebooks', files: ['nb/**', '.readfirst/**'], risks: [{ text: 'nb/a.ipynb: its first cell sets x, which the report reads' }], checks: [{ run: 'true', why: 'nothing' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  return root;
}
const cellEdit = (root) => ({ notebook_path: join(root, 'nb/a.ipynb'), cell_id: 'c1', new_source: 'x = 2\n', edit_mode: 'replace' });
const hook = (root, gate) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-notebook-state-'));
  const out = runHook(JSON.stringify({ session_id: `notebook-${process.pid}-${++n}`, cwd: root, tool_name: 'NotebookEdit', tool_input: cellEdit(root) }), { stateDir, gate, now: Date.now() + 2000 });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};

test('a NotebookEdit gets the notebook\'s notes, and the gate refuses it until they are read', () => {
  const root = repo();
  const plain = hook(root, false);
  assert.match(plain?.additionalContext ?? '', /readfirst notes for nb\/a\.ipynb/u, 'the notes of the notebook');
  assert.match(plain.additionalContext, /its first cell sets x/u);
  const gated = hook(root, true);
  assert.equal(gated?.permissionDecision, 'deny', 'the gate refuses the first NotebookEdit');
  assert.match(gated.permissionDecisionReason, /nb\/a\.ipynb/u);
});

test('install puts NotebookEdit in the matcher, and adds it to an older readfirst entry', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'readfirst-notebook-install-'));
  execFileSync('git', ['-C', fresh, 'init', '-q', '-b', 'main']);
  installHook(fresh);
  const matcher = JSON.parse(readFileSync(join(fresh, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].matcher;
  assert.ok(new RegExp(`^(?:${matcher})$`, 'u').test('NotebookEdit'), matcher);
  const old = mkdtempSync(join(tmpdir(), 'readfirst-notebook-install-'));
  execFileSync('git', ['-C', old, 'init', '-q', '-b', 'main']);
  mkdirSync(join(old, '.claude'));
  writeFileSync(join(old, '.claude/settings.json'), `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: 'npx --yes readfirst hook --gate', timeout: 15 }] }] } }, null, 2)}\n`);
  assert.equal(installHook(old), 'matcher');
  assert.equal(JSON.parse(readFileSync(join(old, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|Bash|NotebookEdit');
  assert.equal(installHook(old), false, 'a second install writes nothing');
});

// The plugin's hook (plugins/readfirst/hooks/hooks.json) matches the same tools install does. It lacks NotebookEdit
// until the release's version PR, which changes it together with the plugin's version.
test('the plugin\'s hook matches the tools install matches', { todo: 'plugins/readfirst/hooks/hooks.json gets NotebookEdit in the release version PR, with the plugin version' }, () => {
  const tools = (m) => m.split('|').sort();
  const fresh = mkdtempSync(join(tmpdir(), 'readfirst-notebook-install-'));
  execFileSync('git', ['-C', fresh, 'init', '-q', '-b', 'main']);
  installHook(fresh);
  const installed = JSON.parse(readFileSync(join(fresh, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].matcher;
  const plugin = JSON.parse(readFileSync(new URL('../plugins/readfirst/hooks/hooks.json', import.meta.url), 'utf8')).hooks.PreToolUse
    .find((m) => (m.hooks ?? []).some((h) => /readfirst hook/u.test(h.command ?? ''))).matcher;
  assert.deepEqual(tools(plugin), tools(installed));
});
