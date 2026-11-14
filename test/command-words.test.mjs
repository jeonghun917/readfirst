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
  for (const args of [`'[{"a":1}]'`, `"{\\"a\\":1,\\"b\\":2}"`, String.raw`\~/a.json`, `'a*.json'`, '"${J}"']) {
    assert.ok(answerArgs(`J=x; readfirst answer ${args}`).every((w) => w.known), args);
  }
});

test('wrappers, redirects and the commands around it are not its words; a pipe into it gives it none', () => {
  const all = commandWords(`sudo env A=1 readfirst answer '[]' > log 2>&1 && sed -i s/a/b/ f`, '/r');
  assert.deepEqual(all.map((c) => [c.words.map((w) => w.text), c.op]), [[['readfirst', 'answer', '[]'], '&&'], [['sed', '-i', 's/a/b/', 'f'], '']]);
  const piped = commandWords('cat a.json | readfirst answer', '/r');
  assert.deepEqual(piped.map((c) => [c.words.map((w) => w.text), c.pipe]), [[['cat', 'a.json'], true], [['readfirst', 'answer'], true]]);
});
