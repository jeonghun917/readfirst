// Each risk and rule in the PreToolUse hook's notes carries a fixed id and what the edit about to be made does to it:
// touched (by the names or lines it gives), not touched, or not judged (it names nothing readfirst can find in the
// code; a Bash command writes the file and there is no edit to compare; the edit is too large to place in the hook's
// budget; or judging failed). The edit is applied to the file as it is on
// disk (Edit, MultiEdit, replace_all, Write) and judged as `readfirst diff` judges a commit. Until this test the notes
// were the same whatever the edit changed. The gate refuses as before.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { brief, itemId, noteStates, runHook } from '../src/cli.mjs';
import { textChange } from '../src/trigger.mjs';

const A = 'export function alpha(x) {\n  const one = 1;\n  return x + one;\n}\n\nexport function beta(y) {\n  const two = 2;\n  return y * two;\n}\n';
const NAMED = '`alpha` must stay pure: the cache keys on its result';
const PROSE = 'this module is old and fragile; go slowly';
const RULE = '`beta` never opens a socket';
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-note-states-'));
  const files = {
    'src/a.js': A,
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: NAMED }, { text: PROSE }] }], rules: [{ id: 'no-net', rule: RULE, files: ['src/**'] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  return root;
}
let n = 0;
// The notes of one first call in a fresh session: [decision, reason text].
function notes(tool, input) {
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-note-states-state-'));
  const out = runHook(JSON.stringify({ session_id: `note-states-${process.pid}-${++n}`, cwd: root, tool_name: tool, tool_input: { file_path: join(root, 'src/a.js'), ...input } }), { stateDir, gate: true });
  const o = JSON.parse(out).hookSpecificOutput;
  return [o.permissionDecision, o.permissionDecisionReason ?? o.additionalContext, root];
}
const NAMED_ID = itemId('risk', 'src', NAMED);
const PROSE_ID = itemId('risk', 'src', PROSE);
const stateOf = (text, id) => text.match(new RegExp(`\\[${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} · ([^\\]]*)\\]`, 'u'))?.[1] ?? null;

test('fixed ids: rule:<id> and risk:<group>:<8 hex of the text>', () => {
  assert.equal(itemId('rule', 'no-net', RULE), 'rule:no-net');
  assert.match(NAMED_ID, /^risk:src:[0-9a-f]{8}$/u);
  assert.equal(itemId('risk', 'src', NAMED), NAMED_ID, 'the same text, the same id');
  assert.notEqual(itemId('risk', 'src', `${NAMED}.`), NAMED_ID, 'another text, another id');
});

test('an Edit inside beta: the risk about alpha is not touched, the rule about beta is, the prose risk is not judged', () => {
  const [decision, text] = notes('Edit', { old_string: '  return y * two;', new_string: '  return y * two * 1;' });
  assert.equal(decision, 'deny', 'the gate refuses as before');
  assert.match(stateOf(text, NAMED_ID), /^not touched: the change does not touch `alpha`/u);
  assert.match(stateOf(text, 'rule:no-net'), /^touched by `beta`/u);
  assert.equal(stateOf(text, PROSE_ID), 'not judged: it names nothing readfirst can find in the code');
});

test('an Edit inside alpha: the risk about alpha is touched, the rule about beta is not', () => {
  const [, text] = notes('Edit', { old_string: '  return x + one;', new_string: '  return x + one + 0;' });
  assert.match(stateOf(text, NAMED_ID), /^touched by `alpha`/u);
  assert.match(stateOf(text, 'rule:no-net'), /^not touched/u);
});

test('MultiEdit and replace_all are applied as Claude Code applies them', () => {
  const [, multi] = notes('MultiEdit', { edits: [{ old_string: 'const one = 1;', new_string: 'const one = 1.0;' }, { old_string: 'return x + one;', new_string: 'return one + x;' }] });
  assert.match(stateOf(multi, NAMED_ID), /^touched/u);
  assert.match(stateOf(multi, 'rule:no-net'), /^not touched/u);
  // `two` is only in beta: replacing every one touches beta alone; `return` is in both.
  const [, onlyBeta] = notes('Edit', { old_string: 'two', new_string: 'pair', replace_all: true });
  assert.match(stateOf(onlyBeta, NAMED_ID), /^not touched/u);
  assert.match(stateOf(onlyBeta, 'rule:no-net'), /^touched/u);
  const [, both] = notes('Edit', { old_string: 'return', new_string: 'return /* checked */', replace_all: true });
  assert.match(stateOf(both, NAMED_ID), /^touched/u);
  assert.match(stateOf(both, 'rule:no-net'), /^touched/u);
});

test('a file a Bash command writes has no edit to judge: its notes say so', () => {
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-note-states-state-'));
  const out = JSON.parse(runHook(JSON.stringify({ session_id: `note-states-bash-${process.pid}`, cwd: root, tool_name: 'Bash', tool_input: { command: 'sed -i s/two/pair/ src/a.js' } }), { stateDir, gate: true })).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(stateOf(out.permissionDecisionReason, NAMED_ID), 'not judged: no edit to judge it against');
});

// The first textChange kept a copy of its furthest points for every round of the walk: a Write that changed every line
// of a 5000-line file ran the hook out of heap (abort after 11 s, no answer, so the call went through). Now the hook
// answers in its budget: it refuses with the notes, and an edit too large to place says so for each item.
test('a Write that changes every line of a 5000-line file: refused with notes, in the budget, each item says why it is not judged', () => {
  const root = repo();
  const big = (tag) => Array.from({ length: 5000 }, (_, i) => `export function f${i}() { return '${tag}${i}'; }`).join('\n') + '\n';
  writeFileSync(join(root, 'src/a.js'), big('old'));
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'big']);
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-note-states-state-'));
  const t = Date.now();
  const out = JSON.parse(runHook(JSON.stringify({ session_id: `note-states-big-${process.pid}`, cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, 'src/a.js'), content: big('new') } }), { stateDir, gate: true })).hookSpecificOutput;
  assert.ok(Date.now() - t < 10_000, `answered in ${Date.now() - t} ms`);
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(stateOf(out.permissionDecisionReason, NAMED_ID), "not judged: the edit changes too much of src/a.js to place within the hook's budget");
  assert.match(out.permissionDecisionReason, new RegExp(`Rule no-net \\[rule:no-net · not judged: the edit changes too much`, 'u'));
});

test('textChange: past its work budget or deadline the change is unplaced, not cut; inside it, the shortest diff', () => {
  const lines = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n');
  const over = textChange(lines('a', 300), lines('b', 300), { work: 1000 });
  assert.deepEqual([over.unplaced, over.whole, over.lines.size], [true, true, 0]);
  assert.equal(textChange(lines('a', 300), lines('b', 300), { deadline: Date.now() - 1 }).unplaced, true);
  const full = textChange(lines('a', 300), lines('b', 300));
  assert.deepEqual([full.unplaced, full.text.length], [undefined, 600]);
  // Every other line changed, with lines added and removed between: as short as git's (one hunk per change).
  const before = lines('k', 200).split('\n');
  const after = before.flatMap((l, i) => (i % 2 ? [`${l}!`] : i % 10 === 0 ? [l, 'new'] : [l]));
  const c = textChange(before.join('\n'), after.join('\n'));
  assert.equal(c.text.length, 100 * 2 + 20);
  // A new file ('' is one empty line) or a file emptied: placed at once, whatever its size, not over the budget.
  const created = textChange('', lines('n', 20_000));
  assert.deepEqual([created.unplaced, created.text.length], [undefined, 20_001]);
  const emptied = textChange(lines('n', 20_000), '');
  assert.deepEqual([emptied.unplaced, emptied.text.length], [undefined, 20_001]);
  assert.deepEqual(textChange('k5', lines('k', 20_000)).hunks, [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 5 }, { oldStart: 1, oldCount: 0, newStart: 7, newCount: 19_994 }]);
});

test('a judge that throws: every item says judging failed, not that there was no edit', () => {
  const list = { targets: [{ path: 'src/a.js' }], checks: [], tests: [], rules: [{ id: 'no-net', rule: RULE }], risks: [{ group: 'src', text: NAMED }] };
  noteStates(list, () => { throw new Error('boom\nat line 2'); });
  const text = brief(list, { ids: true }).join('\n');
  assert.equal(stateOf(text, 'rule:no-net'), 'not judged: judging the edit failed (boom)');
  assert.equal(stateOf(text, NAMED_ID), 'not judged: judging the edit failed (boom)');
  // No edit at all (a Bash write) still reads as before.
  const bash = { ...list, rules: [{ id: 'no-net', rule: RULE }], risks: [] };
  assert.equal(stateOf(brief(bash, { ids: true }).join('\n'), 'rule:no-net'), 'not judged: no edit to judge it against');
});

test('textChange gives the lines git diff gives for an edit', () => {
  const c = textChange(A, A.replace('  return y * two;', '  return y * two * 1;'));
  assert.deepEqual([[...c.lines], c.whole], [[8], false], 'that line, not the whole file');
  assert.deepEqual(c.hunks, [{ oldStart: 8, oldCount: 1, newStart: 8, newCount: 1 }]);
  const added = textChange('a\nb\n', 'a\nx\nb\n');
  assert.deepEqual([[...added.lines], added.hunks], [[2], [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }]]);
  assert.deepEqual([...textChange('same\n', 'same\n').lines], []);
});
