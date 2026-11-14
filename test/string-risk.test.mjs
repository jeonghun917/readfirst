// A risk written as a plain string (`risks: ['...']`, not `{ text }`) breaks the map, and check says so; until
// 2026-11-14 the hook's notes for its files then said `Risk [...]: undefined`, the risk's own words lost. The notes keep
// saying the map is broken, and give the risk's text.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook } from '../src/cli.mjs';

test('a risk written as a string is shown by its text, with the map said to be broken', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-string-risk-'));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], risks: ['a is read by the nightly report'] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start']);
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-string-risk-state-'));
  const out = runHook(JSON.stringify({ session_id: `string-risk-${process.pid}`, cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js'), old_string: '1', new_string: '2' } }), { stateDir, now: Date.now() + 2000 });
  const context = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(context, /map\.json is broken/u);
  assert.match(context, /a is read by the nightly report/u);
  assert.doesNotMatch(context, /undefined/u);
});
