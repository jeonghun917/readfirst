// The common flow form of a file: each body (the module, each function, each class) lowered to a short list of steps
// that is the same for every language, so a reader of values walks one shape instead of each language's syntax. Built
// on src/scopes.mjs (`readScopes`: its tokens, its statements and which reference each name token is), so nothing here
// reads strings, comments or brackets again. It reads only what values need; anything else is `opaque` with its text,
// never a guess. Python only for now: a JavaScript or TypeScript file gives `bodies: null`.
//
// flowSteps(path, body) → { table, bodies } (table: the scopes() table the references point into), or null for a
// file src/code.mjs does not read.
// - bodies[i]: { scope, kind, name, steps }: scope 0 is the module; a def's and a class's body are their own entries.
// - a step has op and line:
//   assign { targets, value, aug? } (`a = b = v`: two targets; aug: '+=' and the like, value: the right-hand side),
//   call { value } and expr { value } (an expression statement: a call, or anything else),
//   return { value|null }, raise { value|null }, assert { cond }, break, continue, import { bindings },
//   def { scope, name, decorators } and class { scope, name, decorators } (their bodies are entries of bodies),
//   branch { cond, then, else } (`elif` is a branch inside else; a `match` is a branch per case, its conds opaque),
//   loop { kind: 'for'|'while', target?, over?, cond?, body, else }, try { body, handlers, else, finally }
//   (handlers[i]: { types: [value]|null, binding|null, body }), with { items: [{ value, target|null }], body },
//   opaque { text, body? } (a statement read no further: del, global, a stray else, with what it holds).
// - a target: { k: 'name', name, binding } (the binding it makes, an index into table.bindings), { k: 'tuple', items }
//   (items may carry star: true), or a value (`self.x`, `a[i]`).
// - a value: { k: 'ref', name, ref } (ref: an index into table.references), { k: 'attr', of, name },
//   { k: 'index', of, key }, { k: 'call', callee, args }, { k: 'new', callee, args } (a call of a class the file binds),
//   { k: 'lit', v: 'None'|'True'|'False'|'num'|'str'|'tuple'|'list'|'dict'|'set', text?, uses?, items? } (uses: the
//   values in an f-string's braces, up to a `!r` or a format spec; items: a tuple's or a list's values, a starred one
//   with spread: '*'; a comprehension has text, no items), { k: 'choice', cond, then, else } (`a if c else b`), { k: 'fn', scope } (a lambda), or
//   { k: 'opaque', text }. await: true on a value that is awaited. args[i]: { value, name? (a keyword), spread? }.
// - a cond: { k: 'none', of, neg } (`x is None`, `x == None`; neg for `is not`, `!=`), { k: 'truthy', of },
//   { k: 'isinstance', of, types }, { k: 'not', of }, { k: 'and'|'or', of: [cond] }, or { k: 'opaque', text }.
// Linear in the text: a value is taken apart only once it is known to be one chain (isChain), so no part is read again
// for an outer value that turns out opaque; countStep counts the walks.
import { readScopes, partsBetween, firstAt } from './scopes.mjs';
import { countStep, isWord, isPunct } from './code.mjs';

export function flowSteps(path, body) {
  const got = readScopes(path, body);
  if (!got) return null;
  const { table, T, refAt } = got;
  if (T.lang !== 'py') return { table, bodies: null };
  const bindAt = new Map();
  T.bindings.forEach((b, i) => { if (b.at !== undefined && !b.hidden) bindAt.set(b.at, i); });
  const lambdaAt = new Map();
  T.scopes.forEach((s, i) => { if (s.kind === 'function' && s.name === null) lambdaAt.set(s.a, i); });
  return { table, bodies: pythonBodies({ T, toks: T.toks, match: T.match, refAt, bindAt, lambdaAt, table }) };
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

function pythonReader(F) {
  const { T, toks, match, refAt, lambdaAt, table } = F;
  const opaque = (a, b) => ({ k: 'opaque', text: textOf(toks, a, b) });
  const closeOf = (j) => match.get(j) ?? -1;
  const isString = (t) => t?.k === 'val' && /^['"]/u.test(t.text ?? '');
  const isNumber = (t) => t?.k === 'val' && /^\.?\d/u.test(t.v);
  const opens = (t) => (isPunct(t, '(') || isPunct(t, '[') || isPunct(t, '{')) && !t.synthetic;

  // A run of strings and their f-string placeholders (synthetic parentheses), with any prefix words between them.
  const stringEnd = (j, b) => {
    for (;;) {
      countStep();
      if (j < b && isString(toks[j])) { j++; continue; }
      if (j < b && toks[j].synthetic && isPunct(toks[j], '(')) { j = closeOf(j) + 1; continue; }
      if (j + 1 < b && isWord(toks[j]) && !refAt.has(j) && isString(toks[j + 1])) { j++; continue; }
      return j;
    }
  };
  // `1`, `1.5` (three tokens), `1e3`.
  const numberEnd = (j, b) => (j + 2 < b && isPunct(toks[j + 1], '.') && isNumber(toks[j + 2]) && toks[j + 2].line === toks[j].line ? j + 3 : j + 1);
  // Where the primary that starts at token a ends (the token after it), or -1 if none starts there.
  const primaryEnd = (a, b) => {
    const t = toks[a];
    if (!t || a >= b) return -1;
    if (t.k === 'word') {
      if (PY_LITERALS.has(t.v)) return a + 1;
      if (refAt.has(a)) return a + 1;
      // A string's prefix (`f"…"`), which is no name: the string follows it.
      return isString(toks[a + 1]) && toks[a + 1].line === t.line ? stringEnd(a + 1, b) : -1;
    }
    if (isString(t)) return stringEnd(a, b);
    if (isNumber(t)) return numberEnd(a, b);
    if (isPunct(t, '-') && isNumber(toks[a + 1])) return numberEnd(a + 1, b);
    if (opens(t)) { const c = closeOf(a); return c < 0 || c >= b ? -1 : c + 1; }
    return -1;
  };

  // Whether a to b-1 is one primary and its postfixes (`.name`, `[…]`, `(…)`), read at depth 0 only.
  const isChain = (a, b) => {
    let q = primaryEnd(a, b);
    if (q < 0) return false;
    while (q < b) {
      countStep();
      if (isPunct(toks[q], '.') && q + 1 < b && isWord(toks[q + 1])) { q += 2; continue; }
      if ((isPunct(toks[q], '[') || isPunct(toks[q], '(')) && !toks[q].synthetic) { const c = closeOf(q); if (c < 0 || c >= b) return false; q = c + 1; continue; }
      return false;
    }
    return true;
  };

  const primary = (a, e) => {
    const t = toks[a];
    if (t.k === 'word' && PY_LITERALS.has(t.v)) return { k: 'lit', v: t.v };
    if (t.k === 'word' && refAt.has(a)) return { k: 'ref', name: t.v, ref: refAt.get(a) };
    if (isNumber(t) || isPunct(t, '-')) return { k: 'lit', v: 'num', text: textOf(toks, a, e) };
    if (opens(t)) {
      const [x, y] = [a + 1, e - 1];
      const compr = firstAt(T, x, y, (u) => isWord(u, 'for')) < y;
      if (isPunct(t, '(')) {
        if (x === y) return { k: 'lit', v: 'tuple', items: [] };
        if (compr) return opaque(a, e);
        return firstAt(T, x, y, (u) => isPunct(u, ',')) < y ? tuple(x, y) : value(x, y);
      }
      if (compr) return { k: 'lit', v: isPunct(t, '[') ? 'list' : 'set', text: textOf(toks, a, e) };
      if (isPunct(t, '[')) return { k: 'lit', v: 'list', items: items(x, y) };
      return { k: 'lit', v: x === y || firstAt(T, x, y, (u) => isPunct(u, ':') || isPunct(u, '**')) < y ? 'dict' : 'set' };
    }
    // A string run: what its placeholders hold are uses, up to a conversion or a format spec (`{x!r}`, `{x:>10}`).
    const uses = [];
    for (let j = a; j < e; j++) {
      countStep();
      if (toks[j].synthetic && isPunct(toks[j], '(')) {
        const c = closeOf(j);
        uses.push(value(j + 1, firstAt(T, j + 1, c, (u) => u.k === 'val' && /^[!:]/u.test(u.text ?? ''))));
        j = c;
      }
    }
    return uses.length ? { k: 'lit', v: 'str', uses } : { k: 'lit', v: 'str' };
  };

  // The values of a tuple's or a list's parts (a starred one carries spread).
  const items = (a, b) => partsBetween(T, a, b).map(([pa, pb]) => (isPunct(toks[pa], '*') ? { ...value(pa + 1, pb), spread: '*' } : value(pa, pb)));
  const tuple = (a, b) => ({ k: 'lit', v: 'tuple', items: items(a, b) });

  const args = (open, close) => partsBetween(T, open + 1, close).map(([pa, pb]) => {
    if (isPunct(toks[pa], '*') || isPunct(toks[pa], '**')) return { spread: toks[pa].v, value: value(pa + 1, pb) };
    if (isWord(toks[pa]) && isPunct(toks[pa + 1], '=') && pa + 1 < pb) return { name: toks[pa].v, value: value(pa + 2, pb) };
    return { value: value(pa, pb) };
  });

  // A call of a name the file binds as a class constructs it.
  const isClassRef = (v) => {
    if (v.k !== 'ref') return false;
    const b = table.references[v.ref]?.to?.binding;
    return b !== undefined && table.bindings[b]?.how === 'class';
  };

  let depth = 0;
  const nested = (read) => (a, b, known) => {
    if (depth >= MAX_NESTING) return { ...opaque(a, b), nesting: true };
    depth++;
    try { return read(a, b, known); } finally { depth--; }
  };
  // noComma: the caller knows a to b-1 holds no depth-0 comma (a part of a choice), so a chain of choices is not
  // searched for one again at each link.
  const value = nested((a, b, noComma = false) => {
    if (a >= b) return opaque(a, b);
    if (isWord(toks[a], 'await')) return { ...value(a + 1, b, noComma), await: true };
    if (isWord(toks[a], 'lambda') && lambdaAt.has(a)) return { k: 'fn', scope: lambdaAt.get(a) };
    // `return a, b`, `x = 1, 2`: a tuple without its parentheses (its commas bind looser than `if … else`).
    if (!noComma && firstAt(T, a, b, (u) => isPunct(u, ',')) < b) return tuple(a, b);
    const ifAt = firstAt(T, a, b, (u) => isWord(u, 'if'));
    if (ifAt < b && ifAt > a) {
      const elseAt = firstAt(T, ifAt + 1, b, (u) => isWord(u, 'else'));
      if (elseAt < b) return { k: 'choice', cond: cond(ifAt + 1, elseAt), then: value(a, ifAt, true), else: value(elseAt + 1, b, true) };
    }
    if (!isChain(a, b)) return opaque(a, b);
    let q = primaryEnd(a, b);
    let v = primary(a, q);
    while (q < b) {
      countStep();
      if (isPunct(toks[q], '.')) { v = { k: 'attr', of: v, name: toks[q + 1].v }; q += 2; continue; }
      const c = closeOf(q);
      if (isPunct(toks[q], '[')) v = { k: 'index', of: v, key: value(q + 1, c) };
      else v = { k: isClassRef(v) ? 'new' : 'call', callee: v, args: args(q, c) };
      q = c + 1;
    }
    return v;
  });

  const isCompare = (u) => isWord(u, 'is') || isWord(u, 'in') || isWord(u, 'not') || (u.k === 'punct' && COMPARE.has(u.v));
  // split: 2 to look for a depth-0 `or` and `and`, 1 for `and` only (a part of an `or`), 0 for neither (what follows
  // a `not` whose range had none), so a run of `not` is not searched again at each one.
  const cond = nested((a, b, split = 2) => {
    if (a >= b) return opaque(a, b);
    const ors = split > 1 ? splitAt(T, a, b, (u) => isWord(u, 'or')) : [];
    if (ors.length > 1) return { k: 'or', of: ors.map(([x, y]) => cond(x, y, 1)) };
    const ands = split > 0 ? splitAt(T, a, b, (u) => isWord(u, 'and')) : [];
    if (ands.length > 1) return { k: 'and', of: ands.map(([x, y]) => cond(x, y, 0)) };
    if (isWord(toks[a], 'not')) return { k: 'not', of: cond(a + 1, b, 0) };
    if (isPunct(toks[a], '(') && closeOf(a) === b - 1 && firstAt(T, a + 1, b - 1, (u) => isPunct(u, ',')) >= b - 1) return cond(a + 1, b - 1);
    if (firstAt(T, a, b, (u) => isWord(u, 'if') || isWord(u, 'lambda')) < b) return opaque(a, b);
    const opAt = firstAt(T, a, b, isCompare);
    if (opAt < b) {
      const t = toks[opAt];
      let rhs = opAt + 1;
      let neg = t.v === '!=';
      if (isWord(t, 'is') && isWord(toks[rhs], 'not')) { rhs++; neg = true; }
      const isNone = (x, y) => y === x + 1 && isWord(toks[x], 'None');
      // One comparison only: a chain (`a == b != c`) is more.
      const one = (isWord(t, 'is') || t.v === '==' || t.v === '!=') && firstAt(T, rhs, b, isCompare) >= b;
      if (one && isNone(rhs, b)) return { k: 'none', of: value(a, opAt), neg };
      if (one && isNone(a, opAt)) return { k: 'none', of: value(rhs, b), neg };
      return opaque(a, b);
    }
    const v = value(a, b);
    if (v.k === 'call' && v.callee.k === 'ref' && v.callee.name === 'isinstance' && table.references[v.callee.ref]?.to?.builtin && v.args.length === 2 && !v.args.some((x) => x.name || x.spread)) {
      // The second argument's tokens: a tuple of classes, or one.
      const open = a + 1;
      const [, [ta, tb]] = partsBetween(T, open + 1, closeOf(open));
      const types = isPunct(toks[ta], '(') && closeOf(ta) === tb - 1 ? partsBetween(T, ta + 1, tb - 1).map(([x, y]) => value(x, y)) : [v.args[1].value];
      return { k: 'isinstance', of: v.args[0].value, types };
    }
    return v.k === 'opaque' ? v : { k: 'truthy', of: v };
  });

  // What an assignment's left side from a to b-1 binds or sets.
  const target = (a, b) => {
    if (b === a + 1 && isWord(toks[a]) && F.bindAt.has(a)) return { k: 'name', name: toks[a].v, binding: F.bindAt.get(a) };
    if (isPunct(toks[a], '*')) return { ...target(a + 1, b), star: true };
    const wrapped = (isPunct(toks[a], '(') || isPunct(toks[a], '[')) && closeOf(a) === b - 1;
    const [x, y] = wrapped ? [a + 1, b - 1] : [a, b];
    if (wrapped || firstAt(T, x, y, (u) => isPunct(u, ',')) < y) return { k: 'tuple', items: partsBetween(T, x, y).map(([pa, pb]) => target(pa, pb)) };
    return value(a, b);
  };

  return { value, cond, target };
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
      if (w === 'return' || w === 'raise') { steps.push({ op: w, ...at, value: r.e > r.k + 1 ? R.value(r.k + 1, r.e) : null }); continue; }
      if (w === 'assert') { steps.push({ op: 'assert', ...at, cond: R.cond(r.k + 1, firstAt(T, r.k + 1, r.e, (y) => isPunct(y, ','))) }); continue; }
      if (w === 'break' || w === 'continue') { steps.push({ op: w, ...at }); continue; }
      if (w === 'pass') continue;
      if (w === 'import' || w === 'from') {
        const bindings = [];
        for (let q = r.i; q < r.e; q++) { countStep(); if (bindAt.has(q)) bindings.push(bindAt.get(q)); }
        steps.push({ op: 'import', ...at, bindings });
        continue;
      }
      if (w === 'del' || w === 'global' || w === 'nonlocal') { steps.push({ op: 'opaque', ...at, text: textOf(toks, r.i, r.e) }); continue; }
      steps.push(assignment(r.i, r.e, at));
    }
    return steps;
  };

  bodies[0].steps = lower(top);
  return bodies;
}
