// This repository's own Claude Code hook (.claude/settings.json) is the gate, and it sees Bash. Until this test the
// matcher was Edit|Write|MultiEdit and the command had no --gate: a file written by a Bash command (sed -i, a
// redirect, a script) went through with no notes at all, a `readfirst find` run in Bash was never recorded, and an
// edit was never refused. The settings are read here as they are committed, and the command they hold is run on a
// Bash event that writes a file with sed -i: it must refuse it with the notes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const pre = JSON.parse(readFileSync(join(here, '.claude/settings.json'), 'utf8')).hooks.PreToolUse;
const entry = pre.find((m) => (m.hooks ?? []).some((h) => /readfirst\.mjs" hook\b/u.test(h.command ?? '')));

test('the PreToolUse hook of this repository matches Bash too and runs the gate', () => {
  assert.ok(entry, 'a PreToolUse entry runs bin/readfirst.mjs hook');
  assert.deepEqual(entry.matcher.split('|').sort(), ['Bash', 'Edit', 'MultiEdit', 'Write']);
  const command = entry.hooks.find((h) => /readfirst\.mjs" hook\b/u.test(h.command)).command;
  assert.equal(command, 'node "$CLAUDE_PROJECT_DIR/bin/readfirst.mjs" hook --gate');
});

test('the command in the settings refuses a Bash call that writes a file with sed -i, with the notes', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-own-hook-'));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: 'a is read by the build' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  // The settings' command, with $CLAUDE_PROJECT_DIR as Claude Code sets it.
  const command = entry.hooks.find((h) => /readfirst\.mjs" hook\b/u.test(h.command)).command;
  const args = command.replace('"$CLAUDE_PROJECT_DIR/bin/readfirst.mjs"', join(here, 'bin/readfirst.mjs')).split(' ').slice(1);
  const event = { session_id: `own-hook-${process.pid}`, cwd: root, tool_name: 'Bash', tool_input: { command: "sed -i 's/1/2/' src/a.js" } };
  const out = JSON.parse(execFileSync('node', args, { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: here } }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /readfirst notes for src\/a\.js[\s\S]*a is read by the build/u);
});
