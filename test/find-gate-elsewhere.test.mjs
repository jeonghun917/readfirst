// A find that ran somewhere else (2026-11-15): a `readfirst find` run in a folder in no repository, or with --root on
// another repository, searched other files, so it does not count for a name added here, and still does not. But the
// refusal said "no `readfirst find` in this session asked about it", which was not so: an agent that had searched was
// told it had not, and searched again in the same place. The refusal now says where the find that asked ran and how
// to run it here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook } from '../src/cli.mjs';

const repo = (prefix) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const files = {
    'src/a.js': 'export function alpha() {\n  return 1;\n}\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], checks: [{ run: 'true', why: 'nothing' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  return root;
};
let n = 0;
function session() {
  const root = repo('readfirst-elsewhere-');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-elsewhere-state-'));
  const id = `elsewhere-${process.pid}-${++n}`;
  let now = Date.now() + 2000;
  const call = (tool, input) => {
    const out = runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) });
    const h = out ? JSON.parse(out).hookSpecificOutput : null;
    return { refused: h?.permissionDecision === 'deny', text: h?.permissionDecisionReason ?? h?.additionalContext ?? '' };
  };
  const add = (name) => call('Edit', { file_path: join(root, 'src/a.js'), old_string: '  return 1;\n}\n', new_string: `  return 1;\n}\nexport function ${name}() {\n  return 2;\n}\n` });
  // The file's notes are shown once first, so the add below is judged only for its new name.
  call('Edit', { file_path: join(root, 'src/a.js'), old_string: 'return 1;', new_string: 'return 1;' });
  return { root, call, add };
}
const findLine = (out) => out.text.split('\n').find((l) => l.includes('readfirst find')) ?? '';

test('a find run in a folder in no repository is named in the refusal, with how to run it here, and still counts for nothing', () => {
  const { root, call, add } = session();
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'readfirst-elsewhere-out-')));
  call('Bash', { command: `cd ${out} && npx readfirst find "retry a payment"` });
  const r = add('retryPayment');
  assert.ok(r.refused, 'the find searched other files, so the name is asked about here');
  const line = findLine(r);
  assert.match(line, /no `readfirst find` in this session asked about it in this repository\./u);
  assert.ok(line.includes(`asked about \`retryPayment\` in ${out}, which is not this repository (${root})`), line);
  assert.ok(line.includes(`with \`--root ${root}\``), line);
});

test('a find run with --root on another repository is named by that repository\'s folder', () => {
  const { root, call, add } = session();
  const other = repo('readfirst-elsewhere-other-');
  call('Bash', { command: `npx readfirst find "retry a payment" --root ${other}` });
  const r = add('retryPayment');
  assert.ok(r.refused);
  assert.ok(findLine(r).includes(`asked about \`retryPayment\` in ${other}, which is not this repository (${root})`), findLine(r));
});

test('a find elsewhere that asked other words is not named, and with no find at all the refusal reads as before', () => {
  const s = session();
  s.call('Bash', { command: `cd ${tmpdir()} && npx readfirst find "refund an order"` });
  const r = s.add('retryPayment');
  assert.ok(r.refused);
  assert.match(findLine(r), /no `readfirst find` in this session asked about it\. Run `npx readfirst find/u);
  const none = session();
  assert.match(findLine(none.add('retryPayment')), /no `readfirst find` in this session asked about it\. Run `npx readfirst find/u);
});

test('the same find run here after it counts as before', () => {
  const { root, call, add } = session();
  call('Bash', { command: `cd ${tmpdir()} && npx readfirst find "retry a payment"` });
  call('Bash', { command: `npx readfirst find "retry a payment" --root ${root}` });
  assert.ok(!add('retryPayment').refused);
});
