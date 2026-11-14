// What counts as a `readfirst find` for the find-first gate (ledger, 2026-11-14): the gate read only the first find in a
// command; a find in a for loop gave the gate the literal `$q` as its query; a find run in one checkout of a
// repository did not count in its other worktrees (the mark was keyed by the checkout's folder); and a name made only
// of find's stop words (`make`, `build`) could never be asked about, since both the query and the name lost them.
// The finds of a command are read as the shell runs them (commandWords), a loop's values stand for its variable, the
// marks are kept per repository (its git common folder), and a stop word asked for counts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook } from '../src/cli.mjs';

let n = 0;
function session() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-findgate-'));
  const files = {
    'src/a.js': 'export function alpha() {\n  return 1;\n}\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], checks: [{ run: 'true', why: 'nothing' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-findgate-state-'));
  const id = `findgate-${process.pid}-${++n}`;
  let now = Date.now() + 2000;
  const call = (tool, input, cwd = root) => {
    const out = runHook(JSON.stringify({ session_id: id, cwd, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) });
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };
  // An edit that adds the function `name` to src/a.js under `at` (the repository, or a worktree of it).
  const add = (name, at = root) => call('Edit', { file_path: join(at, 'src/a.js'), old_string: '  return 1;\n}\n', new_string: `  return 1;\n}\nexport function ${name}() {\n  return 2;\n}\n` });
  // The file's notes are shown once first, so the add below is judged only for its new name.
  call('Edit', { file_path: join(root, 'src/a.js'), old_string: 'return 1;', new_string: 'return 1;' });
  return { root, git, call, add };
}
const noFind = (out) => /no `readfirst find` in this session asked about/u.test(out?.permissionDecisionReason ?? out?.additionalContext ?? '');

test('every find in one command counts, not only the first', () => {
  const { call, add } = session();
  call('Bash', { command: 'npx readfirst find "alpha" && npx readfirst find "retry a payment"' });
  assert.ok(!noFind(add('retryPayment')), 'the second find asked about it');
});

test('a find in a pipeline counts, and a find in a for loop asks the loop\'s values, never the literal variable', () => {
  const pipe = session();
  pipe.call('Bash', { command: 'npx readfirst find "retry a payment" | head -40' });
  assert.ok(!noFind(pipe.add('retryPayment')));
  const loop = session();
  loop.call('Bash', { command: 'for q in "retry a payment" "refund"; do npx readfirst find "$q"; done' });
  assert.ok(!noFind(loop.add('retryPayment')), 'the loop asked "retry a payment"');
  assert.ok(!noFind(loop.add('refundOrder')), 'and "refund"');
  const literal = session();
  literal.call('Bash', { command: 'for q in $LIST; do npx readfirst find "$q"; done' });
  assert.ok(noFind(literal.add('qux')), 'values not known: the word q is not taken as asked');
});

test('a find run in one checkout counts in another worktree of the same repository', () => {
  const { root, git, call, add } = session();
  const wt = mkdtempSync(join(tmpdir(), 'readfirst-findgate-wt-'));
  git('worktree', 'add', '-q', join(wt, 'w'), '-b', 'work');
  call('Bash', { command: 'npx readfirst find "retry a payment"' }, root);
  assert.ok(!noFind(add('retryPayment', join(wt, 'w'))), 'the find in the main checkout asked about it');
});

test('a name made of a stop word counts when find asked that word', () => {
  const { call, add } = session();
  call('Bash', { command: 'npx readfirst find "make"' });
  assert.ok(!noFind(add('make')), 'find asked "make"');
  const other = session();
  other.call('Bash', { command: 'npx readfirst find "retry a payment"' });
  assert.ok(noFind(other.add('build')), 'a find that did not ask it does not count');
});

// Review of 1552438: an option's value was read as a word of the query; a find after a cd was marked for the folder the
// command started in; and a find that asked nothing still counted as a find run after the gate asked.
test('the value of an option that takes one is not a word of the query', () => {
  const { call, add } = session();
  call('Bash', { command: 'npx readfirst find --lang python "retry a payment"' });
  assert.ok(noFind(add('pythonPath')), '`python` is the value of --lang, not asked');
  assert.ok(!noFind(add('retryPayment')), 'the query still counts');
});

test('a find after a cd counts where it runs, and not at all where that is not known', () => {
  const away = session();
  away.call('Bash', { command: `cd ${tmpdir()} && npx readfirst find "retry a payment"` });
  assert.ok(noFind(away.add('retryPayment')), 'the find ran outside this repository');
  const unknown = session();
  unknown.call('Bash', { command: 'cd "$SOMEWHERE" && npx readfirst find "retry a payment"' });
  assert.ok(noFind(unknown.add('retryPayment')), 'where it ran is not known: not counted');
  const here = session();
  here.call('Bash', { command: `cd ${join(here.root, 'src')} && npx readfirst find "retry a payment"` }, tmpdir());
  assert.ok(!noFind(here.add('retryPayment')), 'a cd into the repository counts there');
});

test('a find given --root counts in that folder\'s repository, not the one it was run from', () => {
  const away = session();
  away.call('Bash', { command: `npx readfirst find --root ${tmpdir()} "retry a payment"` });
  assert.ok(noFind(away.add('retryPayment')), 'it searched another folder');
  const here = session();
  here.call('Bash', { command: 'npx readfirst find --root=src "retry a payment"' });
  assert.ok(!noFind(here.add('retryPayment')), 'a --root inside this repository, relative to the command\'s folder');
});

test('a find that asks nothing does not count as a find run after the gate asked', () => {
  const { call, add } = session();
  assert.ok(noFind(add('qux')), 'asked');
  call('Bash', { command: 'npx readfirst find' });
  assert.ok(noFind(add('qux')), 'an empty find opens nothing: the name is still said as not searched for');
});
