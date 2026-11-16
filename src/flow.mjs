// The common flow form of a file: each body (the module, each function, each class) lowered to a short list of steps
// that is the same for every language, so a reader of values walks one shape instead of each language's syntax. Built
// on src/scopes.mjs (`readScopes`: its tokens, its statements and which reference each name token is), so nothing here
// reads strings, comments or brackets again. It reads only what values need; anything else is `opaque` with its text,
// never a guess. Python, JavaScript and TypeScript; what the scripts add is written above scriptReader.
//
// flowSteps(path, body) → { table, bodies } (table: the scopes() table the references point into), or null for a
// file src/code.mjs does not read.
// - bodies[i]: { scope, kind, name, params?, steps }: scope 0 is the module; a def's, a lambda's, an arrow's and a
//   class's body are their own entries (a lambda's or an expression arrow's steps: the return of its expression).
//   params (a function's): [{ target, default|null, star? }] (star: '*' or '**', or '...' for a rest parameter).
// - a step has op and line:
//   assign { targets, value, aug? } (`a = b = v`: two targets; aug: '+=' and the like, value: the right-hand side),
//   call { value } and expr { value } (an expression statement: a call, or anything else),
//   return { value|null }, raise { value|null, cause? } (`raise E from c`), assert { cond }, break and continue
//   { label? } (JS `break outer`; the labelled statement's first step has the label), import { bindings },
//   global and nonlocal { names, bindings } (the table's hidden bindings of the names it moves),
//   def { scope, name, decorators } and class { scope, name, decorators } (their bodies are entries of bodies),
//   branch { cond, then, else } (`elif` is a branch inside else; a `match` is a branch per case, its conds opaque),
//   loop { kind: 'for'|'while', target?, over?, cond?, body, else }, try { body, handlers, else, finally }
//   (handlers[i]: { types: [value]|null, binding|null, body }), with { items: [{ value, target|null }], body },
//   opaque { text, body? } (a statement read no further: del, a stray else, with what it holds).
//   A JS function declaration's def has hoisted: true (bound from the start of the body around it).
// - a target: { k: 'name', name, binding } (the binding it makes, an index into table.bindings), { k: 'tuple', items }
//   (items may carry star: true), or a value (`self.x`, `a[i]`).
// - a value: { k: 'ref', name, ref } (ref: an index into table.references), { k: 'attr', of, name },
//   { k: 'index', of, key }, { k: 'call', callee, args }, { k: 'new', callee, args } (a call of a class the file binds),
//   { k: 'lit', v: 'None'|'True'|'False'|'num'|'str'|'tuple'|'list'|'dict'|'set', text?, uses?, items?, entries? }
//   (uses: the values in an f-string's braces, up to a `!r` or a format spec; items: a tuple's, a list's or a set's
//   values, a starred one with spread: '*'; entries: a dict's, [{ key, name?, value }] (name: a string key's text) or
//   { spread: '**', value }; a comprehension has text, no items), { k: 'choice', cond, then, else } (`a if c else b`), { k: 'fn', scope } (a lambda), or
//   { k: 'opaque', text }. await: true on a value that is awaited; binds: the name a walrus binds
//   (`(m := f())` is f()'s value with binds { k: 'name', … }, so `if m := f():` is truthy of it). args[i]: { value, name? (a keyword), spread? }.
// - a cond: { k: 'none', of, neg } (`x is None`, `x == None`; neg for `is not`, `!=`), { k: 'truthy', of },
//   { k: 'isinstance', of, types }, { k: 'not', of }, { k: 'and'|'or', of: [cond] }, or { k: 'opaque', text }.
// Linear in the text: a value is taken apart only once it is known to be one chain (isChain), so no part is read again
// for an outer value that turns out opaque; countStep counts the walks.
import { readScopes, partsBetween, firstAt } from './scopes.mjs';
import { countStep, isWord, isPunct, needsMore, continues } from './code.mjs';

export function flowSteps(path, body) {
  const got = readScopes(path, body);
  if (!got) return null;
  const { table, T, refAt } = got;
  const bindAt = new Map();
  const hiddenAt = new Map();
  T.bindings.forEach((b, i) => { if (b.at !== undefined) (b.hidden ? hiddenAt : bindAt).set(b.at, i); });
  if (T.lang !== 'py') return { table, bodies: scriptBodies({ T, toks: T.toks, match: T.match, refAt, bindAt, table }) };
  const lambdaAt = new Map();
  T.scopes.forEach((s, i) => { if (s.kind === 'function' && s.name === null) lambdaAt.set(s.a, i); });
  return { table, bodies: pythonBodies({ T, toks: T.toks, match: T.match, refAt, bindAt, hiddenAt, lambdaAt, table }) };
}

const AUGMENTED = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '&=', '|=', '^=', '**=', '<<=', '>>=', '@=']);
const COMPARE = new Set(['==', '!=', '<', '>', '<=', '>=']);
const PY_LITERALS = new Set(['None', 'True', 'False']);
// How deep values and conditions are taken apart: CPython's own parser refuses parentheses nested deeper than 200
// ("too many nested parentheses"). A value deeper than that is opaque with nesting: true, its text whole.
const MAX_NESTING = 200;

// The text of tokens a to b-1, spaced only between two words or values (an f-string's placeholder shows as `{…}`).
function textOf(toks, a, b) {
  let out = '';
  for (let j = a; j < b; j++) {
    countStep();
    const t = toks[j];
    if (t.synthetic) { out += t.v === '(' ? '{' : '}'; continue; }
    const prev = toks[j - 1];
    if (j > a && t.k !== 'punct' && prev && prev.k !== 'punct') out += ' ';
    else if (j > a && t.k !== 'punct' && prev?.k === 'punct' && [',', '=', '==', '!=', ':'].includes(prev.v)) out += ' ';
    out += t.text ?? t.v;
  }
  return out;
}

// The parts of a to b-1 split at depth-0 tokens `at` accepts: [[from, to], …], one part when there is none.
function splitAt(T, a, b, at) {
  const parts = [];
  let start = a;
  for (;;) {
    const j = firstAt(T, start, b, at);
    parts.push([start, j]);
    if (j >= b) return parts;
    start = j + 1;
  }
}

// Python's reader of values: the one reader with Python's table, and its own reader of assignment targets.
function pythonReader(F) {
  const E = exprReader(F, EXPR.py);
  const { T, toks } = F;
  const { value, closeOf } = E;
  // What an assignment's left side from a to b-1 binds or sets.
  const target = (a, b) => {
    if (b === a + 1 && isWord(toks[a]) && F.bindAt.has(a)) return { k: 'name', name: toks[a].v, binding: F.bindAt.get(a) };
    if (isPunct(toks[a], '*')) return { ...target(a + 1, b), star: true };
    const wrapped = (isPunct(toks[a], '(') || isPunct(toks[a], '[')) && closeOf(a) === b - 1;
    const [x, y] = wrapped ? [a + 1, b - 1] : [a, b];
    if (wrapped || firstAt(T, x, y, (u) => isPunct(u, ',')) < y) return { k: 'tuple', items: partsBetween(T, x, y).map(([pa, pb]) => target(pa, pb)) };
    return value(a, b);
  };
  E.target = target;
  return { value, cond: E.cond, target };
}

function pythonBodies(F) {
  const { T, toks, bindAt } = F;
  const R = pythonReader(F);
  const recs = T.statements ?? [];
  const indentOf = (line) => /^[ \t]*/u.exec(T.rows[line - 1].code)[0].length;
  // How deep each statement sits: its line's indent, or, after a header on the same line (`if x: return`), deeper.
  let prev = null;
  for (const r of recs) {
    countStep();
    const t = toks[r.i];
    r.depth = t.first || !prev ? indentOf(t.line) : prev.colon ? prev.depth + 0.5 : prev.depth;
    prev = r;
  }
  // The statements as a tree: a header's body is the statements after it that sit deeper.
  let j = 0;
  const block = (depth) => {
    const out = [];
    while (j < recs.length && recs[j].depth > depth) {
      countStep();
      const r = recs[j++];
      out.push({ r, body: r.colon ? block(r.depth) : [] });
    }
    return out;
  };
  const top = block(-1);

  const bodies = [{ scope: 0, kind: 'module', name: null, steps: null }];
  // The parameters from token a to b-1: { target, default, star? }, past a bare `*` or `/`.
  const params = (a, b) => {
    const out = [];
    for (const [pa, pb] of partsBetween(T, a, b)) {
      countStep();
      let q = pa;
      const star = isPunct(toks[q], '*') || isPunct(toks[q], '**') ? toks[q].v : null;
      if (star) q++;
      if (!isWord(toks[q]) || !bindAt.has(q)) continue;
      const eq = firstAt(T, q, pb, (y) => isPunct(y, '='));
      const p = { target: { k: 'name', name: toks[q].v, binding: bindAt.get(q) }, default: eq < pb ? R.value(eq + 1, pb) : null };
      if (star) p.star = star;
      out.push(p);
    }
    return out;
  };
  const head = (node) => (isWord(toks[node.r.k]) ? toks[node.r.k].v : null);
  const lineOf = (r) => toks[r.i].line;

  // An assignment or an expression statement from token i to e-1 (the targets before each depth-0 `=`).
  const assignment = (i, e, at) => {
    const eqs = [];
    let colonAt = -1;
    let aug = -1;
    for (let q = i; q < e; q++) {
      countStep();
      const t = toks[q];
      if (isPunct(t, '(') || isPunct(t, '[') || isPunct(t, '{')) { const c = F.match.get(q); if (c === undefined) break; q = c; continue; }
      if (isWord(t, 'lambda')) break;
      if (isPunct(t, '=')) eqs.push(q);
      else if (t.k === 'punct' && AUGMENTED.has(t.v) && aug < 0 && !eqs.length) aug = q;
      else if (isPunct(t, ':') && colonAt < 0 && !eqs.length) colonAt = q;
    }
    if (aug >= 0) return { op: 'assign', ...at, targets: [R.target(i, aug)], value: R.value(aug + 1, e), aug: toks[aug].v };
    if (colonAt >= 0) return { op: 'assign', ...at, targets: [R.target(i, colonAt)], value: eqs.length ? R.value(eqs[0] + 1, e) : null };
    if (!eqs.length) {
      const v = R.value(i, e);
      return { op: v.k === 'call' || v.k === 'new' ? 'call' : 'expr', ...at, value: v };
    }
    const targets = [];
    let start = i;
    for (const q of eqs) { targets.push(R.target(start, q)); start = q + 1; }
    return { op: 'assign', ...at, targets, value: R.value(start, e) };
  };

  const lower = (nodes) => {
    const steps = [];
    let decorators = [];
    for (let x = 0; x < nodes.length; x++) {
      countStep();
      const node = nodes[x];
      const { r } = node;
      const w = head(node);
      const at = { line: lineOf(r) };
      const next = (word) => nodes[x + 1] && nodes[x + 1].r.colon && head(nodes[x + 1]) === word;
      if (isPunct(toks[r.i], '@')) { decorators.push(R.value(r.i + 1, r.e)); continue; }
      if (r.colon && (w === 'def' || w === 'class') && r.opens !== null) {
        steps.push({ op: w, ...at, scope: r.opens, name: toks[r.k + 1].v, decorators });
        decorators = [];
        const s = T.scopes[r.opens];
        const entry = { scope: r.opens, kind: s.kind, name: s.name, steps: null };
        if (w === 'def') {
          let p = r.k + 2;
          if (isPunct(toks[p], '[')) p = F.match.get(p) + 1;
          entry.params = isPunct(toks[p], '(') ? params(p + 1, Math.min(F.match.get(p) ?? r.e, r.e)) : [];
        }
        bodies.push(entry);
        entry.steps = lower(node.body);
        continue;
      }
      decorators = [];
      if (r.colon && w === 'if') {
        const first = { op: 'branch', ...at, cond: R.cond(r.k + 1, r.e), then: lower(node.body), else: [] };
        let cur = first;
        while (next('elif')) {
          const n = nodes[++x];
          const b = { op: 'branch', line: lineOf(n.r), cond: R.cond(n.r.k + 1, n.r.e), then: lower(n.body), else: [] };
          cur.else = [b];
          cur = b;
        }
        if (next('else')) cur.else = lower(nodes[++x].body);
        steps.push(first);
        continue;
      }
      if (r.colon && (w === 'while' || w === 'for')) {
        const loop = { op: 'loop', ...at, kind: w };
        if (w === 'while') loop.cond = R.cond(r.k + 1, r.e);
        else {
          const inAt = firstAt(T, r.k + 1, r.e, (t) => isWord(t, 'in'));
          loop.target = R.target(r.k + 1, inAt);
          loop.over = R.value(inAt + 1, r.e);
        }
        loop.body = lower(node.body);
        loop.else = next('else') ? lower(nodes[++x].body) : [];
        steps.push(loop);
        continue;
      }
      if (r.colon && w === 'try') {
        const t = { op: 'try', ...at, body: lower(node.body), handlers: [], else: [], finally: [] };
        while (next('except')) {
          const n = nodes[++x];
          let a = n.r.k + 1;
          if (isPunct(toks[a], '*')) a++;
          const asAt = firstAt(T, a, n.r.e, (y) => isWord(y, 'as'));
          const types = a >= asAt ? null : isPunct(toks[a], '(') && F.match.get(a) === asAt - 1 ? partsBetween(T, a + 1, asAt - 1).map(([p, q]) => R.value(p, q)) : [R.value(a, asAt)];
          t.handlers.push({ types, binding: asAt < n.r.e && bindAt.has(asAt + 1) ? bindAt.get(asAt + 1) : null, body: lower(n.body) });
        }
        if (next('else')) t.else = lower(nodes[++x].body);
        if (next('finally')) t.finally = lower(nodes[++x].body);
        steps.push(t);
        continue;
      }
      if (r.colon && w === 'with') {
        let [a, b] = [r.k + 1, r.e];
        if (isPunct(toks[a], '(') && F.match.get(a) === b - 1) [a, b] = [a + 1, b - 1];
        const items = partsBetween(T, a, b).map(([pa, pb]) => {
          const asAt = firstAt(T, pa, pb, (y) => isWord(y, 'as'));
          return { value: R.value(pa, asAt), target: asAt < pb ? R.target(asAt + 1, pb) : null };
        });
        steps.push({ op: 'with', ...at, items, body: lower(node.body) });
        continue;
      }
      if (r.colon && w === 'match') {
        const subject = textOf(toks, r.k + 1, r.e);
        const cases = node.body.filter((n) => n.r.colon && head(n) === 'case');
        // From the last case up: each case is a branch whose else is the cases after it; `case _:` is that else itself.
        let chain = [];
        for (let c = cases.length - 1; c >= 0; c--) {
          countStep();
          const n = cases[c].r;
          const body = lower(cases[c].body);
          if (n.e === n.k + 2 && isWord(toks[n.k + 1], '_')) { chain = body; continue; }
          chain = [{ op: 'branch', line: lineOf(n), cond: { k: 'opaque', text: `match ${subject} case ${textOf(toks, n.k + 1, n.e)}` }, then: body, else: chain }];
        }
        steps.push(...chain);
        continue;
      }
      if (r.colon) { steps.push({ op: 'opaque', ...at, text: textOf(toks, r.i, r.e), body: lower(node.body) }); continue; }
      if (w === 'return') { steps.push({ op: w, ...at, value: r.e > r.k + 1 ? R.value(r.k + 1, r.e) : null }); continue; }
      if (w === 'raise') {
        // `raise E from cause`: the value is E, the cause apart.
        const from = firstAt(T, r.k + 1, r.e, (y) => isWord(y, 'from'));
        const step = { op: 'raise', ...at, value: from > r.k + 1 ? R.value(r.k + 1, from) : null };
        if (from < r.e) step.cause = R.value(from + 1, r.e);
        steps.push(step);
        continue;
      }
      if (w === 'assert') { steps.push({ op: 'assert', ...at, cond: R.cond(r.k + 1, firstAt(T, r.k + 1, r.e, (y) => isPunct(y, ','))) }); continue; }
      if (w === 'break' || w === 'continue') { steps.push({ op: w, ...at }); continue; }
      if (w === 'pass') continue;
      if (w === 'import' || w === 'from') {
        const bindings = [];
        for (let q = r.i; q < r.e; q++) { countStep(); if (bindAt.has(q)) bindings.push(bindAt.get(q)); }
        steps.push({ op: 'import', ...at, bindings });
        continue;
      }
      if (w === 'global' || w === 'nonlocal') {
        // The names it moves, and the table's hidden binding of each (how 'global' or 'nonlocal'): their assignments
        // in this body bind the module's or the enclosing function's name.
        const names = [];
        const bindings = [];
        for (let q = r.k + 1; q < r.e; q++) {
          countStep();
          if (!isWord(toks[q])) continue;
          names.push(toks[q].v);
          const b = F.hiddenAt.get(q);
          if (b !== undefined) bindings.push(b);
        }
        steps.push({ op: w, ...at, names, bindings });
        continue;
      }
      if (w === 'del') { steps.push({ op: 'opaque', ...at, text: textOf(toks, r.i, r.e) }); continue; }
      steps.push(assignment(r.i, r.e, at));
    }
    return steps;
  };

  bodies[0].steps = lower(top);
  // A lambda's body: the return of its expression.
  for (const [a, s] of F.lambdaAt) {
    countStep();
    const colon = firstAt(T, a + 1, T.scopes[s].b, (y) => isPunct(y, ':'));
    bodies.push({ scope: s, kind: 'function', name: null, params: params(a + 1, colon), steps: [{ op: 'return', line: toks[colon + 1]?.line ?? toks[a].line, value: R.value(colon + 1, T.scopes[s].b) }] });
  }
  return bodies;
}

// ---------------------------------------------------------------------------------------------- JavaScript, TypeScript

// What JavaScript and TypeScript add to the steps and values above:
// - steps: loop kind 'do' (its body runs before its cond) and keys: true for `for (k in o)`; a classic `for (i; c; u)`
//   is its init's steps before the loop, then the loop with cond c and u's step last in its body. A `switch` is a
//   branch per case like a `match` (conds opaque, `default` the last else, a case's own last `break` left out); a
//   case with no statements is one branch with the case after it (`case 'b': case 'c':`), and a case with statements
//   that falls through keeps only its own. A comma expression statement is its parts' steps. field { name,
//   value|null, static, decorators } in a class body. A TypeScript declaration that only names types (`type`,
//   `interface`, `declare`) gives no step; `enum` and `namespace` give an opaque step with their header.
// - targets: { k: 'object', items: [{ key, target, default? }], rest? } for `{ a, b: c = 1, ...r }`; a tuple's holes
//   are null, and an item with a default is its pattern with default on it (`[a = 1]`).
// - values: lit v 'null'|'undefined'|'true'|'false'|'regex'|'jsx' too (a template literal is 'str' with uses); an
//   object literal is a dict whose entries are { name, value } (a word, string or number key, a shorthand `{ a }`),
//   { key, value } (a computed `[k]`), { spread: '...', value }, a method or accessor as its function's value;
//   { k: 'fn', scope } for an arrow or a function expression, { k: 'class', scope } for a class expression;
//   an assignment inside an expression (`(m = re.exec(s))`) is its value with binds (an augmented one, `x ||= y`,
//   is opaque with binds and aug), as a walrus is in Python;
//   optional: true on an attr, index or call read through `?.`; a tagged template is a call with tagged: true and
//   the template as its one argument; a `void f()` statement is f()'s call step; as: the type text of `x as T` or `x satisfies T`
//   (a claim of the code, not a proof). `a ?? b`, `a || b`, `a && b` and a comma expression are opaque.
// - conds: `x === null`, `x === undefined`, `typeof x === 'undefined'` are none with exact 'null' or 'undefined'
//   (`x == null` is none with no exact: either); { k: 'typeof', of, is, neg } for `typeof x === 'string'`;
//   `x instanceof C` is isinstance; `!` is not, `&&` and `||` are and and or.
const JS_AUGMENTED = new Set(['+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
const JS_COMPARE = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=']);
const JS_LITERALS = new Set(['null', 'true', 'false']);
const TS_TYPE_ONLY = new Set(['type', 'interface', 'declare']);
const PARAM_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override']);
const MEMBER_MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'abstract', 'override', 'declare', 'accessor', 'async', 'get', 'set']);

// ------------------------------------------------------------------------------------ the one reader of values

// What a language gives the one reader of values and conditions (exprReader): its words, marks and forms. The
// engine is the same for every language: the order it tries the forms in, the walk of a chain, the split of a
// condition at its operators, the comparisons with null. A form a language does not have is off. A new language is
// a table here and a reader of its statements, not a second reader of values.
const EXPR = {
  py: {
    literals: PY_LITERALS,
    or: (u) => isWord(u, 'or'),
    and: (u) => isWord(u, 'and'),
    not: (u) => isWord(u, 'not'),
    notTight: false, // `not a == b` is not (a == b): `not` binds looser than a comparison
    comma: 'tuple', // `a, b` is a tuple
    ternary: 'words', // `a if c else b`
    fn: 'lambda',
    binds: 'walrus', // `name := value`
    nullishOp: null,
    condOpaque: (u) => isWord(u, 'if') || isWord(u, 'lambda'),
    compares: (u) => isWord(u, 'is') || isWord(u, 'in') || isWord(u, 'not') || (u.k === 'punct' && COMPARE.has(u.v)),
    // The comparisons that can test for null, and whether they say which null (Python has one: never).
    equality: { is: { neg: false, loose: true }, '==': { neg: false, loose: true }, '!=': { neg: true, loose: true } },
    isNot: true, // `is not`
    nullWords: new Set(['None']),
    undefinedWord: false,
    instanceOf: null,
    typeofWord: null,
    isinstanceCall: 'isinstance',
    argSpreads: new Set(['*', '**']),
    itemSpread: '*',
    keywordArgs: true,
    string: /^['"]/u,
    stringPrefix: /^[rRbBuUfFtT]{1,2}$/u, // `f"…"`, `rb"…"`
    concatStrings: true, // `"a" "b"` is one string
    formatSpec: true, // `{x!r}`, `{x:>10}`: the use ends at the conversion
    regex: false,
    numberDot: true, // `1.5` is three tokens
    comprehensions: true,
    braces: 'dict',
    newWord: false,
    voidWord: false,
    jsx: false,
    as: false,
    optional: false,
    nonNull: false,
    tagged: false,
  },
  js: {
    literals: JS_LITERALS,
    or: (u) => isPunct(u, '||'),
    and: (u) => isPunct(u, '&&'),
    not: (u) => isPunct(u, '!'),
    notTight: true, // `!x === y` is (!x) === y: `!` binds tighter than a comparison
    comma: 'sequence', // `a, b` is b
    ternary: 'marks', // `c ? a : b`
    fn: 'script', // arrows, function and class expressions
    binds: 'assign', // `(m = re.exec(s))`
    nullishOp: '??',
    condOpaque: (u) => isPunct(u, '?') || isPunct(u, ',') || isPunct(u, '=>'),
    compares: (u, j, refAt) => (u.k === 'punct' && JS_COMPARE.has(u.v)) || ((isWord(u, 'instanceof') || isWord(u, 'in')) && !refAt.has(j)),
    equality: { '==': { neg: false, loose: true }, '!=': { neg: true, loose: true }, '===': { neg: false, loose: false }, '!==': { neg: true, loose: false } },
    isNot: false,
    nullWords: new Set(['null']),
    undefinedWord: true, // the builtin `undefined`, not a local of that name
    instanceOf: 'instanceof',
    typeofWord: 'typeof',
    isinstanceCall: null,
    argSpreads: new Set(['...']),
    itemSpread: '...',
    keywordArgs: false,
    string: /^['"`]/u,
    stringPrefix: null,
    concatStrings: false,
    formatSpec: false,
    regex: true,
    numberDot: false,
    comprehensions: false,
    braces: 'object',
    newWord: true,
    voidWord: true,
    jsx: true, // in a file lexLang reads as JSX (not .ts)
    as: true, // `x as T`, `x satisfies T`
    optional: true, // `?.`
    nonNull: true, // `x!`
    tagged: true, // `` tag`…` ``
  },
};

// The one reader of values and conditions, for the language L. It returns { value, cond, opaque, closeOf, items };
// the caller sets target (what an assignment's left side sets, a reader of patterns of its own language), which an
// assignment inside an expression asks.
function exprReader(F, L) {
  const { T, toks, match, refAt, table } = F;
  const api = { target: null };
  const opaque = (a, b) => ({ k: 'opaque', text: textOf(toks, a, b) });
  const closeOf = (j) => match.get(j) ?? -1;
  const isString = (t) => t?.k === 'val' && L.string.test(t.text ?? '');
  const quoted = (t) => t?.k === 'val' && /^['"]/u.test(t.text ?? '');
  const isTemplate = (t) => L.tagged && t?.k === 'val' && /^`/u.test(t.text ?? '');
  const isRegex = (t) => L.regex && t?.k === 'val' && /^\//u.test(t.text ?? '');
  const isNumber = (t) => t?.k === 'val' && /^\.?\d/u.test(t.v);
  const isComma = (u) => isPunct(u, ',');
  const opens = (t) => (isPunct(t, '(') || isPunct(t, '[') || isPunct(t, '{')) && !t.synthetic;
  const jsx = L.jsx && !/\.[mc]?ts$/u.test(T.path ?? '');
  const word = (j, v) => isWord(toks[j], v) && !refAt.has(j);
  const compares = (u, j) => L.compares(u, j, refAt);
  const hasFor = (x, y) => firstAt(T, x, y, (u) => isWord(u, 'for')) < y;
  // A string's prefix (`f"…"`): a word that is no name, right before a string on its line.
  const isPrefix = (j) => Boolean(L.stringPrefix) && isWord(toks[j]) && !refAt.has(j) && L.stringPrefix.test(toks[j].v) && isString(toks[j + 1]) && toks[j + 1].line === toks[j].line;
  const builtinUndefined = (j) => L.undefinedWord && isWord(toks[j], 'undefined') && refAt.has(j) && table.references[refAt.get(j)].to.builtin;
  // The function or class scope that starts at token j, of the kind asked.
  const scopeAt = (j, kind) => F.starts?.get(j)?.find((s) => T.scopes[s].kind === kind) ?? null;
  // The scope of the arrow that starts at token a (its parameters, or `async` before them).
  const arrowAt = (a) => {
    for (const j of [a, a + 1]) { const s = scopeAt(j, 'function'); if (s !== null && T.scopes[s].arrow) return s; }
    return null;
  };

  // A string and the placeholders of its f-string or template (synthetic parentheses); where strings written side
  // by side are one (Python), the strings after it and their prefixes too.
  const stringEnd = (j, b) => {
    j++;
    for (;;) {
      countStep();
      if (j < b && toks[j].synthetic && isPunct(toks[j], '(')) { j = closeOf(j) + 1; continue; }
      if (!L.concatStrings) return j;
      if (j < b && isString(toks[j])) { j++; continue; }
      if (j + 1 < b && isPrefix(j)) { j++; continue; }
      return j;
    }
  };
  // `1`, `1e3`, and in Python `1.5` (three tokens).
  const numberEnd = (j, b) => (L.numberDot && j + 2 < b && isPunct(toks[j + 1], '.') && isNumber(toks[j + 2]) && toks[j + 2].line === toks[j].line ? j + 3 : j + 1);
  // Where the primary that starts at token a ends (the token after it), or -1 if none starts there.
  const primaryEnd = (a, b) => {
    const t = toks[a];
    if (!t || a >= b) return -1;
    if (t.k === 'word') {
      if (L.literals.has(t.v)) return a + 1;
      if (L.newWord && t.v === 'new') {
        if (isPunct(toks[a + 1], '.')) return isWord(toks[a + 2]) ? a + 3 : -1;
        let q = primaryEnd(a + 1, b);
        if (q < 0) return -1;
        while (q < b && isPunct(toks[q], '.') && isWord(toks[q + 1])) { countStep(); q += 2; }
        const angle = T.typeAngles?.get(q);
        if (angle !== undefined && angle <= b) q = angle;
        if (isPunct(toks[q], '(') && !toks[q].synthetic) { const c = closeOf(q); return c < 0 || c >= b ? -1 : c + 1; }
        return q;
      }
      if (refAt.has(a)) return a + 1;
      return isPrefix(a) ? stringEnd(a + 1, b) : -1;
    }
    if (isString(t)) return stringEnd(a, b);
    if (isRegex(t)) return a + 1;
    if (isNumber(t)) return numberEnd(a, b);
    if (isPunct(t, '-') && isNumber(toks[a + 1])) return numberEnd(a + 1, b);
    if (opens(t)) { const c = closeOf(a); return c < 0 || c >= b ? -1 : c + 1; }
    if (jsx && isPunct(t, '<')) return b;
    return -1;
  };
  // The token after a postfix at q (`.x`, `[…]`, `(…)`; where the language has them `?.x`, `?.[…]`, `?.(…)`,
  // `<T>(…)`, a non-null `!`, a tagged template), or -1.
  const postfixEnd = (q, b) => {
    let j = q;
    if (L.optional && isPunct(toks[j], '?.')) { if (isWord(toks[j + 1]) && j + 1 < b) return j + 2; j++; }
    if (isPunct(toks[j], '.') && isWord(toks[j + 1]) && j + 1 < b) return j + 2;
    if (L.nonNull && isPunct(toks[j], '!') && j === q) return j + 1;
    if (isTemplate(toks[j]) && j === q) return stringEnd(j, b);
    const angle = T.typeAngles?.get(j);
    if (angle !== undefined && angle < b && isPunct(toks[angle], '(')) j = angle;
    if ((isPunct(toks[j], '[') || isPunct(toks[j], '(')) && !toks[j].synthetic) { const c = closeOf(j); return c < 0 || c >= b ? -1 : c + 1; }
    return -1;
  };
  // Whether a to b-1 is one primary and its postfixes, read at depth 0 only.
  const isChain = (a, b) => {
    let q = primaryEnd(a, b);
    if (q < 0) return false;
    while (q < b) { countStep(); q = postfixEnd(q, b); if (q < 0) return false; }
    return true;
  };

  // The values of a tuple's, a list's or a set's parts: a hole is null, a starred or spread one carries spread.
  const items = (a, b) => partsBetween(T, a, b).map(([pa, pb]) => (pa === pb ? null : isPunct(toks[pa], L.itemSpread) ? { ...value(pa + 1, pb), spread: L.itemSpread } : value(pa, pb)));
  const args = (open, close) => partsBetween(T, open + 1, close).map(([pa, pb]) => {
    if (toks[pa].k === 'punct' && L.argSpreads.has(toks[pa].v)) return { spread: toks[pa].v, value: value(pa + 1, pb) };
    if (L.keywordArgs && isWord(toks[pa]) && isPunct(toks[pa + 1], '=') && pa + 1 < pb) return { name: toks[pa].v, value: value(pa + 2, pb) };
    return { value: value(pa, pb) };
  });
  // A call of a name the file binds as a class constructs it.
  const isClassRef = (v) => {
    if (v.k !== 'ref') return false;
    const b = table.references[v.ref]?.to?.binding;
    return b !== undefined && table.bindings[b]?.how === 'class';
  };

  // A Python dict's entries ({ key, name?, value }, name: a string key's text; or { spread: '**', value }), a set's
  // items, a comprehension's text.
  const dict = (a, e) => {
    const [x, y] = [a + 1, e - 1];
    const colon = x < y && firstAt(T, x, y, (u) => isPunct(u, ':') || isPunct(u, '**')) < y;
    if (hasFor(x, y)) return { k: 'lit', v: colon ? 'dict' : 'set', text: textOf(toks, a, e) };
    if (x < y && !colon) return { k: 'lit', v: 'set', items: items(x, y) };
    const entries = partsBetween(T, x, y).map(([pa, pb]) => {
      if (isPunct(toks[pa], '**')) return { spread: '**', value: value(pa + 1, pb) };
      const at = firstAt(T, pa, pb, (u) => isPunct(u, ':'));
      const entry = { key: value(pa, at), value: value(at + 1, pb) };
      if (at === pa + 1 && quoted(toks[pa])) entry.name = toks[pa].text.slice(1, -1);
      return entry;
    });
    return { k: 'lit', v: 'dict', entries };
  };
  // An object literal's entries: { name, value } (a word, string or number key; a shorthand `{ a }` is a's
  // reference), { key, value } (a computed `[k]: v`), { spread: '...', value }; a method or an accessor is its
  // function's value.
  const objectEntries = (a, b) => partsBetween(T, a, b).filter(([pa, pb]) => pa < pb).map(([pa, pb]) => {
    countStep();
    if (isPunct(toks[pa], '...')) return { spread: '...', value: value(pa + 1, pb) };
    const fn = methodFrom(pa, pb);
    if (fn !== null) {
      // The name is the token before the method's scope (its parameters or type parameters): `m(`, `[k](`.
      const last = T.scopes[fn].a - 1;
      if (isPunct(toks[last], ']')) return { key: value(T.back.get(last) + 1, last), value: { k: 'fn', scope: fn } };
      return { name: quoted(toks[last]) ? toks[last].text.slice(1, -1) : toks[last].v, value: { k: 'fn', scope: fn } };
    }
    const colon = firstAt(T, pa, pb, (u) => isPunct(u, ':'));
    if (colon >= pb) return { name: toks[pa].v, value: value(pa, pb) };
    if (isPunct(toks[pa], '[')) return { key: value(pa + 1, closeOf(pa)), value: value(colon + 1, pb) };
    return { name: quoted(toks[pa]) ? toks[pa].text.slice(1, -1) : toks[pa].v, value: value(colon + 1, pb) };
  });
  // The function scope a method of an object literal starts, from token a, before b, at the parts' depth.
  const methodFrom = (a, b) => {
    for (let j = a; j < b; j++) {
      countStep();
      const s = scopeAt(j, 'function');
      if (s !== null) return s;
      if (isPunct(toks[j], ':') || isPunct(toks[j], '{')) return null;
      if (opens(toks[j]) && !isPunct(toks[j], '[')) return null;
      if (isPunct(toks[j], '[')) j = closeOf(j);
    }
    return null;
  };

  const primary = (a, e) => {
    const t = toks[a];
    if (t.k === 'word') {
      if (L.literals.has(t.v)) return { k: 'lit', v: t.v };
      if (L.newWord && t.v === 'new') {
        if (isPunct(toks[a + 1], '.')) return opaque(a, e);
        let q = primaryEnd(a + 1, e);
        let callee = primary(a + 1, q);
        while (q < e && isPunct(toks[q], '.')) { callee = { k: 'attr', of: callee, name: toks[q + 1].v }; q += 2; }
        const angle = T.typeAngles?.get(q);
        if (angle !== undefined && angle <= e) q = angle;
        return { k: 'new', callee, args: q < e ? args(q, closeOf(q)) : [] };
      }
      if (builtinUndefined(a)) return { k: 'lit', v: 'undefined' };
      if (refAt.has(a)) return { k: 'ref', name: t.v, ref: refAt.get(a) };
    }
    if (isRegex(t)) return { k: 'lit', v: 'regex' };
    if (isNumber(t) || isPunct(t, '-')) return { k: 'lit', v: 'num', text: textOf(toks, a, e) };
    if (isPunct(t, '(')) {
      if (a + 1 === e - 1) return L.comma === 'tuple' ? { k: 'lit', v: 'tuple', items: [] } : opaque(a + 1, e - 1);
      if (L.comprehensions && hasFor(a + 1, e - 1)) return opaque(a, e);
      return value(a + 1, e - 1);
    }
    if (isPunct(t, '[')) {
      if (L.comprehensions && hasFor(a + 1, e - 1)) return { k: 'lit', v: 'list', text: textOf(toks, a, e) };
      return { k: 'lit', v: 'list', items: items(a + 1, e - 1) };
    }
    if (isPunct(t, '{')) return L.braces === 'dict' ? dict(a, e) : { k: 'lit', v: 'dict', entries: objectEntries(a + 1, e - 1) };
    if (jsx && isPunct(t, '<')) return { k: 'lit', v: 'jsx' };
    // A string run: what its placeholders hold are uses (up to a conversion or a format spec where the language has
    // them: `{x!r}`, `{x:>10}`).
    const uses = [];
    for (let j = a; j < e; j++) {
      countStep();
      if (toks[j].synthetic && isPunct(toks[j], '(')) {
        const c = closeOf(j);
        uses.push(value(j + 1, L.formatSpec ? firstAt(T, j + 1, c, (u) => u.k === 'val' && /^[!:]/u.test(u.text ?? '')) : c));
        j = c;
      }
    }
    return uses.length ? { k: 'lit', v: 'str', uses } : { k: 'lit', v: 'str' };
  };

  let depth = 0;
  const nested = (read) => (a, b, known) => {
    if (depth >= MAX_NESTING) return { ...opaque(a, b), nesting: true };
    depth++;
    try { return read(a, b, known); } finally { depth--; }
  };
  // The `:` that ends the middle of the conditional whose `?` is at q, or b. One walk from q pairs every `?` it meets
  // at its depth with its `:` (a stack), so a conditional nested in a middle (`a ? b ? c : d : e`) is not walked again.
  const colons = new Map();
  const colonOf = (q, b) => {
    if (!colons.has(q)) {
      const open = [];
      for (let j = q; j < b; j++) {
        countStep();
        const t = toks[j];
        if (opens(t) || (t.synthetic && isPunct(t, '('))) { const c = closeOf(j); if (c < 0) break; j = c; continue; }
        if (isPunct(t, '?')) open.push(j);
        else if (isPunct(t, ':') && open.length) { colons.set(open.pop(), j); if (!open.length) break; }
      }
    }
    const c = colons.get(q);
    return c !== undefined && c < b ? c : b;
  };

  // A function written as a value: a lambda (Python), an arrow or a function or class expression (scripts).
  const fnValue = (a, b) => {
    if (L.fn === 'lambda') return isWord(toks[a], 'lambda') && F.lambdaAt.has(a) ? { k: 'fn', scope: F.lambdaAt.get(a) } : null;
    const arrow = arrowAt(a);
    if (arrow !== null && T.scopes[arrow].b >= b) return { k: 'fn', scope: arrow };
    const fnAt = isWord(toks[a], 'async') && isWord(toks[a + 1], 'function') ? a + 1 : a;
    if (!isWord(toks[fnAt], 'function') && !isWord(toks[a], 'class')) return null;
    const kind = isWord(toks[a], 'class') ? 'class' : 'function';
    for (let j = fnAt + 1; j < b; j++) {
      countStep();
      const s = scopeAt(j, kind);
      if (s !== null) return T.scopes[s].b >= b ? { k: kind === 'class' ? 'class' : 'fn', scope: s } : opaque(a, b);
      if (isPunct(toks[j], '{') && kind === 'function') break;
    }
    return opaque(a, b);
  };
  // `a, b` at depth 0: a tuple (Python), or a sequence (scripts), whose value is its last part when the parts before
  // are literals (`(0, f)`, as TypeScript writes an unbound call) and opaque otherwise.
  const commaValue = (a, b) => {
    if (L.comma === 'tuple') return { k: 'lit', v: 'tuple', items: items(a, b) };
    const parts = partsBetween(T, a, b);
    if (parts.length > 1 && parts.slice(0, -1).every(([x, y]) => y === x + 1 && (toks[x].k === 'val' || L.literals.has(toks[x].v)))) return value(...parts.at(-1));
    return opaque(a, b);
  };
  // A value that binds a name as it is made: a walrus (`(m := f())`), an assignment inside an expression
  // (`(m = re.exec(s))`, `(x ||= y)`; an augmented one's value is opaque); its value with binds, what it sets.
  // Assignment binds loosest, so the first depth-0 `=` splits it, unless a `?` comes before (`c ? x = 1 : y`).
  const bindsValue = (a, b) => {
    if (L.binds === 'walrus') {
      if (!(isWord(toks[a]) && F.bindAt.has(a) && isPunct(toks[a + 1], ':') && isPunct(toks[a + 2], '='))) return null;
      return { ...value(a + 3, b, true), binds: { k: 'name', name: toks[a].v, binding: F.bindAt.get(a) } };
    }
    const at = firstAt(T, a, b, (u) => isPunct(u, '=') || (u.k === 'punct' && JS_AUGMENTED.has(u.v)) || isPunct(u, '?'));
    if (!(at < b && at > a) || isPunct(toks[at], '?')) return null;
    const binds = api.target(a, at);
    if (isPunct(toks[at], '=')) return { ...value(at + 1, b, true), binds };
    return { ...opaque(a, b), binds, aug: toks[at].v };
  };
  // A conditional expression: `a if c else b`, or `c ? a : b` (whose missing `:` makes it opaque).
  const choice = (a, b) => {
    if (L.ternary === 'words') {
      const ifAt = firstAt(T, a, b, (u) => isWord(u, 'if'));
      if (!(ifAt < b && ifAt > a)) return null;
      const elseAt = firstAt(T, ifAt + 1, b, (u) => isWord(u, 'else'));
      return elseAt < b ? { k: 'choice', cond: cond(ifAt + 1, elseAt), then: value(a, ifAt, true), else: value(elseAt + 1, b, true) } : null;
    }
    const q = firstAt(T, a, b, (u) => isPunct(u, '?'));
    if (!(q < b && q > a)) return null;
    const c = colonOf(q, b);
    return c < b ? { k: 'choice', cond: cond(a, q), then: value(q + 1, c, true), else: value(c + 1, b, true) } : opaque(a, b);
  };

  // The forms in the order they bind, loosest first: a function written here, a comma, await, `void 0`, a JSX
  // element (its attributes hold `=`), a binding value, a conditional, `as`, then one chain or opaque. noComma: the
  // caller knows a to b-1 holds no depth-0 comma, so a chain of conditionals is not searched for one at each link.
  const value = nested((a, b, noComma = false) => {
    if (a >= b) return opaque(a, b);
    const fn = fnValue(a, b);
    if (fn) return fn;
    if (!noComma && firstAt(T, a, b, isComma) < b) return commaValue(a, b);
    if (isWord(toks[a], 'await')) return { ...value(a + 1, b, true), await: true };
    if (L.voidWord && word(a, 'void') && b === a + 2 && toks[a + 1].k === 'val') return { k: 'lit', v: 'undefined' };
    if (jsx && isPunct(toks[a], '<')) return { k: 'lit', v: 'jsx' };
    const bound = bindsValue(a, b);
    if (bound) return bound;
    const ternary = choice(a, b);
    if (ternary) return ternary;
    if (L.as) {
      const asAt = firstAt(T, a, b, (u, j) => (isWord(u, 'as') || isWord(u, 'satisfies')) && !refAt.has(j));
      if (asAt < b && asAt > a) return { ...value(a, asAt, true), as: textOf(toks, asAt + 1, b) };
    }
    if (!isChain(a, b)) return opaque(a, b);
    let e = primaryEnd(a, b);
    let v = primary(a, e);
    while (e < b) {
      countStep();
      const next = postfixEnd(e, b);
      let j = e;
      const optional = L.optional && isPunct(toks[j], '?.');
      if (optional) j++;
      if (L.nonNull && isPunct(toks[j], '!') && !optional) { e = next; continue; }
      // A tagged template (`` sql`… ${x}` ``) is a call of its tag with the template.
      if (isTemplate(toks[j]) && !optional) { v = { k: 'call', callee: v, args: [{ value: primary(j, next) }], tagged: true }; e = next; continue; }
      const angle = T.typeAngles?.get(j);
      if (angle !== undefined && angle < b && isPunct(toks[angle], '(')) j = angle;
      if (isWord(toks[j])) v = { k: 'attr', of: v, name: toks[j].v };
      else if (isPunct(toks[j], '.')) v = { k: 'attr', of: v, name: toks[j + 1].v };
      else if (isPunct(toks[j], '[')) v = { k: 'index', of: v, key: value(j + 1, closeOf(j)) };
      else v = { k: isClassRef(v) ? 'new' : 'call', callee: v, args: args(j, closeOf(j)) };
      if (optional) v.optional = true;
      e = next;
    }
    return v;
  });

  // The null a token range is: 'None', 'null' or 'undefined' (the builtin), or null.
  const nullish = (x, y) => {
    if (y !== x + 1) return null;
    if (isWord(toks[x]) && L.nullWords.has(toks[x].v)) return toks[x].v;
    return builtinUndefined(x) ? 'undefined' : null;
  };
  const stringOf = (x, y) => (y === x + 1 && quoted(toks[x]) ? toks[x].text.slice(1, -1) : null);
  // A comparison at op, the only one in a to b-1: with null (none: neg for `is not`, `!=`, `!==`; exact for a
  // strict one, which says which null), with typeof's string (`typeof x === 'string'`), instanceof; else opaque.
  const comparison = (a, op, b) => {
    const t = toks[op];
    let rhs = op + 1;
    let eq = Object.hasOwn(L.equality, t.v) ? L.equality[t.v] : null;
    if (L.isNot && isWord(t, 'is') && isWord(toks[rhs], 'not')) { rhs++; eq = { neg: true, loose: true }; }
    if (firstAt(T, rhs, b, compares) < b) return opaque(a, b);
    if (L.instanceOf && isWord(t, L.instanceOf)) return { k: 'isinstance', of: value(a, op), types: [value(op + 1, b)] };
    if (!eq) return opaque(a, b);
    for (const [x, y, ox, oy] of [[rhs, b, a, op], [a, op, rhs, b]]) {
      const n = nullish(x, y);
      if (n) return eq.loose ? { k: 'none', of: value(ox, oy), neg: eq.neg } : { k: 'none', of: value(ox, oy), neg: eq.neg, exact: n };
      const s = L.typeofWord ? stringOf(x, y) : null;
      if (s !== null && word(ox, L.typeofWord)) {
        if (s === 'undefined') return { k: 'none', of: value(ox + 1, oy), neg: eq.neg, exact: 'undefined' };
        return { k: 'typeof', of: value(ox + 1, oy), is: s, neg: eq.neg };
      }
    }
    return opaque(a, b);
  };
  // `isinstance(x, C)` or `isinstance(x, (A, B))`, with the builtin isinstance (not a local of that name).
  const isinstanceCall = (a, v) => {
    if (!(L.isinstanceCall && v.k === 'call' && v.callee.k === 'ref' && v.callee.name === L.isinstanceCall && table.references[v.callee.ref]?.to?.builtin && v.args.length === 2 && !v.args.some((x) => x.name || x.spread))) return null;
    const open = a + 1;
    const [, [ta, tb]] = partsBetween(T, open + 1, closeOf(open));
    const types = isPunct(toks[ta], '(') && closeOf(ta) === tb - 1 ? partsBetween(T, ta + 1, tb - 1).map(([x, y]) => value(x, y)) : [v.args[1].value];
    return { k: 'isinstance', of: v.args[0].value, types };
  };
  // split: 2 to look for a depth-0 or and and, 1 for and only (a part of an or), 0 for neither (what follows a
  // loose `not`), -1 for neither and no comparison either (what follows a tight `!` whose range had none), so a run of
  // them is not searched again at each one. A loose `not` takes the comparison after it (`not a == b`); a tight `!`
  // before a comparison is opaque (`!x === y` is `(!x) === y`).
  const cond = nested((a, b, split = 2) => {
    if (a >= b) return opaque(a, b);
    if (L.nullishOp && split > 0 && firstAt(T, a, b, (u) => isPunct(u, L.nullishOp)) < b) return opaque(a, b);
    const ors = split > 1 ? splitAt(T, a, b, L.or) : [];
    if (ors.length > 1) return { k: 'or', of: ors.map(([x, y]) => cond(x, y, 1)) };
    const ands = split > 0 ? splitAt(T, a, b, L.and) : [];
    if (ands.length > 1) return { k: 'and', of: ands.map(([x, y]) => cond(x, y, 0)) };
    if (!L.notTight && L.not(toks[a])) return { k: 'not', of: cond(a + 1, b, 0) };
    if (isPunct(toks[a], '(') && closeOf(a) === b - 1 && firstAt(T, a + 1, b - 1, isComma) >= b - 1) return cond(a + 1, b - 1);
    if (split >= 0 && firstAt(T, a, b, L.condOpaque) < b) return opaque(a, b);
    const op = split >= 0 ? firstAt(T, a, b, compares) : b;
    if (L.notTight && L.not(toks[a])) return op < b ? opaque(a, b) : { k: 'not', of: cond(a + 1, b, -1) };
    if (op < b) return comparison(a, op, b);
    const v = value(a, b);
    return isinstanceCall(a, v) ?? (v.k === 'opaque' ? v : { k: 'truthy', of: v });
  });

  return Object.assign(api, { value, cond, opaque, closeOf, items });
}

// The scripts' reader of values: the one reader with JavaScript's table, and its own reader of patterns.
function scriptReader(F) {
  const E = exprReader(F, EXPR.js);
  const { T, toks } = F;
  const { value, opaque, closeOf } = E;

  // A destructuring pattern, or a plain name, from token a to b-1 (a type after a top-level `:` left out).
  const pattern = (a, b) => {
    if (a >= b) return null;
    if (isWord(toks[a]) && F.bindAt.has(a)) return { k: 'name', name: toks[a].v, binding: F.bindAt.get(a) };
    if (isPunct(toks[a], '[') && closeOf(a) < b) {
      // An item with a default (`[a = 1]`) is its pattern with default on it.
      const item = (pa, pb) => { const got = withDefault(pa, pb); return got && !got.k && 'default' in got ? { ...got.target, default: got.default } : got; };
      return { k: 'tuple', items: partsBetween(T, a + 1, closeOf(a)).map(([pa, pb]) => (pa === pb ? null : isPunct(toks[pa], '...') ? { ...pattern(pa + 1, pb), star: true } : item(pa, pb))) };
    }
    if (isPunct(toks[a], '{') && closeOf(a) < b) {
      const out = { k: 'object', items: [] };
      for (const [pa, pb] of partsBetween(T, a + 1, closeOf(a))) {
        countStep();
        if (pa === pb) continue;
        if (isPunct(toks[pa], '...')) { out.rest = pattern(pa + 1, pb); continue; }
        const colon = firstAt(T, pa, pb, (u) => isPunct(u, ':'));
        const key = isPunct(toks[pa], '[') ? opaque(pa, closeOf(pa) + 1).text : toks[pa].text?.slice(1, -1) ?? toks[pa].v;
        const got = colon < pb ? withDefault(colon + 1, pb) : withDefault(pa, pb);
        out.items.push(got && !got.k && 'default' in got ? { key, target: got.target, default: got.default } : { key, target: got });
      }
      return out;
    }
    return null;
  };
  // A pattern with a default (`a = 1`): { target, default }; without one, the pattern itself.
  const withDefault = (a, b) => {
    const eq = firstAt(T, a, b, (u) => isPunct(u, '='));
    return eq < b ? { target: pattern(a, eq), default: value(eq + 1, b) } : pattern(a, b);
  };
  // What an assignment's left side sets: a name, a pattern, or a value (`this.x`, `a[i]`).
  const target = (a, b) => {
    if (b === a + 1 && isWord(toks[a]) && F.bindAt.has(a)) return { k: 'name', name: toks[a].v, binding: F.bindAt.get(a) };
    if ((isPunct(toks[a], '[') || isPunct(toks[a], '{')) && closeOf(a) === b - 1) return pattern(a, b) ?? opaque(a, b);
    return value(a, b);
  };

  E.target = target;
  return { value, cond: E.cond, target, pattern, withDefault, opaque, closeOf };
}

function scriptBodies(F) {
  const { T, toks, match, bindAt } = F;
  const n = toks.length;
  const starts = new Map();
  T.scopes.forEach((s, i) => { if (s.kind === 'function' || s.kind === 'class') { const l = starts.get(s.a); if (l) l.push(i); else starts.set(s.a, [i]); } });
  F.starts = starts;
  const R = scriptReader(F);
  const { closeOf } = R;
  const lineOf = (j) => toks[j]?.line ?? toks.at(-1)?.line ?? 1;
  const endsStatement = (j) => j > 0 && toks[j].first && !needsMore(toks[j - 1]) && !continues(toks[j]);
  const word = (j, v) => isWord(toks[j], v) && !F.refAt.has(j) && !bindAt.has(j);
  // Where the simple statement from token i ends (the token after it, a `;` left out), at most q.
  const stmtEnd = (i, q) => {
    for (let j = i; j < q; j++) {
      countStep();
      const t = toks[j];
      if (j > i && endsStatement(j)) return j;
      if (isPunct(t, ';')) return j;
      if ((isPunct(t, '(') || isPunct(t, '[') || isPunct(t, '{')) || (t.synthetic && isPunct(t, '('))) { const c = match.get(j); if (c === undefined || c >= q) return q; j = c; continue; }
      const angle = T.typeAngles?.get(j);
      if (angle !== undefined && angle <= q) j = angle - 1;
    }
    return q;
  };
  const past = (j, q) => (isPunct(toks[j], ';') && j < q ? j + 1 : j);
  // The first function or class scope that starts from token a on, before b.
  const scopeFrom = (a, b, kind) => {
    for (let j = a; j < b; j++) {
      countStep();
      const s = starts.get(j)?.find((x) => T.scopes[x].kind === kind);
      if (s !== undefined) return s;
      if (kind === 'function' && isPunct(toks[j], '{')) return null;
    }
    return null;
  };
  // A decorator from the `@` at j: its end (the token after `@a.b(…)`).
  const decoratorEnd = (j) => {
    let q = j + 1;
    if (isPunct(toks[q], '(')) return closeOf(q) + 1;
    while (isWord(toks[q]) && isPunct(toks[q + 1], '.')) { countStep(); q += 2; }
    q++;
    if (isPunct(toks[q], '(') && toks[q].line === toks[q - 1].line) q = closeOf(q) + 1;
    return q;
  };

  // A statement or expression without its own syntax, from token i to e-1: an assignment, a `++`, or an expression.
  const simple = (i, e, out) => {
    const at = { line: lineOf(i) };
    if (i >= e) return;
    // `void promise()` as a statement still makes the call; only its value is dropped.
    if (word(i, 'void') && i + 1 < e) { simple(i + 1, e, out); return; }
    // `a = 1, b = f()`: a comma expression is its parts in order (an arrow's parameters are in parentheses).
    const commas = splitAt(T, i, e, (u) => isPunct(u, ','));
    if (commas.length > 1 && firstAt(T, i, e, (u) => isPunct(u, '=>')) >= e) { for (const [x, y] of commas) simple(x, y, out); return; }
    const eqs = [];
    let aug = -1;
    for (let q = i; q < e; q++) {
      countStep();
      const t = toks[q];
      if ((isPunct(t, '(') || isPunct(t, '[') || isPunct(t, '{')) || (t.synthetic && isPunct(t, '('))) { const c = match.get(q); if (c === undefined) break; q = c; continue; }
      const angle = T.typeAngles?.get(q);
      if (angle !== undefined && angle <= e) { q = angle - 1; continue; }
      if (isPunct(t, '=>') || isPunct(t, '?')) break;
      if (isPunct(t, '=')) eqs.push(q);
      else if (t.k === 'punct' && JS_AUGMENTED.has(t.v) && aug < 0 && !eqs.length) aug = q;
    }
    if (aug >= 0) { out.push({ op: 'assign', ...at, targets: [R.target(i, aug)], value: R.value(aug + 1, e), aug: toks[aug].v }); return; }
    if (!eqs.length && (isPunct(toks[e - 1], '++') || isPunct(toks[e - 1], '--')) && e - 1 > i) { out.push({ op: 'assign', ...at, targets: [R.target(i, e - 1)], value: null, aug: toks[e - 1].v }); return; }
    if (!eqs.length && (isPunct(toks[i], '++') || isPunct(toks[i], '--'))) { out.push({ op: 'assign', ...at, targets: [R.target(i + 1, e)], value: null, aug: toks[i].v }); return; }
    if (!eqs.length) {
      const v = R.value(i, e);
      out.push({ op: v.k === 'call' || v.k === 'new' ? 'call' : 'expr', ...at, value: v });
      return;
    }
    const targets = [];
    let start = i;
    for (const q of eqs) { targets.push(R.target(start, q)); start = q + 1; }
    out.push({ op: 'assign', ...at, targets, value: R.value(start, e) });
  };
  // `const a = 1, { b } = c` from token a (past the word) to e-1: an assignment per declarator.
  const declarations = (a, e, out) => {
    for (const [pa, pb] of partsBetween(T, a, e)) {
      countStep();
      const eq = firstAt(T, pa, pb, (u) => isPunct(u, '='));
      const typeAt = firstAt(T, pa, eq, (u) => isPunct(u, ':'));
      const end = Math.min(eq, typeAt);
      const bang = isPunct(toks[end - 1], '!') ? end - 1 : end;
      out.push({ op: 'assign', line: lineOf(pa), targets: [R.pattern(pa, bang) ?? R.opaque(pa, bang)], value: eq < pb ? R.value(eq + 1, pb) : null });
    }
  };

  // The statement from token i (before q): pushes its steps on out and gives the token after it. Past MAX_NESTING
  // statements inside each other, the rest of the block is one opaque step with nesting: true.
  let depth = 0;
  const statement = (i, q, out) => {
    if (depth >= MAX_NESTING) { out.push({ op: 'opaque', line: lineOf(i), text: textOf(toks, i, q), nesting: true }); return q; }
    depth++;
    try { return statementIn(i, q, out); } finally { depth--; }
  };
  const statementIn = (i, q, out) => {
    countStep();
    const t = toks[i];
    const at = { line: lineOf(i) };
    if (isPunct(t, ';')) return i + 1;
    if (isPunct(t, '{')) { const c = closeOf(i); out.push(...statements(i + 1, c)); return c + 1; }
    // `outer: for (…)`: the statement's first step carries the label a `break outer` or `continue outer` names.
    if (isWord(t) && isPunct(toks[i + 1], ':') && !F.refAt.has(i) && !bindAt.has(i)) {
      const before = out.length;
      const end = statement(i + 2, q, out);
      if (out.length > before) out[before].label = t.v;
      return end;
    }
    const w = isWord(t) && !F.refAt.has(i) && !bindAt.has(i) ? t.v : null;
    if (w === 'if' && isPunct(toks[i + 1], '(')) {
      const c = closeOf(i + 1);
      const b = { op: 'branch', ...at, cond: R.cond(i + 2, c), then: [], else: [] };
      let j = statement(c + 1, q, b.then);
      if (word(j, 'else')) j = statement(j + 1, q, b.else);
      out.push(b);
      return j;
    }
    if (w === 'for') {
      let open = i + 1;
      if (word(open, 'await')) open++;
      const c = closeOf(open);
      const semi = splitAt(T, open + 1, c, (u) => isPunct(u, ';'));
      const loop = { op: 'loop', ...at, kind: 'for' };
      if (semi.length === 3) {
        const [[ia, ib], [ca, cb], [ua, ub]] = semi;
        if (ia < ib) declOrSimple(ia, ib, out);
        loop.cond = ca < cb ? R.cond(ca, cb) : null;
        loop.body = [];
        const j = statement(c + 1, q, loop.body);
        if (ua < ub) simple(ua, ub, loop.body);
        loop.else = [];
        out.push(loop);
        return j;
      }
      const inAt = firstAt(T, open + 1, c, (u, j) => (isWord(u, 'of') || isWord(u, 'in')) && !F.refAt.has(j) && !bindAt.has(j));
      let ta = open + 1;
      if (['const', 'let', 'var'].some((d) => word(ta, d))) ta++;
      loop.target = R.pattern(ta, inAt) ?? R.target(ta, inAt);
      loop.over = R.value(inAt + 1, c);
      if (isWord(toks[inAt], 'in')) loop.keys = true;
      loop.body = [];
      const j = statement(c + 1, q, loop.body);
      loop.else = [];
      out.push(loop);
      return j;
    }
    if (w === 'while' && isPunct(toks[i + 1], '(')) {
      const c = closeOf(i + 1);
      const loop = { op: 'loop', ...at, kind: 'while', cond: R.cond(i + 2, c), body: [], else: [] };
      const j = statement(c + 1, q, loop.body);
      out.push(loop);
      return j;
    }
    if (w === 'do') {
      const loop = { op: 'loop', ...at, kind: 'do', body: [], else: [] };
      let j = statement(i + 1, q, loop.body);
      if (word(j, 'while') && isPunct(toks[j + 1], '(')) { const c = closeOf(j + 1); loop.cond = R.cond(j + 2, c); j = past(c + 1, q); }
      out.push(loop);
      return j;
    }
    if (w === 'try') {
      const tr = { op: 'try', ...at, body: [], handlers: [], else: [], finally: [] };
      let j = statement(i + 1, q, tr.body);
      if (word(j, 'catch')) {
        const h = { types: null, binding: null, body: [] };
        j++;
        if (isPunct(toks[j], '(')) {
          const c = closeOf(j);
          const typeAt = firstAt(T, j + 1, c, (u) => isPunct(u, ':'));
          const p = R.pattern(j + 1, typeAt);
          if (p?.k === 'name') h.binding = p.binding; else if (p) h.target = p;
          j = c + 1;
        }
        j = statement(j, q, h.body);
        tr.handlers.push(h);
      }
      if (word(j, 'finally')) j = statement(j + 1, q, tr.finally);
      out.push(tr);
      return j;
    }
    if (w === 'switch' && isPunct(toks[i + 1], '(')) {
      const c = closeOf(i + 1);
      const subject = textOf(toks, i + 2, c);
      const open = c + 1;
      const close = closeOf(open);
      // The cases: their label and the statements up to the next case at this depth.
      const cases = [];
      let j = open + 1;
      while (j < close) {
        countStep();
        if (word(j, 'case') || word(j, 'default')) {
          const colon = word(j, 'default') ? j + 1 : firstAt(T, j + 1, close, (u) => isPunct(u, ':'));
          cases.push({ at: j, label: word(j, 'default') ? null : textOf(toks, j + 1, colon), body: [] });
          j = colon + 1;
          continue;
        }
        if (!cases.length) { j = stmtEnd(j, close) + 1; continue; }
        j = statement(j, close, cases.at(-1).body);
      }
      // A case with no statements falls through to the next: it is one branch with it (`case 'b': case 'c':`), and
      // a group holding `default` is the last else.
      const groups = [];
      for (const cs of cases) {
        countStep();
        const g = groups.at(-1);
        if (g && !g.body.length) { g.labels.push(cs.label); g.body = cs.body; } else groups.push({ at: cs.at, labels: [cs.label], body: cs.body });
      }
      let chain = [];
      for (let k = groups.length - 1; k >= 0; k--) {
        countStep();
        const g = groups[k];
        if (g.body.at(-1)?.op === 'break') g.body.pop();
        if (g.labels.includes(null)) { chain = g.body; continue; }
        chain = [{ op: 'branch', line: lineOf(g.at), cond: { k: 'opaque', text: `switch ${subject} case ${g.labels.join(' | ')}` }, then: g.body, else: chain }];
      }
      out.push(...chain);
      return close + 1;
    }
    if (w === 'return' || w === 'throw') {
      const e = toks[i + 1] && !toks[i + 1].first && i + 1 < q ? stmtEnd(i + 1, q) : i + 1;
      out.push({ op: w === 'throw' ? 'raise' : 'return', ...at, value: e > i + 1 ? R.value(i + 1, e) : null });
      return past(e, q);
    }
    if (w === 'break' || w === 'continue') {
      // `break outer`: the label names the loop (or block) it leaves.
      const step = { op: w, ...at };
      let j = i + 1;
      if (isWord(toks[j]) && !toks[j].first && j < q) { step.label = toks[j].v; j++; }
      out.push(step);
      return past(j, q);
    }
    if (t.k === 'punct' && t.v === '@') {
      const decorators = [];
      let j = i;
      while (isPunct(toks[j], '@') && j < q) { countStep(); const e = decoratorEnd(j); decorators.push(R.value(j + 1, e)); j = e; }
      const before = out.length;
      const end = statement(j, q, out);
      if (out.length > before && out[before].decorators) out[before].decorators = decorators;
      return end;
    }
    if (w === 'function' || (w === 'async' && word(i + 1, 'function'))) {
      const s = scopeFrom(i + 1, q, 'function');
      if (s === null) return stmtEnd(i, q) + 1;
      // A function declaration is bound from the start of the body around it (hoisted), not from where it stands.
      out.push({ op: 'def', ...at, scope: s, name: T.scopes[s].name, decorators: [], hoisted: true });
      return Math.max(T.scopes[s].b, i + 1);
    }
    if (w === 'class' || (w === 'abstract' && word(i + 1, 'class'))) {
      const s = scopeFrom(i + 1, q, 'class');
      if (s === null) return stmtEnd(i, q) + 1;
      out.push({ op: 'class', ...at, scope: s, name: T.scopes[s].name, decorators: [] });
      return Math.max(T.scopes[s].b, i + 1);
    }
    if (w === 'import' && !isPunct(toks[i + 1], '(') && !isPunct(toks[i + 1], '.')) {
      const e = stmtEnd(i, q);
      const bindings = [];
      for (let j = i; j < e; j++) { countStep(); if (bindAt.has(j)) bindings.push(bindAt.get(j)); }
      out.push({ op: 'import', ...at, bindings });
      return past(e, q);
    }
    if (w === 'export') {
      if (word(i + 1, 'default')) {
        const j = i + 2;
        if (word(j, 'function') || word(j, 'class') || (word(j, 'async') && word(j + 1, 'function')) || word(j, 'abstract')) return statement(j, q, out);
        const e = stmtEnd(j, q);
        out.push({ op: 'expr', ...at, value: R.value(j, e), export: 'default' });
        return past(e, q);
      }
      if (isPunct(toks[i + 1], '{') || isPunct(toks[i + 1], '*') || word(i + 1, 'type') && isPunct(toks[i + 2], '{') || isPunct(toks[i + 1], '=')) {
        const e = stmtEnd(i, q);
        out.push({ op: 'opaque', ...at, text: textOf(toks, i, e) });
        return past(e, q);
      }
      return statement(i + 1, q, out);
    }
    if ((w === 'const' || w === 'let' || w === 'var') && (isWord(toks[i + 1]) || isPunct(toks[i + 1], '[') || isPunct(toks[i + 1], '{')) && !toks[i + 1].first) {
      if (w === 'const' && word(i + 1, 'enum')) return statement(i + 1, q, out);
      const e = stmtEnd(i, q);
      declarations(i + 1, e, out);
      return past(e, q);
    }
    // TypeScript declarations of types only: no step. enum and namespace: their header, opaque.
    if (w && TS_TYPE_ONLY.has(w) && isWord(toks[i + 1]) && !toks[i + 1].first) {
      const e = stmtEnd(i, q);
      return past(e, q);
    }
    if (w && (w === 'enum' || w === 'namespace' || w === 'module') && (isWord(toks[i + 1]) || (toks[i + 1]?.k === 'val')) && !toks[i + 1].first) {
      const brace = firstAt(T, i + 1, q, (u) => isPunct(u, '{'));
      out.push({ op: 'opaque', ...at, text: textOf(toks, i, brace) });
      return brace < q ? closeOf(brace) + 1 : q;
    }
    const e = stmtEnd(i, q);
    simple(i, e, out);
    return past(Math.max(e, i + 1), q);
  };
  const declOrSimple = (a, b, out) => {
    if (['const', 'let', 'var'].some((d) => word(a, d))) declarations(a + 1, b, out);
    else simple(a, b, out);
  };
  const statements = (p, q) => {
    const out = [];
    for (let i = p; i < q;) { const j = statement(i, q, out); i = j > i ? j : i + 1; }
    return out;
  };

  // A class body: its methods as defs, its fields, its static blocks' statements.
  const classBody = (s) => {
    const { a, b } = T.scopes[s];
    const close = closeOf(a);
    const out = [];
    let i = a + 1;
    while (i < close) {
      countStep();
      if (isPunct(toks[i], ';')) { i++; continue; }
      const decorators = [];
      while (isPunct(toks[i], '@') && i < close) { const e = decoratorEnd(i); decorators.push(R.value(i + 1, e)); i = e; }
      if (isWord(toks[i], 'static') && isPunct(toks[i + 1], '{')) { const c = closeOf(i + 1); out.push(...statements(i + 2, c)); i = c + 1; continue; }
      let isStatic = false;
      // A modifier is followed, on its line, by what names a member: a word, `[`, `#`, `*` or a string.
      const named = (u) => u && !u.first && (isWord(u) || isPunct(u, '[') || isPunct(u, '#') || isPunct(u, '*') || u.k === 'val');
      while (isWord(toks[i]) && MEMBER_MODIFIERS.has(toks[i].v) && named(toks[i + 1])) {
        if (toks[i].v === 'static') isStatic = true;
        i++;
      }
      const nameAt = i;
      let j = i;
      if (isPunct(toks[j], '*')) j++;
      if (isPunct(toks[j], '#')) j++;
      if (isPunct(toks[j], '[')) j = closeOf(j) + 1; else j++;
      const name = textOf(toks, nameAt, j);
      if (isPunct(toks[j], '?') || isPunct(toks[j], '!')) j++;
      const fn = starts.get(j)?.find((x) => T.scopes[x].kind === 'function') ?? (T.typeAngles?.has(j) ? starts.get(j)?.[0] ?? scopeFrom(j, close, 'function') : null);
      if (fn !== null && fn !== undefined && (isPunct(toks[j], '(') || isPunct(toks[j], '<'))) {
        out.push({ op: 'def', line: lineOf(nameAt), scope: fn, name, decorators, static: isStatic });
        i = Math.max(T.scopes[fn].b, j + 1);
        continue;
      }
      if (isPunct(toks[j], '(') || isPunct(toks[j], '<')) { i = stmtEnd(j, close); i = past(i, close); continue; } // an overload or an abstract method: no body
      // An index signature `[k: string]: T` is a type only.
      const e = stmtEnd(nameAt, close);
      const eq = firstAt(T, j, e, (u) => isPunct(u, '='));
      if (!(isPunct(toks[nameAt], '[') && isPunct(toks[j], ':'))) out.push({ op: 'field', line: lineOf(nameAt), name, value: eq < e ? R.value(eq + 1, e) : null, static: isStatic, decorators });
      i = past(Math.max(e, nameAt + 1), close);
    }
    return out;
  };
  // A function's body: its statements, or, for an arrow with an expression body, the return of that expression.
  const functionBody = (s) => {
    const sc = T.scopes[s];
    if (sc.arrow) {
      const arrowAt = firstAt(T, sc.a, sc.b, (u) => isPunct(u, '=>'));
      const start = arrowAt + 1;
      if (isPunct(toks[start], '{') && closeOf(start) === sc.b - 1) return statements(start + 1, sc.b - 1);
      // The expression ends at the scope's end, less the brackets that close around the arrow (`map(x => x.y)`, whose
      // scope runs to the `)`): taken off from the end, not found by a walk from the start, which deep arrows
      // (`a => b => c`) would repeat for each.
      let end = sc.b;
      while (end - 1 > start && toks[end - 1].k === 'punct' && ')]}'.includes(toks[end - 1].v) && (T.back.get(end - 1) ?? -1) < start) { countStep(); end--; }
      return [{ op: 'return', line: lineOf(start), value: R.value(start, end) }];
    }
    const last = sc.b - 1;
    const open = isPunct(toks[last], '}') ? T.back?.get(last) ?? -1 : -1;
    if (open < sc.a) return [];
    return statements(open + 1, last);
  };

  // A function's parameters: { target, default, star? ('...' for a rest one) }, past decorators (`@Body() b`) and
  // TypeScript's parameter properties (`private x: X`); a `this: T` parameter names no parameter.
  const params = (s) => {
    let p = T.scopes[s].a;
    if (word(p, 'async')) p++;
    const angle = T.typeAngles?.get(p);
    if (angle !== undefined) p = angle;
    if (isWord(toks[p])) return bindAt.has(p) ? [{ target: { k: 'name', name: toks[p].v, binding: bindAt.get(p) }, default: null }] : [];
    if (!isPunct(toks[p], '(')) return [];
    const out = [];
    for (const [pa, pb] of partsBetween(T, p + 1, closeOf(p))) {
      countStep();
      let q = pa;
      while (isPunct(toks[q], '@') && q < pb) q = decoratorEnd(q);
      while (isWord(toks[q]) && PARAM_MODIFIERS.has(toks[q].v) && q + 1 < pb && (isWord(toks[q + 1]) || isPunct(toks[q + 1], '{') || isPunct(toks[q + 1], '['))) q++;
      const rest = isPunct(toks[q], '...');
      if (rest) q++;
      if (q >= pb || isWord(toks[q], 'this')) continue;
      const eq = firstAt(T, q, pb, (u) => isPunct(u, '='));
      let end = Math.min(eq, firstAt(T, q, eq, (u) => isPunct(u, ':')));
      if (isPunct(toks[end - 1], '?')) end--;
      const param = { target: R.pattern(q, end) ?? R.opaque(q, end), default: eq < pb ? R.value(eq + 1, pb) : null };
      if (rest) param.star = '...';
      out.push(param);
    }
    return out;
  };

  const bodies = [{ scope: 0, kind: 'module', name: null, steps: statements(0, n) }];
  T.scopes.forEach((s, i) => {
    countStep();
    if (s.kind === 'function') bodies.push({ scope: i, kind: 'function', name: s.name, params: params(i), steps: functionBody(i) });
    else if (s.kind === 'class') bodies.push({ scope: i, kind: 'class', name: s.name, steps: classBody(i) });
  });
  return bodies;
}
