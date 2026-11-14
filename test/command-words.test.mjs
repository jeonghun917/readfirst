// A command's words as the shell hands them over (commandWords in src/bash-writes.mjs), for a hook that takes an
// argument's text from the command line, as `readfirst answer '<json>'` will. A JSON answer carries apostrophes,
// escaped quotes and backslashes; each form below is checked against the argument bash itself passes (`printf '%s\0'`),
// and must parse as the JSON that was meant. Next to them, the look-alikes that are no literal argument: a $( ), a
// variable from outside the command, backticks, and JSON fed through a pipe.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { commandWords } from '../src/bash-writes.mjs';

// What bash passes as the arguments after `readfirst answer`, one per \0.
const bashArgs = (args) => spawnSync('bash', ['-c', `printf '%s\\0' ${args}`], { encoding: 'utf8' }).stdout.split('\0').slice(0, -1);
const answerArgs = (command) => {
  const at = commandWords(command, '/r').find((c) => c.words.some((w) => w.text === 'answer'));
  return at.words.slice(at.words.findIndex((w) => w.text === 'answer') + 1);
};

test('a JSON answer with an apostrophe, an escaped quote or a backslash: the word bash passes, and the JSON meant', () => {
  for (const [args, meant] of [
    [String.raw`'[{"because":"it'\''s fine"}]'`, [{ because: "it's fine" }]],
    [String.raw`"[{\"because\":\"a \\\"b\\\" c\"}]"`, [{ because: 'a "b" c' }]],
    [String.raw`'[{"because":"x\\y"}]'`, [{ because: 'x\\y' }]],
    [String.raw`"[{\"because\":\"x\\\\y\"}]"`, [{ because: 'x\\y' }]],
    [String.raw`'[{"because":"'"it's"'"}]'`, [{ because: "it's" }]],
    [String.raw`\[\{\"a\":1\}\]`, [{ a: 1 }]],
  ]) {
    const words = answerArgs(`npx readfirst answer ${args}`);
    assert.deepEqual(words.map((w) => w.text), bashArgs(args), args);
    assert.equal(words.length, 1, args);
    assert.ok(words[0].known, args);
    assert.deepEqual(JSON.parse(words[0].text), meant, args);
  }
});

test('a variable the command sets is known; a $( ), backticks or a variable from outside it are not', () => {
  assert.deepEqual(answerArgs(`J='[{"a":1}]'; readfirst answer "$J"`).map((w) => [w.text, w.known]), [['[{"a":1}]', true]]);
  for (const args of ['"$(cat a.json)"', '`cat a.json`', '"$OUT"', '"$1"']) {
    const words = answerArgs(`readfirst answer ${args}`);
    assert.equal(words.length, 1, args);
    assert.equal(words[0].known, false, args);
  }
});

test('a word the shell may expand by what is on disk is not known: unquoted JSON, braces, a ~; quoted or escaped it is', () => {
  // Unquoted, [{"a":1}] is a glob and {"a":1,"b":2} brace expansion: bash passes two words for the second.
  assert.deepEqual(bashArgs('{"a":1,"b":2}'), ['a:1', 'b:2']);
  for (const args of ['[{"a":1}]', '{"a":1,"b":2}', '~/a.json', 'a*.json', 'a?.json']) {
    assert.ok(answerArgs(`readfirst answer ${args}`).every((w) => !w.known), args);
  }
  // A ~ after the = of a word shaped like an assignment, or after a : in it, is the home folder too (bash expands both).
  assert.deepEqual(bashArgs('a=~/x x=y~ a:~'), [`a=${process.env.HOME}/x`, 'x=y~', 'a:~']);
  for (const args of ['a=~/x', 'PATH=~:~']) assert.ok(answerArgs(`readfirst answer ${args}`).every((w) => !w.known), args);
  for (const args of [`'[{"a":1}]'`, `"{\\"a\\":1,\\"b\\":2}"`, String.raw`\~/a.json`, `'a*.json'`, '"${J}"', 'x=y~', String.raw`a=\~/x`]) {
    assert.ok(answerArgs(`J=x; readfirst answer ${args}`).every((w) => w.known), args);
  }
});

// The review of 2026-11-14 ran 84 argument forms through bash: each of these was given as known while bash passed
// something else (more words, a /dev/fd path, or nothing: a syntax error).
test('a variable unquoted, process substitution, a backslash at the end or a quote left open is not known', () => {
  assert.deepEqual(spawnSync('bash', ['-c', `V="a b"; printf '%s\\0' $V`], { encoding: 'utf8' }).stdout.split('\0').slice(0, -1), ['a', 'b'], 'bash splits it');
  for (const command of ['V="a b"; readfirst answer $V', 'V=x; readfirst answer $V', 'IFS=,; V="a,b"; readfirst answer $V',
    'readfirst answer <(echo hi)', 'readfirst answer abc\\', `readfirst answer 'abc`, 'readfirst answer "abc']) {
    assert.ok(answerArgs(command).length && answerArgs(command).every((w) => !w.known), command);
  }
  assert.deepEqual(answerArgs('V="a b"; readfirst answer "$V"').map((w) => [w.text, w.known]), [['a b', true]], 'quoted it is one word, as bash passes it');
});

test('a here-document body and a function body are not commands where they are written', () => {
  // The body's lines are data: text that reads like an answer in a document written with cat is none.
  assert.deepEqual(commandWords(`cat > notes.md <<EOF\nrun: readfirst answer '["x"]'\nEOF`, '/r').map((c) => c.words.map((w) => w.text)), [['cat']]);
  assert.deepEqual(commandWords(`readfirst answer <<'EOF'\n{"a":1}\nEOF\necho done`, '/r').map((c) => c.words.map((w) => w.text)), [['readfirst', 'answer'], ['echo', 'done']]);
  // A function's definition and the commands of its body run when it is called: they are marked `body`.
  const fn = commandWords(`f() {\n  readfirst answer '[]'\n}\nf '{"a":1}'`, '/r').map((c) => [c.words.map((w) => w.text).join(' '), c.body]);
  assert.deepEqual(fn, [['f() {', true], ['readfirst answer []', true], ['}', true], ['f {"a":1}', false]]);
  assert.ok(commandWords(`f() { readfirst answer '[]'; }; f`, '/r').filter((c) => c.words.some((w) => w.text === 'answer')).every((c) => c.body));
});

test('wrappers, redirects and the commands around it are not its words; a pipe into it gives it none', () => {
  const all = commandWords(`sudo env A=1 readfirst answer '[]' > log 2>&1 && sed -i s/a/b/ f`, '/r');
  assert.deepEqual(all.map((c) => [c.words.map((w) => w.text), c.op]), [[['readfirst', 'answer', '[]'], '&&'], [['sed', '-i', 's/a/b/', 'f'], '']]);
  const piped = commandWords('cat a.json | readfirst answer', '/r');
  assert.deepEqual(piped.map((c) => [c.words.map((w) => w.text), c.pipe]), [[['cat', 'a.json'], true], [['readfirst', 'answer'], true]]);
});
