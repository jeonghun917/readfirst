// What a change touches, with the trigger engine on the one reader (src/code.mjs). Each case here read wrong while
// declarations were found by a pattern per line and ended by counting braces per line: a line after an inner helper
// belonged to nothing, evidence on a one-line local was about that local, evidence in a doc comment was judged by the
// ten lines around it, a table ended at its first entry, a word in a comment counted as a use, and a line of a
// template counted as code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unusedCode } from '../src/audit.mjs';
import { unseenIn } from '../src/readlist.mjs';
import { evidenceDrift, judge, parsePatch } from '../src/trigger.mjs';

const L = (...a) => a.join('\n');
// One risk shown for one file, judged against changed lines of that file.
const judged = (path, body, text, lines, changes = null) => {
  const list = { rules: [], risks: [{ group: 'g', text, for: [path] }] };
  judge(list, { changes: new Map([[path, changes ?? { lines: new Set(lines), text: lines.map(() => 'x'), hunks: [], whole: false }]]), read: (p) => (p === path ? body : null), files: [path], imports: [] });
  return list.risks[0].trigger;
};
const drift = (path, body, text) => evidenceDrift({ groups: [{ id: 'g', files: [path], risks: [{ text }] }], rules: [] }, { files: [path], read: (p) => (p === path ? body : null) });

// ---- a line after an inner helper belongs to the function around it
const OUTER = L(
  'export function outer(list) {', //  1
  '  const helper = (a) => {', //      2
  '    return a;', //                  3
  '  };', //                           4
  '  const first = helper(list[0]);', // 5
  ...Array.from({ length: 13 }, (_, i) => `  step(${i});`), // 6-18
  '  return first;', //               19
  '}', //                             20
  '', //                              21
  'export function far() {', //       22
  '  return 1;', //                   23
  '  // nothing else', //             24
  '}', //                             25
);

test('evidence after an inner helper is about the function around it: a change anywhere in that function touches it', () => {
  const text = 'the last step returns the first result, never the last (lib/a.mjs:19)';
  assert.equal(judged('lib/a.mjs', OUTER, text, [6]).triggered, true, 'line 6 is in outer, thirteen lines above the evidence');
  assert.equal(judged('lib/a.mjs', OUTER, text, [23]).triggered, false, 'line 23 is in another function, four lines below it');
});

// ---- evidence on a one-line local is about the function, not the local
const ROUTE = L(
  "import { accounts } from './repo';", //                              1
  '', //                                                                 2
  '// Deletes the account.', //                                          3
  'export async function DELETE(req) {', //                              4
  '  const owned = await accounts.soleOwnerOf(req.user.id);', //         5
  '  const shared = owned.filter((o) => o.members > 1);', //             6
  '  if (shared.length) return deny();', //                              7
  '  return ok();', //                                                   8
  '}', //                                                                9
);

test('evidence on a one-line local value is about the function it is in', () => {
  const text = 'a new delete path must keep the sole-owner check (app/route.ts:6)';
  assert.equal(judged('app/route.ts', ROUTE, text, [5]).triggered, true, 'the line above the evidence, in the same function');
  assert.equal(judged('app/route.ts', ROUTE, text, [8]).triggered, true);
  assert.equal(judged('app/route.ts', ROUTE, text, [1]).triggered, false, 'an import, five lines above the evidence');
});

// ---- evidence in the comment above a declaration is about that declaration
const BOX = L(
  "import { a } from 'node:crypto';", // 1
  "import { b } from 'node:fs';", //     2
  "import { c } from 'node:path';", //   3
  '', //                                 4
  '/**', //                              5
  ' * Encrypts webhook secrets with', // 6
  ' * APP_ENCRYPTION_KEY.', //           7
  ' */', //                              8
  'export class SecretBox {', //         9
  '  seal(x) { return x; }', //         10
  '}', //                               11
);

test('evidence in a doc comment is about the declaration below it, not about the ten lines around it', () => {
  const text = 'rotating the key makes every stored secret unreadable (lib/secrets.ts:7)';
  assert.equal(judged('lib/secrets.ts', BOX, text, [3]).triggered, false, 'an import four lines above');
  assert.equal(judged('lib/secrets.ts', BOX, text, [10]).triggered, true, 'a method of the class');
  assert.equal(judged('lib/secrets.ts', BOX, text, [6]).triggered, true, 'the comment itself');
});

// ---- evidence inside one entry of a table is about that entry, named by its key
const TABLE = L(
  'const JS = /\\.js$/u;', //                                  1
  'export const PATTERNS = [', //                              2
  '  // A promise nobody waits for.', //                       3
  "  { id: 'no-await', lang: JS, find: (s) => s.match(/x/u) },", // 4
  '  // An assertion on a promise that the test never waits for,', // 5
  '  // so the test passes whatever the code does.', //         6
  '  {', //                                                    7
  "    id: 'js-expect-promise', lang: JS, tests: true,", //     8
  '    find: (stmt) => {', //                                  9
  ...Array.from({ length: 12 }, (_, i) => `      if (stmt.length === ${i}) return null;`), // 10-21
  '      return stmt;', //                                    22
  '    },', //                                                23
  '  },', //                                                  24
  "  { id: 'str-replace', lang: JS, find: (s) => s },", //     25
  '];', //                                                    26
  'export const after = 1;', //                               27
);

test('evidence inside a table entry is about that entry when the text names its key', () => {
  const text = 'patterns marked tests: true (js-expect-promise) see test files and nothing else (the flag at lib/p.mjs:8)';
  assert.equal(judged('lib/p.mjs', TABLE, text, [22]).triggered, true, 'the same entry, fourteen lines below the evidence');
  assert.equal(judged('lib/p.mjs', TABLE, text, [6]).triggered, true, "the entry's own comment");
  assert.equal(judged('lib/p.mjs', TABLE, text, [4]).triggered, false, 'the entry above, four lines away');
  assert.equal(judged('lib/p.mjs', TABLE, text, [25]).triggered, false, 'the entry below');
  assert.deepEqual(drift('lib/p.mjs', TABLE, text), { drift: [], unanchored: [] }, 'check has nothing to say: the key anchors it');
});

test('evidence inside a table entry whose key the text does not name is about the whole table, and check says it has no anchor', () => {
  const text = 'some patterns see test files and nothing else (the flag at lib/p.mjs:8)';
  assert.equal(judged('lib/p.mjs', TABLE, text, [4]).triggered, true);
  assert.equal(judged('lib/p.mjs', TABLE, text, [27]).triggered, false);
  assert.deepEqual(drift('lib/p.mjs', TABLE, text).unanchored.map((u) => u.ref), ['lib/p.mjs:8']);
});

test('a table written as an object: an entry is a property, named by its name', () => {
  const body = L('export const LIMITS = {', '  // per minute', '  free: { calls: 10, burst: 2 },', "  'pro-team': {", '    calls: 100,', '    burst: 20,', '  },', '};');
  const text = 'the pro-team plan may burst above its rate (lib/limits.mjs:6)';
  assert.equal(judged('lib/limits.mjs', body, text, [5]).triggered, true);
  assert.equal(judged('lib/limits.mjs', body, text, [3]).triggered, false, 'the entry above');
  assert.equal(judged('lib/limits.mjs', body, 'the free plan never bursts (lib/limits.mjs:3)', [2]).triggered, true, 'a property named by a plain word, and its comment');
  assert.equal(judged('lib/limits.mjs', body, 'the free plan never bursts (lib/limits.mjs:3)', [5]).triggered, false);
});

test('evidence on a line no declaration holds is judged by the ten lines around it', () => {
  const body = L("import { run } from './run.mjs';", '', 'run(1);', 'run(2);', ...Array.from({ length: 14 }, () => ''), 'run(3);');
  const text = 'the second call must stay after the first (bin/start.mjs:4)';
  assert.equal(judged('bin/start.mjs', body, text, [3]).triggered, true);
  assert.equal(judged('bin/start.mjs', body, text, [19]).triggered, false, 'fifteen lines below');
});

// ---- a constant set to a template over lines; a Python signature over lines
const BRIEF = L(
  'export const OUT = "/out";', //     1
  'export const RUBRIC = `# the rubric', // 2
  '- ${OUT}/map.json exists', //        3
  '- every group has a title', //       4
  'function example() {', //            5
  '- a check that ends here;', //       6
  '- and the last line`;', //           7
  '', //                                8
  'export function after() {', //       9
  '  return RUBRIC.length;', //        10
  '}', //                              11
);

test('a change anywhere inside a template over lines touches the constant it is set to, and nothing after it does', () => {
  const text = 'a `RUBRIC` line can be met by deleting things';
  for (const line of [3, 5, 6, 7]) assert.equal(judged('lib/brief.mjs', BRIEF, text, [line]).triggered, true, `line ${line}`);
  assert.equal(judged('lib/brief.mjs', BRIEF, text, [10]).triggered, false);
  // The line shaped like a declaration inside the template is text: nothing called `example` is declared.
  assert.match(judged('lib/brief.mjs', BRIEF, '`example` must stay', [5]).why, /names no symbol or line/u);
});

const HOOKS = L(
  'def verify_webhook(', //                     1
  '    body: bytes,', //                        2
  '    sig: str,', //                           3
  ') -> dict[str, Any]:', //                    4
  '    """Checks the signature.', //            5
  'A line of the docstring at column 0.', //    6
  '    """', //                                 7
  '    expected = sign(body)', //               8
  '    return hmac.compare_digest(expected, sig)', // 9
  '', //                                       10
  'def other():', //                           11
  '    pass', //                               12
);

test('Python: the body of a function whose signature runs over lines is inside it', () => {
  assert.equal(judged('app/webhooks.py', HOOKS, '`verify_webhook` compares in constant time', [9]).triggered, true);
  assert.equal(judged('app/webhooks.py', HOOKS, '`verify_webhook` compares in constant time', [12]).triggered, false);
  assert.deepEqual(drift('app/webhooks.py', HOOKS, '`verify_webhook` compares in constant time (app/webhooks.py:9)').drift, [], 'its evidence has not drifted');
});

// ---- names in changed lines are looked for in code, read in the line's place in the file
const HELP = L(
  'export function runHook(event) {', //   1
  '  return event;', //                    2
  '}', //                                  3
  'export const HELP = `usage:', //        4
  '  the hook calls runHook() once', //    5
  '  per event`;', //                      6
  'export function other() {', //          7
  '  return runHook(1);', //               8
  '}', //                                  9
);

test('a changed line inside a template is text: a name in it is not a use of that name', () => {
  const text = '`runHook` swallows every error';
  const inTemplate = parsePatch(L('@@ -5,1 +5,1 @@', '-  the hook calls runHook() twice', '+  the hook calls runHook() once'));
  assert.deepEqual(inTemplate.at, [-5, 5]);
  assert.equal(judged('src/help.mjs', HELP, text, null, inTemplate).triggered, false, 'added and removed lines of the template');
  const inCode = parsePatch(L('@@ -8,1 +8,1 @@', '-  return runHook(2);', '+  return runHook(1);'));
  assert.equal(judged('src/help.mjs', HELP, text, null, inCode).triggered, true, 'the same name in a line of code');
  // A change given without `at` (lines only) is read line by line, as before.
  assert.equal(judged('src/help.mjs', HELP, text, null, { lines: new Set([8]), text: ['  return runHook(1);'], hunks: [], whole: false }).triggered, true);
});

// ---- a file the reader cannot finish; a language it has no grammar for
test('a file that ends inside a template has no bounds to trust: a change to it touches every item about it, and it is listed as unseen', () => {
  const body = L('export function first() {', '  return 1;', '}', 'const text = `never closed', 'export function after() {', '  return 2;', '}');
  assert.equal(judged('lib/open.mjs', body, '`first` returns one', [6]).triggered, true);
  assert.match(unseenIn('lib/open.mjs', () => body).map((u) => u.why).join(' '), /ends inside a template/u);
  assert.deepEqual(unseenIn('lib/a.mjs', () => OUTER), []);
});

test('a language with no reader of its structure: a declaration runs to the next one indented no deeper', () => {
  const go = L('package main', '', '// Save writes the row.', 'func Save(x int) int {', '\tif x > 0 {', '\t\treturn x', '\t}', '\treturn 0', '}', '', '// Load reads the row.', 'func Load() int {', '\treturn 1', '}');
  assert.equal(judged('main.go', go, '`Save` must stay idempotent', [8]).triggered, true);
  assert.equal(judged('main.go', go, '`Save` must stay idempotent', [13]).triggered, false);
  assert.equal(judged('main.go', go, '`Save` must stay idempotent', [11]).triggered, false, 'the comment above the next declaration belongs to that one');
  assert.equal(judged('main.go', go, '`Load` reads one row', [13]).triggered, true);
  // A class holds its methods: they are indented deeper, so none of them ends it.
  const java = L('public class OrderStore {', '    public void save(Order o) {', '        db.put(o);', '    }', '', '    public Order load(String id) {', '        return db.get(id);', '    }', '}', '', 'class Other {', '}');
  assert.equal(judged('OrderStore.java', java, '`OrderStore` is the only writer of orders', [7]).triggered, true);
  assert.equal(judged('OrderStore.java', java, '`OrderStore` is the only writer of orders', [12]).triggered, false);
});

test('a plain lowercase word names a class or a type as it names a function, never a plain value', () => {
  const body = L('export type config = {', '  limit: number', '}', 'export const limits = 3', 'export function other() {', '  return 1', '}');
  assert.deepEqual(judged('lib/c.ts', body, '`config` holds the limits', [2]).about, ['`config`']);
  assert.equal(judged('lib/c.ts', body, '`config` holds the limits', [6]).triggered, false);
  assert.deepEqual(judged('lib/c.ts', body, '`limits` is three', [6]).about, [], 'a lowercase word that is only a value names nothing');
});

// ---- audit: a name in a comment or a string is not a use
test('unused code: a name that other files hold only in a comment, a string or template text is still unused', () => {
  const texts = {
    'lib/a.mjs': L('export function deadThing() {}', 'export function live() {}', 'export enum Mode { A }', 'export interface Shape { a: number }'),
    'lib/b.mjs': L("import { live } from './a.mjs';", '// deadThing was called here once', "const note = 'deadThing';", 'const page = `', '  deadThing()', '`;', 'live();'),
  };
  const out = unusedCode({ code: Object.keys(texts), users: new Map([['lib/a.mjs', 1]]), read: (p) => texts[p] ?? null });
  assert.deepEqual(out.map((u) => `${u.path}:${u.name}:${u.line}`), ['lib/a.mjs:deadThing:1', 'lib/a.mjs:Mode:3']);
});
