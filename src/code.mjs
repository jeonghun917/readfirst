// The one reader of code: where code is on each line (`lex`), where declarations start and end, the comment and
// decorators above each (`top`), what is around each (`parent`), and which declaration a line belongs to (`scopeOf`).
// One pass over the characters with the state carried from line to line, then one walk over the tokens with the
// brackets that are open. Nothing is matched against a single line, so text in a template, a string, a comment or a
// docstring is never taken for code, and a string, template, comment or bracket that runs over lines is one thing.
// No parser and no dependency; the work is linear in the text. JavaScript, TypeScript (JSX and TSX too), Python, and
// the <script> blocks of .vue and .svelte files.
//
// What it does not know, each a guess that test/code.test.mjs pins: JSX text on a line of its own outside
// parentheses; whether `/` after `)` divides or opens a regular expression; whether a `{` after something unusual
// opens a block or an object (a block taken for an object costs a declaration not read, never a false one).

const REGEX_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|do|else|void|delete|throw|yield|await|instanceof|new)$/u;
// One pass. lang is 'js' (JavaScript and TypeScript) or 'py'. Per line:
// - code: the line at the same length, with the insides of strings, template text, comments and regular expressions
//   as spaces. Names inside a template's `${ }` stay (they are code); the `${` and its `}` are spaces.
// - mark, per character: 'c' code, 'l' part of a literal, 't' the backtick that opens a template, 'p' code inside a
//   template's placeholder, ' ' nothing (a comment, or space).
// - startsIn: '' or what the line begins inside: 'block' (a /* */ comment), 'template', 'string3' (Python's triple quotes).
// - comment: part of the line is a comment. tplOpen: the line ends inside a template's `${ }`.
// - state: the state after the line. Passing it as the third argument goes on from the next line, so a hunk or a
//   file's second half reads as it does in the whole file.
const NO_TEMPLATES = Object.freeze([]);
export function lex(lines, lang, state = null) {
  const py = lang === 'py';
  let q = state?.q ?? null;
  const tpl = state?.tpl ? [...state.tpl] : [];
  let last = state?.last ?? '';
  const out = [];
  for (const text of lines) {
    const startsIn = q === 'block' ? 'block' : q === '`' ? 'template' : q && q.length === 3 ? 'string3' : '';
    let code = '';
    let mark = '';
    let comment = false;
    let i = 0;
    const blank = (n = 1, m = ' ') => { code += ' '.repeat(n); mark += m.repeat(n); i += n; };
    const keep = (n = 1, m = 'c') => { code += text.slice(i, i + n); mark += m.repeat(n); i += n; };
    while (i < text.length) {
      const c = text[i];
      if (py) {
        if (q) {
          if (c === '\\') { blank(Math.min(2, text.length - i), 'l'); continue; }
          if (q.length === 3 ? text.startsWith(q, i) : c === q) { const n = q.length; q = null; keep(n, 'l'); continue; }
          blank(1, 'l'); continue;
        }
        if (c === '#') { comment = true; blank(text.length - i); break; }
        if (c === '"' || c === "'") { const n = text.startsWith(c.repeat(3), i) ? 3 : 1; q = c.repeat(n); keep(n, 'l'); continue; }
        keep(); continue;
      }
      if (q === 'block') { if (c === '*' && text[i + 1] === '/') { q = null; blank(2); last = ''; } else blank(); continue; }
      if (q === 're') {
        if (c === '\\') blank(Math.min(2, text.length - i), 'l');
        else if (c === '[') {
          // A character class: `/` and `[` are text in it, and an escaped `]` does not close it.
          let end = i + 1;
          while (end < text.length && text[end] !== ']') end += text[end] === '\\' ? 2 : 1;
          blank(Math.min(end, text.length) - i, 'l');
        } else if (c === '/') {
          // The flags are part of the literal: `/x/is` is not followed by a word `is`.
          q = null; last = 'x'; keep(1, 'l');
          let n = 0;
          while (/[A-Za-z]/u.test(text[i + n] ?? '')) n++;
          if (n) blank(n, 'l');
        }
        else blank(1, 'l');
        continue;
      }
      if (q === '`') {
        if (c === '\\') blank(Math.min(2, text.length - i), 'l');
        else if (c === '`') { q = null; last = 'x'; keep(1, 'l'); }
        else if (c === '$' && text[i + 1] === '{') { tpl.push(0); q = null; blank(2, 'l'); last = '{'; }
        else blank(1, 'l');
        continue;
      }
      if (q) { if (c === '\\') blank(Math.min(2, text.length - i), 'l'); else if (c === q) { q = null; last = 'x'; keep(1, 'l'); } else blank(1, 'l'); continue; }
      if (c === '/' && text[i + 1] === '/') { comment = true; blank(text.length - i); break; }
      if (c === '/' && text[i + 1] === '*') { q = 'block'; comment = true; blank(2); continue; }
      if (c === '/' && text[i - 1] !== '<' && !(last === '}' && text[i + 1] === '>') && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/u.test(last) || REGEX_KEYWORD.test(code.trimEnd()))) { q = 're'; keep(1, 'l'); continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; keep(1, c === '`' ? 't' : 'l'); continue; }
      if (tpl.length) {
        if (c === '{') tpl[tpl.length - 1]++;
        else if (c === '}') { if (tpl[tpl.length - 1] === 0) { tpl.pop(); q = '`'; blank(1, 'l'); continue; } tpl[tpl.length - 1]--; }
      }
      if (!/\s/u.test(c) && !(c === '!' && last === 'x' && text[i + 1] !== '=' && !REGEX_KEYWORD.test(code.trimEnd()))) last = /[A-Za-z0-9_$)\]]/u.test(c) ? 'x' : c;
      keep(1, tpl.length ? 'p' : 'c'); // code inside a template's ${ } is part of that literal for the token walk
    }
    if (py ? q === "'" || q === '"' : q === "'" || q === '"' || q === 're') q = null;
    if (startsIn === 'block') comment = true;
    out.push({ code, mark, startsIn, comment, text, tplOpen: tpl.length > 0, state: { q, tpl: tpl.length ? [...tpl] : NO_TEMPLATES, last } });
  }
  return out;
}

// ---- tokens: the code of the lexed lines as words, punctuation and literals, each with its line and whether it is
// the first on its line. A literal (string, template text, regular expression) is one token whatever it holds.
// `>>` and `>>>` are left as single `>`: closing generics (`Promise<Res<T>>`) cannot be told from a shift here.
const OPS = ['...', '===', '!==', '**=', '<<=', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**'];
export function tokens(rows, from = 0, to = rows.length) {
  const out = [];
  for (let l = from; l < to; l++) {
    const { code, mark, startsIn } = rows[l];
    let first = true;
    let carried = startsIn === 'template' || startsIn === 'string3' || (l > from && rows[l - 1].tplOpen);
    for (let i = 0; i < code.length;) {
      const c = code[i];
      if (mark[i] === ' ' || (mark[i] === 'c' && /\s/u.test(c))) { i++; continue; }
      if (mark[i] !== 'c') {
        let j = i;
        while (j < code.length && (mark[j] !== 'c' && mark[j] !== ' ' || (mark[j] === ' ' && /[ltp]/u.test(mark[j + 1] ?? '') && /\s/u.test(code[j])))) j++;
        // The rest of a template or string that began on an earlier line is the same literal, not a new token.
        if (carried && out.length && out.at(-1).k === 'val') out.at(-1).endLine = l + 1;
        else { out.push({ k: 'val', v: mark[i] === 't' ? '`' : "''", line: l + 1, endLine: l + 1, first }); first = false; }
        carried = false;
        i = j;
        continue;
      }
      carried = false;
      let v;
      if (/[\w$#]/u.test(c)) { let j = i + 1; while (j < code.length && /[\w$]/u.test(code[j]) && mark[j] === 'c') j++; v = code.slice(i, j); out.push({ k: /^\d/u.test(v) ? 'val' : 'word', v, line: l + 1, endLine: l + 1, first }); i = j; }
      else { v = OPS.find((o) => code.startsWith(o, i)) ?? c; out.push({ k: 'punct', v, line: l + 1, endLine: l + 1, first }); i += v.length; }
      first = false;
    }
  }
  return out;
}

// Where a line break does not end a statement: the token before it needs more, or the token after it can only
// continue what stands (the pair automatic semicolon insertion looks at).
const NEEDS_MORE = new Set(['=>', '=', '(', '[', '{', ',', '+', '-', '*', '/', '%', '?', ':', '&', '|', '.', '?.', '<', '^', '...', '==', '===', '!=', '!==', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '**=', '<<=', '&&=', '||=', '??=']);
const NEEDS_MORE_WORD = new Set(['extends', 'implements', 'as', 'satisfies', 'keyof', 'typeof', 'infer', 'in', 'of', 'instanceof', 'is', 'new']);
const CONTINUES = new Set(['?', ':', '.', '?.', '>', ',', '(', '[', ')', ']', '}', '{', '&&', '||', '??', '+', '-', '*', '/', '%', '|', '&', '^', '=', '=>', '==', '===', '!=', '!==', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '**=', '&&=', '||=', '??=']);
const CONTINUES_WORD = new Set(['extends', 'implements', 'in', 'instanceof']);
const needsMore = (t) => (t.k === 'punct' ? NEEDS_MORE.has(t.v) : t.k === 'word' && NEEDS_MORE_WORD.has(t.v));
const continues = (t) => (t.k === 'punct' ? CONTINUES.has(t.v) : t.k === 'word' ? CONTINUES_WORD.has(t.v) : t.v === '`');
// After one of these a brace opens a type, not a body: `): { a: number } {`, `<T extends { id: string }>`.
const TYPE_BEFORE = new Set([':', '|', '&', ',', '<', '(', '=', '?', '[', '=>', 'extends', 'keyof', 'typeof', 'in', 'is', 'infer', 'readonly']);
// After one of these a brace in an expression opens an object (or a type), not a block of statements.
const OBJECT_BEFORE = new Set(['(', '[', ',', '=', ':', '?', '{', '&', '|', '!', '+', '-', '*', '%', '<', '.', '...', '&&', '||', '??', '==', '===', '!=', '!==', 'return', 'case', 'yield', 'await', 'typeof', 'in', 'of', 'as', 'satisfies', 'default', 'export', 'import', 'from', 'type']);
// Words that begin a statement with a parenthesis after them. A class body is known to be one, so any name is a
// member there (`delete(id) {`, `catch(e) {`); whether a brace opened an object is read from the token before it, so
// there these words are taken as what they usually are.
const STATEMENT_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do', 'else', 'try', 'throw', 'typeof', 'await', 'yield', 'with', 'super', 'import']);
const STATEMENT_WORDS = new Set(['export', 'default', 'declare', 'async', 'abstract']);
const MEMBER_WORDS = new Set(['public', 'private', 'protected', 'static', 'async', 'override', 'readonly', 'abstract', 'declare', 'accessor', 'get', 'set']);

const isWord = (t, v) => t?.k === 'word' && (v === undefined || t.v === v);
const isPunct = (t, v) => t?.k === 'punct' && t.v === v;
// The token that closes the bracket opened at token k, or -1.
export function closeOf(toks, k) {
  let depth = 0;
  for (let j = k; j < toks.length; j++) {
    if (toks[j].k !== 'punct') continue;
    if ('([{'.includes(toks[j].v)) depth++;
    else if (')]}'.includes(toks[j].v) && --depth === 0) return j;
  }
  return -1;
}
// Past type arguments or parameters `<...>` that open at k: the token after their `>`, or -1.
function afterAngle(toks, k) {
  let depth = 0;
  for (let j = k; j < toks.length; j++) {
    if (isPunct(toks[j], '<')) depth++;
    else if (isPunct(toks[j], '>')) { if (--depth === 0) return j + 1; }
    else if (toks[j].k === 'punct' && '([{'.includes(toks[j].v)) { j = closeOf(toks, j); if (j < 0) return -1; }
  }
  return -1;
}
// Whether a function or class begins at token k: `function`, `class`, or an arrow function, which is
// [async] [<T>] (parameters) followed by `=>` or by `:` (a return type), or [async] name `=>`.
function functionAt(toks, k) {
  if (isWord(toks[k], 'async')) k++;
  if (isWord(toks[k], 'function') || isWord(toks[k], 'class')) return true;
  if (isPunct(toks[k], '<')) { k = afterAngle(toks, k); if (k < 0 || !isPunct(toks[k], '(')) return false; }
  if (isPunct(toks[k], '(')) { const c = closeOf(toks, k); return c > 0 && (isPunct(toks[c + 1], '=>') || isPunct(toks[c + 1], ':')); }
  return isWord(toks[k]) && isPunct(toks[k + 1], '=>');
}
// Whether the value that begins at token k is a function or class: it is one; or it is one in parentheses
// (`(async () => { ... }) as T`); or it is one call on a plain name with one as its first argument and nothing after
// the call (`memo(() => ...)`, `list.filter((x) => ...)`). A call that is passed on (`.map(f).filter(Boolean)`),
// awaited, or made on the spot (`(() => 1)()`) gives a value, not a function.
function valueIsFunction(toks, k) {
  if (functionAt(toks, k)) return true;
  const endsAfter = (j) => {
    if (isWord(toks[j], 'as') || isWord(toks[j], 'satisfies')) return true; // a type follows, to the statement's end
    if (isPunct(toks[j], '!')) j++;
    const t = toks[j];
    return !t || (t.k === 'punct' && ';,)]}'.includes(t.v)) || (t.first && !continues(t));
  };
  const wrapped = (j) => functionAt(toks, j) || (isPunct(toks[j], '(') && functionAt(toks, j + 1)); // `(fn) as T`
  if (isPunct(toks[k], '(')) { const c = closeOf(toks, k); return c > 0 && functionAt(toks, k + 1) && endsAfter(c + 1); }
  if (!isWord(toks[k]) || ['await', 'new', 'typeof', 'yield', 'void', 'delete'].includes(toks[k].v)) return false;
  let j = k + 1;
  for (;;) {
    if ((isPunct(toks[j], '.') || isPunct(toks[j], '?.')) && isWord(toks[j + 1])) j += 2;
    else if (isPunct(toks[j], '[')) { j = closeOf(toks, j); if (j < 0) return false; j++; }
    else if (isPunct(toks[j], '!')) j++;
    else break;
  }
  if (isPunct(toks[j], '<')) { j = afterAngle(toks, j); if (j < 0) return false; }
  if (!isPunct(toks[j], '(')) return false;
  const c = closeOf(toks, j);
  return c > 0 && wrapped(j + 1) && endsAfter(c + 1);
}

// ---- JavaScript and TypeScript: one walk over the tokens with the brackets that are open, each knowing what it is
// (a block of statements, a class body, an object, a type body, a parenthesis). Declarations are read where the
// grammar has them: at a statement's start in a block, at a member's start in a class body or an object, and a
// named `function` or `class` that starts its line as a value. Each is closed by its own body, its `;`, the token
// pair at a line break, or the bracket around it.
function scanJs(toks, lastLine) {
  const decls = [];
  const frames = [{ kind: 'block', atStart: true, cur: null, pend: null, deco: 0 }];
  let prev = null;
  const push = (kind, extra = {}) => frames.push({ kind, atStart: true, cur: null, pend: null, member: null, deco: 0, ...extra });
  const isStmt = (f) => f.kind === 'block' || f.kind === 'class';
  const endStatement = (f, line) => {
    if (f.cur?.rec && f.cur.rec.end === null) f.cur.rec.end = line;
    f.cur = null; f.pend = null; f.atStart = true; f.deco = 0; f.decoFirst = null; f.classHead = false;
  };
  // What is around a declaration that starts now: the body it is in, or the statement or member still open in a
  // bracket further out (`exports.is = (() => { const check = ...` is inside `is`). Read here, from the open
  // brackets, because two declarations on one line cannot be told apart by their lines. `own`: the statement open in
  // this very bracket is around it too (a named function used as a value inside `const run =`).
  const around = (own) => {
    for (let k = frames.length - 1; k >= 0; k--) {
      const g = frames[k];
      if (own || k < frames.length - 1) { if (g.cur?.rec) return g.cur.rec; if (g.member) return g.member; }
      if (g.decl) return g.decl;
    }
    return null;
  };
  // startsLine: nothing stands before it on its line, so the comment lines above that line are its own.
  const record = (name, line, what, form, startsLine, own = false) => { const rec = { name, line, end: null, what, form, bodied: false, fnValue: false, assigned: false, local: frames.length > 1, exported: false, member: false, startsLine, around: around(own) }; decls.push(rec); return rec; };
  const word = isWord;
  const punct = isPunct;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let f = frames.at(-1);
    // A line break that ends the statement in progress.
    if (t.first && isStmt(f) && !f.atStart && prev && !needsMore(prev) && !continues(t)) endStatement(f, prev.endLine);
    if (punct(t, ';') && isStmt(f)) { endStatement(f, t.first && prev ? prev.endLine : t.line); prev = t; continue; }
    // A comma ends an object's member, unless a method is still waiting for its body (`set(): Either<A, B> {`).
    if (punct(t, ',') && f.kind === 'object' && !f.pend) { if (f.member) { f.member.end = prev.endLine; f.member = null; } f.atStart = true; prev = t; continue; }

    // Decorators before a statement or a member: `@name`, `@a.b`, `@name(...)`.
    if (isStmt(f) && f.atStart) {
      if (punct(t, '@')) { f.deco = 1; f.decoFirst ??= t.first; prev = t; continue; }
      if (f.deco === 1 && t.k === 'word') { f.deco = 2; prev = t; continue; }
      if (f.deco === 2 && punct(t, '.')) { f.deco = 1; prev = t; continue; }
      if (f.deco === 2 && punct(t, '(')) { f.deco = 0; push('paren', { decorator: true }); prev = t; continue; }
      f.deco = 0;
    }

    let opensStatement = false;
    if (isStmt(f) && f.atStart && !(t.k === 'punct' && ')]}'.includes(t.v))) {
      // The start of a statement or of a class member.
      opensStatement = true;
      f.atStart = false;
      const own = t.first || f.decoFirst === true; // its decorators began the line
      f.decoFirst = null;
      f.cur = { rec: null, label: word(t, 'case') || word(t, 'default'), value: word(t, 'export') && word(toks[i + 1], 'default') };
      const before = decls.length;
      if (f.kind === 'class') {
        let k = i;
        while (toks[k] && (toks[k].k === 'word' || punct(toks[k], '*'))) k++;
        const name = toks[k - 1];
        const mods = toks.slice(i, Math.max(i, k - 1)).every((m) => punct(m, '*') || MEMBER_WORDS.has(m.v));
        const after = punct(toks[k], '?') || punct(toks[k], '!') ? toks[k + 1] : toks[k]; // `name?(` is an optional method
        if (k > i && word(name) && mods && (punct(after, '(') || punct(after, '<'))) f.cur.rec = record(name.v, t.line, 'fn', 'block', own);
      } else if (!punct(t, '{')) {
        let k = i;
        while (word(toks[k]) && STATEMENT_WORDS.has(toks[k].v) && !(toks[k].v === 'async' && !word(toks[k + 1], 'function'))) k++;
        const w = toks[k];
        const n = toks[k + 1];
        if (word(w, 'function')) { const nm = punct(n, '*') ? toks[k + 2] : n; if (word(nm)) f.cur.rec = record(nm.v, t.line, 'fn', 'block', own); }
        else if (word(w, 'class')) { if (word(n) && n.v !== 'extends' && n.v !== 'implements') f.cur.rec = record(n.v, t.line, 'class', 'block', own); else f.classHead = true; }
        else if ((word(w, 'interface') || word(w, 'enum')) && word(n) && !punct(n, '=')) { if (word(n)) f.cur.rec = record(n.v, t.line, 'type', 'block', own); }
        else if (word(w, 'const') && word(n, 'enum') && word(toks[k + 2])) f.cur.rec = record(toks[k + 2].v, t.line, 'type', 'block', own);
        else if (word(w, 'type') && word(n) && (punct(toks[k + 2], '=') || punct(toks[k + 2], '<'))) f.cur.rec = record(n.v, t.line, 'alias', 'statement', own);
        else if ((word(w, 'const') || word(w, 'let') || word(w, 'var')) && word(n)) f.cur.rec = record(n.v, t.line, 'var', 'statement', own);
        else if (word(w, 'exports') && punct(n, '.') && word(toks[k + 2]) && punct(toks[k + 3], '=')) f.cur.rec = record(toks[k + 2].v, t.line, 'var', 'statement', own);
        else if (word(w, 'module') && punct(n, '.') && word(toks[k + 2], 'exports') && punct(toks[k + 3], '.') && word(toks[k + 4]) && punct(toks[k + 5], '=')) f.cur.rec = record(toks[k + 4].v, t.line, 'var', 'statement', own);
      }
      if (decls.length > before && word(t, 'export')) decls.at(-1).exported = true;
    } else if (f.kind === 'object' && f.atStart && !(t.k === 'punct' && ')]}'.includes(t.v))) {
      // A member of an object: `name(...) {`, `async name(...) {`, `get name() {`, `*name() {`.
      f.atStart = false;
      let k = i;
      while (toks[k] && (toks[k].k === 'word' || punct(toks[k], '*'))) k++;
      const name = toks[k - 1];
      const mods = toks.slice(i, Math.max(i, k - 1)).every((m) => punct(m, '*') || m.v === 'async' || m.v === 'get' || m.v === 'set');
      if (k === i + 1 && word(name) && punct(toks[k], ':') && functionAt(toks, k + 1)) { f.member = record(name.v, t.line, 'fn', 'statement', t.first); f.member.member = true; f.member.fnValue = true; }
      if (k > i && word(name) && !STATEMENT_HEADS.has(name.v) && mods && (punct(toks[k], '(') || punct(toks[k], '<'))) f.pend = { name: name.v, line: t.line, what: 'fn', startsLine: t.first };
    } else if (t.first && (word(t, 'function') || word(t, 'class') || (word(t, 'async') && word(toks[i + 1], 'function')))) {
      // A named function or class that starts its line as a value: `register(` / `function onDone() {`.
      const at = word(t, 'async') ? i + 1 : i;
      const nm = punct(toks[at + 1], '*') ? toks[at + 2] : toks[at + 1];
      if (word(nm) && nm.v !== 'extends' && nm.v !== 'implements') f.pend = { name: nm.v, line: t.line, what: toks[at].v === 'class' ? 'class' : 'fn', startsLine: true };
      else if (toks[at].v === 'class') f.classHead = true;
    } else if (word(t, 'class') && !(f.cur?.rec?.what === 'class' && !f.cur.rec.bodied)) f.classHead = true;

    // A statement set to a function or class (valueIsFunction, read once at its `=`).
    if (punct(t, '=') && f.cur?.rec?.what === 'var' && !f.cur.rec.assigned) f.cur.rec.fnValue = valueIsFunction(toks, i + 1);
    if (punct(t, '=') && f.cur?.rec) f.cur.rec.assigned = true;
    if (punct(t, '(')) push('paren');
    else if (punct(t, '[')) push('bracket');
    else if (punct(t, '{')) {
      const before = prev ? prev.v : '';
      const waiting = f.pend ?? (f.cur?.rec?.form === 'block' && !f.cur.rec.bodied ? f.cur.rec : null);
      if (waiting && !TYPE_BEFORE.has(before)) {
        // The body of the declaration that is waiting for one.
        const rec = waiting === f.pend ? record(waiting.name, waiting.line, waiting.what, 'value', waiting.startsLine, true) : waiting;
        rec.bodied = true;
        f.pend = null;
        f.classHead = false;
        push(rec.what === 'class' ? 'class' : rec.what === 'type' ? 'type' : 'block', { decl: rec });
      } else if ((waiting || f.classHead) && TYPE_BEFORE.has(before)) push('object'); // a type in a header
      else if (f.classHead) { f.classHead = false; push('class'); }
      // Inside a value (after a statement's `=`, after `export default`, in a parenthesis, bracket or object) a
      // brace is a block only after a parameter list or an arrow; a statement's own brace is read from what precedes it.
      else {
        const inValue = !isStmt(f) || f.cur?.value || (f.cur?.rec && f.cur.rec.form === 'statement' && f.cur.rec.assigned);
        push(opensStatement || (before === ':' && f.cur?.label) ? 'block' : (inValue ? before !== ')' && before !== '=>' : OBJECT_BEFORE.has(before)) ? 'object' : 'block');
      }
    } else if (t.k === 'punct' && ')]}'.includes(t.v) && frames.length > 1) {
      const g = frames.pop();
      if (g.member) g.member.end = prev.endLine;
      if (isStmt(g) && g.cur) endStatement(g, prev.endLine);
      f = frames.at(-1);
      if (g.decl) {
        g.decl.end = t.line;
        // A declaration that is the whole statement ends the statement with its body.
        if (f.cur?.rec === g.decl) { f.cur = null; f.atStart = true; }
      }
      if (g.decorator) { f.atStart = true; f.cur = null; }
    }
    prev = t;
  }
  for (const f of frames) if (f.cur?.rec && f.cur.rec.end === null) f.cur.rec.end = prev ? prev.endLine : lastLine;
  for (const d of decls) if (d.end === null) d.end = lastLine;
  // Which of them readfirst reads is a choice, made in this one line: a value inside a function or block (`const n = 1`)
  // is read only when it is set to a function or class.
  const kept = new Map();
  for (const d of decls) if (!(d.what === 'var' && d.local && !d.fnValue)) kept.set(d, { name: d.name, line: d.line, end: d.end, fn: d.what === 'fn' || d.fnValue, body: d.bodied || d.fnValue, value: d.form === 'value', what: d.what, exported: d.exported, member: d.member, startsLine: d.startsLine, around: d.around });
  // What is around each, among the declarations that are read.
  for (const s of kept.values()) { let a = s.around; while (a && !kept.has(a)) a = a.around; s.around = a ? kept.get(a) : null; }
  return [...kept.values()];
}

// ---- Python: a statement starts on a logical line (outside every bracket and string, not after a backslash).
// `def`, `async def` and `class` are read there at any indent; at column 0 also a name that is assigned or annotated.
const PY_KEYWORD = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class', 'return', 'import', 'from', 'pass', 'raise', 'assert', 'del', 'global', 'nonlocal', 'lambda', 'yield', 'await', 'async', 'not', 'and', 'or', 'in', 'is', 'match', 'case', 'print', 'break', 'continue', 'None', 'True', 'False']);
function scanPy(rows, raw) {
  const decls = [];
  const indent = (i) => raw[i].match(/^\s*/u)[0].length;
  const starts = []; // which lines start a logical line
  let depth = 0;
  let joined = false;
  for (let i = 0; i < rows.length; i++) {
    starts.push(depth === 0 && !joined && !rows[i].startsIn && Boolean(rows[i].code.trim()));
    for (const c of rows[i].code) { if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth = Math.max(0, depth - 1); }
    joined = /\\\s*$/u.test(rows[i].code);
  }
  for (let i = 0; i < rows.length; i++) {
    if (!starts[i]) continue;
    const code = rows[i].code;
    const head = code.match(/^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/u);
    const name = head ? null : indent(i) === 0 ? code.match(/^([A-Za-z_]\w*)\s*(?:=(?!=)|:\s*\S)/u) : null;
    if (!head && !(name && !PY_KEYWORD.has(name[1]))) continue;
    // The logical line: the lines after it that are still inside its brackets, its string or a backslash join.
    let last = i;
    let open = 0;
    for (let k = i; k < rows.length; k++) {
      if (k > i && (starts[k] || !(open > 0 || rows[k].startsIn || /\\\s*$/u.test(rows[k - 1].code)))) break;
      last = k;
      for (const c of rows[k].code) { if ('([{'.includes(c)) open++; else if (')]}'.includes(c)) open--; }
    }
    let end = last + 1;
    if (head) {
      // The body: every line until the next logical line indented no deeper.
      for (let k = last + 1; k < rows.length; k++) {
        if (starts[k] && indent(k) <= indent(i)) break;
        if (rows[k].code.trim() || rows[k].startsIn) end = k + 1;
      }
    }
    decls.push({ name: head ? head[2] : name[1], line: i + 1, end, fn: Boolean(head) && head[1] === 'def', body: Boolean(head), value: false, what: head ? (head[1] === 'def' ? 'fn' : 'class') : 'var', exported: false, member: false, startsLine: true, around: null });
  }
  // One statement to a logical line, so what is around each is the nearest earlier one whose lines hold it.
  const open = [];
  for (const d of decls) {
    while (open.length && open.at(-1).end < d.line) open.pop();
    d.around = open.at(-1) ?? null;
    open.push(d);
  }
  return decls;
}
// The <script> blocks of a .vue or .svelte file: { from, to } as line indexes of the code between the tags, and the
// language its tag names. Everything else in such a file is markup or styles, not code.
export function scriptBlocks(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (!/^\s*<script\b/u.test(raw[i])) continue;
    let k = i;
    while (k < raw.length && !/>\s*$/u.test(raw[k])) k++; // a tag whose attributes run over lines
    const tag = raw.slice(i, k + 1).join(' ');
    let j = k + 1;
    while (j < raw.length && !/^\s*<\/script>/u.test(raw[j])) j++;
    if (k > j || /<\/script>/u.test(raw[k])) { i = k; continue; } // opened and closed on one line: not read
    out.push({ from: k + 1, to: j, lang: tag.match(/\blang=["']?(\w+)/u)?.[1] ?? 'js' });
    i = j;
  }
  return out;
}

// The declarations of a file, in the order they start. Each: name, line, end, top (the first line of the comment and
// decorators right above it, or its own line), what ('fn', 'class', 'type', 'alias', 'var'), fn (a function, or a
// statement set to one), body (it has a body of its own: a function or class, or a statement set to one), value (a
// named function or class used as a value), exported, member, depth, parent and parentLine (the name and line of the
// declaration around it, or null). A value inside a function is read only when it is set to a function or class.
// members: also an object's properties set to a function (`save: async (row) => ...`).
export function declarations(path, body, { members = false } = {}) {
  const py = /\.py$/u.test(path);
  const raw = body.split('\n');
  let rows;
  let found;
  if (/\.(?:vue|svelte)$/u.test(path)) {
    rows = raw.map((text) => ({ code: '', mark: '', startsIn: 'outside', comment: false, text, outside: true }));
    found = [];
    for (const b of scriptBlocks(raw)) {
      lex(raw.slice(b.from, b.to), 'js').forEach((r, i) => { rows[b.from + i] = r; });
      found.push(...scanJs(tokens(rows, b.from, b.to), b.to));
    }
  } else {
    rows = lex(raw, py ? 'py' : 'js');
    found = py ? scanPy(rows, raw) : scanJs(tokens(rows), raw.length);
  }
  if (!members) {
    const gone = new Set(found.filter((d) => d.member));
    found = found.filter((d) => !gone.has(d));
    for (const d of found) while (d.around && gone.has(d.around)) d.around = d.around.around;
  }
  found.sort((a, b) => a.line - b.line || b.end - a.end);
  const blankOrComment = (i) => !rows[i].code.trim();
  for (const s of found) {
    // Its top: the comment lines and decorators right above, with no blank line between. Only the first declaration
    // on a line has one: a comment belongs to what follows it, and a second statement on the line follows the first.
    let top = s.line;
    for (; s.startsLine;) {
      const above = top - 2;
      if (above < 0 || rows[above].outside || (!raw[above].trim() && rows[above].startsIn !== 'block')) break; // an empty line inside a /* */ is still the comment
      if (blankOrComment(above) || /^\s*@/u.test(rows[above].code)) { top--; continue; }
      // The last line of a decorator written over lines (`@Module({` ... `})`): go up to the line that opens it.
      let depth = 0;
      let k = above;
      for (; k >= 0; k--) {
        for (const c of rows[k].code) { if (')]}'.includes(c)) depth++; else if ('([{'.includes(c)) depth--; }
        if (depth <= 0) break;
      }
      if (k < 0 || depth !== 0 || k === above || !/^\s*@/u.test(rows[k].code)) break;
      top = k + 1;
    }
    s.top = top;
  }
  // Nesting, from what the walk found around each.
  const depthOf = (d) => { let n = 0; for (let a = d.around; a; a = a.around) n++; return n; };
  for (const s of found) { s.depth = depthOf(s); s.parent = s.around?.name ?? null; s.parentLine = s.around?.line ?? null; }
  for (const s of found) { delete s.around; delete s.startsLine; }
  return found;
}

// What a line is about: the innermost declaration holding it (its comment above included) that is top-level or has a
// body of its own (a function or class, or a statement set to one); a local value is not a scope.
export function scopeOf(decls, line) {
  const holding = decls.filter((d) => d.top <= line && line <= d.end && (d.depth === 0 || (d.body && d.end > d.line)));
  return holding.sort((a, b) => b.depth - a.depth || b.line - a.line)[0] ?? null;
}
