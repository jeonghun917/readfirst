// The scopes of a JavaScript, TypeScript or Python file, the names each one binds, and which binding each name a line
// uses means. Read from the tokens of src/code.mjs (the one reader: strings, comments and brackets are not read again
// here) in two walks over them: the first finds the scopes and their bindings, the second goes through the scopes in
// order with, for each name, the scopes that bind it (a stack per name), so a name is looked up in one step however
// deep it sits. How each language looks a name up is data (`LANGS`), not code per case:
// - Python: the function, the functions around it, the module, the builtins. A class body is seen only from inside
//   itself, not from its methods. `global` and `nonlocal` move a name's bindings to the module or the function around.
//   A name assigned anywhere in a function is that function's own throughout it, before the assignment too.
// - JavaScript and TypeScript: the block for let, const and class, the function for var and function declarations
//   (hoisted), the module, the globals.
// A name bound more than once in a scope is a binding per time: a use means the last one before it, or the first one
// when none comes before (`early`: a hoisted function, a name a function body uses and the module binds later, or a
// use before the assignment that makes it local). What the walks cannot tell is `unknown` with a reason from
// `REASONS`, never a guess. Where an import's module text points is `resolveImport`, from the resolvers importEdges
// uses (src/imports.mjs); following a re-export (`export * from`, `export { x } from`) to the file that defines the
// name is not done here.
import { codeRows, tokens, bracketMatches, countStep, needsMore, continues, OBJECT_BEFORE, isWord, isPunct, reads } from './code.mjs';
import { importResolver } from './imports.mjs';

// Why a name or a module is not known: the closed list.
export const REASONS = ['import-star', 'eval', 'with-statement', 'dynamic-import', 'computed-require', 'unresolved-module', 'undefined-name', 'locals-globals', 'string-annotation'];

const wordSet = (s) => new Set(s.split(/\s+/u).filter(Boolean));
const LANGS = {
  py: {
    keywords: wordSet(`False None True and as assert async await break class continue def del elif else except finally for
      from global if import in is lambda nonlocal not or pass raise return try while with yield`),
    builtins: wordSet(`abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex
      copyright credits delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals
      hasattr hash help hex id input int isinstance issubclass iter len license list locals map max memoryview min next
      object oct open ord pow print property quit range repr reversed round set setattr slice sorted staticmethod str sum
      super tuple type vars zip __import__ __name__ __file__ __doc__ __builtins__ __spec__ __loader__ __package__
      __debug__ __annotations__ __dict__ __class__ NotImplemented Ellipsis
      BaseException BaseExceptionGroup Exception ExceptionGroup ArithmeticError AssertionError AttributeError
      BlockingIOError BrokenPipeError BufferError ChildProcessError ConnectionAbortedError ConnectionError
      ConnectionRefusedError ConnectionResetError EOFError EnvironmentError FileExistsError FileNotFoundError
      FloatingPointError GeneratorExit IOError ImportError IndentationError IndexError InterruptedError
      IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError
      NotADirectoryError NotImplementedError OSError OverflowError PermissionError ProcessLookupError RecursionError
      ReferenceError RuntimeError StopAsyncIteration StopIteration SyntaxError SystemError SystemExit TabError
      TimeoutError TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError UnicodeTranslateError
      ValueError ZeroDivisionError Warning UserWarning DeprecationWarning PendingDeprecationWarning RuntimeWarning
      SyntaxWarning FutureWarning ImportWarning UnicodeWarning BytesWarning ResourceWarning EncodingWarning`),
    // Names in an annotation that wrap the type rather than name it: `Optional[Store]`, `Store | None`, `list[Store]`.
    wrappers: wordSet(`Optional Union List Dict Set FrozenSet Tuple Type Iterable Iterator Sequence MutableSequence Mapping
      MutableMapping Collection Callable Awaitable Coroutine Generator AsyncIterator AsyncIterable AsyncGenerator ClassVar
      Final Annotated Literal Any Self NoReturn Never TypeAlias Required NotRequired list dict set frozenset tuple type
      None int str float bool bytes object complex`),
    // Modules whose members are such wrappers: `typing.Optional`, `t.List`.
    typingModules: wordSet('typing typing_extensions t collections abc'),
  },
  js: {
    keywords: wordSet(`break case catch class const continue debugger default delete do else export extends finally for function
      if import in instanceof new return super switch this throw try typeof var void while with yield let static async
      await of get set as from implements interface package private protected public enum type declare abstract readonly
      namespace module keyof infer is satisfies true false null override accessor asserts unique global`),
    builtins: wordSet(`globalThis window self document console process require module exports __dirname __filename Buffer
      setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask structuredClone fetch
      URL URLSearchParams TextEncoder TextDecoder AbortController AbortSignal Headers Request Response FormData Blob File
      Event EventTarget CustomEvent crypto performance navigator location history localStorage sessionStorage alert
      confirm prompt requestAnimationFrame cancelAnimationFrame Math JSON Object Array String Number Boolean Symbol BigInt
      Date RegExp Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError Promise Map Set
      WeakMap WeakSet WeakRef FinalizationRegistry Proxy Reflect Intl ArrayBuffer SharedArrayBuffer DataView Int8Array
      Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array
      BigUint64Array Atomics parseInt parseFloat isNaN isFinite encodeURI encodeURIComponent decodeURI decodeURIComponent
      escape unescape NaN Infinity undefined arguments eval Function Iterator`),
    wrappers: wordSet(`Array ReadonlyArray Promise PromiseLike Partial Required Readonly Record Pick Omit Exclude Extract
      NonNullable ReturnType Parameters InstanceType Awaited Map Set ReadonlyMap ReadonlySet WeakMap WeakSet Iterable
      Iterator AsyncIterable string number boolean any unknown never void object symbol bigint null undefined true false`),
    typingModules: new Set(),
  },
};

const OPEN = '([{';
const isOpen = (t) => t?.k === 'punct' && OPEN.includes(t.v);
// The marks the first walk puts on name tokens.
const REF = 1; // a use of a name, looked up in the second walk
const BIND = 2; // where a binding is made: not a use
const KEY = 3; // a property key, a keyword argument, an export's outside name: not a name of a scope
const TREF = 4; // a name in a type annotation: a use, with `type: true`
const SKIP = 5; // a type, or a part of an import: nothing to look up
const ASSIGN = 6; // `x = …` in JavaScript: a new binding of the x the name finds, not a use
const AREF = 7; // `x += …`, `x++`: a use of x and then a new binding of it
const AUGMENTED = new Set(['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**=', '<<=', '&&=', '||=', '??=']);

// The table of a file: { scopes, bindings, references, unknown }, or null for a file src/code.mjs does not read.
// - scopes[i]: { kind: 'module'|'function'|'class'|'block'|'comprehension', name, from, to (lines), parent }
// - bindings[i]: { name, scope, line, how, import?, annotation?, type?, hidden? }. how: import, parameter, assign, def,
//   class, for, with, except, catch, destructure, global, nonlocal, var, let, const, type. import: { module, name,
//   alias, form } (form: esm, require, export-from, py-import, py-from; name: the imported name, 'default', '*' or null
//   for the module itself). annotation: { names: [{ name, member, ref }] } (ref: the reference the name is looked up
//   as), or { unknown: 'string-annotation' }. type: true for a type-only binding (`import type`, `declare`,
//   `if TYPE_CHECKING`). A global or nonlocal statement and an `export … from` are bindings with `hidden: true`:
//   listed, not looked up.
// - references[i]: { name, line, scope, member, to, type?, early? }. to: { binding } | { builtin: true } |
//   { unknown: reason }. member: the name after a `.` that follows, if any.
// - unknown[i]: { line, reason, text }: what makes a scope's names, or an import, unknowable (import *, eval, with,
//   import() or require() of something that is not one string).
export function scopes(path, body) {
  if (!reads(path)) return null;
  const rows = codeRows(path, body);
  const toks = tokens(rows);
  const lang = /\.py$/u.test(path) ? 'py' : 'js';
  const T = newTable(toks, lang);
  // A script's first line `#!/usr/bin/env node` names the program that runs it, not code.
  if (lang === 'js' && String(body).startsWith('#!')) for (let j = 0; j < toks.length && toks[j].line === 1; j++) T.marks[j] = SKIP;
  if (lang === 'py') readPython(T, rows);
  else readScript(T);
  return finishTable(T, rows.length);
}

function newTable(toks, lang) {
  const n = toks.length;
  const t = {
    toks, n, lang, data: LANGS[lang], match: bracketMatches(toks), marks: new Uint8Array(n), scopes: [], bindings: [],
    reasonsAt: [], unknown: [],
  };
  t.back = new Map();
  for (const [open, close] of t.match) t.back.set(close, open);
  t.scope = (kind, name, a, b) => { t.scopes.push({ kind, name, a, b, names: new Map(), moved: null, reason: null }); return t.scopes.length - 1; };
  // A binding of name in scope s, made at token at; extra.pos orders it among the scope's bindings when that is not
  // where it is written (a parameter is bound from its function's start).
  t.bind = (s, name, at, how, extra = {}) => {
    const { pos = at, ...rest } = extra;
    const b = { name, scope: s, line: toks[at]?.line ?? 1, how, ...rest, pos };
    t.bindings.push(b);
    if (!rest.hidden) {
      const list = t.scopes[s].names.get(name);
      if (list) list.push(t.bindings.length - 1); else t.scopes[s].names.set(name, [t.bindings.length - 1]);
    }
    return t.bindings.length - 1;
  };
  t.unknownAt = (pos, reason, text, blur = true) => {
    t.unknown.push({ line: toks[pos]?.line ?? 1, reason, text });
    if (blur) t.reasonsAt.push({ pos, reason });
  };
  return t;
}

// The names of a type annotation from token a to the one before b, marked TREF, the rest SKIP. A quoted annotation in
// Python is a string token, not read again: unknown.
function annotationOf(T, a, b) {
  const { toks, marks, data } = T;
  let quoted = false;
  for (let j = a; j < b; j++) if (toks[j].k === 'val' && toks[j].v !== '`' && !/^\d/u.test(toks[j].v)) quoted = true;
  if (quoted && T.lang === 'py') {
    for (let j = a; j < b; j++) { countStep(); marks[j] = SKIP; }
    return { unknown: 'string-annotation' };
  }
  const names = [];
  for (let j = a; j < b; j++) {
    countStep();
    const t = toks[j];
    marks[j] = SKIP;
    if (t.k !== 'word' || isPunct(toks[j - 1], '.') || data.keywords.has(t.v)) continue;
    const member = isPunct(toks[j + 1], '.') && isWord(toks[j + 2]) ? toks[j + 2].v : null;
    if (data.wrappers.has(t.v) || (member && data.typingModules.has(t.v) && data.wrappers.has(member))) continue;
    marks[j] = TREF;
    names.push({ name: t.v, member, pos: j });
  }
  return { names };
}

// The parts of the inside of a bracket, from token a to the one before b, split at its own commas: [start, end) pairs.
function partsBetween(T, a, b) {
  const out = [];
  let start = a;
  for (let j = a; j < b; j++) {
    countStep();
    if (isOpen(T.toks[j])) { const c = T.match.get(j); if (c === undefined || c >= b) break; j = c; continue; }
    if (isPunct(T.toks[j], ',')) { out.push([start, j]); start = j + 1; }
  }
  if (b > start) out.push([start, b]);
  return out;
}

// The first token from a to the one before b, at a's bracket depth, that `stop` accepts, or b.
function firstAt(T, a, b, stop) {
  for (let j = a; j < b; j++) {
    countStep();
    if (stop(T.toks[j], j)) return j;
    if (isOpen(T.toks[j])) { const c = T.match.get(j); if (c === undefined) return b; j = c; }
  }
  return b;
}

// ---------------------------------------------------------------------------------------------------------------- Python

const PY_HEADS = wordSet('def class if elif else for while with try except finally match case');

function readPython(T, rows) {
  const { toks, n, marks, match } = T;
  const indentWidth = (line) => /^[ \t]*/u.exec(rows[line - 1].code)[0].length;
  const backslashCarried = (line) => line >= 2 && /\\\s*$/u.test(rows[line - 2].code);
  const moduleScope = T.scope('module', null, 0, n);
  const blocks = []; // { scope, indent } for a def or class body, { typeOnly: true, indent } for `if TYPE_CHECKING:`
  const scopeNow = () => { for (let k = blocks.length - 1; k >= 0; k--) if (blocks[k].scope !== undefined) return blocks[k].scope; return moduleScope; };
  let typeOnlyOpen = 0; // `if TYPE_CHECKING:` blocks open around the statement
  const typeOnly = () => typeOnlyOpen > 0;
  // Where a binding of `name` made in scope s goes: the module for a global, the function around for a nonlocal.
  const movedHome = (s, name) => T.scopes[s].moved?.get(name) ?? s;
  const bindHere = (s, name, at, how, extra = {}) => T.bind(movedHome(s, name), name, at, how, typeOnly() ? { ...extra, type: true } : extra);

  // Every name of an expression is a use, except a property after `.`, a keyword argument's name and keywords; a lambda
  // and a comprehension are scopes of their own, a lambda closed where the expression it is in goes on past it.
  const walkExpr = (a, b) => {
    const opened = []; // [open, close] of the brackets around j
    const lambdas = []; // { scope, depth, after }: closed at a `,`, a closing bracket or a `for` at their depth
    for (let j = a; j < b; j++) {
      countStep();
      while (opened.length && j > opened.at(-1)[1]) opened.pop();
      while (lambdas.length) {
        const l = lambdas.at(-1);
        if (j <= l.after) break;
        const t = toks[j];
        if (opened.length < l.depth || (opened.length === l.depth && (isPunct(t, ',') || isWord(t, 'for') || isPunct(t, ')') || isPunct(t, ']') || isPunct(t, '}')))) { T.scopes[l.scope].b = j; lambdas.pop(); } else break;
      }
      const t = toks[j];
      if (isOpen(t)) { const c = match.get(j); opened.push([j, c === undefined ? n : c]); continue; }
      if (t.k !== 'word' || marks[j]) continue;
      if (isPunct(toks[j - 1], '.')) continue;
      if (t.v === 'lambda') {
        const colon = firstAt(T, j + 1, b, (x) => isPunct(x, ':'));
        const s = T.scope('function', null, j, b);
        for (const [pa, pb] of partsBetween(T, j + 1, colon)) {
          let k = pa;
          while (k < pb && (isPunct(toks[k], '*') || isPunct(toks[k], '**'))) k++;
          if (isWord(toks[k])) { marks[k] = BIND; T.bind(s, toks[k].v, k, 'parameter', { pos: j }); }
        }
        lambdas.push({ scope: s, depth: opened.length, after: colon });
        continue;
      }
      if (t.v === 'for' && opened.length) {
        const [o, c] = opened.at(-1);
        T.comprehensions ??= new Map();
        if (!T.comprehensions.has(o)) T.comprehensions.set(o, T.scope('comprehension', null, o + 1, c));
        const inAt = firstAt(T, j + 1, c, (x) => isWord(x, 'in'));
        targets(j + 1, inAt, 'for', T.comprehensions.get(o), o + 1);
        j = inAt;
        continue;
      }
      if (T.data.keywords.has(t.v)) continue;
      const inCall = opened.length && isPunct(toks[opened.at(-1)[0]], '(');
      if (inCall && isPunct(toks[j + 1], '=') && (isPunct(toks[j - 1], '(') || isPunct(toks[j - 1], ','))) { marks[j] = KEY; continue; }
      if ((t.v === 'eval' || t.v === 'exec') && isPunct(toks[j + 1], '(')) T.unknownAt(j, 'eval', t.v);
      if (['globals', 'locals', 'vars'].includes(t.v) && isPunct(toks[j + 1], '(') && isPunct(toks[j + 2], ')') && (isPunct(toks[j + 3], '[') || (isPunct(toks[j + 3], '.') && isWord(toks[j + 4], 'update')))) T.unknownAt(j, 'locals-globals', t.v);
      marks[j] = REF;
    }
    for (const l of lambdas) T.scopes[l.scope].b = b;
  };

  // The names an assignment, a `for`, a `with … as` or an `except … as` binds from token a to the one before b: a name
  // that a `.`, `[` or `(` follows is used, not bound (`a.b = 1`, `a[i] = 1`); a subscript's or a call's inside is an
  // expression.
  const targets = (a, b, how, s, pos) => {
    for (let j = a; j < b; j++) {
      countStep();
      const t = toks[j];
      if (isOpen(t)) {
        const c = match.get(j) ?? b;
        const prev = toks[j - 1];
        if ((isPunct(t, '[') || isPunct(t, '(')) && j > a && (isWord(prev) || isPunct(prev, ')') || isPunct(prev, ']'))) { walkExpr(j + 1, Math.min(c, b)); j = c; }
        continue;
      }
      if (t.k !== 'word' || marks[j] || T.data.keywords.has(t.v)) continue;
      if (isPunct(toks[j - 1], '.')) continue;
      if (isPunct(toks[j + 1], '.') || isPunct(toks[j + 1], '[') || isPunct(toks[j + 1], '(')) { marks[j] = REF; continue; }
      marks[j] = BIND;
      bindHere(s, t.v, j, how, pos === undefined ? {} : { pos });
    }
  };

  // One statement from token i (its first word at k, past `async`) to the one before e; colon: e is the `:` that ends
  // a compound statement's header.
  const pyStatement = (i, k, e, colon) => {
    const s = scopeNow();
    const t = toks[k];
    const indent = indentWidth(toks[i].line);
    if (isPunct(toks[i], '@')) { walkExpr(i + 1, e); return; }
    if (!isWord(t)) { pyAssignment(i, e, s); return; }
    if (t.v === 'import') {
      for (const [pa, pb] of partsBetween(T, k + 1, e)) {
        let j = pa;
        const dotted = [];
        while (j < pb && (isWord(toks[j]) || isPunct(toks[j], '.')) && !isWord(toks[j], 'as')) { if (isWord(toks[j])) dotted.push(toks[j].v); marks[j] = SKIP; j++; }
        const asAt = isWord(toks[j], 'as') ? j + 1 : -1;
        if (asAt > 0) marks[j] = SKIP;
        const at = asAt > 0 ? asAt : pa;
        if (!isWord(toks[at]) || !dotted.length) continue;
        marks[at] = BIND;
        bindHere(s, toks[at].v, at, 'import', { import: { module: dotted.join('.'), name: null, alias: asAt > 0 ? toks[at].v : null, form: 'py-import' } });
      }
      return;
    }
    if (t.v === 'from') {
      let j = k + 1;
      let mod = '';
      while (j < e && !isWord(toks[j], 'import')) { mod += toks[j].v; marks[j] = SKIP; j++; }
      if (j >= e) return;
      for (let q = j; q < e; q++) if (!marks[q]) marks[q] = SKIP;
      const list = isPunct(toks[j + 1], '(') ? [j + 2, match.get(j + 1) ?? e] : [j + 1, e];
      for (const [pa] of partsBetween(T, list[0], list[1])) {
        if (isPunct(toks[pa], '*')) {
          T.bind(s, '*', pa, 'import', { hidden: true, import: { module: mod, name: '*', alias: null, form: 'py-from' } });
          T.unknownAt(pa, 'import-star', mod);
          continue;
        }
        if (!isWord(toks[pa])) continue;
        const alias = isWord(toks[pa + 1], 'as') && isWord(toks[pa + 2]) ? pa + 2 : -1;
        const at = alias > 0 ? alias : pa;
        marks[at] = BIND;
        bindHere(s, toks[at].v, at, 'import', { import: { module: mod, name: toks[pa].v, alias: alias > 0 ? toks[alias].v : null, form: 'py-from' } });
      }
      return;
    }
    if (t.v === 'def' && colon) {
      const nameAt = k + 1;
      if (!isWord(toks[nameAt])) { walkExpr(k + 1, e); return; }
      marks[nameAt] = BIND;
      bindHere(s, toks[nameAt].v, nameAt, 'def');
      let p = nameAt + 1;
      if (isPunct(toks[p], '[')) { const c = match.get(p) ?? e; for (let q = p; q <= c && q < e; q++) marks[q] = SKIP; p = c + 1; }
      const fnScope = T.scope('function', toks[nameAt].v, e + 1, n);
      T.scopes[fnScope].line = toks[k].line;
      if (isPunct(toks[p], '(')) {
        const c = Math.min(match.get(p) ?? e, e);
        for (const [pa, pb] of partsBetween(T, p + 1, c)) {
          let q = pa;
          while (q < pb && (isPunct(toks[q], '*') || isPunct(toks[q], '**') || isPunct(toks[q], '/'))) q++;
          if (!isWord(toks[q])) continue;
          marks[q] = BIND;
          const eqAt = firstAt(T, q + 1, pb, (x) => isPunct(x, '='));
          const extra = { pos: e + 1 };
          if (isPunct(toks[q + 1], ':')) extra.annotation = annotationOf(T, q + 2, eqAt);
          T.bind(fnScope, toks[q].v, q, 'parameter', extra);
          if (eqAt < pb) walkExpr(eqAt + 1, pb);
        }
        if (isPunct(toks[c + 1], '-') && isPunct(toks[c + 2], '>')) { marks[c + 1] = SKIP; marks[c + 2] = SKIP; annotationOf(T, c + 3, e); }
      }
      blocks.push({ scope: fnScope, indent });
      return;
    }
    if (t.v === 'class' && colon) {
      const nameAt = k + 1;
      if (!isWord(toks[nameAt])) { walkExpr(k + 1, e); return; }
      marks[nameAt] = BIND;
      bindHere(s, toks[nameAt].v, nameAt, 'class');
      if (isPunct(toks[nameAt + 1], '(')) walkExpr(nameAt + 1, e);
      const cls = T.scope('class', toks[nameAt].v, e + 1, n);
      T.scopes[cls].isClass = true;
      T.scopes[cls].line = toks[k].line;
      blocks.push({ scope: cls, indent });
      return;
    }
    if (t.v === 'global' || t.v === 'nonlocal') {
      for (let j = k + 1; j < e; j++) {
        if (!isWord(toks[j])) continue;
        marks[j] = SKIP;
        let to = moduleScope;
        if (t.v === 'nonlocal') for (let b = blocks.length - 1; b >= 0; b--) if (blocks[b].scope !== undefined && blocks[b].scope !== s && T.scopes[blocks[b].scope].kind === 'function') { to = blocks[b].scope; break; }
        T.scopes[s].moved ??= new Map();
        T.scopes[s].moved.set(toks[j].v, to);
        // The statement holds for the whole function: bindings of the name made above it move too.
        const earlier = T.scopes[s].names.get(toks[j].v);
        if (earlier) {
          T.scopes[s].names.delete(toks[j].v);
          for (const b of earlier) { T.bindings[b].scope = to; const list = T.scopes[to].names.get(toks[j].v); if (list) list.push(b); else T.scopes[to].names.set(toks[j].v, [b]); }
        }
        T.bind(s, toks[j].v, j, t.v, { hidden: true });
      }
      return;
    }
    if (t.v === 'for' && colon) {
      const inAt = firstAt(T, k + 1, e, (x) => isWord(x, 'in'));
      targets(k + 1, inAt, 'for', s);
      walkExpr(inAt + 1, e);
      return;
    }
    if (t.v === 'with' && colon) {
      let [a, b] = [k + 1, e];
      if (isPunct(toks[a], '(') && match.get(a) === e - 1) [a, b] = [a + 1, e - 1];
      for (const [pa, pb] of partsBetween(T, a, b)) {
        const asAt = firstAt(T, pa, pb, (x) => isWord(x, 'as'));
        walkExpr(pa, asAt);
        if (asAt < pb) targets(asAt + 1, pb, 'with', s);
      }
      return;
    }
    if (t.v === 'except' && colon) {
      const asAt = firstAt(T, k + 1, e, (x) => isWord(x, 'as'));
      walkExpr(k + 1, asAt);
      if (asAt < e && isWord(toks[asAt + 1])) { marks[asAt + 1] = BIND; bindHere(s, toks[asAt + 1].v, asAt + 1, 'except'); }
      return;
    }
    if (t.v === 'if' && colon) {
      if (e - k === 2 ? isWord(toks[k + 1], 'TYPE_CHECKING') : e - k === 4 && isWord(toks[k + 1]) && isPunct(toks[k + 2], '.') && isWord(toks[k + 3], 'TYPE_CHECKING')) { blocks.push({ typeOnly: true, indent }); typeOnlyOpen++; }
      walkExpr(k + 1, e);
      return;
    }
    if (PY_HEADS.has(t.v) || T.data.keywords.has(t.v)) { walkExpr(k, e); return; }
    pyAssignment(i, e, s);
  };

  // An expression statement, or an assignment: targets before each `=` at depth 0, an annotation after a first `:`.
  const pyAssignment = (i, e, s) => {
    const eqs = [];
    let colonAt = -1;
    let augmented = -1;
    for (let j = i; j < e; j++) {
      countStep();
      if (isOpen(toks[j])) { const c = match.get(j); if (c === undefined) break; j = c; continue; }
      if (isWord(toks[j], 'lambda')) break;
      if (isPunct(toks[j], '=')) eqs.push(j);
      else if (toks[j].k === 'punct' && AUGMENTED.has(toks[j].v) && augmented < 0 && !eqs.length) augmented = j;
      else if (isPunct(toks[j], ':') && colonAt < 0 && !eqs.length) colonAt = j;
    }
    if (augmented >= 0) {
      const name = augmented - 1;
      if (name === i && isWord(toks[name]) && !T.data.keywords.has(toks[name].v)) { marks[name] = AREF; bindHere(s, toks[name].v, name, 'assign'); } else walkExpr(i, augmented);
      walkExpr(augmented + 1, e);
      return;
    }
    if (colonAt >= 0) {
      const end = eqs.length ? eqs[0] : e;
      const annotation = annotationOf(T, colonAt + 1, end);
      if (colonAt === i + 1 && isWord(toks[i])) { marks[i] = BIND; bindHere(s, toks[i].v, i, 'assign', { annotation, pos: e }); } else walkExpr(i, colonAt);
      if (eqs.length) walkExpr(eqs[0] + 1, e);
      return;
    }
    if (!eqs.length) { walkExpr(i, e); return; }
    let start = i;
    // A binding an assignment makes holds from the statement's end: its value still sees the one before (`x = x + 1`).
    for (const q of eqs) { targets(start, q, 'assign', s, e); start = q + 1; }
    walkExpr(start, e);
  };

  // The statements, each from its start to the start of the next: a new line at bracket depth 0 that does not carry on
  // from a backslash, a `;`, or the end of a compound statement's header (its `:` at depth 0).
  let i = 0;
  while (i < n) {
    countStep();
    const head = isWord(toks[i], 'async') ? i + 1 : i;
    const compound = isWord(toks[head]) && PY_HEADS.has(toks[head].v);
    let e = i;
    let colon = false;
    for (let j = i; j < n; j++) {
      countStep();
      if (j > i && toks[j].first && !backslashCarried(toks[j].line)) { e = j; break; }
      if (isPunct(toks[j], ';')) { e = j; break; }
      if (compound && isPunct(toks[j], ':')) { e = j; colon = true; break; }
      if (isOpen(toks[j])) { const c = match.get(j); if (c === undefined) { e = n; break; } j = c; }
      e = j + 1;
    }
    if (toks[i].first) {
      const ind = indentWidth(toks[i].line);
      while (blocks.length && blocks.at(-1).indent >= ind) { const b = blocks.pop(); if (b.scope !== undefined) T.scopes[b.scope].b = i; if (b.typeOnly) typeOnlyOpen--; }
    }
    pyStatement(i, head, e, colon);
    i = e < n && (isPunct(toks[e], ';') || colon) ? e + 1 : Math.max(e, i + 1);
  }
  for (const b of blocks) if (b.scope !== undefined) T.scopes[b.scope].b = n;
}

// ---------------------------------------------------------------------------------------------- JavaScript, TypeScript

const BLOCK_AFTER = wordSet('else try finally do');
const MEMBER_WORDS = wordSet('public private protected static readonly abstract override declare async get set accessor');
const PARAM_WORDS = wordSet('public private protected readonly override');
const stringOf = (t) => (t.text ?? '').replace(/^['"`]|['"`]$/gu, '');

function readScript(T) {
  const { toks, n, marks, match, back } = T;
  const moduleScope = T.scope('module', null, 0, n);
  const roles = new Map(); // opening token → 'body' (a function's body), 'class', 'pattern', 'skip'
  const ctx = [{ open: -1, close: n, role: 'block' }]; // the brackets around: block, object, class, paren, brack, pattern, body
  // The scopes around: end, or null for an arrow's expression body; fn, the function (or module) a `var` in it binds in.
  const stack = [{ s: moduleScope, end: n, fn: moduleScope }];
  const enterScope = (entry) => { entry.fn = T.scopes[entry.s].kind === 'function' ? entry.s : stack.at(-1).fn; stack.push(entry); };
  const starts = new Map(); // token → scopes that open there
  const scopeStartAt = (pos, s) => { const l = starts.get(pos); if (l) l.push(s); else starts.set(pos, [s]); };
  const varScope = () => stack.at(-1).fn;
  const blockScope = () => stack.at(-1).s;
  const endsStatement = (j) => j > 0 && toks[j].first && !needsMore(toks[j - 1]) && !continues(toks[j]);
  let declared = -1; // `declare` seen at this token: the statement's bindings are types
  let typed = null; // the parameters of `(a: T): R => …`: the last `)` a `:` followed
  const arefs = new Set(); // names a `++` or `--` before them updates
  const caseColons = new Set();

  // A destructuring pattern (or a plain name) from token a to the one before b: the names marked BIND and bound, keys
  // KEY, defaults left to be read as uses; a type after `:` at a parameter's top is its annotation.
  const bindPattern = (a, b, s, how, extra = {}) => {
    const work = [[a, b, 'top']];
    const made = [];
    while (work.length) {
      const [x, y, kind] = work.pop();
      countStep();
      let j = x;
      if (isPunct(toks[j], '...')) j++;
      if (isPunct(toks[j], '{') || isPunct(toks[j], '[')) {
        const c = Math.min(match.get(j) ?? y, y);
        roles.set(j, 'pattern');
        const object = isPunct(toks[j], '{');
        for (const [pa, pb] of partsBetween(T, j + 1, c)) {
          if (object && !isPunct(toks[pa], '...')) {
            const colon = firstAt(T, pa, pb, (t) => isPunct(t, ':'));
            if (colon < pb) { if (isWord(toks[pa])) marks[pa] = KEY; work.push([colon + 1, pb, 'inner']); continue; }
          }
          work.push([pa, pb, 'inner']);
        }
        continue;
      }
      if (!isWord(toks[j])) continue;
      marks[j] = BIND;
      let k = j + 1;
      if (isPunct(toks[k], '?') || isPunct(toks[k], '!')) k++;
      const own = {};
      if (kind === 'top' && isPunct(toks[k], ':')) own.annotation = annotationOf(T, k + 1, firstAt(T, k + 1, y, (t) => isPunct(t, '=')));
      made.push(T.bind(s, toks[j].v, j, how, { ...extra, ...own }));
    }
    return made;
  };

  const params = (open, close, s) => {
    for (const [pa, pb] of partsBetween(T, open + 1, close)) {
      let q = pa;
      while (q < pb && isWord(toks[q]) && PARAM_WORDS.has(toks[q].v) && (isWord(toks[q + 1]) || isPunct(toks[q + 1], '{') || isPunct(toks[q + 1], '['))) { marks[q] = SKIP; q++; }
      if (isWord(toks[q], 'this')) { const end = firstAt(T, q, pb, (t) => isPunct(t, '=')); for (let r = q; r < end; r++) marks[r] = SKIP; continue; }
      const eq = firstAt(T, q, pb, (t) => isPunct(t, '='));
      bindPattern(q, eq, s, 'parameter', { pos: open });
      // The type of a destructured parameter (`{ k }: Opts`) is a type, not a use of a value.
      const c = isOpen(toks[q]) ? match.get(q) : undefined;
      if (c !== undefined && isPunct(toks[c + 1], ':')) annotationOf(T, c + 2, eq);
    }
  };

  // A type from token j: SKIP to its end (a `,`, `;`, `=`, `?`, a closing bracket or a statement's end at its depth, or
  // a `{` that opens a body). An object type and brackets inside are passed whole.
  const skipType = (j, b = n) => {
    let atom = false;
    for (; j < b; j++) {
      countStep();
      const t = toks[j];
      if (atom && endsStatement(j)) break;
      if (t.k === 'punct') {
        if ([',', ';', ')', ']', '}', '=', '?', '&&', '||'].includes(t.v)) break;
        if (t.v === '{' && atom) break;
        if (isOpen(t)) { const c = match.get(j) ?? n; for (let q = j; q <= c && q < n; q++) marks[q] = SKIP; j = c; atom = true; continue; }
        marks[j] = SKIP;
        atom = t.v === '>';
        continue;
      }
      if (atom && t.k === 'word' && !['extends', 'keyof', 'typeof', 'is', 'infer'].includes(t.v)) break;
      marks[j] = SKIP;
      atom = t.k !== 'word' || !['keyof', 'typeof', 'readonly', 'infer', 'extends', 'is', 'unique', 'asserts', 'new'].includes(t.v);
    }
    return j;
  };
  const skipAngles = (p) => { let d = 0; for (; p < n; p++) { countStep(); marks[p] = SKIP; if (isPunct(toks[p], '<')) d++; else if (isPunct(toks[p], '>') && --d === 0) return p + 1; } return p; };

  // A function from its parameters (or type parameters) at token p: the scope from the `(` to its body's end, the
  // parameters bound in it. The index of its body's `{`, or -1 (no body: an overload or an abstract method).
  const callableAt = (p, name) => {
    if (isPunct(toks[p], '<')) p = skipAngles(p);
    if (!isPunct(toks[p], '(')) return -1;
    const c = match.get(p);
    if (c === undefined) return -1;
    let q = c + 1;
    if (isPunct(toks[q], ':')) { marks[q] = SKIP; q = skipType(q + 1); }
    if (!isPunct(toks[q], '{')) { for (let r = p; r < q; r++) if (!marks[r] || marks[r] === REF) marks[r] = SKIP; return -1; }
    const end = (match.get(q) ?? n - 1) + 1;
    const s = T.scope('function', name, p, end);
    scopeStartAt(p, s);
    roles.set(q, 'body');
    params(p, c, s);
    return q;
  };

  const importDecl = (j) => {
    let k = j + 1;
    const typeAll = isWord(toks[k], 'type') && !isPunct(toks[k + 1], ',') && !isWord(toks[k + 1], 'from');
    if (typeAll) k++;
    const pending = [];
    if (isWord(toks[k]) && !isWord(toks[k], 'from')) { pending.push({ at: k, name: 'default' }); k++; if (isPunct(toks[k], ',')) k++; }
    if (isPunct(toks[k], '*') && isWord(toks[k + 1], 'as') && isWord(toks[k + 2])) { pending.push({ at: k + 2, name: '*' }); k += 3; }
    if (isPunct(toks[k], '{')) {
      const c = match.get(k) ?? n;
      for (const [pa] of partsBetween(T, k + 1, c)) {
        let q = pa;
        const type = isWord(toks[q], 'type') && isWord(toks[q + 1]);
        if (type) q++;
        if (!isWord(toks[q]) && toks[q]?.k !== 'val') continue;
        const at = isWord(toks[q + 1], 'as') ? q + 2 : q;
        pending.push({ at, name: toks[q].k === 'val' ? stringOf(toks[q]) : toks[q].v, type });
      }
      k = c + 1;
    }
    const fromAt = isWord(toks[k], 'from') ? k + 1 : k;
    const mod = toks[fromAt]?.k === 'val' ? stringOf(toks[fromAt]) : null;
    const end = mod === null ? k : fromAt + 1;
    for (let q = j; q < end && q < n; q++) marks[q] = SKIP;
    if (mod === null) return end;
    for (const p of pending) {
      if (!isWord(toks[p.at])) continue;
      marks[p.at] = BIND;
      const alias = p.name === toks[p.at].v ? null : toks[p.at].v;
      T.bind(moduleScope, toks[p.at].v, p.at, 'import', { import: { module: mod, name: p.name, alias, form: 'esm' }, ...(typeAll || p.type ? { type: true } : {}) });
    }
    return end;
  };

  const exportDecl = (j) => {
    let k = j + 1;
    const type = isWord(toks[k], 'type') && (isPunct(toks[k + 1], '{') || isPunct(toks[k + 1], '*'));
    if (type) { marks[k] = SKIP; k++; }
    const typeFlag = type ? { type: true } : {};
    if (isPunct(toks[k], '*') || isPunct(toks[k], '{')) {
      const star = isPunct(toks[k], '*');
      const named = star && isWord(toks[k + 1], 'as') && isWord(toks[k + 2]);
      const c = star ? (named ? k + 2 : k) : (match.get(k) ?? n);
      const fromAt = isWord(toks[c + 1], 'from') ? c + 2 : -1;
      if (fromAt > 0 && toks[fromAt]?.k === 'val') {
        const mod = stringOf(toks[fromAt]);
        for (let q = j; q <= fromAt; q++) marks[q] = SKIP;
        if (star) T.bind(moduleScope, named ? toks[k + 2].v : '*', named ? k + 2 : k, 'import', { hidden: true, import: { module: mod, name: '*', alias: named ? toks[k + 2].v : null, form: 'export-from' }, ...typeFlag });
        else for (const [pa] of partsBetween(T, k + 1, c)) {
          if (!isWord(toks[pa])) continue;
          const alias = isWord(toks[pa + 1], 'as') && isWord(toks[pa + 2]) ? toks[pa + 2].v : null;
          T.bind(moduleScope, alias ?? toks[pa].v, pa, 'import', { hidden: true, import: { module: mod, name: toks[pa].v, alias, form: 'export-from' }, ...typeFlag });
        }
        return fromAt + 1;
      }
      if (!star) {
        marks[j] = SKIP; marks[k] = SKIP;
        for (const [pa] of partsBetween(T, k + 1, c)) {
          if (isWord(toks[pa])) marks[pa] = type ? SKIP : REF;
          if (isWord(toks[pa + 1], 'as')) { marks[pa + 1] = SKIP; if (toks[pa + 2]) marks[pa + 2] = KEY; }
        }
        return c + 1;
      }
    }
    marks[j] = SKIP;
    if (isWord(toks[k], 'default')) { marks[k] = SKIP; return k + 1; }
    return k;
  };

  // `require('m')` or `require('m').x` from token a to the one before b: { module, member }, or null.
  const requireOf = (a, b) => {
    if (!isWord(toks[a], 'require') || !isPunct(toks[a + 1], '(') || toks[a + 2]?.k !== 'val' || !isPunct(toks[a + 3], ')')) return null;
    if (b === a + 4) return { module: stringOf(toks[a + 2]), member: null };
    if (b === a + 6 && isPunct(toks[a + 4], '.') && isWord(toks[a + 5])) return { module: stringOf(toks[a + 2]), member: toks[a + 5].v };
    return null;
  };
  // The key a name of an object pattern from token a to the one before b is taken by (`{ a: b }` gives a for b), or
  // the name itself (`{ a }`), or null for a name that is not in an object pattern.
  const keyOf = (name, a, b) => {
    if (!isPunct(toks[a], '{')) return null;
    for (const [pa, pb] of partsBetween(T, a + 1, b - 1)) {
      const colon = firstAt(T, pa, pb, (t) => isPunct(t, ':'));
      if (isWord(toks[colon < pb ? colon + 1 : pa], name)) return isWord(toks[pa]) ? toks[pa].v : null;
    }
    return null;
  };

  const declaration = (j) => {
    const kind = toks[j].v;
    const s = kind === 'var' ? varScope() : blockScope();
    const type = declared >= 0 ? { type: true } : {};
    let k = j + 1;
    for (;;) {
      countStep();
      if (k >= n) break;
      const declaratorStop = (t, q) => isPunct(t, ',') || isPunct(t, ';') || isPunct(t, '=') || isPunct(t, ':') || isPunct(t, '!') || isWord(t, 'of') || isWord(t, 'in') || (q > k && endsStatement(q)) || isPunct(t, ')');
      const plain = isWord(toks[k]);
      const targetEnd = plain ? firstAt(T, k, n, declaratorStop) : (match.get(k) ?? n - 1) + 1;
      const made = bindPattern(k, targetEnd, s, plain ? kind : 'destructure', type);
      let q = isPunct(toks[targetEnd], '!') ? targetEnd + 1 : targetEnd;
      if (isPunct(toks[q], ':')) {
        const end = skipType(q + 1);
        if (plain && made.length) T.bindings[made[0]].annotation = annotationOf(T, q + 1, end);
        marks[q] = SKIP;
        q = end;
      }
      if (isPunct(toks[q], '=')) {
        const init = q + 1;
        const end = firstAt(T, init, n, (t, r) => isPunct(t, ',') || isPunct(t, ';') || isPunct(t, ')') || (r > init && endsStatement(r)));
        const req = requireOf(init, end);
        if (req !== null) {
          for (const b of made) {
            const bd = T.bindings[b];
            const name = req.member ?? keyOf(bd.name, k, targetEnd);
            bd.import = { module: req.module, name, alias: name !== null && name !== bd.name ? bd.name : null, form: 'require' };
          }
        }
        q = end;
      }
      k = q;
      if (!isPunct(toks[k], ',')) break;
      k++;
    }
  };

  for (let j = 0; j < n; j++) {
    countStep();
    while (stack.length > 1) {
      const top = stack.at(-1);
      if (top.end !== null) { if (j >= top.end) { stack.pop(); continue; } break; }
      const t = toks[j];
      if (j > top.after && (ctx.length < top.depth || (ctx.length === top.depth && (isPunct(t, ',') || isPunct(t, ';') || endsStatement(j))))) { T.scopes[top.s].b = j; stack.pop(); continue; }
      break;
    }
    for (const s of starts.get(j) ?? []) enterScope({ s, end: T.scopes[s].b });
    if (declared >= 0 && j > declared && (isPunct(toks[j], ';') || endsStatement(j))) declared = -1;
    const t = toks[j];
    const prev = toks[j - 1];
    const role = ctx.at(-1).role;
    if (t.k === 'punct') {
      if (isOpen(t)) {
        const c = match.get(j) ?? n;
        let r = roles.get(j);
        if (!r) {
          // A pattern's own brackets were given their role by bindPattern; one with no role inside a pattern is in a
          // default value (`{ a = { k: v } }`), an expression like any other.
          if (t.v === '(') r = 'paren';
          else if (t.v === '[') r = 'brack';
          else if (role === 'class' || !prev || isPunct(prev, ')')) r = 'block';
          else if (isWord(prev) && BLOCK_AFTER.has(prev.v)) r = 'block';
          else if (endsStatement(j) || isPunct(prev, ';') || isPunct(prev, '}') || (isPunct(prev, '{') && role !== 'object')) r = 'block';
          else if (isPunct(prev, ':') && caseColons.has(j - 1)) r = 'block';
          else if (OBJECT_BEFORE.has(prev.v)) r = 'object';
          else r = 'block';
          if (r === 'block') { const s = T.scope('block', null, j, c + 1); enterScope({ s, end: c + 1 }); }
        }
        if (r === 'class') {
          const s = T.scope('class', T.classNames?.get(j) ?? null, j, c + 1);
          T.scopes[s].isClass = true;
          (T.classAt ??= new Map()).set(j, s);
          enterScope({ s, end: c + 1 });
        }
        if (r === 'skip') { for (let q = j; q <= c && q < n; q++) if (!marks[q]) marks[q] = SKIP; j = c; continue; }
        ctx.push({ open: j, close: c, role: r });
        continue;
      }
      if (')]}'.includes(t.v)) {
        if (ctx.length > 1 && ctx.at(-1).close === j) ctx.pop();
        if (t.v === ')' && isPunct(toks[j + 1], ':') && role !== 'object') {
          // A `:` after a `)` starts a return type only when a `=>` follows the type at this depth.
          // A `?` or `:` ends the look as well: the next branch of a ternary, so `c ? (a) : c ? (b) : …` is not read to
          // its end for each `)` (a conditional type as an arrow's return type is not seen as one).
          const arrow = firstAt(T, j + 2, n, (x, q) => isPunct(x, '=>') || isPunct(x, ',') || isPunct(x, ';') || isPunct(x, ')') || isPunct(x, ']') || isPunct(x, '}') || isPunct(x, '=') || isPunct(x, '?') || isPunct(x, ':') || endsStatement(q));
          typed = isPunct(toks[arrow], '=>') ? { open: back.get(j), close: j, depth: ctx.length, arrow } : null;
        }
        continue;
      }
      if (t.v === '=>') {
        let a = -1;
        let open = -1;
        let close = -1;
        // `(a: T): R => …`: the parameters a `:` and a return type follow, before a name that would be one parameter.
        if (typed && typed.arrow === j) { open = typed.open; close = typed.close; a = open; for (let q = close + 1; q < j; q++) marks[q] = SKIP; }
        else if (isWord(prev) && !T.data.keywords.has(prev.v)) a = j - 1;
        else if (isPunct(prev, ')')) { open = back.get(j - 1) ?? -1; close = j - 1; a = open; }
        typed = null;
        if (a < 0) continue;
        if (isWord(toks[a - 1], 'async')) a--;
        const bodyOpen = isPunct(toks[j + 1], '{') ? j + 1 : -1;
        const end = bodyOpen >= 0 ? (match.get(bodyOpen) ?? n - 1) + 1 : null;
        const s = T.scope('function', null, a, end ?? n);
        if (open >= 0) params(open, close, s);
        else { marks[j - 1] = BIND; T.bind(s, prev.v, j - 1, 'parameter'); }
        if (bodyOpen >= 0) { roles.set(bodyOpen, 'body'); enterScope({ s, end }); } else enterScope({ s, end: null, depth: ctx.length, after: j });
        continue;
      }
      const assignable = isWord(prev) && marks[j - 1] === REF && !isPunct(toks[j - 2], '.') && !isPunct(toks[j - 2], '?.');
      // An assignment's new binding holds from the end of its value, which still sees the one before (`z = z + 1`).
      const valueEnd = () => firstAt(T, j + 1, n, (x, q) => isPunct(x, ',') || isPunct(x, ';') || isPunct(x, ')') || isPunct(x, ']') || isPunct(x, '}') || (q > j + 1 && endsStatement(q)));
      if (t.v === '=' && assignable && (role === 'block' || role === 'body' || role === 'paren')) { marks[j - 1] = ASSIGN; (T.assignEnds ??= new Map()).set(j - 1, valueEnd()); continue; }
      if ((AUGMENTED.has(t.v) || t.v === '++' || t.v === '--') && assignable) { marks[j - 1] = AREF; if (AUGMENTED.has(t.v)) (T.assignEnds ??= new Map()).set(j - 1, valueEnd()); continue; }
      if ((t.v === '++' || t.v === '--') && isWord(toks[j + 1]) && !isPunct(toks[j + 2], '.')) arefs.add(j + 1);
      continue;
    }
    if (t.k !== 'word' || marks[j]) continue;
    if (isPunct(prev, '.') || isPunct(prev, '?.')) continue;
    // An object literal's member: a key, a method, or a name written for itself (`{ a }`).
    if (role === 'object' && (isPunct(prev, '{') || isPunct(prev, ','))) {
      let k = j;
      while (isWord(toks[k]) && ['get', 'set', 'async'].includes(toks[k].v) && (isWord(toks[k + 1]) || isPunct(toks[k + 1], '[') || isPunct(toks[k + 1], '*'))) { marks[k] = SKIP; k++; }
      if (isPunct(toks[k], '*')) k++;
      if (isWord(toks[k]) && isPunct(toks[k + 1], ':')) { marks[k] = KEY; continue; }
      if (isWord(toks[k]) && (isPunct(toks[k + 1], '(') || isPunct(toks[k + 1], '<'))) { marks[k] = KEY; callableAt(k + 1, toks[k].v); continue; }
      if (k !== j) continue;
    }
    // A class member: modifiers, its name, then a method or a field.
    if (role === 'class' && (isPunct(prev, '{') || isPunct(prev, ';') || isPunct(prev, '}') || endsStatement(j))) {
      let k = j;
      while (isWord(toks[k]) && MEMBER_WORDS.has(toks[k].v) && (isWord(toks[k + 1]) || isPunct(toks[k + 1], '[') || isPunct(toks[k + 1], '*') || isPunct(toks[k + 1], '{'))) { marks[k] = SKIP; k++; }
      if (isPunct(toks[k], '*')) k++;
      if (isWord(toks[k])) {
        marks[k] = KEY;
        let q = k + 1;
        if (isPunct(toks[q], '?') || isPunct(toks[q], '!')) q++;
        if (isPunct(toks[q], '(') || isPunct(toks[q], '<')) callableAt(q, toks[k].v);
        else if (isPunct(toks[q], ':')) { marks[q] = SKIP; skipType(q + 1); }
      }
      continue;
    }
    const v = t.v;
    if (v === 'import' && !isPunct(toks[j + 1], '(') && !isPunct(toks[j + 1], '.')) { j = importDecl(j) - 1; continue; }
    if (v === 'import' && isPunct(toks[j + 1], '(')) {
      if (!(toks[j + 2]?.k === 'val' && isPunct(toks[j + 3], ')'))) T.unknownAt(j, 'dynamic-import', 'import()', false);
      continue;
    }
    if (v === 'export') { j = exportDecl(j) - 1; continue; }
    if (v === 'declare') {
      marks[j] = SKIP;
      declared = j;
      if (isWord(toks[j + 1], 'module') || isWord(toks[j + 1], 'namespace') || isWord(toks[j + 1], 'global')) {
        const o = firstAt(T, j + 1, n, (x) => isPunct(x, '{') || isPunct(x, ';'));
        if (isPunct(toks[o], '{')) roles.set(o, 'skip');
      }
      continue;
    }
    if ((v === 'var' || v === 'let' || v === 'const') && (isWord(toks[j + 1]) || isPunct(toks[j + 1], '{') || isPunct(toks[j + 1], '['))) {
      if (!isWord(toks[j + 1], 'enum')) declaration(j);
      continue;
    }
    if (v === 'function') {
      let k = j + 1;
      if (isPunct(toks[k], '*')) k++;
      const named = isWord(toks[k]);
      const expression = Boolean(prev) && (OBJECT_BEFORE.has(prev.v) || isPunct(prev, '=>')) && !isWord(prev, 'export') && !isWord(prev, 'default');
      const body = callableAt(named ? k + 1 : k, named ? toks[k].v : null);
      if (named) {
        marks[k] = BIND;
        if (expression && body >= 0) T.bind(T.scopes.length - 1, toks[k].v, k, 'def');
        else T.bind(varScope(), toks[k].v, k, 'def', declared >= 0 || body < 0 ? { type: true } : {});
      }
      continue;
    }
    if (v === 'class') {
      const k = j + 1;
      const named = isWord(toks[k]) && !['extends', 'implements'].includes(toks[k].v);
      const expression = Boolean(prev) && OBJECT_BEFORE.has(prev.v) && !isWord(prev, 'export') && !isWord(prev, 'default');
      if (named) marks[k] = BIND;
      let q = named ? k + 1 : k;
      if (isPunct(toks[q], '<')) q = skipAngles(q);
      const bodyOpen = firstAt(T, q, n, (x) => isPunct(x, '{') || isWord(x, 'implements'));
      if (isWord(toks[bodyOpen], 'implements')) skipType(bodyOpen + 1);
      const open = isPunct(toks[bodyOpen], '{') ? bodyOpen : firstAt(T, bodyOpen, n, (x) => isPunct(x, '{'));
      if (open < n) { roles.set(open, 'class'); T.classNames ??= new Map(); if (named) T.classNames.set(open, toks[k].v); }
      if (named) {
        if (expression && open < n) (T.classExpressions ??= []).push({ at: open, name: toks[k].v, pos: k });
        else T.bind(blockScope(), toks[k].v, k, 'class', declared >= 0 ? { type: true } : {});
      }
      continue;
    }
    if (v === 'catch' && isPunct(toks[j + 1], '(')) {
      const c = match.get(j + 1) ?? n;
      const bodyOpen = isPunct(toks[c + 1], '{') ? c + 1 : -1;
      const end = bodyOpen >= 0 ? (match.get(bodyOpen) ?? n - 1) + 1 : c + 1;
      const s = T.scope('block', null, j + 1, end);
      scopeStartAt(j + 1, s);
      if (bodyOpen >= 0) roles.set(bodyOpen, 'body');
      const colon = firstAt(T, j + 2, c, (x) => isPunct(x, ':'));
      bindPattern(j + 2, colon, s, 'catch');
      if (colon < c) skipType(colon + 1, c);
      continue;
    }
    if (v === 'for' && (isPunct(toks[j + 1], '(') || (isWord(toks[j + 1], 'await') && isPunct(toks[j + 2], '(')))) {
      const open = isPunct(toks[j + 1], '(') ? j + 1 : j + 2;
      const c = match.get(open) ?? n;
      let end;
      if (isPunct(toks[c + 1], '{')) { end = (match.get(c + 1) ?? n - 1) + 1; roles.set(c + 1, 'body'); } else {
        end = firstAt(T, c + 1, n, (x, q) => isPunct(x, ';') || (q > c + 1 && endsStatement(q)));
        if (isPunct(toks[end], ';')) end++;
      }
      scopeStartAt(open, T.scope('block', null, open, end));
      continue;
    }
    if (v === 'with' && isPunct(toks[j + 1], '(')) {
      const c = match.get(j + 1) ?? n;
      T.unknownAt(Math.min(isPunct(toks[c + 1], '{') ? c + 2 : c + 1, n - 1), 'with-statement', 'with');
      continue;
    }
    if (v === 'type' && isWord(toks[j + 1]) && (isPunct(toks[j + 2], '=') || isPunct(toks[j + 2], '<'))) {
      marks[j] = SKIP; marks[j + 1] = BIND;
      T.bind(blockScope(), toks[j + 1].v, j + 1, 'type', { type: true });
      let q = j + 2;
      if (isPunct(toks[q], '<')) q = skipAngles(q);
      if (isPunct(toks[q], '=')) { marks[q] = SKIP; j = skipType(q + 1) - 1; }
      continue;
    }
    if ((v === 'interface' || v === 'enum') && isWord(toks[j + 1])) {
      marks[j] = SKIP; marks[j + 1] = BIND;
      T.bind(blockScope(), toks[j + 1].v, j + 1, v === 'interface' ? 'type' : 'const', v === 'interface' || declared >= 0 ? { type: true } : {});
      const o = firstAt(T, j + 2, n, (x) => isPunct(x, '{'));
      const c = match.get(o) ?? n - 1;
      for (let q = j + 2; q <= c && q < n; q++) marks[q] = SKIP;
      j = c;
      continue;
    }
    if ((v === 'as' || v === 'satisfies') && prev && !isPunct(prev, '{') && !isPunct(prev, ',')) { marks[j] = SKIP; j = skipType(j + 1) - 1; continue; }
    // The `:` that ends a `case` or `default` label: a `{` after it opens a block, not an object.
    if (v === 'case' || (v === 'default' && isPunct(toks[j + 1], ':'))) caseColons.add(firstAt(T, j + 1, n, (x) => isPunct(x, ':')));
    if (T.data.keywords.has(v)) { if (v !== 'this' && v !== 'super') marks[j] = SKIP; continue; }
    // A label: a name and a `:` that start a statement.
    if (isPunct(toks[j + 1], ':') && (role === 'block' || role === 'body') && (endsStatement(j) || isPunct(prev, ';') || isPunct(prev, '{') || isPunct(prev, '}'))) { marks[j] = SKIP; continue; }
    if (v === 'eval' && isPunct(toks[j + 1], '(')) T.unknownAt(j, 'eval', 'eval');
    if (v === 'Function' && isWord(prev, 'new') && isPunct(toks[j + 1], '(')) T.unknownAt(j, 'eval', 'new Function');
    if (v === 'require' && isPunct(toks[j + 1], '(') && !(toks[j + 2]?.k === 'val' && isPunct(toks[j + 3], ')'))) T.unknownAt(j, 'computed-require', 'require()', false);
    marks[j] = arefs.has(j) ? AREF : REF;
  }
  for (const top of stack) if (top.end === null) T.scopes[top.s].b = n;
  // A class expression's name is bound inside the class only.
  for (const c of T.classExpressions ?? []) {
    const s = T.classAt?.get(c.at);
    if (s !== undefined) T.bind(s, c.name, c.pos, 'class');
  }
}

// --------------------------------------------------------------------------------------------------- the second walk

function finishTable(T, lineCount) {
  const { toks, n, marks, scopes, bindings, data } = T;
  for (const s of scopes) for (const list of s.names.values()) list.sort((x, y) => bindings[x].pos - bindings[y].pos);
  const order = scopes.map((_, i) => i).sort((x, y) => scopes[x].a - scopes[y].a || scopes[y].b - scopes[x].b || x - y);
  const parent = new Array(scopes.length).fill(null);
  // The scopes in order, each entered at its first token and left at its end: visit(p, s) for each token p, with s the
  // innermost scope around it.
  const sweepScopes = (enter, leave, visit) => {
    const open = [];
    let k = 0;
    for (let p = 0; p <= n; p++) {
      countStep();
      while (open.length > 1 && scopes[open.at(-1)].b <= p) leave(open.pop());
      while (k < order.length && scopes[order[k]].a <= p) {
        const s = order[k++];
        while (open.length > 1 && scopes[open.at(-1)].b <= scopes[s].a) leave(open.pop());
        enter(s, open.at(-1) ?? null);
        open.push(s);
      }
      if (p < n) visit(p, open.at(-1));
    }
    while (open.length) leave(open.pop());
  };
  // First: each scope's parent, and the reasons that make a scope's unbound names unknowable.
  const reasons = [...T.reasonsAt].sort((x, y) => x.pos - y.pos);
  let r = 0;
  sweepScopes((s, p) => { parent[s] = p; }, () => {}, (p, s) => {
    while (r < reasons.length && reasons[r].pos <= p) { scopes[s].reason ??= reasons[r].reason; r++; }
  });
  // Then the uses, in order, each looked up in the scopes around it: a stack per name of the scopes that bind it.
  const all = new Map();
  const noClass = new Map();
  const pushScope = (m, name, s) => { const l = m.get(name); if (l) l.push(s); else m.set(name, [s]); };
  const blur = new Array(scopes.length).fill(null);
  const references = [];
  const refAt = new Map();
  // The binding of a scope's list a use at token p means: the last one before it (at it too, unless strict), or the
  // first one (early). The uses come in order and a scope's list is only asked while the scope is open, so a cursor
  // kept on the list only moves forward.
  const pickBinding = (list, p, strict) => {
    let k = list.cursor ?? -1;
    while (k + 1 < list.length && (strict ? bindings[list[k + 1]].pos < p : bindings[list[k + 1]].pos <= p)) { countStep(); k++; }
    list.cursor = k;
    return k >= 0 ? { binding: list[k], early: false, at: k } : { binding: list[0], early: true, at: -1 };
  };
  sweepScopes((s, p) => {
    blur[s] = scopes[s].reason ?? (p === null ? null : blur[p]);
    for (const name of scopes[s].names.keys()) { pushScope(all, name, s); if (!scopes[s].isClass) pushScope(noClass, name, s); }
  }, (s) => {
    for (const name of scopes[s].names.keys()) { all.get(name).pop(); if (!scopes[s].isClass) noClass.get(name).pop(); }
  }, (p, s) => {
    const mark = marks[p];
    if (mark !== REF && mark !== TREF && mark !== ASSIGN && mark !== AREF) return;
    const name = toks[p].v;
    const homeScope = T.lang === 'py'
      ? (scopes[s].isClass && scopes[s].names.has(name) ? s : noClass.get(name)?.at(-1) ?? null)
      : all.get(name)?.at(-1) ?? null;
    let to;
    let early = false;
    if (homeScope !== null) {
      const list = scopes[homeScope].names.get(name);
      const got = pickBinding(list, p, mark === AREF);
      to = { binding: got.binding };
      early = got.early;
      if (T.lang === 'js' && (mark === ASSIGN || mark === AREF)) {
        const pos = T.assignEnds?.get(p) ?? p;
        bindings.push({ name, scope: homeScope, line: toks[p].line, how: 'assign', pos });
        let at = got.at + 1;
        while (at < list.length && bindings[list[at]].pos <= pos) { countStep(); at++; }
        list.splice(at, 0, bindings.length - 1);
      }
    } else if (data.builtins.has(name)) to = { builtin: true };
    else to = { unknown: blur[s] ?? 'undefined-name' };
    if (mark === ASSIGN && homeScope !== null) return;
    const ref = { name, line: toks[p].line, scope: s, member: (isPunct(toks[p + 1], '.') || isPunct(toks[p + 1], '?.')) && isWord(toks[p + 2]) ? toks[p + 2].v : null, to };
    if (mark === TREF) ref.type = true;
    if (early) ref.early = true;
    refAt.set(p, references.length);
    references.push(ref);
  });
  const lastLine = toks.length ? toks.at(-1).line : 1;
  return {
    scopes: scopes.map((s, i) => ({
      // A def or class scope starts at its header's line, though its names are looked up from its body.
      kind: s.kind, name: s.name, from: i === 0 ? 1 : s.line ?? toks[s.a]?.line ?? lastLine, to: i === 0 ? lineCount : toks[Math.max(s.a, s.b - 1)]?.line ?? lastLine, parent: parent[i],
    })),
    bindings: bindings.map((b) => {
      const out = { name: b.name, scope: b.scope, line: b.line, how: b.how };
      if (b.import) out.import = b.import;
      if (b.annotation) out.annotation = b.annotation.unknown ? { unknown: b.annotation.unknown } : { names: b.annotation.names.map((x) => ({ name: x.name, member: x.member, ref: refAt.get(x.pos) ?? null })) };
      if (b.type) out.type = true;
      if (b.hidden) out.hidden = true;
      return out;
    }),
    references,
    unknown: T.unknown,
  };
}

// --------------------------------------------------------------------------------------------------- across files

const RESOLVERS = new WeakMap();
// Where an import binding's module text points: { file } (a tracked file; for Python `from a import b`, the submodule
// a/b first), { outside: name } (a package that is not the repository's: its top-level name), or
// { unknown: 'unresolved-module', text }. repo: { files, read }, the repository's tracked files and a function that
// gives a file's text, asked only for package.json and tsconfig/jsconfig files. Nothing here reads the disk.
export function resolveImport(from, imp, repo) {
  let r = RESOLVERS.get(repo);
  if (!r) { r = importResolver(repo.files, repo.read); RESOLVERS.set(repo, r); }
  const text = imp.module;
  if (imp.form === 'py-import' || imp.form === 'py-from') {
    const dots = /^\.*/u.exec(text)[0].length;
    const dotted = text.slice(dots);
    if (imp.form === 'py-from' && imp.name && imp.name !== '*') {
      const sub = r.py(from, dots, dotted ? `${dotted}.${imp.name}` : imp.name);
      if (sub) return { file: sub };
    }
    const file = r.py(from, dots, dotted);
    if (file) return { file };
    if (dots || r.pyTop(dotted.split('.')[0])) return { unknown: 'unresolved-module', text };
    return { outside: dotted.split('.')[0] };
  }
  if (/^[a-z]+:/u.test(text)) return { outside: text };
  const file = r.js(from, text);
  if (file) return { file };
  // A relative path, a subpath import, or the repository's own alias (`@/x`, `~/x`) that no tracked file matches.
  if (/^(?:\.|\/|#|[@~]\/)/u.test(text)) return { unknown: 'unresolved-module', text };
  // The package's name: `@scope/name` for a scoped one, else the first part.
  return { outside: /^@[^/]+\/[^/]+|^[^/]+/u.exec(text)[0] };
}
