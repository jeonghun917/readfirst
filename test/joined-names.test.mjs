// A risk that writes two names joined by a slash ("not inside encodeToken/decodeToken") named nothing: a name next
// to a `/` was refused, to keep the folders of a path out, so the risk was never judged against a change and showed for
// its files every time. Each part that looks like code is a name; a path stays a path.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, unmatchedItems } from '../src/trigger.mjs';

const AUTH = 'export function encodeToken(p) {\n  return p;\n}\nexport function decodeToken(p, h) {\n  return p === h;\n}\nexport function other() {\n  return 1;\n}\n';
const read = (p) => (p === 'src/token.js' ? AUTH : p === 'src/fooBar/bazQux.js' ? 'export const one = 1;\n' : null);
const files = ['src/token.js', 'src/fooBar/bazQux.js'];
const change = (path, line, text) => new Map([[path, { lines: new Set([line]), text: [text], hunks: [], whole: false }]]);
const one = (text, changes, shown = ['src/token.js']) => {
  const list = { targets: [...changes.keys()].map((p) => ({ path: p, group: 'src' })), rules: [], risks: [{ group: 'src', text, for: shown }] };
  judge(list, { changes, read, files, imports: [] });
  return list.risks[0].trigger;
};

test('names joined by a slash are each read: a change to either function triggers the risk', () => {
  const text = 'the expiry is checked only inside encodeToken/decodeToken; a new caller that skips them is not checked';
  const second = one(text, change('src/token.js', 5, '  return p == h;'));
  assert.deepEqual(second.about, ['`encodeToken`', '`decodeToken`']);
  assert.equal(second.triggered, true, JSON.stringify(second));
  assert.deepEqual(second.by, ['`decodeToken`']);
  const neither = one(text, change('src/token.js', 8, '  return 2;'));
  assert.equal(neither.triggered, false, 'a change to another function of the file does not touch it');
  assert.equal(neither.why.includes('`encodeToken`'), true);
});

test('so are calls and backticked names joined by a slash, and a name at the end of a sentence', () => {
  assert.deepEqual(one('call encodeToken()/decodeToken() and nothing else', change('src/token.js', 2, '  return q;')).about, ['`encodeToken`', '`decodeToken`']);
  assert.deepEqual(one('keep `encodeToken/decodeToken` together', change('src/token.js', 2, '  return q;')).about, ['`encodeToken`', '`decodeToken`']);
  assert.deepEqual(one('Nothing signs outside encodeToken/decodeToken.', change('src/token.js', 2, '  return q;')).by, ['`encodeToken`']);
});

test('a path is still a path: its folders are not names', () => {
  // src/fooBar/bazQux.js has an extension and is taken out as a path; lib/fooBar/index and src/readlist have a part
  // that does not look like code.
  for (const text of ['see src/fooBar/bazQux.js for the limit', 'see lib/encodeToken/index for the limit', 'see src/decodeToken for the limit', 'see lib/encodeToken/decodeToken for the limit']) {
    const t = one(text, change('src/token.js', 2, '  return q;'));
    assert.deepEqual(t.about.filter((a) => a.startsWith('`')), [], `${text}: ${JSON.stringify(t)}`);
  }
});

test('audit no longer counts such a risk as one that can never be judged', () => {
  const map = { groups: [{ id: 'src', files: ['src/**'], risks: [{ text: 'the limit is checked only inside encodeToken/decodeToken' }, { text: 'something nobody can find' }] }] };
  assert.deepEqual(unmatchedItems(map, { files, read }).map((u) => u.where), ['groups.src.risks[1]']);
});
