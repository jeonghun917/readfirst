// find and the find gate on the one reader (src/code.mjs). What `definitions` listed while it matched a pattern
// against each line: text shaped like a declaration inside a template, a comment or a docstring; values built by a
// chain of calls, as functions; and nothing a file's header comment says. What the gate took for new code while it
// read an edit's strings as if they were files: a function that only moved, a word in a string, and not a method
// whose class the fragment did not hold.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newCode } from '../src/cli.mjs';
import { definitions, find } from '../src/find.mjs';

const L = (...a) => a.join('\n');
const names = (path, body) => definitions(path, body).map((d) => `${d.name}:${d.line}:${d.kind}`).join(' ');

test('text shaped like a declaration is not a definition: a template, a block comment, a Python docstring', () => {
  const page = L('export const PAGE = `<script>', 'function drawCity() {', '  const tooltip = (e) => e;', '}', 'class Layout {}', '</script>`;', '/*', 'function retired() {}', '*/', 'export function viewHtml() {', '  return PAGE;', '}');
  assert.equal(names('src/view.mjs', page), 'viewHtml:10:function');
  const py = L('def real():', '    """Usage:', '', '    def example():', '        class Sample:', '    """', '    # def commented():', '    return 1');
  assert.equal(names('app/a.py', py), 'real:1:function');
});

test('a value is not a function: a chain of calls, a call made on the spot, an awaited call; one call around a function is', () => {
  const body = L(
    'const scars = commits.filter((c) => c.fix).map((c) => c.hash);',
    'const weight = scars.reduce((n, c) => n + c.length, 0) * half;',
    'const top = (() => {', '  return 1;', '})();',
    'const rows = await load(() => 1);',
    'const slugify = memoize((s) => s);',
    'const onSave = useCallback(async () => {});',
    'export const parseArgs = (argv) => argv;',
    'export const LIMIT = 3;',
  );
  assert.equal(names('src/history.mjs', body), 'slugify:7:function onSave:8:function parseArgs:9:function');
});

test('lines that only look like a declaration: a word starting with function, a type in an import list, a call with a callback', () => {
  const body = L('import {', '  type ViewRegion,', '  other,', "} from './x'", 'const opts = {', '  functionName: 1,', '}', 'registerRoute(function onDone(err) {', '  return err', '})', 'describe("x", () => {', '})', 'export type Region = { id: string }', 'export enum Mode { A }');
  assert.equal(names('src/a.ts', body), 'Region:13:type Mode:14:type', 'a function named inside a call that does not start its line is the call\'s argument');
});

test('methods are read whatever their header looks like: parameters over lines, a decorator on a parameter, generics', () => {
  const body = L('export class UserController {', '  async updateUser(', '    @GqlUser() user: AuthUser,', '    @Args("input") input: UpdateInput,', '  ): Promise<User> {', '    return user;', '  }', '  findMany<T extends { id: string }>(where: T): T[] {', '    return [];', '  }', '  #secret() {}', '  ok() {}', '}');
  assert.equal(names('src/user.controller.ts', body), 'UserController:1:type updateUser:2:function findMany:8:function');
});

test('CommonJS: what a module puts on exports is a definition, a function or not, and so is a function in the object it exports', () => {
  const body = L(
    'exports.formatMoney = function (n) {', '  return n;', '};',
    "exports.parser = require('./parser');",
    'module.exports.chargeCard = (c) => c;',
    'module.exports = {', '  parseDiff: function (text) {', '    return text;', '  },', '  limit: 3,', '  refund(order) {},', '};',
  );
  assert.equal(names('lib/pay.js', body), 'formatMoney:1:function parser:4:function chargeCard:5:function parseDiff:7:function refund:11:function');
  const wrapped = L('define(function (require, exports, module) {', '  const local = 1;', '  var Mode = function () {};', '  exports.Mode = Mode;', '});');
  assert.equal(names('lib/mode.js', wrapped), 'Mode:3:function Mode:4:function', 'a module written inside a wrapper function exports from there');
  const vue = L('export default defineComponent({', '  methods: {', '    saveOrder: async function () {},', '  },', '});');
  assert.equal(names('src/Order.js', vue), 'saveOrder:3:function');
});

test('a property set to a function in any other object is not a definition: an options object, a member of a named value', () => {
  const body = L(
    'const code = main(argv, { out: (text) => { printed += text; }, err: () => {} });',
    'judge(list, { changes, read: (path) => files[path] ?? null });',
    'const handlers = {', '  onClick: () => {},', '  retryPayment() {},', '};',
  );
  assert.equal(names('test/a.test.mjs', body), 'retryPayment:5:function', 'a method written out with a body is still read; a property set to an arrow is not');
});

test('the comment of a definition is the comment above it, decorators left out, and the file header says what its module is for', () => {
  const body = L(
    '// Where the long string and comment blocks are in a run of source lines.',
    '// One pass, carrying the state from line to line.',
    '',
    "import { x } from './x.mjs';",
    '',
    'export function blockLines(lines) {', '  return lines;', '}',
    '',
    '// Counts the brackets of one line.',
    'export function depthChange(line) {', '  return 0;', '}',
  );
  const defs = definitions('src/lex.mjs', body);
  assert.deepEqual(defs.map((d) => [d.name, d.doc]), [['blockLines', ''], ['depthChange', 'Counts the brackets of one line.']]);
  assert.match(defs.header, /^Where the long string and comment blocks are/u);
  // A header that is the first declaration's own comment is that declaration's, not the file's.
  assert.equal(definitions('src/one.mjs', L('// Reads one file.', 'export function readOne() {}', 'export function other() {}')).header, '');
  const py = L('@app.route("/")', '# Shows the index page.', 'def index():', '    """Renders the list of orders."""', '    return 1');
  assert.equal(definitions('app/views.py', py)[0].doc, 'Shows the index page. Renders the list of orders.');
});

test('find reaches a module through the comment its file opens with, once for the file and not for each function in it', () => {
  const files = {
    'src/lex.mjs': L('// Where the long string and comment blocks are in a run of source lines: strings, templates and comments', '// carried across lines.', '', 'export function blockLines(lines) {', '  return lines;', '}'),
    'src/shapes.mjs': L('// Counts brackets.', 'export function depthChange(line) {', '  return 0;', '}', '// Skips strings on one line.', 'export function skipStrings(line) {', '  return line;', '}'),
  };
  const r = find({ query: 'strings templates comments across lines', files: Object.keys(files), read: (p) => files[p] ?? null });
  assert.deepEqual(r.code.map((h) => h.name ?? h.file), ['src/lex.mjs', 'skipStrings']);
  assert.deepEqual(r.code[0].inComment, ['string', 'template', 'comment', 'across', 'line'].filter((w) => r.words.includes(w)), 'said as found in its comment');
  // "where" asks, it does not describe: it is not a word to match (it met `where` clauses and "nowhere" in comments).
  assert.deepEqual(find({ query: 'where the strings are', files: Object.keys(files), read: (p) => files[p] ?? null }).words, ['string']);
});

// ---- the find gate: the names an edit adds, read from the whole file before and after
const gate = (before, tool, input) => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-newcode-'));
  try {
    const file = join(dir, 'a.ts');
    if (before !== null) writeFileSync(file, before);
    return newCode(tool, input, file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const FILE = L('export class Store {', '  load(id: string) {', '    return id;', '  }', '}', 'export const HELP = `usage:', '  run it', '`;', 'export function alpha() {', '  return 1;', '}');

test('the gate: a function that an edit only moves or re-indents is not new', () => {
  const moved = { old_string: L('export function alpha() {', '  return 1;', '}'), new_string: L('if (ready) {', '  function alpha() {', '    return 1;', '  }', '}') };
  assert.deepEqual(gate(FILE, 'Edit', moved), []);
  assert.deepEqual(gate(FILE, 'Edit', { old_string: '  return 1;', new_string: '  return 2;' }), []);
});

test('the gate: a line shaped like a declaration added inside a template is text', () => {
  assert.deepEqual(gate(FILE, 'Edit', { old_string: '  run it', new_string: L('  run it', 'function example() {', '}') }), []);
});

test('the gate: a method added inside a class is new, though the edit holds neither the class nor a whole statement', () => {
  const add = { old_string: L('    return id;', '  }'), new_string: L('    return id;', '  }', '  saveOrder(', '    order: Order,', '  ): void {', '  }') };
  assert.deepEqual(gate(FILE, 'Edit', add), ['saveOrder']);
  assert.deepEqual(gate(FILE, 'MultiEdit', { edits: [add, { old_string: 'export function alpha() {', new_string: L('export function betaHelper() {}', 'export function alpha() {') }] }), ['saveOrder', 'betaHelper']);
});

test('the gate: a Write is compared with the file as it was, and a new file is all new', () => {
  assert.deepEqual(gate(FILE, 'Write', { content: `${FILE}\nexport function gamma() {}\n` }), ['gamma']);
  assert.deepEqual(gate(null, 'Write', { content: 'export function first() {}\n' }), ['first']);
  assert.deepEqual(gate(FILE, 'Edit', { old_string: 'not in the file', new_string: 'function ghost() {}' }), [], 'an edit that cannot apply adds nothing');
  assert.deepEqual(gate(FILE, 'Edit', { old_string: '', new_string: 'function ghost() {}' }), [], 'nor does one with nothing to replace');
});
