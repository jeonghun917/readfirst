// `readfirst check` said what a field should be, never what was wrong with it: a risk of 2,153 characters was
// "groups[2].risks[32]: { text, files? }", the same line as a risk with no text, a risk whose text is a number or a
// risk that spelled the field `txt` (ledger map-check-hides-length-limit: a session cut a risk three times to find the
// limit). mapProblems now says why: the length and the limit, the field missing (and the unknown field next to it), or
// the type it got instead. Each line keeps its old start (`why: text`), so what matched it still does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapProblems } from '../src/map.mjs';

const FILES = ['src/a.js'];
const MAP = (group = {}, rest = {}) => ({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], ...group }], ...rest });
const problems = (map) => mapProblems(map, FILES, { placement: false });

test('a risk too long says its length and the limit', () => {
  assert.deepEqual(problems(MAP({ risks: [{ text: 'x'.repeat(2153) }] })), ['groups[0].risks[0].text: text (2153 characters, over the 2,000-character limit)']);
  assert.deepEqual(problems(MAP({ risks: [{ text: 'x'.repeat(2000) }] })), [], 'at the limit: good');
});

test('a risk whose text field is misspelled says text is missing and names the unknown field', () => {
  assert.deepEqual(problems(MAP({ risks: [{ txt: 'a' }] })), ['groups[0].risks[0].text: text (missing)', 'groups[0].risks[0].txt: unknown field; did you mean `text`?']);
});

test('a field of the wrong type says the type it got', () => {
  assert.deepEqual(problems(MAP({ risks: [{ text: 42 }] })), ['groups[0].risks[0].text: text (a number)']);
  assert.deepEqual(problems(MAP({ risks: ['a risk as a bare string'] })), ['groups[0].risks[0]: { text, files? } (a string)']);
  assert.deepEqual(problems(MAP({ risks: [{ text: '   ' }] })), ['groups[0].risks[0].text: text (empty)']);
  assert.deepEqual(problems(MAP({ files: ['src/**', 7] })), ['groups[0].files: a list of non-empty strings (item 1: a number)']);
});

test('other text fields say why too: a title over its limit, an empty why, a check command too long', () => {
  assert.deepEqual(problems(MAP({ title: 't'.repeat(250) })), ['groups[0].title: text (250 characters, over the 200-character limit)']);
  assert.deepEqual(problems(MAP({}, { rules: [{ id: 'r', rule: 'a rule', why: '', files: ['src/a.js'] }] })), ['rules[0].why: text (empty)']);
  assert.deepEqual(problems(MAP({ checks: [{ run: 'x'.repeat(600) }] })), ['groups[0].checks[0].run: text (600 characters, over the 500-character limit)']);
});
