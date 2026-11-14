// The gate asks for answers (plan of 2026-11-13, step 2). Until this, `hook --gate` refused the first call on a file
// with its notes and let the same call through when it was made again, whether the notes had been read or not (ledger
// gate-resend-passes-without-reading). Now each rule and risk the change touches, or that readfirst cannot judge
// against it, is asked, and the call is refused until each has an answer: `readfirst answer '<json>'`, read by the
// hook from the command line, kept only when its call is let through, holding for the session while the change
// touches the item by no other names. An unsure answer lets the call through and blocks the stop once.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { itemId, main, runHook, runStopHook } from '../src/cli.mjs';

const A = 'export function alpha(x) {\n  const one = 1;\n  return x + one;\n}\n\nexport function beta(y) {\n  const two = 2;\n  return y * two;\n}\n';
const NAMED = '`alpha` must stay pure: the cache keys on its result';
const BOTH = '`alpha` and `beta` share one cache';
const PROSE = 'this module is old and fragile; go slowly';
const RULE = '`beta` never opens a socket';
const ID = { named: itemId('risk', 'src', NAMED), both: itemId('risk', 'src', BOTH), prose: itemId('risk', 'src', PROSE), rule: 'rule:no-net' };
let n = 0;
function session({ risks = [NAMED, BOTH, PROSE], rules = [{ id: 'no-net', rule: RULE, files: ['src/**'] }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-answers-'));
  const files = {
    'src/a.js': A,
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: risks.map((text) => ({ text })) }], rules }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-answers-state-'));
  const id = `answers-${process.pid}-${++n}`;
  let now = 1000;
  const call = (tool, input) => { const out = runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: tool, tool_input: input }), { stateDir, gate: true, now: (now += 1000) }); return out ? JSON.parse(out).hookSpecificOutput : null; };
  const stop = () => { const out = runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 }); return out ? JSON.parse(out) : null; };
  // The answers kept in the state, in the order given: [item, kind].
  const kept = () => readFileSync(join(stateDir, `readfirst-hook-${id.replace(/[^\w-]/gu, '')}.lines`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)[0]).filter((k) => k.startsWith('answer:')).map((k) => JSON.parse(k.slice('answer:'.length)).slice(0, 2));
  return { root, call, stop, kept, bash: (command) => call('Bash', { command }) };
}
const inBeta = (root) => ({ file_path: join(root, 'src/a.js'), old_string: '  return y * two;', new_string: '  return y * two * 1;' });
const inAlpha = (root) => ({ file_path: join(root, 'src/a.js'), old_string: '  return x + one;', new_string: '  return x + one + 0;' });
// The ids a refusal asks, in its order.
const asked = (out) => [...String(out?.permissionDecisionReason ?? '').matchAll(/^- `((?:rule|risk):[^`]+)`/gmu)].map((m) => m[1]);
const decision = (out) => (out ? out.permissionDecision ?? 'context' : 'through');
// One quoted argument, an apostrophe written as '\'' the way a shell needs it.
const answer = (list) => `npx readfirst answer '${JSON.stringify(list).replace(/'/gu, "'\\''")}'`;
const keeps = (...ids) => ids.map((item) => ({ item, answer: 'keeps', because: "it's the same arithmetic, no I/O" }));

test('an edit inside beta asks what it touches and what cannot be judged, not the risk about alpha', () => {
  const s = session();
  const out = s.call('Edit', inBeta(s.root));
  assert.equal(out.permissionDecision, 'deny');
  assert.deepEqual(asked(out).sort(), [ID.both, ID.prose, ID.rule].sort(), 'touched: the rule and the shared cache; not judged: the prose risk');
  assert.match(out.permissionDecisionReason, /readfirst notes for src\/a\.js/u, 'the notes come with the first refusal');
  assert.match(out.permissionDecisionReason, /npx readfirst answer '\[\{"item":"<id>","answer":"keeps\|not-this\|done\|unsure"/u, 'it says how to answer');
});

test('a resend with no answer is refused, listing the same items', () => {
  const s = session();
  const first = s.call('Edit', inBeta(s.root));
  const again = s.call('Edit', inBeta(s.root));
  assert.equal(again.permissionDecision, 'deny', 'made again with nothing answered');
  assert.deepEqual(asked(again), asked(first));
  assert.doesNotMatch(again.permissionDecisionReason, /readfirst notes for/u, 'the notes are not repeated; each item comes with its text');
  assert.match(again.permissionDecisionReason, new RegExp(`\`${ID.rule}\` \\(touched by \`beta\`\\): Rule no-net: \`beta\` never opens a socket`, 'u'));
});

test('a partial answer is refused with the rest listed; a full answer passes', () => {
  const s = session();
  s.call('Edit', inBeta(s.root));
  assert.equal(s.bash(answer(keeps(ID.rule))), null, 'the answer itself goes through');
  const partial = s.call('Edit', inBeta(s.root));
  assert.equal(partial.permissionDecision, 'deny');
  assert.deepEqual(asked(partial).sort(), [ID.both, ID.prose].sort(), 'only the items not answered');
  assert.equal(s.bash(answer([...keeps(ID.both), { item: ID.prose, answer: 'done', because: 'went slowly: one line' }])), null);
  assert.equal(decision(s.call('Edit', inBeta(s.root))), 'through', 'every item answered');
});

test('an answer and a write in one command is refused, and a refused call\'s answers are not kept', () => {
  const s = session();
  const ids = asked(s.call('Edit', inBeta(s.root)));
  // The hook runs before the command: when sed writes, the answer has not run.
  const both = s.bash(`${answer(keeps(...ids))} && sed -i s/two/pair/ src/a.js`);
  assert.equal(both.permissionDecision, 'deny');
  assert.ok(asked(both).length >= ids.length, 'the write is asked its items');
  assert.deepEqual(asked(s.call('Edit', inBeta(s.root))).sort(), ids.sort(), 'the answers of the refused call were not kept');
  assert.equal(s.bash(answer(keeps(...ids))), null);
  assert.equal(decision(s.call('Edit', inBeta(s.root))), 'through');
});

test('an answer from $(cat f), a variable (even one the command sets), a here-document or a pipe is not read, and nothing of it is kept', () => {
  const s = session();
  const ids = asked(s.call('Edit', inBeta(s.root)));
  const json = JSON.stringify(keeps(...ids));
  const quoted = `'${json.replace(/'/gu, "'\\''")}'`;
  writeFileSync(join(s.root, 'a.json'), json);
  // A variable is no answer even when the command sets it: the answer is one literal argument.
  for (const command of ['npx readfirst answer "$(cat a.json)"', 'npx readfirst answer "$ANSWERS"', `J=${quoted}; npx readfirst answer "$J"`, `J=${quoted}; npx readfirst answer $J`, `npx readfirst answer "\`cat a.json\`"`, `npx readfirst answer <<'E'\n${json}\nE`, 'cat a.json | npx readfirst answer', `npx readfirst answer ${quoted} | tail -1`]) {
    const out = s.bash(command);
    assert.equal(out?.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /nothing of this answer is kept:\n- `readfirst answer` is not read: /u, command);
  }
  assert.match(s.bash(`J=${quoted}; npx readfirst answer "$J"`).permissionDecisionReason, /an answer is one literal argument/u);
  assert.deepEqual(asked(s.call('Edit', inBeta(s.root))).sort(), ids.sort(), 'still asked');
  // Written out, in single quotes or double quotes with nothing to expand, it is read.
  assert.equal(s.bash(`npx readfirst answer ${quoted}`), null);
  assert.equal(decision(s.call('Edit', inBeta(s.root))), 'through');
  assert.equal(s.bash(`npx readfirst answer "${json.replace(/"/gu, '\\"')}"`), null, 'double quotes with escaped quotes inside');
});

test('an answer is checked: ids asked, a kind, a because, and a not-this no wider than what the change touched', () => {
  const s = session();
  s.call('Edit', inBeta(s.root));
  const refused = (list, why) => { const out = s.bash(answer(list)); assert.equal(out?.permissionDecision, 'deny', why); return out.permissionDecisionReason; };
  assert.match(refused(keeps(ID.named), 'not asked'), new RegExp(`\`${ID.named}\` was not asked in this session`, 'u'));
  assert.match(refused([{ item: ID.rule, answer: 'fine', because: 'x' }], 'a kind'), /"answer" is "fine"; give one of keeps/u);
  assert.match(refused([{ item: ID.rule, answer: 'keeps' }], 'a because'), /has no "because"/u);
  assert.match(refused([{ item: ID.rule, answer: 'not-this', because: 'about alpha', symbols: ['alpha'] }], 'wider'), /not-this names `alpha`, which the change did not touch it by \(it touched `beta`\)/u);
  assert.match(refused([{ item: ID.rule, answer: 'not-this', because: 'x' }], 'no symbols'), /a not-this answer names in "symbols"/u);
  // The prose risk was not judged: no names, so no not-this, whatever symbols it names.
  assert.match(refused([{ item: ID.prose, answer: 'not-this', because: 'the edit is in beta', symbols: ['beta'] }], 'not-this on an item not judged'), /readfirst could not judge it against the change, so there are no names it was touched by for a not-this to stay within: answer keeps, done or unsure/u);
  assert.match(s.bash("npx readfirst answer '[{'").permissionDecisionReason, /not JSON/u);
  // One bad answer and nothing of the command is kept, the good ones neither.
  refused([...keeps(ID.rule), { item: ID.prose, answer: 'keeps' }], 'one bad');
  assert.ok(asked(s.call('Edit', inBeta(s.root))).includes(ID.rule), 'the good answer beside a bad one was not kept');
  assert.equal(s.bash(answer([{ item: ID.rule, answer: 'not-this', because: 'only the arithmetic of beta', symbols: ['beta'] }, ...keeps(ID.both, ID.prose)])), null);
  assert.equal(decision(s.call('Edit', inBeta(s.root))), 'through');
});

test('an answer holds while the change touches the item by the same names; a new symbol asks again', () => {
  const s = session();
  s.call('Edit', inBeta(s.root));
  s.bash(answer(keeps(ID.both, ID.prose, ID.rule)));
  assert.equal(decision(s.call('Edit', inBeta(s.root))), 'through');
  // alpha: the shared-cache risk is now touched by `alpha`, which it was not answered for; the risk about alpha is
  // touched for the first time; the rule about beta is not touched; the prose risk was answered for the session.
  const out = s.call('Edit', inAlpha(s.root));
  assert.equal(out.permissionDecision, 'deny');
  assert.deepEqual(asked(out).sort(), [ID.both, ID.named].sort());
  s.bash(answer(keeps(ID.both, ID.named)));
  assert.equal(decision(s.call('Edit', inAlpha(s.root))), 'through');
  assert.equal(decision(s.call('Edit', inBeta(s.root))), 'through', 'beta still answered');
});

const unsure = (...list) => list.map((item) => ({ item, answer: 'unsure', because: 'cannot tell what the cache keys on' }));

test('with 4 items asked: an answer leaving over half of them unsure is refused, counted by item, split or not', () => {
  const s = session();
  // A write by sed has no edit to judge: all four items are asked.
  const ids = asked(s.bash('sed -i s/two/pair/ src/a.js'));
  assert.deepEqual(ids.sort(), [ID.both, ID.named, ID.prose, ID.rule].sort());
  const all = s.bash(answer(unsure(...ids)));
  assert.equal(all.permissionDecision, 'deny', 'one answer, every item unsure');
  assert.match(all.permissionDecisionReason, /4 of the 4 items asked in this session would be left unsure with this answer, more than half/u);
  assert.equal(s.bash(answer([...unsure(ID.rule, ID.both), ...keeps(ID.prose, ID.named)])), null, 'two of four unsure: not more than half, taken');
  const third = s.bash(answer(unsure(ID.prose)));
  assert.equal(third.permissionDecision, 'deny', 'split: a third item unsure in another answer');
  assert.match(third.permissionDecisionReason, /3 of the 4 items asked in this session would be left unsure/u);
  // By item: the same item unsure again is still one, and an item answered otherwise since no longer counts.
  assert.equal(s.bash(answer(unsure(ID.rule))), null, 'the rule unsure again: still 2 items');
  assert.equal(s.bash(answer(keeps(ID.rule))), null);
  assert.equal(s.bash(answer(unsure(ID.prose))), null, 'the rule answered keeps: the prose risk makes 2 again, taken');
  assert.equal(s.bash(answer(keeps(ID.prose))), null);
  assert.equal(s.bash(answer(unsure(ID.rule))), null, 'the rule unsure again after keeps: 2 items, taken');
  // Every answer is kept, the unsure ones too, so the record shows an item named twice.
  assert.deepEqual(s.kept().filter(([item]) => item === ID.rule).map(([, kind]) => kind), ['unsure', 'unsure', 'keeps', 'unsure']);
  assert.equal(decision(s.bash('sed -i s/two/pair/ src/a.js')), 'through', 'unsure answers let the write through');
  const stopped = s.stop();
  assert.equal(stopped?.decision, 'block');
  assert.match(stopped.reason, /2 answer\(s\) of this session are still unsure:\n- `risk:src:[0-9a-f]{8}`: cannot tell what the cache keys on\n- `rule:no-net`: cannot tell/u);
  assert.notEqual(s.stop()?.decision, 'block', 'once, so a stop cannot loop');
  // Answered again with another kind, they are no longer open.
  assert.equal(s.bash(answer(keeps(ID.rule, ID.both))), null);
  assert.equal(s.stop()?.decision, undefined, 'nothing unsure left');
});

test('with fewer than 4 items asked an unsure is taken, and the Stop hook refuses once for it', () => {
  const s = session({ risks: [PROSE], rules: [] });
  const ids = asked(s.call('Edit', inBeta(s.root)));
  assert.deepEqual(ids, [ID.prose]);
  assert.equal(s.bash(answer(unsure(ID.prose))), null, 'one of one item unsure: taken');
  assert.equal(decision(s.call('Edit', inBeta(s.root))), 'through');
  const stopped = s.stop();
  assert.equal(stopped?.decision, 'block');
  assert.match(stopped.reason, new RegExp(`1 answer\\(s\\) of this session are still unsure:\\n- \`${ID.prose}\``, 'u'));
});

test('a map that cannot be read: nothing is asked, and the notes say the map could not be read', () => {
  const s = session();
  writeFileSync(join(s.root, '.readfirst/map.json'), '{ "format": "readfirst/map@1", "groups": [');
  const out = s.call('Edit', inBeta(s.root));
  assert.equal(decision(out), 'context', 'nothing to answer: through, with the notes');
  assert.match(out.additionalContext, /\.readfirst\/map\.json is broken/u);
  assert.match(out.additionalContext, /\.readfirst\/map\.json could not be read, so these notes hold none of its rules and risks and the gate asks none of them/u);
  assert.deepEqual(asked(out), []);
});

test('without --gate nothing is asked and an answer is not read', () => {
  const s = session();
  const plain = (tool, input) => runHook(JSON.stringify({ session_id: `answers-plain-${process.pid}`, cwd: s.root, tool_name: tool, tool_input: input }), { stateDir: mkdtempSync(join(tmpdir(), 'readfirst-answers-plain-')) });
  assert.equal(JSON.parse(plain('Edit', inBeta(s.root))).hookSpecificOutput.permissionDecision, undefined);
  assert.equal(plain('Bash', { command: "npx readfirst answer '[{'" }), null);
});

test('readfirst answer prints what it was given and what is wrong, and writes nothing', () => {
  let out = '';
  const io = { out: (t) => { out += t; }, err: () => {} };
  assert.equal(main(['answer', JSON.stringify([{ item: ID.rule, answer: 'not-this', because: "it's only beta's arithmetic", symbols: ['beta'] }])], io), 0);
  assert.match(out, /readfirst answer: 1 answer\(s\):\n- rule:no-net: not-this \(beta\), because it's only beta's arithmetic\n/u);
  out = '';
  assert.equal(main(['answer', '[{"item":"rule:no-net","answer":"maybe"}]'], io), 1);
  assert.match(out, /not kept, nothing of it:\n- `rule:no-net`: "answer" is "maybe"; give one of keeps .*\n- `rule:no-net` has no "because"/u);
  assert.throws(() => main(['answer'], io), /one quoted JSON argument/u);
});
