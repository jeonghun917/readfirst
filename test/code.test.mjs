// The one reader of code (src/code.mjs): where code is, where declarations start and end, the comment and decorators
// above each, what is around each, and which declaration a line belongs to. Every expected bound in this file is what
// a parser gives for the snippet (the TypeScript compiler's and Python's ast, run outside this package, which has no
// dependencies): name:first line-last line, in the order they start. A new misread becomes a snippet here, with the
// parser's answer, before any rule in the reader changes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { closeOf, declarations, lex, scopeOf, scriptBlocks, tokens } from '../src/code.mjs';

const L = (...a) => a.join('\n');
const bounds = (path, body, opts) => declarations(path, body, opts).map((d) => `${d.name}:${d.line}-${d.end}`).join(' ');

// ---- Where a declaration ends: the shapes that were each repaired once by a rule for one line.
const ENDS = [
  ['an inner helper ends at its own brace, the function around it at its own', 'a.mjs', ['function main() {', '  const save = () => {', '    go();', '  };', '  save();', '  more();', '}', 'function next() {}'], 'main:1-7 save:2-4 next:8-8'],
  ['a constant set to a template over lines ends at its backtick', 'a.mjs', ['const SQL = `', '  create table t (', '    id int', '  )', '`;', '', 'export function ensureTable() {', '  run(SQL);', '}'], 'SQL:1-5 ensureTable:7-9'],
  ['a call cut over lines with no semicolon', 'a.mjs', ['const x = make(', '  1,', '  2', ')', 'function f() {', '  return 1', '}'], 'x:1-4 f:5-7'],
  ['a placeholder and a brace inside a template do not end the constant', 'a.mjs', ['export const RUBRIC = `line', 'write to ${OUT} now', 'more { text', 'tail`;', 'export function after() {', '  return 1;', '}'], 'RUBRIC:1-4 after:5-7'],
  ['a template holding a line shaped like a declaration', 'a.mjs', ['export const RUBRIC = `', 'function example() {', '  ${OUT}', '}', 'tail', '`;', 'export function after() {', '  return 1;', '}'], 'RUBRIC:1-6 after:7-9'],
  ['a block comment holding a line shaped like a declaration', 'a.mjs', ['/*', 'function old() {', '}', '*/', 'function real() {', '  return 1;', '}'], 'real:5-7'],
  ['a brace in a string and in a regular expression', 'a.mjs', ['function f(s) {', "  if (s === '}') return /[{}]/.test(s);", '  return "{";', '}', 'const y = 1;'], 'f:1-4 y:5-5'],
  ['an object as a default parameter and as a return type', 'a.ts', ['export function f(a: { x: number } = {}): { y: number } {', '  return { y: a.x };', '}', 'const z = 2'], 'f:1-3 z:4-4'],
  ['chained calls over lines', 'a.mjs', ['const rows = list', '  .filter((x) => x.ok)', '  .map((x) => x.id)', 'function g() {}'], 'rows:1-3 g:4-4'],
  ['Python: a signature over lines, a docstring line at column 0, a comment and a blank line in the body', 'a.py', ['def verify_webhook(', '    body: bytes,', '    sig: str,', ') -> dict[str, Any]:', '    """Doc', 'with a line at column 0', '    """', '    x = 1', '', '    # c', '    return hmac.compare_digest(a, b)', '', 'def other():', '    pass'], 'verify_webhook:1-11 other:13-14'],
  ['Python: constants over lines, a body on the header line, a continuation at column 0', 'a.py', ['SETTINGS = {', '    "a": 1,', '}', 'SQL = """', 'select 1', '"""', 'def fff(): return 1', 'class Abc:', '    def mmm(self):', '        return (1,', '2)', '    X = 1'], 'SETTINGS:1-3 SQL:4-6 fff:7-7 Abc:8-12 mmm:9-11'],
  ['Python: text in a docstring and in a comment is not a declaration', 'a.py', ['def real():', '    """', '    def inside_doc():', '    class AlsoText:', '    """', '    # def in_comment():', '    return 1'], 'real:1-7'],
  ['a statement with no semicolon ends at the bracket that closes the block around it', 'a.js', ['function f() {', '  const g = () => 1', '}', 'const z = 1'], 'f:1-3 g:2-2 z:4-4'],
  ['a labelled block is a block: the `if` in it is a statement, not a member', 'a.js', ['function f(x) {', '  outer: {', '    if (x) {', '      break outer', '    }', '  }', '}'], 'f:1-7'],
];
for (const [name, path, lines, want] of ENDS) test(`ends: ${name}`, () => assert.equal(bounds(path, lines.join('\n')), want));

// ---- Statements without semicolons, TypeScript's angle brackets, and lines that only look like a declaration.
const SHAPES = [
  ['asi: identifier, then a line starting with (', 'a.js', ['const a = b', '(c || d).run()', 'const z = 1'], 'a:1-2 z:3-3'],
  ['asi: identifier, then a line starting with [', 'a.js', ['const a = b', '[1, 2].forEach(run)', 'const z = 1'], 'a:1-2 z:3-3'],
  ['asi: identifier, then a line starting with a template', 'a.js', ['const a = tag', '`text`', 'const z = 1'], 'a:1-2 z:3-3'],
  ['asi: guarded with ; on the next line', 'a.js', ['const a = b', ';(c || d).run()', ';[1, 2].forEach(run)', 'const z = 1'], 'a:1-1 z:4-4'],
  ['asi: return alone on its line', 'a.js', ['function fn() {', '  const inner = () => {', '    return', '    1 + 1', '  }', '  return', '  inner()', '}', 'const z = 1'], 'fn:1-8 inner:2-5 z:9-9'],
  ['asi: next line starts with ++ or --', 'a.js', ['let a = b', '++c', 'let d = e', '--c'], 'a:1-1 d:3-3'],
  ['asi: next line starts with a regular expression', 'a.js', ['const a = b', '/x/.test(a) && run()', 'const z = 1'], 'a:1-2 z:3-3'],
  ['asi: chained calls with comments between', 'a.js', ['const rows = list', '  // keep the good ones', '  .filter((x) => x.ok)', '  /* then their ids */', '  .map((x) => x.id)', 'const z = 1'], 'rows:1-5 z:6-6'],
  ['asi: operator at the line end, and at the next line start', 'a.js', ['const a = b +', '  c', 'const d = e', '  + f', '  || g', 'const z = 1'], 'a:1-2 d:3-5 z:6-6'],
  ['asi: ternary over lines', 'a.js', ['const a = b', '  ? c', '  : d', 'const z = 1'], 'a:1-3 z:4-4'],
  ['asi: } then ) on later lines', 'a.js', ['const a = run(() => {', '  go()', '}', ')', 'const b = wrap(function () {', '}', ', 1)', 'const z = 1'], 'a:1-4 b:5-7 z:8-8'],
  ['asi: object, then a line starting with (', 'a.js', ['const a = {', '  b: 1', '}', '(function () {})()', 'const z = 1'], 'a:1-4 z:5-5'],
  ['asi: arrow with an expression body on the next line', 'a.js', ['const f = (a) =>', '  a + 1', 'const g = async (a) =>', '  await a', 'const z = 1'], 'f:1-2 g:3-4 z:5-5'],
  ['asi: decorators', 'a.ts', ['const a = 1', '@Injectable()', 'export class Svc {', '  @Input() name = 1', '  @HostListener("x")', '  onX() {', '    return 1', '  }', '}', 'const z = 1'], 'a:1-1 Svc:3-9 onX:6-8 z:10-10'],
  ['asi: JSX in parentheses', 'a.tsx', ['const el = (', '  <div className="a">', '    it\'s {count} of {total}', '  </div>', ')', 'const z = 1'], 'el:1-5 z:6-6'],
  ['asi: JSX by ternary', 'a.tsx', ['const el = ok', '  ? <A value={1} />', '  : <B />', 'const z = 1'], 'el:1-3 z:4-4'],
  ['asi: `as` at a line end', 'a.ts', ['const a = b as', '  Listener | null', 'const z = 1'], 'a:1-2 z:3-3'],
  ['asi: `satisfies` starting a line does not continue (no line break is allowed before it)', 'a.ts', ['const c = {', '  d: 1,', '}', '  satisfies Shape', 'const z = 1'], 'c:1-3 z:5-5'],
  ['asi: class fields without semicolons', 'a.ts', ['class Abc {', '  count = 1', '  items = []', '  static make = () => new Abc()', '  run() {', '    return 1', '  }', '}', 'const z = 1'], 'Abc:1-8 run:5-7 z:9-9'],
  ['asi: overloads without bodies', 'a.ts', ['export function ref<T>(value: T): Ref<T>', 'export function ref<T = any>(): Ref<T | undefined>', 'export function ref(value?: unknown) {', '  return make(value)', '}', 'const z = 1'], 'ref:1-1 ref:2-2 ref:3-5 z:6-6'],
  ['asi: Allman braces', 'a.js', ['function foo()', '{', '  return 1', '}', 'class Bar', '{', '}', 'const z = 1'], 'foo:1-4 Bar:5-7 z:8-8'],
  ['template: a placeholder left open at a line end', 'a.js', ['const url = `${', '  base', '}/images/add.svg`', 'const z = 1'], 'url:1-3 z:4-4'],
  ['looks like a declaration: a word starting with function, a type in a list, a call with a callback', 'a.ts', ['import {', '  type Shape,', '  other,', '} from \'./x\'', 'const opts = {', '  functionName: 1,', '}', 'class Abc {', '  run() {', '    register(function onDone(err) {', '      return err', '    })', '    it("x", () => {', '    })', '  }', '}', 'const z = 1'], 'opts:5-7 Abc:8-16 run:9-15 z:17-17'],
  ['statements: a block after a case label, and reserved words where a member could be', 'a.ts', ['class Abc {', '  run(x: number) {', '    switch (x) {', '      case 1: {', '        if (x) {', '          return 1', '        }', '        break', '      }', '      default: {', '        for (const y of [x]) {', '        }', '      }', '    }', '    return 0', '  }', '  #hidden(): number {', '    return 1', '  }', '}', 'const z = 1'], 'Abc:1-20 run:2-16 #hidden:17-19 z:21-21'],
  ['generics: closing brackets that look like a shift', 'a.ts', ['export function defineProps<TypeProps>(): DefineProps<', '  LooseRequired<TypeProps>,', '  BooleanKey<TypeProps>', '>', 'export type Fetch<T> = (', '  args?: Req<T>', ') => Promise<Res<End<T>>>', 'export function defineProps() {', '  return 1', '}', 'const z = 1'], 'defineProps:1-4 Fetch:5-7 defineProps:8-10 z:11-11'],
  ['values: a function, one call around a function, and what only holds one', 'a.ts', ['function outer(list: number[]) {', '  const direct = (a: number) => {', '    return a', '  }', '  const wrapped = memo((a: number) => {', '    return a', '  })', '  const chained = list', '    .map((a) => {', '      return a', '    })', '    .filter(Boolean)', '  const awaited = await run(async () => {', '    return 1', '  })', '  const called = (() => {', '    return 1', '  })()', '  const grouped = (list ?? []).some(', '    (a) => a > 1', '  )', '  return direct(wrapped(chained[0])) + awaited + called + grouped', '}', 'const z = 1'], 'outer:1-23 direct:2-4 wrapped:5-7 z:24-24'],
  ['values: typed arrows, a function in parentheses, a generic call, a call ending in !', 'a.ts', ['function outer(list: number[]) {', '  const typed = (a: number, b: { c: 1 }[]): Promise<void> | null => {', '    return null', '  }', '  const cast = (async (a: number) => {', '    return a', '  }) as typeof fetch', '  const reduced = wrap<number | null>((w, d) => {', '    return w', '  })', '  const first = list.find((d) => {', '    return d > 1', '  })!', '  return typed(1, []) ?? cast ?? reduced ?? first', '}', 'const z = 1'], 'outer:1-15 typed:2-4 cast:5-7 reduced:8-10 first:11-13 z:16-16'],
  ['members: names that are reserved words, optional methods, an object after a type assertion', 'a.ts', ['class Repo {', '  async delete(id: string): Promise<boolean> {', '    return true', '  }', '  public stream?(): number {', '    return 1', '  }', '  catch(e: Error) {', '    return e', '  }', '}', 'export default <Module>{', '  onInit(app) {', '    return app', '  },', '}', 'const z = 1'], 'Repo:1-11 delete:2-4 stream:5-7 catch:8-10 onInit:13-15 z:17-17'],
  ['values: generic arrows, a return type with parentheses, an indexed callee, a class as a value', 'a.ts', ['function outer(list: number[][]) {', '  const keep = <T extends { for: string }>(items: T[] | undefined) =>', '    (items ?? []).filter(Boolean)', '  const call = async <T>(method: string): Promise<(A & { b: 1 })[]> => {', '    return []', '  }', '  const index = list[0].findIndex(', '    (r) => r > 1', '  )', '  const Local = class<T> extends Base<T> {', '    run() {', '      return 1', '    }', '  }', '  return keep([]) ?? call("x") ?? index ?? Local', '}', 'const table: Record<string, Fn> = <any>{', '  find(...args: unknown[]) {', '    return args', '  },', '  async listen<T>(event: string) {', '    return event', '  },', '}', 'const z = 1'], 'outer:1-16 keep:2-3 call:4-6 index:7-9 Local:10-14 run:11-13 table:17-24 find:18-20 listen:21-23 z:25-25'],
  ['members: a comma in a return type before the body; a class, then an arrow with a typed value', 'a.ts', ['export class First<T> implements Router<T> {', '  name: string = "x"', '}', 'export const build: (params: {', '  paths: string[]', '}) => Ctor<typeof First> = ({ paths }) => {', '  const Local = class<T> extends First<T> {', '    run() {', '      return 1', '    }', '  }', '  return new Local()', '}', 'export const store = {', '  async init(path: string) {', '    return path', '  },', '  async set(', '    path: string,', '  ): Promise<Either<StoreError, void>> {', '    return path', '  },', '  wrapped: vi.fn(((el) => {', '    return el', '  }) as Hook),', '}', 'const hook = vi.fn(((el) => {', '  return el', '}) as Hook)', 'const z = 1'], 'First:1-3 build:4-13 Local:7-11 run:8-10 store:14-26 init:15-17 set:18-22 hook:27-29 z:30-30'],
  ['generics: arrow with <T,>', 'a.ts', ['const idf = <T,>(x: T) => x', 'const two = <T,>(x: T): T => {', '  return x', '}', 'const z = 1'], 'idf:1-1 two:2-4 z:5-5'],
  ['generics: arrow with <T,> in .tsx', 'a.tsx', ['const idf = <T,>(x: T) => x', 'const two = <T extends object>(x: T): T => {', '  return x', '}', 'const el = <Box<string> value="a" />', 'const z = 1'], 'idf:1-1 two:2-4 el:5-5 z:6-6'],
  ['generics: call with a type argument', 'a.ts', ['const a = foo<Bar>(x)', 'const b = make<', '  One,', '  Two', '>(x, {', '  y: 1,', '})', 'const z = 1'], 'a:1-1 b:2-7 z:8-8'],
  ['generics: comparison in a header default', 'a.ts', ['function cmp(a = b < c, d = e > f) {', '  return a', '}', 'function gen<T>(a: T, big = a > 1) {', '  return big', '}', 'const z = 1'], 'cmp:1-3 gen:4-6 z:7-7'],
  ['generics: => inside a type', 'a.ts', ['function on(cb: (x: number) => void): () => void {', '  return () => cb(1)', '}', 'function mk(): () => { a: number } {', '  return () => ({ a: 1 })', '}', 'const z = 1'], 'on:1-3 mk:4-6 z:7-7'],
  ['generics: braces in the header generics', 'a.ts', ['function merge<', '  T extends { id?: string; at?: Date | null },', '>(local: T[], fetched: T[]): T[] {', '  return local', '}', 'const z = 1'], 'merge:1-5 z:6-6'],
  ['generics: return type with braces, over lines', 'a.ts', ['function gen(', '  key: string,', '):', '  | {', '      value: string', '      skip: boolean', '    }', '  | undefined {', '  return undefined', '}', 'async function who(): Promise<', '  Reply | { error: string }', '> {', '  return get()', '}', 'const z = 1'], 'gen:1-10 who:11-15 z:16-16'],
  ['generics: conditional types', 'a.ts', ['type Left<T extends Either<any, any>> =', '  T extends Either<', '    infer U,', '    infer _', '  >', '    ? U', '    : never', 'type Row<K extends Key, C = true> = Build<', '  Tables,', '  C extends Record<string, unknown> ? C : true', '>', 'function pick<T>(x: T): T extends { a: infer A } ? A : never {', '  return x as never', '}', 'const z = 1'], 'Left:1-7 Row:8-11 pick:12-14 z:15-15'],
  ['generics: class header', 'a.ts', ['export default class Store<', '  S,', '  D extends { [x: string]: Fn<S, any> },', '> {', '  run() {', '    return 1', '  }', '}', 'class Box<T extends { a: 1 }> extends Base<{ b: T }> implements Has<T> {', '}', 'const z = 1'], 'Store:1-8 run:5-7 Box:9-10 z:11-11'],
  ['generics: shift and comparison operators in a body', 'a.ts', ['function bits(a: number, b: number) {', '  if (a < b && b > 1) return a << 2', '  return a >> 1 >= b ? a : b', '}', 'const z = 1'], 'bits:1-4 z:5-5'],
  ['regex: flags that spell a keyword', 'a.ts', ['const tagRE = /<a>(.*)<\\/a>/is', 'const after = 1', 'const z = 1'], 'tagRE:1-1 after:2-2 z:3-3'],
  ['regex: an escaped ] inside a character class', 'a.js', ['function escape(string) {', '  return string.replace(/[.*+?^${}()|[\\]\\\\/]/g, \'\\\\$&\')', '}', 'const z = 1'], 'escape:1-3 z:4-4'],
];
for (const [name, path, lines, want] of SHAPES) test(`shape: ${name}`, () => assert.equal(bounds(path, lines.join('\n')), want));

// Known and not read right, each with the parser's answer: JSX text on its own line outside parentheses is not known
// to the lexer; `await` at a line's end is not among the words that need more; a method named `catch` or `with` in
// an object is taken for the statement; a callee that begins with a parenthesis is not seen as the one call it is.
// They are listed so that a change that fixes one is seen, and so that none is fixed by a rule for its one line.
const NOT_YET = [
  ['asi: JSX without parentheses over lines', 'a.tsx', ['const el = <div>', '  text', '</div>', 'const z = 1'], 'el:1-3 z:4-4'],
  ['await at a line end, its call on the next line', 'a.ts', ['import \'x\'', 'const stats =', '  await // a note', '  repository.stats()', 'const z = 1'], 'stats:2-4 z:5-5'],
  ['methods named catch and with in an object', 'a.ts', ['const api = {', '  catch(e: Error) {', '    return e', '  },', '  with(x: number) {', '    return x', '  },', '}', 'const z = 1'], 'api:1-8 catch:2-4 with:5-7 z:9-9'],
  ['a value whose callee begins with a parenthesis', 'a.ts', ['function outer(plan: Plan) {', '  const kept = (plan.ops as Op[]).filter((op) => {', '    return op.ok', '  })', '  return kept', '}', 'const z = 1'], 'outer:1-6 kept:2-4 z:7-7'],
];
for (const [name, path, lines, want] of NOT_YET) test(`not read right yet: ${name}`, { todo: 'a guess of the reader, named in its header' }, () => assert.equal(bounds(path, lines.join('\n')), want));

// ---- The comment and decorators above a declaration (top), and what is around it (parent).
const around = (path, body, opts) => declarations(path, body, opts).map((d) => `${d.name}:${d.top}/${d.parent ?? '-'}`).join(' ');

test('top and parent: several statements on one line; only the first has the comment above the line', () => {
  assert.equal(around('a.js', L('// a note', 'var a = 1; var b = function () { return 1 }; var c = 2', 'var d = 3')), 'a:1/- b:2/- c:2/- d:3/-');
});

test('parent: two local functions on one line are both inside the statement around them, not inside each other', () => {
  assert.equal(around('a.cjs', 'exports.is = (() => { const one = (x) => x; const two = (x) => { return one(x) }; return two })()'), 'is:1/- one:1/is two:1/is');
  assert.equal(around('a.js', 'const log = { info() {}, warn() {}, error() {} }'), 'log:1/- info:1/log warn:1/log error:1/log');
});

test('parent: a named function used as a value is inside the statement it is a value of', () => {
  assert.equal(around('a.js', L('const run =', '  function named() {', '    return 1', '  }', 'function next() {}')), 'run:1/- named:2/run next:5/-');
});

test('parent: what is declared in the body of a function passed as a value is inside that function', () => {
  assert.equal(around('a.js', L('register(', '  function onDone() {', '    function inner() {', '      return 1', '    }', '  }', ')')), 'onDone:2/- inner:3/onDone');
});

test('top: a decorator over several lines, a comment above it, and a comment between a decorator and its method', () => {
  const body = L('// the users module', '@Module({', '  imports: [Db],', '})', 'export class UsersModule {', '  @Get(":id")', '  // one user', '  find(@Param("id") id: string) {', '    return id', '  }', '}');
  assert.equal(around('a.ts', body), 'UsersModule:1/- find:6/UsersModule');
  assert.equal(bounds('a.ts', body), 'UsersModule:5-11 find:8-10');
});

test('top: an empty line inside a block comment is still the comment; a blank line above it ends the top', () => {
  assert.equal(around('a.js', L('// not its comment', '', '/**', ' * First part.', '', ' * Second part.', ' */', 'function documented() {}')), 'documented:3/-');
});

test('top and parent, Python: decorators and the comment above them; a method is inside its class', () => {
  const body = L('import x', '', '# the index', '@app.route("/")', '@login_required', 'def index():', '    return 1', '', 'class A:', '    @property', '    def name(self):', '        return 1');
  assert.equal(around('a.py', body), 'index:3/- A:9/- name:10/A');
});

test('members: an object property set to a function is read only when asked for, and what is inside it keeps a parent', () => {
  const body = L('export const api = {', '  save: async (row) => {', '    const check = () => {', '      return row', '    }', '    return check()', '  },', '  limit: 3,', '}');
  assert.equal(around('a.js', body, { members: true }), 'api:1/- save:2/api check:3/save');
  assert.equal(around('a.js', body), 'api:1/- check:3/api');
});

// ---- Which declaration a line belongs to.
const scope = (path, body, line) => { const s = scopeOf(declarations(path, body), line); return s ? `${s.name}:${s.top}-${s.end}` : 'none'; };

test('scopeOf: a line after a one-line local, and after an inner helper, belongs to the function around it', () => {
  const route = L("import { x } from 'y';", '', '// Deletes the account.', 'export async function DELETE(req) {', '  const owned = await accounts.soleOwnerOf(user.id);', '  const shared = owned.filter((o) => o.members > 1);', '  if (shared.length) return deny();', '  const helper = (a) => {', '    return a;', '  };', '  return ok(helper(1));', '}');
  assert.equal(scope('route.ts', route, 6), 'DELETE:3-12');
  assert.equal(scope('route.ts', route, 9), 'helper:8-10');
  assert.equal(scope('route.ts', route, 11), 'DELETE:3-12');
  assert.equal(scope('route.ts', route, 1), 'none');
});

test('scopeOf: a line in the comment above a declaration belongs to it; an import above the comment to nothing', () => {
  const sec = L("import { a } from 'node:crypto';", "import { b } from 'node:fs';", "import { c } from 'node:path';", '', '/**', ' * Encrypts webhook secrets with', ' * APP_ENCRYPTION_KEY.', ' */', 'export class SecretBox {', '  seal(x) { return x; }', '}');
  assert.equal(scope('secrets.ts', sec, 7), 'SecretBox:5-11');
  assert.equal(scope('secrets.ts', sec, 3), 'none');
});

// ---- .vue and .svelte: only the lines between <script> and </script> are code.
test('single-file components: markup and styles are not code, each <script> block is read on its own', () => {
  const vue = ['<template>', '  <button @click="function fake() {">{{ label }}</button>', '  <p>a backtick ` in text, and a brace {</p>', '</template>', '<script', '  setup', '  lang="ts">', 'const label = `', 'function notCode() {', '`', 'function onSave() {', '  return 1', '}', '</script>', '<style>', '.a { color: red }', '</style>'];
  assert.deepEqual(scriptBlocks(vue), [{ from: 7, to: 13, lang: 'ts' }]);
  assert.equal(bounds('a.vue', vue.join('\n')), 'label:8-10 onSave:11-13');
  const svelte = L('<script module>', '  export const prerender = true', '</script>', '<script>', '  let data = $props()', '  function open() {', '    return data', '  }', '</script>', '{#if data}<p>function shown() {</p>{/if}');
  assert.equal(bounds('a.svelte', svelte), 'prerender:2-2 data:5-5 open:6-8');
  assert.equal(scope('a.svelte', svelte, 10), 'none');
});

// ---- The lexer.
const codeOf = (lines, lang = 'js') => lex(lines, lang).map((r) => r.code);

test('lex: code has the length of its line, with strings, template text, comments and regular expressions as spaces', () => {
  const lines = ['const a = "x{" + `t ${name + "}"} u` // note {', "const re = /[/{]\\//g, s = 'it\\'s'", 'x = 1 /* c */ + 2'];
  const rows = lex(lines, 'js');
  for (const [i, r] of rows.entries()) { assert.equal(r.code.length, lines[i].length); assert.equal(r.mark.length, lines[i].length); }
  assert.deepEqual(rows.map((r) => r.code), ['const a = "  " + `    name + " "   `          ', "const re = /      / , s = '     '", 'x = 1         + 2']);
  assert.deepEqual(rows.map((r) => r.comment), [true, false, true]);
});

test('lex: a regular expression after return, a JSX closing tag, and a division after a non-null assertion', () => {
  // `/` after `return` opens a regular expression, so the backtick in it opens no template.
  assert.deepEqual(lex(['function f(s) { return /`/.test(s); }', 'const a = 1; /* c', '*/'], 'js').map((r) => r.startsIn || '-'), ['-', '-', 'block']);
  // `</div>` is not a regular expression to the end of the line: the brackets after it are code.
  assert.equal(bounds('a.tsx', L('const el = (', '  <div>{list.map((x) => (<b>{x}</b>))}</div>', ')', 'const z = 1')), 'el:1-3 z:4-4');
  // `a! / b` divides.
  assert.deepEqual(codeOf(['const ratio = a! / b', 'const s = 1']), ['const ratio = a! / b', 'const s = 1']);
});

test('lex: the flags belong to the regular expression, and an escaped ] does not close a character class', () => {
  assert.deepEqual(codeOf(['const tagRE = /<a>/is']), ['const tagRE = /   /  ']);
  assert.equal(bounds('a.ts', L('const tagRE = /<a>(.*)<\\/a>/is', 'const after = 1')), 'tagRE:1-1 after:2-2');
  const line = "  return string.replace(/[.*+?^${}()|[\\]\\\\/]/g, '\\\\$&')";
  assert.equal(codeOf([line])[0], "  return string.replace(/                   / , '    ')");
  assert.equal(bounds('a.js', L('function escape(string) {', line, '}', 'const z = 1')), 'escape:1-3 z:4-4');
});

test('lex, Python: triple-quoted strings over lines, a quote inside a string, a # inside a string', () => {
  const rows = lex(['SEP = "\'\'\'"', 'DOC = """', "it's # not a comment", '"""  # a comment', 'x = 1'], 'py');
  assert.deepEqual(rows.map((r) => r.startsIn || '-'), ['-', '-', 'string3', 'string3', '-']);
  assert.deepEqual(rows.map((r) => r.comment), [false, false, false, true, false]);
  assert.equal(rows[2].code.trim(), '');
});

test('lex: a quoted string whose line ends in a backslash goes on at the next line (Python and JavaScript)', () => {
  // Python's ast reads one string here and gives the class its method (clean, lines 7 to 8); V8 runs the JavaScript
  // one and gives the string as 'one   two.'.
  const py = L('class A:', '    x = f(', '        h=_("one \\', '        two.")', '    )', '', '    def clean(self):', '        return 1');
  assert.deepEqual(codeOf(py.split('\n'), 'py').slice(2, 5), ['        h=_("     ', '            ")', '    )']);
  assert.equal(lex(py.split('\n'), 'py')[3].startsIn, 'string');
  assert.equal(bounds('a.py', py, { members: true }), 'A:1-8 clean:7-8');
  const js = L('const o = {', "  h: f('one \\", "  two.'),", '};', 'function clean() {', '  return 1;', '}');
  assert.equal(bounds('a.ts', js), 'o:1-4 clean:5-7');
  assert.deepEqual(tokens(lex(js.split('\n'), 'js')).filter((t) => t.k === 'val').map((t) => [t.line, t.endLine]), [[2, 3], [6, 6]]);
  // An escaped backslash at the end carries nothing on, and a string left open without one still ends at its line.
  assert.deepEqual(codeOf(["a = 'x\\\\", 'b = 1'], 'py'), ["a = '   ", 'b = 1']);
  assert.deepEqual(codeOf(["a = 'x", "b = '1'"]), ["a = ' ", "b = ' '"]);
  assert.deepEqual(codeOf(['x = 1  # C:\\', 'y = 2'], 'py'), ['x = 1       ', 'y = 2']);
});

test('tokens and closeOf: a literal is one token whatever it holds, and a bracket closes at its own partner', () => {
  const toks = tokens(lex(['run(a, [b, { c }], ")]}", `x${y}z`)', 'next()'], 'js'));
  assert.deepEqual(toks.map((t) => t.v), ['run', '(', 'a', ',', '[', 'b', ',', '{', 'c', '}', ']', ',', "''", ',', '`', ')', 'next', '(', ')']);
  assert.equal(closeOf(toks, 1), 15);
  assert.equal(closeOf(toks, 4), 10);
  assert.deepEqual(toks.filter((t) => t.first).map((t) => t.v), ['run', 'next']);
});

// ---- This package's own code, and the lexer's state carried from line to line.
const OWN = execFileSync('git', ['ls-files', 'src', 'bin', 'test'], { encoding: 'utf8' }).split('\n').filter((f) => /\.mjs$/u.test(f));

test('lex: going on from the state after any line gives what the whole file gives', () => {
  const samples = OWN.map((f) => [f, 'js', readFileSync(f, 'utf8').split('\n')]);
  // What `/` is depends on the last token of the line before.
  samples.push(['a.js', 'js', ['const half = total', '  / 2 / parts', 'const re = cond ?', '  /x{/ : null', 'const t = `a ${', '  b + `c ${d}`', '} e`']]);
  samples.push(['a.py', 'py', ['def f(', '    a,', '):', '    """doc', 'def g():', '    """', "    s = 'x'  # c", '    return (a,', 'a)', 'X = """', 'text', '"""']]);
  for (const [file, lang, lines] of samples) {
    const whole = lex(lines, lang);
    for (let i = 1; i < lines.length; i++) assert.deepEqual(lex([lines[i]], lang, whole[i - 1].state)[0], whole[i], `${file}:${i + 1}`);
  }
});

test('own code: the lexer finishes every file, and no declaration starts in a template, a string or a comment', () => {
  for (const f of OWN) {
    const lines = readFileSync(f, 'utf8').split('\n');
    const rows = lex(lines, 'js');
    assert.deepEqual([f, rows.at(-1).state.q, rows.at(-1).state.tpl.length], [f, null, 0]);
    for (const d of declarations(f, lines.join('\n'))) {
      assert.equal(rows[d.line - 1].startsIn, '', `${f}:${d.line} ${d.name} starts inside a ${rows[d.line - 1].startsIn}`);
      assert.ok(d.top <= d.line && d.line <= d.end, `${f}:${d.line} ${d.name}`);
    }
  }
});

test('own code: a top-level function or class ends at a closing brace at column 0, and none runs into the next', () => {
  for (const f of OWN.filter((x) => !x.startsWith('test/'))) {
    const lines = readFileSync(f, 'utf8').split('\n');
    const top = declarations(f, lines.join('\n')).filter((d) => d.depth === 0);
    for (const [i, d] of top.entries()) {
      if (d.what === 'fn' || d.what === 'class') assert.match(lines[d.end - 1], d.end === d.line ? /\}\s*$/u : /^\}/u, `${f}: ${d.name} (line ${d.line}) ends at line ${d.end}`);
      if (top[i + 1]) assert.ok(d.end < top[i + 1].line, `${f}: ${d.name} (line ${d.line}) ends at ${d.end}, past ${top[i + 1].name} at ${top[i + 1].line}`);
    }
  }
});

test('own code: the page script inside a template is text, not declarations', () => {
  // src/view-city.mjs builds an HTML page whose <script> is written inside a template literal.
  const body = readFileSync('src/view-city.mjs', 'utf8');
  const rows = lex(body.split('\n'), 'js');
  const inTemplate = rows.filter((r) => r.startsIn === 'template' && /^\s*(?:function|const|let|var)\s/u.test(r.text)).length;
  assert.ok(inTemplate > 20, 'the page script is still written inside a template');
  const view = declarations('src/view-city.mjs', body).find((d) => d.name === 'viewHtmlCity');
  assert.ok(view.end - view.line > 200, `viewHtmlCity holds its whole template (lines ${view.line} to ${view.end})`);
});
