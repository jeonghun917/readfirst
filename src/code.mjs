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
// The steps the reader takes: one for each character, token or bracket a loop of it passes. Off unless a test turns
// it on, and then a measure of the work that does not depend on the machine's speed (test/code.test.mjs reads it to
// see that the work grows with the text, not with its square). Work done inside a builtin (a slice, a regular
// expression) is not counted. countSteps(on) gives the count so far and starts again from zero, on or off.
let counting = false;
let steps = 0;
export function countSteps(on) { const n = steps; counting = on; steps = 0; return n; }
// One step of a reader built on this one's tokens (src/scopes.mjs), counted with this reader's own.
export function countStep() { if (counting) steps++; }
// One pass. lang is 'js' (JavaScript and TypeScript) or 'py'. Per line:
// - code: the line at the same length, with the insides of strings, template text, comments and regular expressions
//   as spaces. Names inside a template's `${ }` stay (they are code); the `${` and its `}` are spaces.
// - mark, per character: 'c' code, 'l' part of a literal, 't' the backtick that opens a template, 'p' code inside a
//   template's or an f-string's placeholder, 'o' and 'e' the `${` (`{`) that opens one and the `}` that ends it, ' '
//   nothing (a comment, or space). A Python placeholder's code is marked but left as spaces in `code`, as the rest of
//   its string is, so what reads `code` sees the line it saw before f-strings were read.
// - startsIn: '' or what the line begins inside: 'block' (a /* */ comment), 'template', 'string3' (Python's triple quotes),
//   'string' (a quoted string the line above carried on with a backslash at its end).
// - comment: part of the line is a comment. tplOpen: the line ends inside a template's `${ }`.
// - state: the state after the line. Passing it as the third argument goes on from the next line, so a hunk or a
//   file's second half reads as it does in the whole file.
const NO_TEMPLATES = Object.freeze([]);
export function lex(lines, lang, state = null) {
  const py = lang === 'py';
  let q = state?.q ?? null;
  const tpl = state?.tpl ? [...state.tpl] : [];
  let last = state?.last ?? '';
  // Python: the placeholders of f-strings open around (fs), and whether the string open is an f-string (fq) or raw.
  const fs = state?.fs ? state.fs.map((f) => ({ ...f })) : [];
  let fq = state?.fq ?? false;
  let raw = state?.raw ?? false;
  const out = [];
  for (const text of lines) {
    const startsIn = q === 'block' ? 'block' : q === '`' ? 'template' : q && q.length === 3 ? 'string3' : q === "'" || q === '"' ? 'string' : '';
    let carriesOn = false; // a quoted string whose line ends in a backslash goes on at the next line
    let code = '';
    let mark = '';
    let comment = false;
    let i = 0;
    const blank = (n = 1, m = ' ') => { code += ' '.repeat(n); mark += m.repeat(n); i += n; };
    const keep = (n = 1, m = 'c') => { code += text.slice(i, i + n); mark += m.repeat(n); i += n; };
    while (i < text.length) {
      if (counting) steps++;
      const c = text[i];
      if (py) {
        if (q) {
          // A backslash keeps the next character from ending the string, in a raw string too (`r'\''`); only a raw
          // f-string's `\{` still opens a placeholder.
          if (c === '\\' && !(raw && fq && text[i + 1] === '{')) { carriesOn = i === text.length - 1; blank(Math.min(2, text.length - i), 'l'); continue; }
          if (q.length === 3 ? text.startsWith(q, i) : c === q) { const n = q.length; q = null; fq = false; raw = false; if (fs.length) blank(n, 'l'); else keep(n, 'l'); continue; }
          // An f-string's `{` opens a placeholder (`{{` is a brace); its code is marked 'p', its `{` 'o' and `}` 'e'.
          if (fq && c === '{' && text[i + 1] !== '{') { fs.push({ q, raw, spec: false, depth: 0 }); q = null; fq = false; raw = false; blank(1, 'o'); continue; }
          if (fq && (c === '{' || c === '}') && text[i + 1] === c) { blank(2, 'l'); continue; }
          blank(1, 'l'); continue;
        }
        const f = fs.at(-1);
        if (f) {
          // Inside a placeholder: code to its `}` at its own depth, then the f-string goes on. After a `:` at that depth
          // the format spec is text, but a `{` in it opens a placeholder of its own; `!r`, `!s`, `!a` are text.
          const close = () => { fs.pop(); blank(1, 'e'); if (!fs.at(-1)?.spec) { q = f.q; raw = f.raw; fq = true; } };
          if (f.spec) {
            if (c === '{') { fs.push({ q: f.q, raw: f.raw, spec: false, depth: 0 }); blank(1, 'o'); continue; }
            if (c === '}') { close(); continue; }
            blank(1, 'l'); continue;
          }
          if (f.depth === 0 && c === '}') { close(); continue; }
          if (f.depth === 0 && c === ':') { f.spec = true; blank(1, 'l'); continue; }
          if (f.depth === 0 && c === '!' && /[rsa]/u.test(text[i + 1] ?? '') && /[:}]/u.test(text[i + 2] ?? '')) { blank(2, 'l'); continue; }
          if ('([{'.includes(c)) f.depth++;
          else if (')]}'.includes(c)) f.depth--;
        }
        if (c === '#' && !f) { comment = true; blank(text.length - i); break; }
        if (c === '"' || c === "'") {
          const n = text.startsWith(c.repeat(3), i) ? 3 : 1;
          // A prefix right before the quote (`f`, `rb`, `Rf`, `t`): f and t interpolate, r keeps backslashes.
          const prefix = /(?:^|[^\w])([A-Za-z]{1,2})$/u.exec(text.slice(Math.max(0, i - 3), i))?.[1] ?? '';
          const prefixed = /^(?:[rRbBuUfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/u.test(prefix);
          fq = prefixed && /[fFtT]/u.test(prefix);
          raw = prefixed && /[rR]/u.test(prefix);
          q = c.repeat(n);
          if (f) blank(n, 'l'); else keep(n, 'l');
          continue;
        }
        if (f) { blank(1, 'p'); continue; }
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
        else if (c === '$' && text[i + 1] === '{') { tpl.push(0); q = null; blank(2, 'o'); last = '{'; }
        else blank(1, 'l');
        continue;
      }
      if (q) { if (c === '\\') { carriesOn = i === text.length - 1; blank(Math.min(2, text.length - i), 'l'); } else if (c === q) { q = null; last = 'x'; keep(1, 'l'); } else blank(1, 'l'); continue; }
      if (c === '/' && text[i + 1] === '/') { comment = true; blank(text.length - i); break; }
      if (c === '/' && text[i + 1] === '*') { q = 'block'; comment = true; blank(2); continue; }
      if (c === '/' && text[i - 1] !== '<' && !(last === '}' && text[i + 1] === '>') && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/u.test(last) || REGEX_KEYWORD.test(code.trimEnd()))) { q = 're'; keep(1, 'l'); continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; keep(1, c === '`' ? 't' : 'l'); continue; }
      if (tpl.length) {
        if (c === '{') tpl[tpl.length - 1]++;
        else if (c === '}') { if (tpl[tpl.length - 1] === 0) { tpl.pop(); q = '`'; blank(1, 'e'); continue; } tpl[tpl.length - 1]--; }
      }
      if (!/\s/u.test(c) && !(c === '!' && last === 'x' && text[i + 1] !== '=' && !REGEX_KEYWORD.test(code.trimEnd()))) last = /[A-Za-z0-9_$)\]]/u.test(c) ? 'x' : c;
      keep(1, tpl.length ? 'p' : 'c'); // code inside a template's ${ } is part of that literal for the token walk
    }
    if (q === 're' || ((q === "'" || q === '"') && !carriesOn)) q = null;
    if (startsIn === 'block') comment = true;
    out.push({ code, mark, startsIn, comment, text, tplOpen: tpl.length > 0 || fs.length > 0, state: { q, tpl: tpl.length ? [...tpl] : NO_TEMPLATES, last, fs: fs.length ? fs.map((f) => ({ ...f })) : NO_TEMPLATES, fq, raw } });
  }
  return out;
}

// ---- tokens: the code of the lexed lines as words, punctuation and literals, each with its line and whether it is
// the first on its line. A literal (string, template text, regular expression) is one token whatever it holds; `text`
// is what it is written as on its first line.
// `>>` and `>>>` are left as single `>`: closing generics (`Promise<Res<T>>`) cannot be told from a shift here.
const OPS = ['...', '===', '!==', '**=', '<<=', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**'];
// With { placeholders: true }, the code of each placeholder (a template's `${ }`, an f-string's `{ }`) is given as
// tokens too, between a `(` and a `)` marked `synthetic`, after the literal it is in: `` `a ${x} b` `` is the literal,
// `(`, `x`, `)`. A string inside a placeholder is a literal of its own.
export function tokens(rows, from = 0, to = rows.length, { placeholders = false } = {}) {
  const out = [];
  let open = 0; // placeholders open (with { placeholders })
  const lits = []; // per depth of open placeholders, the literal read there: its rest after a placeholder joins it
  for (let l = from; l < to; l++) {
    const { code, mark, startsIn, text } = rows[l];
    let first = true;
    let carried = startsIn === 'template' || startsIn === 'string3' || startsIn === 'string' || (l > from && rows[l - 1].tplOpen);
    for (let i = 0; i < code.length;) {
      if (counting) steps++;
      const c = code[i];
      if (mark[i] === ' ' || (mark[i] === 'c' && /\s/u.test(c))) { i++; continue; }
      if (placeholders && mark[i] !== 'c') {
        const m = mark[i];
        const at = { line: l + 1, endLine: l + 1, first: false };
        if (m === 'o') { open++; lits[open] = null; out.push({ k: 'punct', v: '(', synthetic: true, ...at }); i += code.startsWith('${', i) || text.startsWith('${', i) ? 2 : 1; continue; }
        if (m === 'e') { lits[open] = null; open--; out.push({ k: 'punct', v: ')', synthetic: true, ...at }); i++; carried = Boolean(lits[open]); continue; }
        if (m === 'p') {
          lits[open] = null; // code after a literal in a placeholder: a later literal there is another
          // Code in a placeholder: a word, a number or punctuation, read from the line's text (a Python
          // placeholder's code is spaces in `code`).
          if (/\s/u.test(text[i])) { i++; continue; }
          let j = i + 1;
          if (/[\w$#]/u.test(text[i])) { while (j < code.length && /[\w$]/u.test(text[j]) && mark[j] === 'p') j++; const v = text.slice(i, j); out.push({ k: /^\d/u.test(v) ? 'val' : 'word', v, ...at }); }
          else { const v = OPS.find((o) => text.startsWith(o, i) && [...o].every((_, d) => mark[i + d] === 'p')) ?? text[i]; out.push({ k: 'punct', v, ...at }); j = i + v.length; }
          i = j;
          continue;
        }
        // Literal text: the rest of the literal at this depth (after a placeholder, or from the line above), or a new one.
        let j = i;
        while (j < code.length && /[lt]/u.test(mark[j])) j++;
        // The rest of a literal from the line above takes the line's start: what follows it is not first on its line.
        if (carried && lits[open]) { lits[open].endLine = l + 1; if (open === 0) first = false; }
        else if (open === 0 && carried && out.length && out.at(-1).k === 'val') { out.at(-1).endLine = l + 1; first = false; }
        else {
          const t = { k: 'val', v: m === 't' ? '`' : "''", line: l + 1, endLine: l + 1, first: open === 0 && first, text: text.slice(i, j) };
          out.push(t);
          lits[open] = t;
          if (open === 0) first = false;
        }
        carried = false;
        i = j;
        continue;
      }
      if (placeholders && open === 0) lits[0] = null;
      if (mark[i] !== 'c') {
        let j = i;
        while (j < code.length && (mark[j] !== 'c' && mark[j] !== ' ' || (mark[j] === ' ' && /[ltpoe]/u.test(mark[j + 1] ?? '') && /\s/u.test(code[j])))) j++;
        // The rest of a template or string that began on an earlier line is the same literal, not a new token.
        if (carried && out.length && out.at(-1).k === 'val') out.at(-1).endLine = l + 1;
        else { out.push({ k: 'val', v: mark[i] === 't' ? '`' : "''", line: l + 1, endLine: l + 1, first, text: rows[l].text.slice(i, j) }); first = false; }
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
export const needsMore = (t) => (t.k === 'punct' ? NEEDS_MORE.has(t.v) : t.k === 'word' && NEEDS_MORE_WORD.has(t.v));
export const continues = (t) => (t.k === 'punct' ? CONTINUES.has(t.v) : t.k === 'word' ? CONTINUES_WORD.has(t.v) : t.v === '`');
// After one of these a brace opens a type, not a body: `): { a: number } {`, `<T extends { id: string }>`.
const TYPE_BEFORE = new Set([':', '|', '&', ',', '<', '(', '=', '?', '[', '=>', 'extends', 'keyof', 'typeof', 'in', 'is', 'infer', 'readonly']);
// After one of these a brace in an expression opens an object (or a type), not a block of statements.
export const OBJECT_BEFORE = new Set(['(', '[', ',', '=', ':', '?', '{', '&', '|', '!', '+', '-', '*', '%', '<', '.', '...', '&&', '||', '??', '==', '===', '!=', '!==', 'return', 'case', 'yield', 'await', 'typeof', 'in', 'of', 'as', 'satisfies', 'default', 'export', 'import', 'from', 'type']);
// Words that begin a statement with a parenthesis after them. A class body is known to be one, so any name is a
// member there (`delete(id) {`, `catch(e) {`); whether a brace opened an object is read from the token before it, so
// there these words are taken as what they usually are.
const STATEMENT_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do', 'else', 'try', 'throw', 'typeof', 'await', 'yield', 'with', 'super', 'import']);
const STATEMENT_WORDS = new Set(['export', 'default', 'declare', 'async', 'abstract']);
const MEMBER_WORDS = new Set(['public', 'private', 'protected', 'static', 'async', 'override', 'readonly', 'abstract', 'declare', 'accessor', 'get', 'set']);

export const isWord = (t, v) => t?.k === 'word' && (v === undefined || t.v === v);
export const isPunct = (t, v) => t?.k === 'punct' && t.v === v;
// The token that closes the bracket opened at token k, or -1.
export function closeOf(toks, k) {
  let depth = 0;
  for (let j = k; j < toks.length; j++) {
    if (counting) steps++;
    if (toks[j].k !== 'punct') continue;
    if ('([{'.includes(toks[j].v)) depth++;
    else if (')]}'.includes(toks[j].v) && --depth === 0) return j;
  }
  return -1;
}
// Past type arguments or parameters `<...>` that open at k: the token after their `>`, or -1. The `<` and `>` are
// counted from k to the end of the tokens, a bracket passed whole (its match as closeOf finds it) and a closing one
// read past; a bracket that never closes, or the end, gives -1. The answers for a list of tokens are found once, for
// all its tokens (angleEnds): read from each `<`, a `<` left open went to the end every time, and `<` after `<`
// (`function f<a` line after line, members `m<a` in a class) took time growing with the square of the text.
const ANGLE_ENDS = new WeakMap();
export function afterAngle(toks, k) {
  if (counting) steps++;
  let ends = ANGLE_ENDS.get(toks);
  if (!ends) { ends = angleEnds(toks); ANGLE_ENDS.set(toks, ends); }
  return ends[k + 1];
}
// For each token j, where reading on from it first meets a `>` that no `<` read since opened: the token after that
// `>`, or -1. Filled from the last token back, so each answer is made of later ones: a `>` is its own; a `<` skips to
// past its own `>` and goes on from there; a bracket skips to past its match (bracketMatches, the matches closeOf
// gives); anything else is the next token's. The `<` at k is then closed by the answer for k + 1.
function angleEnds(toks) {
  const closes = bracketMatches(toks);
  const ends = new Int32Array(toks.length + 1).fill(-1);
  for (let j = toks.length - 1; j >= 0; j--) {
    if (counting) steps++;
    const t = toks[j];
    if (t.k === 'punct' && '([{'.includes(t.v)) ends[j] = closes.has(j) ? ends[closes.get(j) + 1] : -1;
    else if (isPunct(t, '>')) ends[j] = j + 1;
    else if (isPunct(t, '<')) ends[j] = ends[j + 1] < 0 ? -1 : ends[ends[j + 1]];
    else ends[j] = ends[j + 1];
  }
  return ends;
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
// awaited, or made on the spot (`(() => 1)()`) gives a value, not a function. The token where that function or class
// begins, or -1.
function valueFunctionAt(toks, k) {
  if (functionAt(toks, k)) return k;
  const endsAfter = (j) => {
    if (isWord(toks[j], 'as') || isWord(toks[j], 'satisfies')) return true; // a type follows, to the statement's end
    if (isPunct(toks[j], '!')) j++;
    const t = toks[j];
    return !t || (t.k === 'punct' && ';,)]}'.includes(t.v)) || (t.first && !continues(t));
  };
  const wrapped = (j) => (functionAt(toks, j) ? j : isPunct(toks[j], '(') && functionAt(toks, j + 1) ? j + 1 : -1); // `(fn) as T`
  if (isPunct(toks[k], '(')) { const c = closeOf(toks, k); return c > 0 && functionAt(toks, k + 1) && endsAfter(c + 1) ? k + 1 : -1; }
  if (!isWord(toks[k]) || ['await', 'new', 'typeof', 'yield', 'void', 'delete'].includes(toks[k].v)) return -1;
  let j = k + 1;
  for (;;) {
    if (counting) steps++;
    if ((isPunct(toks[j], '.') || isPunct(toks[j], '?.')) && isWord(toks[j + 1])) j += 2;
    else if (isPunct(toks[j], '[')) { j = closeOf(toks, j); if (j < 0) return -1; j++; }
    else if (isPunct(toks[j], '!')) j++;
    else break;
  }
  if (isPunct(toks[j], '<')) { j = afterAngle(toks, j); if (j < 0) return -1; }
  if (!isPunct(toks[j], '(')) return -1;
  const c = closeOf(toks, j);
  const at = c > 0 ? wrapped(j + 1) : -1;
  return at >= 0 && endsAfter(c + 1) ? at : -1;
}
// Where the parameters of the function that begins at token k open: the token of its `(`, or of its one parameter
// written without parentheses (`async url =>`), or -1 (a class, or no function there). Past `async`, `function`, a
// `*`, the function's name and its type parameters `<...>`.
function paramsOpen(toks, k) {
  if (k < 0) return -1;
  if (isWord(toks[k], 'async') && !isPunct(toks[k + 1], '=>')) k++;
  if (isWord(toks[k], 'class')) return -1;
  if (isWord(toks[k], 'function')) { k++; if (isPunct(toks[k], '*')) k++; if (isWord(toks[k])) k++; }
  if (isPunct(toks[k], '<')) { k = afterAngle(toks, k); if (k < 0) return -1; }
  if (isPunct(toks[k], '(')) return k;
  return isWord(toks[k]) && isPunct(toks[k + 1], '=>') ? k : -1;
}
// The parts of a bracket's inside, from token `from` to the one before `to`, split at its own commas: [start, end)
// pairs. A bracket inside is passed whole (closeOf), and so are type arguments (afterAngle): a `<` in a type, which
// begins after `as` or `satisfies` (`headers = {} as Record<string, string>`) and, in a parameter list (typed), after
// a parameter's `:` (`m: Map<string, number>`), up to its `=`; and a `<` right after `new Name`
// (`out = new Map<string, boolean>()`). py: a `lambda` in a default value has parameters of its own, to its `:`.
// close: what finds a bracket's match, closeOf unless the caller has the matches already (closesFrom).
function partsOf(toks, from, to, typed, py = false, close = closeOf) {
  const out = [];
  let start = from;
  let inType = false;
  let after = null; // 'new', 'name' or 'dot' while reading `new a.b`
  for (let j = from; j < to; j++) {
    if (counting) steps++;
    const t = toks[j];
    if (py && isWord(t, 'lambda')) {
      for (j++; j < to && !isPunct(toks[j], ':'); j++) if ((!counting || steps++ >= 0) && toks[j].k === 'punct' && '([{'.includes(toks[j].v)) { const c = close(toks, j); if (c < 0 || c >= to) return out; j = c; }
      continue;
    }
    if (t.k === 'word') {
      if (t.v === 'as' || t.v === 'satisfies') inType = true;
      after = t.v === 'new' ? 'new' : after === 'new' || after === 'dot' ? 'name' : null;
      continue;
    }
    if (t.k !== 'punct') { after = null; continue; }
    if (t.v === '.' && after === 'name') { after = 'dot'; continue; }
    const typeArguments = t.v === '<' && (inType || after === 'name');
    after = null;
    if ('([{'.includes(t.v)) { const c = close(toks, j); if (c < 0 || c >= to) return out; j = c; }
    else if (typeArguments) { const a = afterAngle(toks, j); if (a > 0 && a <= to) j = a - 1; }
    else if (typed && t.v === ':') inType = true;
    else if (t.v === '=') inType = false;
    else if (t.v === ',') { if (j > start) out.push([start, j]); start = j + 1; inType = false; }
  }
  if (to > start) out.push([start, to]);
  return out;
}
// The match of every bracket from the one at `open` to its own match, in one pass: a Map from each opening token to
// its closing token, the same matches closeOf gives one at a time. A bracket not closed by then is not in it.
function closesFrom(toks, open) {
  const at = new Map();
  const opened = [];
  for (let j = open; j < toks.length; j++) {
    if (counting) steps++;
    if (toks[j].k !== 'punct') continue;
    if ('([{'.includes(toks[j].v)) opened.push(j);
    else if (')]}'.includes(toks[j].v)) { at.set(opened.pop(), j); if (!opened.length) break; }
  }
  return at;
}
// The match of every bracket of a list of tokens, the same matches closeOf gives: closesFrom from each bracket that
// no other holds, which is passed whole. A bracket never closed holds the rest, which closesFrom has read already.
export function bracketMatches(toks) {
  const closes = new Map();
  for (let j = 0; j < toks.length; j++) {
    if (counting) steps++;
    if (toks[j].k !== 'punct' || !'([{'.includes(toks[j].v)) continue;
    const at = closesFrom(toks, j);
    for (const [open, close] of at) closes.set(open, close);
    if (!at.has(j)) break;
    j = at.get(j);
  }
  return closes;
}
// The names a destructuring pattern binds, from its bracket at `open`: { key, name } each. key: the property it is
// taken from (an object's key; null for an array's element and a `...rest`); an inner pattern's names take the key
// of the property it stands for (`{ user: { id } }` binds id with key user). The patterns inside are read from a
// stack of their own, not by calling this again (that ran out of the call stack 5,000 deep), and every bracket's
// match is found once (closesFrom), not again for each pattern around it, so the work grows with the text however
// deep it nests. The names come in the order they are written.
function patternNames(toks, open, outer) {
  const at = closesFrom(toks, open);
  const match = (_, j) => at.get(j) ?? -1;
  const out = [];
  const stack = []; // the patterns being read, the innermost last: its parts, the next to read, its kind and key
  const enter = (o, key) => { const c = match(toks, o); if (c >= 0) stack.push({ parts: partsOf(toks, o + 1, c, false, false, match), next: 0, object: isPunct(toks[o], '{'), outer: key }); };
  enter(open, outer);
  while (stack.length) {
    const f = stack.at(-1);
    if (f.next === f.parts.length) { stack.pop(); continue; }
    const [a, b] = f.parts[f.next++];
    if (counting) steps++;
    let k = a;
    if (isPunct(toks[k], '...')) { if (isWord(toks[k + 1])) out.push({ key: f.outer, name: toks[k + 1].v }); else if (isPunct(toks[k + 1], '{') || isPunct(toks[k + 1], '[')) enter(k + 1, f.outer); continue; }
    if (!f.object) {
      if (isWord(toks[k])) out.push({ key: f.outer, name: toks[k].v });
      else if (isPunct(toks[k], '{') || isPunct(toks[k], '[')) enter(k, f.outer);
      continue;
    }
    // A property: `key`, `key = x`, `key: name`, `key: { ... }`, `'key': name`, `[computed]: name`.
    let key = null;
    if (isWord(toks[k])) key = toks[k].v;
    else if (toks[k]?.k === 'val') key = toks[k].text?.match(/^(['"`])(.*)\1$/u)?.[2] ?? null;
    else if (isPunct(toks[k], '[')) { k = match(toks, k); if (k < 0) continue; }
    k++;
    if (isPunct(toks[k], ':') && k + 1 < b) {
      const v = toks[k + 1];
      if (isWord(v)) out.push({ key: f.outer ?? key, name: v.v });
      else if (isPunct(v, '{') || isPunct(v, '[')) enter(k + 1, f.outer ?? key);
    } else if (key !== null && isWord(toks[a])) out.push({ key: f.outer ?? key, name: key });
  }
  return out;
}
// Constructor parameter properties (`constructor(private readonly db: Db)`): the words before the name.
const PARAM_WORDS = new Set(['public', 'private', 'protected', 'readonly', 'override']);
// The parameters of a function from the token where they open (paramsOpen; for Python the `(` of the `def`): each
// { bindings: [{ key, name }], deco, rest, self, marker }. bindings: the names the parameter binds (a destructuring
// binds several). deco: the last part of the name of its first decorator (`@Body()`, `@Args('input')`), or null.
// rest: `...x`, `*args`, `**kwargs`. self: Python's first parameter named self or cls, JavaScript's `this`. marker:
// Python's bare `*` or `/` (no bindings). Types and default values are not read; what is input is not said here.
function paramsOf(toks, open, py) {
  if (open < 0 || !toks[open]) return undefined;
  if (!isPunct(toks[open], '(')) return [{ bindings: [{ key: null, name: toks[open].v }], deco: null, rest: false, self: false, marker: null }];
  const close = closeOf(toks, open);
  if (close < 0) return undefined;
  const out = [];
  for (const [a, b] of partsOf(toks, open + 1, close, true, py)) {
    if (counting) steps++;
    if (py && b - a === 1 && (isPunct(toks[a], '*') || isPunct(toks[a], '/'))) { out.push({ bindings: [], deco: null, rest: false, self: false, marker: toks[a].v }); continue; }
    let k = a;
    let deco = null;
    while (k < b && isPunct(toks[k], '@')) {
      k++;
      let last = null;
      while (k < b && isWord(toks[k])) { last = toks[k].v; if (isPunct(toks[k + 1], '.')) k += 2; else { k++; break; } }
      if (isPunct(toks[k], '(')) { const c = closeOf(toks, k); k = c < 0 ? b : c + 1; }
      deco ??= last;
    }
    while (k + 1 < b && isWord(toks[k]) && PARAM_WORDS.has(toks[k].v) && (isWord(toks[k + 1]) || isPunct(toks[k + 1], '{') || isPunct(toks[k + 1], '['))) k++;
    const rest = isPunct(toks[k], '...') || isPunct(toks[k], '**') || (py && isPunct(toks[k], '*'));
    if (rest) k++;
    let bindings = [];
    if (isWord(toks[k])) bindings = [{ key: null, name: toks[k].v }];
    else if (isPunct(toks[k], '{') || isPunct(toks[k], '[')) bindings = patternNames(toks, k, null);
    const name = bindings.length === 1 ? bindings[0].name : null;
    const self = out.length === 0 && !rest && (py ? name === 'self' || name === 'cls' : name === 'this');
    out.push({ bindings, deco, rest, self, marker: null });
  }
  return out;
}

// ---- JavaScript and TypeScript: one walk over the tokens with the brackets that are open, each knowing what it is
// (a block of statements, a class body, an object, a type body, a parenthesis). Declarations are read where the
// grammar has them: at a statement's start in a block, at a member's start in a class body or an object, and a
// named `function` or `class` that starts its line as a value. Each is closed by its own body, its `;`, the token
// pair at a line break, or the bracket around it.
function scanJs(toks, lastLine, wantParams = false) {
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
    if (counting) steps++;
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
      // module: the statement sets what the module exports as a whole (`export default`, `module.exports =`).
      f.cur = { rec: null, label: word(t, 'case') || word(t, 'default'), value: word(t, 'export') && word(toks[i + 1], 'default'), module: frames.length === 1 && ((word(t, 'export') && word(toks[i + 1], 'default')) || (word(t, 'module') && punct(toks[i + 1], '.') && word(toks[i + 2], 'exports') && punct(toks[i + 3], '='))) };
      const before = decls.length;
      if (f.kind === 'class') {
        let k = i;
        while (toks[k] && (toks[k].k === 'word' || punct(toks[k], '*'))) k++;
        const name = toks[k - 1];
        const mods = toks.slice(i, Math.max(i, k - 1)).every((m) => punct(m, '*') || MEMBER_WORDS.has(m.v));
        const at = punct(toks[k], '?') || punct(toks[k], '!') ? k + 1 : k; // `name?(` is an optional method
        const after = toks[at];
        if (k > i && word(name) && mods && (punct(after, '(') || punct(after, '<'))) { f.cur.rec = record(name.v, t.line, 'fn', 'block', own); f.cur.rec.open = paramsOpen(toks, at); }
      } else if (!punct(t, '{')) {
        let k = i;
        while (word(toks[k]) && STATEMENT_WORDS.has(toks[k].v) && !(toks[k].v === 'async' && !word(toks[k + 1], 'function'))) k++;
        const w = toks[k];
        const n = toks[k + 1];
        if (word(w, 'function')) { const nm = punct(n, '*') ? toks[k + 2] : n; if (word(nm)) { f.cur.rec = record(nm.v, t.line, 'fn', 'block', own); f.cur.rec.open = paramsOpen(toks, k); } }
        else if (word(w, 'class')) { if (word(n) && n.v !== 'extends' && n.v !== 'implements') f.cur.rec = record(n.v, t.line, 'class', 'block', own); else f.classHead = true; }
        else if ((word(w, 'interface') || word(w, 'enum')) && word(n) && !punct(n, '=')) { if (word(n)) f.cur.rec = record(n.v, t.line, w.v === 'enum' ? 'enum' : 'type', 'block', own); }
        else if (word(w, 'const') && word(n, 'enum') && word(toks[k + 2])) f.cur.rec = record(toks[k + 2].v, t.line, 'enum', 'block', own);
        else if (word(w, 'type') && word(n) && (punct(toks[k + 2], '=') || punct(toks[k + 2], '<'))) f.cur.rec = record(n.v, t.line, 'alias', 'statement', own);
        else if ((word(w, 'const') || word(w, 'let') || word(w, 'var')) && word(n)) f.cur.rec = record(n.v, t.line, 'var', 'statement', own);
        else if (word(w, 'exports') && punct(n, '.') && word(toks[k + 2]) && punct(toks[k + 3], '=')) { f.cur.rec = record(toks[k + 2].v, t.line, 'var', 'statement', own); f.cur.rec.ofModule = true; }
        else if (word(w, 'module') && punct(n, '.') && word(toks[k + 2], 'exports') && punct(toks[k + 3], '.') && word(toks[k + 4]) && punct(toks[k + 5], '=')) { f.cur.rec = record(toks[k + 4].v, t.line, 'var', 'statement', own); f.cur.rec.ofModule = true; }
      }
      if (decls.length > before && word(t, 'export')) decls.at(-1).exported = true;
    } else if (f.kind === 'object' && f.atStart && !(t.k === 'punct' && ')]}'.includes(t.v))) {
      // A member of an object: `name(...) {`, `async name(...) {`, `get name() {`, `*name() {`.
      f.atStart = false;
      let k = i;
      while (toks[k] && (toks[k].k === 'word' || punct(toks[k], '*'))) k++;
      const name = toks[k - 1];
      const mods = toks.slice(i, Math.max(i, k - 1)).every((m) => punct(m, '*') || m.v === 'async' || m.v === 'get' || m.v === 'set');
      if (k === i + 1 && word(name) && punct(toks[k], ':') && functionAt(toks, k + 1)) { f.member = record(name.v, t.line, 'fn', 'statement', t.first); f.member.member = true; f.member.fnValue = true; f.member.ofModule = Boolean(f.moduleOwn); f.member.open = paramsOpen(toks, k + 1); }
      if (k > i && word(name) && !STATEMENT_HEADS.has(name.v) && mods && (punct(toks[k], '(') || punct(toks[k], '<'))) f.pend = { name: name.v, line: t.line, what: 'fn', startsLine: t.first, open: paramsOpen(toks, k) };
    } else if (t.first && (word(t, 'function') || word(t, 'class') || (word(t, 'async') && word(toks[i + 1], 'function')))) {
      // A named function or class that starts its line as a value: `register(` / `function onDone() {`.
      const at = word(t, 'async') ? i + 1 : i;
      const nm = punct(toks[at + 1], '*') ? toks[at + 2] : toks[at + 1];
      if (word(nm) && nm.v !== 'extends' && nm.v !== 'implements') f.pend = { name: nm.v, line: t.line, what: toks[at].v === 'class' ? 'class' : 'fn', startsLine: true, open: paramsOpen(toks, i) };
      else if (toks[at].v === 'class') f.classHead = true;
    } else if (word(t, 'class') && !(f.cur?.rec?.what === 'class' && !f.cur.rec.bodied)) f.classHead = true;

    // A statement set to a function or class (valueIsFunction, read once at its `=`).
    if (punct(t, '=') && f.cur?.rec?.what === 'var' && !f.cur.rec.assigned) { const at = valueFunctionAt(toks, i + 1); f.cur.rec.fnValue = at >= 0; f.cur.rec.open = paramsOpen(toks, at); }
    if (punct(t, '=') && f.cur?.rec) f.cur.rec.assigned = true;
    // moduleOwn: the bracket is the value the module exports as a whole, or inside it (`export default wrap({ ... })`).
    const moduleOwn = (isStmt(f) && Boolean(f.cur?.module)) || Boolean(f.moduleOwn);
    if (punct(t, '(')) push('paren', { moduleOwn });
    else if (punct(t, '[')) push('bracket');
    else if (punct(t, '{')) {
      const before = prev ? prev.v : '';
      const waiting = f.pend ?? (f.cur?.rec?.form === 'block' && !f.cur.rec.bodied ? f.cur.rec : null);
      if (waiting && !TYPE_BEFORE.has(before)) {
        // The body of the declaration that is waiting for one.
        const rec = waiting === f.pend ? record(waiting.name, waiting.line, waiting.what, 'value', waiting.startsLine, true) : waiting;
        if (waiting === f.pend) rec.open = waiting.open;
        rec.bodied = true;
        f.pend = null;
        f.classHead = false;
        push(rec.what === 'class' ? 'class' : rec.what === 'type' || rec.what === 'enum' ? 'type' : 'block', { decl: rec });
      } else if ((waiting || f.classHead) && TYPE_BEFORE.has(before)) push('object'); // a type in a header
      else if (f.classHead) { f.classHead = false; push('class'); }
      // Inside a value (after a statement's `=`, after `export default`, in a parenthesis, bracket or object) a
      // brace is a block only after a parameter list or an arrow; a statement's own brace is read from what precedes it.
      else {
        const inValue = !isStmt(f) || f.cur?.value || (f.cur?.rec && f.cur.rec.form === 'statement' && f.cur.rec.assigned);
        const kind = opensStatement || (before === ':' && f.cur?.label) ? 'block' : (inValue ? before !== ')' && before !== '=>' : OBJECT_BEFORE.has(before)) ? 'object' : 'block';
        push(kind, kind === 'object' ? { moduleOwn } : {});
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
  // is read only when it is set to a function or class, or put on `exports` (a module written inside a wrapper
  // function, `define(function (require, exports) { exports.Mode = Mode })`, exports from there).
  const kept = new Map();
  for (const d of decls) {
    if (d.what === 'var' && d.local && !d.fnValue && !d.ofModule) continue;
    const s = { name: d.name, line: d.line, end: d.end, fn: d.what === 'fn' || d.fnValue, body: d.bodied || d.fnValue, value: d.form === 'value', what: d.what, exported: d.exported, member: d.member, ofModule: Boolean(d.ofModule), startsLine: d.startsLine, around: d.around };
    // Asked for only (params: true), so what declarations gives without it is unchanged.
    if (wantParams && s.fn) { const p = paramsOf(toks, d.open ?? -1, false); if (p) s.params = p; }
    kept.set(d, s);
  }
  // What is around each, among the declarations that are read.
  for (const s of kept.values()) { let a = s.around; while (a && !kept.has(a)) a = a.around; s.around = a ? kept.get(a) : null; }
  return [...kept.values()];
}

// ---- Python: a statement starts on a logical line (outside every bracket and string, not after a backslash).
// `def`, `async def` and `class` are read there at any indent; at column 0 also a name that is assigned or annotated.
const PY_KEYWORD = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class', 'return', 'import', 'from', 'pass', 'raise', 'assert', 'del', 'global', 'nonlocal', 'lambda', 'yield', 'await', 'async', 'not', 'and', 'or', 'in', 'is', 'match', 'case', 'print', 'break', 'continue', 'None', 'True', 'False']);
function scanPy(rows, raw, wantParams = false) {
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
    const d = { name: head ? head[2] : name[1], line: i + 1, end, fn: Boolean(head) && head[1] === 'def', body: Boolean(head), value: false, what: head ? (head[1] === 'def' ? 'fn' : 'class') : 'var', exported: false, member: false, ofModule: false, startsLine: true, around: null };
    // The parameters: the tokens of the `def`'s logical line, from its first `(`.
    if (wantParams && d.fn) { const toks = tokens(rows, i, last + 1); const p = paramsOf(toks, toks.findIndex((t) => isPunct(t, '(')), true); if (p) d.params = p; }
    decls.push(d);
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

// The files this reader has a grammar for. Any other language is read by its callers with their own, rougher means.
const READS = /\.(?:m?js|cjs|jsx|tsx?|mts|cts|vue|svelte|py)$/u;
export const reads = (path) => READS.test(path);

// The lexed lines of a whole file. In a .vue or .svelte file only the lines of its <script> blocks are code, each
// block lexed on its own; every other line has no code (`outside`). blocks: those blocks, or null for other files.
function rowsOf(path, raw) {
  if (!/\.(?:vue|svelte)$/u.test(path)) return { rows: lex(raw, /\.py$/u.test(path) ? 'py' : 'js'), blocks: null };
  const rows = raw.map((text) => ({ code: '', mark: '', startsIn: 'outside', comment: false, text, outside: true, state: null }));
  const blocks = scriptBlocks(raw);
  for (const b of blocks) lex(raw.slice(b.from, b.to), 'js').forEach((r, i) => { rows[b.from + i] = r; });
  return { rows, blocks };
}
// The same, for callers that want each line's code (`rows[i].code`) or to go on from a line's state.
export const codeRows = (path, body) => rowsOf(path, String(body).split('\n')).rows;
// What a file ends inside when the lexer cannot finish it ('a block comment', 'a template', 'a string'), or ''. Its
// declarations cannot be trusted then: one thing left open shifts everything after it.
export function unfinished(rows) {
  const s = rows.at(-1)?.state;
  if (!s) return '';
  return s.q === 'block' ? 'a block comment' : s.q === '`' || s.tpl.length ? 'a template' : s.q ? 'a string' : '';
}

// The declarations of a file, in the order they start. Each: name, line, end, top (the first line of the comment and
// decorators right above it, or its own line), what ('fn', 'class', 'type' for an interface, 'enum', 'alias' for
// `type N =`, 'var'), fn (a function, or a
// statement set to one), body (it has a body of its own: a function or class, or a statement set to one), value (a
// named function or class used as a value), exported, member, ofModule (it is what a CommonJS module puts on
// `exports`, or a property of the object a module exports as a whole), depth, parent and parentLine (the name and line of the
// declaration around it, or null). A value inside a function is read only when it is set to a function or class.
// members: also an object's properties set to a function (`save: async (row) => ...`).
// params: also, on each function, `params` (paramsOf): the names each parameter binds, read to the bracket that closes
// the list, however many lines and levels it takes. Without it the output is what it always was.
export function declarations(path, body, { members = false, params = false } = {}) {
  const py = /\.py$/u.test(path);
  const raw = body.split('\n');
  const { rows, blocks } = rowsOf(path, raw);
  let found;
  if (blocks) found = blocks.flatMap((b) => scanJs(tokens(rows, b.from, b.to), b.to, params));
  else found = py ? scanPy(rows, raw, params) : scanJs(tokens(rows), raw.length, params);
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
  // Nesting, from what the walk found around each. What is around a declaration starts before it or on its line and
  // ends no earlier, so it comes first in `found` and has its depth already: one step each, where walking the whole
  // chain for each declaration took the square of the nesting (classes and methods nested 16,000 deep took 2.6 seconds).
  const depthOf = (d) => { let n = 0; for (let a = d.around; a; a = a.around) { if (counting) steps++; n++; } return n; };
  for (const s of found) { s.depth = s.around ? (s.around.depth ?? depthOf(s.around)) + 1 : 0; s.parent = s.around?.name ?? null; s.parentLine = s.around?.line ?? null; }
  for (const s of found) { delete s.around; delete s.startsLine; }
  return found;
}

// What a line is about: the innermost declaration holding it (its comment above included) that is top-level or has a
// body of its own (a function or class, or a statement set to one); a local value is not a scope.
export function scopeOf(decls, line) {
  const holding = decls.filter((d) => d.top <= line && line <= d.end && (d.depth === 0 || (d.body && d.end > d.line)));
  return holding.sort((a, b) => b.depth - a.depth || b.line - a.line)[0] ?? null;
}

// An entry of a table: when the declaration `d` is set to an array or an object, the element or property of it that
// holds `line`, as { line, end, key }. The comment lines above an entry are part of it. key: a property's name, or
// the first string an element holds (`{ id: 'no-await', ... }`, `['no-await', ...]`), or null. Evidence that points
// into a long table is about that entry, and a text can name it by its key.
export function entryAt(path, body, d, line) {
  if (!reads(path) || line < d.line || line > d.end) return null;
  const off = d.line - 1;
  const toks = tokens(lex(String(body).split('\n').slice(off, d.end), /\.py$/u.test(path) ? 'py' : 'js'));
  let k = toks.findIndex((t) => isPunct(t, '='));
  if (k < 0 || !(isPunct(toks[k + 1], '[') || isPunct(toks[k + 1], '{'))) return null;
  k++;
  const close = closeOf(toks, k);
  if (close < 0) return null;
  const unquote = (t) => t?.text?.match(/^(['"`])(.*)\1$/u)?.[2] ?? null;
  let start = k + 1;
  let depth = 0;
  for (let j = k + 1; j <= close; j++) {
    const t = toks[j];
    if (j < close && t.k === 'punct' && '([{'.includes(t.v)) depth++;
    else if (j < close && t.k === 'punct' && ')]}'.includes(t.v)) depth--;
    if (j < close && !(depth === 0 && isPunct(t, ','))) continue;
    if (j > start) {
      const from = Math.min(toks[start].line, toks[start - 1].endLine + 1) + off;
      const to = toks[j - 1].endLine + off;
      if (from <= line && line <= to) {
        const named = isPunct(toks[start + 1], ':') ? (isWord(toks[start]) ? toks[start].v : unquote(toks[start])) : null;
        return { line: from, end: to, key: named ?? unquote(toks.slice(start, j).find((x) => unquote(x) !== null)) };
      }
    }
    start = j + 1;
  }
  return null;
}
