// The bug shapes `readfirst scan` looks for, without a model: a line that computes a new value and drops it (a Django
// QuerySet .filter(), a string .replace() or .strip()), and a test assertion on a promise that nothing waits for.
// These are the shapes already published in readfirst's write-ups; the hosted version (readfirst-cloud, Pro and the
// one-off audit) runs more, through this file's machinery: `candidates` and `discardedResults` take the list of
// patterns to look for. What is code on a line, and where a function's body is, comes from the one reader
// (src/code.mjs); nothing here skips a string or a comment by itself.
import { createHash } from 'node:crypto';
import { declarations, lex, tokens } from './code.mjs';

export const PATTERNS_VERSION = 'patterns-7';
// Patterns about test code: the audit and the pattern bank read test files for these and for nothing else.
export const TEST_PATTERNS = () => new Set(PATTERNS.filter((p) => p.tests).map((p) => p.id));

const PY = /\.py$/u;
const JS = /\.(?:[cm]?[jt]sx?)$/u;
const lineHash = (text) => createHash('sha256').update(String(text).trim()).digest('hex').slice(0, 16);

// A receiver chain with no spaces: a name, attributes, calls and subscripts (Model.objects.filter(a=1), df["x"]).
const RECV = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]\n]*\]|\((?:[^()\n]|\([^()\n]*\))*\))*`;

const QS_METHODS = 'filter|exclude|order_by|annotate|distinct|select_related|prefetch_related|only|defer|values|values_list|using|alias';

export const PATTERNS = [
  {
    id: 'queryset', lang: PY,
    head: new RegExp(`^(${RECV})\\.(${QS_METHODS})\\(`, 'u'),
    // Only on something that is a queryset: the chain goes through .objects or a related manager, or the name was
    // assigned from one in this file.
    queryset: true,
    why: (m) => `\`.${m}()\` returns a new QuerySet and leaves this one as it was, so the line changes nothing. Assign it back.`,
  },
  {
    id: 'str-method', lang: PY,
    head: new RegExp(`^(${RECV})\\.(strip|lstrip|rstrip|lower|upper|casefold|removeprefix|removesuffix)\\(`, 'u'),
    why: (m) => `Strings can't change in place: \`.${m}()\` returns a new string, and this line drops it. Assign it back.`,
  },
  {
    id: 'str-replace', lang: PY,
    head: new RegExp(`^(${RECV})\\.(replace)\\(\\s*[rbuf]?['"]`, 'u'),
    skip: /^(?:os|shutil|pathlib|Path|re|str)$/u,
    unless: /\binplace\s*=/u,
    why: () => "Strings can't change in place: `.replace()` returns a new string, and this line drops it. Assign it back.",
  },
  {
    id: 'js-string', lang: JS,
    head: new RegExp(`^(${RECV})\\.(trim|trimStart|trimEnd|toUpperCase|toLowerCase|padStart|padEnd)\\(`, 'u'),
    skip: /^this$/u, // the class's own method, not a string
    why: (m) => `Strings are immutable: \`.${m}()\` returns a new string, and this line drops it.`,
  },
  {
    id: 'js-replace', lang: JS,
    head: new RegExp(`^(${RECV})\\.(replace|replaceAll)\\(\\s*['"\`/]`, 'u'),
    // Navigation (router.replace('/login'), window.location, a history wrapper) and DOMTokenList.replace (classList)
    // change things in place.
    skip: /(?:location|history|router|navigation|navigator|classlist)$|(?:^|\.)actions$|^this$/iu,
    // String.replace takes two arguments; a call with one is some other object's method (a search-result list's own replaceAll(value)).
    args: 2,
    why: (m) => `Strings are immutable: \`.${m}()\` returns a new string, and this line drops it.`,
  },
  {
    // `expect(promise).rejects.toThrow()` returns a promise, and nothing waits for it: in Jest the test is over before the
    // assertion runs, so it passes whatever the code does (and a failure later is an unhandled rejection no test owns).
    // Vitest (1.6, 2.1 and 3.2) and bun test fail such a test as they should, so files that run on them are left out
    // (notIn: a *.vitest.* name, or an import of vitest or bun:test); a vitest suite with globals and no import is
    // still flagged (measured 2026-11-08).
    // Test files only matter here, so the audit and the pattern bank read them for this pattern (tests: true).
    id: 'js-expect-promise', lang: JS, tests: true,
    notIn: { path: /\.vitest\./u, text: /\bfrom\s*['"](?:vitest|bun:test)['"]|\brequire\(\s*['"](?:vitest|bun:test)['"]\s*\)/u },
    find: (stmt) => {
      const head = stmt.match(/^expect(?:\.soft)?\(/u);
      if (!head) return null;
      const close = closeOf(stmt, head[0].length - 1, false);
      if (close < 0) return null;
      const tail = stmt.slice(close).match(/^\.(resolves|rejects)\.(?:not\.)?(\w+)\(/u);
      if (!tail) return null;
      const m = [stmt.slice(0, close + tail[0].length), stmt.slice(0, close) + `.${tail[1]}`, tail[2]];
      m.open = close + tail[0].length - 1;
      return m;
    },
    why: () => '`expect(...).resolves/.rejects` returns a promise; without `await` (or `return`) the test ends before the assertion runs, so it passes whatever the code does. Add `await`.',
  },
];

// Brackets opened minus closed on a line of code (a row of the lexer: what is in a string, a template, a comment or a
// regular expression is not code). In JavaScript a brace opens a block far more often than a value, so only ( and [
// count there: counting braces made every line of a function body look like the inside of a call.
function depthChange({ code }, py) {
  let d = 0;
  for (const c of code) {
    if ((py ? '([{' : '([').includes(c)) d++;
    else if ((py ? ')]}' : ')]').includes(c)) d--;
  }
  return d;
}

// JavaScript statement context: a stack of the brackets still open, 'b' for a block brace (a function or control-flow body,
// whose lines are statements again even inside a call: `items.forEach((x) => {`) and 'p' for ( [ and a brace that
// opens an object literal or a type. A line is a statement start when the top of the stack is a block or empty.
// Reads a row of the lexer; `last` is the last significant character so far, carried over from the lines above (a
// literal counts as a value). Returns the new { stack, last }.
function scanStack(state, { code, mark }) {
  const stack = state.stack.slice();
  let last = state.last ?? '';
  for (let i = 0; i < code.length; i++) {
    if (mark[i] === ' ') continue;
    if (mark[i] !== 'c') { last = 'x'; continue; }
    const c = code[i];
    if (c === '(' || c === '[') { stack.push('p'); last = c; continue; }
    if (c === ')' || c === ']') { stack.pop(); last = c; continue; }
    if (c === '{') {
      const before = code.slice(0, i).trimEnd() || last;
      // After `case x:` and `default:` the brace opens that branch's block, though a colon stands before it.
      const object = /(?:[(\[,=:?{&|!+\-*%<.]|\breturn|\bcase|\byield|\bawait|\btypeof|\bin|\bof)$/u.test(before) && !/=>$/u.test(before) && !/^\s*(?:case\b.*|default\s*):$/u.test(before);
      stack.push(object ? 'p' : 'b');
      last = c;
      continue;
    }
    if (c === '}') { stack.pop(); last = c; continue; }
    if (!/\s/u.test(c)) last = c;
  }
  return { stack, last };
}

// The new file's lines a patch shows (context and added), each with its number and whether the patch adds it.
function newLines(patch) {
  const out = [];
  let line = 0;
  for (const l of String(patch ?? '').split('\n')) {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (h) { line = Number(h[1]); out.push({ hunk: true }); continue; }
    if (l.startsWith('-') || l.startsWith('\\')) continue;
    if (l.startsWith('+++')) continue;
    out.push({ line, text: l.slice(1), added: l.startsWith('+') });
    line++;
  }
  return out;
}

// From an opening bracket, the index just past its match, or -1. `code` is the statement as the lexer left it: the
// same length as its text, with the insides of strings, templates, comments and regular expressions as spaces.
// -1 too when what opens there is not code (the pattern's words stood in the text of a template).
function closeOf(code, open) {
  if (code[open] !== '(') return -1;
  let d = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') d++;
    else if (code[i] === ')' && --d === 0) return i + 1;
  }
  return -1;
}

// How many arguments the call that opens at `open` has; 0 for (). Reads the same code (a string's quotes are kept
// there, so a string is an argument). An argument is what stands before a comma or the closing parenthesis: the
// comma after the last one (`f(\n  a,\n)`) starts nothing.
function argCount(code, open) {
  let d = 0;
  let n = 0;
  let any = false; // something of an argument has been read since the last comma
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') { if (d === 1) any = true; d++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (--d === 0) return n + (any ? 1 : 0); continue; }
    if (d === 1) { if (c === ',') { if (any) n++; any = false; } else if (!/\s/u.test(c)) any = true; }
  }
  return 0;
}

export const QS_HINT = /\.objects\b|_set\b|\bQuerySet\b|(?:^|\.)(?:qs|queryset|\w+_qs)$/u;
// name = <queryset>: a manager or QuerySet in the assignment (.objects, QuerySet, a related manager), or a value whose
// chain goes straight into a queryset method (name = locked().filter(...)), on one line or opening a bracket whose next
// line starts it. A queryset method nested inside some other call (TableData.from_data(qs.prefetch_related(x))) is not
// one: what comes back is whatever that call returns.
export const assignedFromQueryset = (name, text) => {
  const esc = name.replace(/[.$]/gu, '\\$&');
  const rhs = new RegExp(`(?:^|\\n)\\s*${esc}\\s*(?::[^=\\n]+)?=\\s*(?:\\(\\s*\\n\\s*)?([^\\n]*)`, 'gu');
  for (const m of text.matchAll(rhs)) {
    const v = m[1];
    if (/\.objects\b|\bQuerySet\b|_set\./u.test(v)) return true;
    if (new RegExp(`^[A-Za-z_][\\w.]*(?:\\([^()]*\\))?\\.(?:${QS_METHODS}|all|none)\\(`, 'u').test(v)) return true;
  }
  return false;
};

const indentOf = (l) => l.match(/^\s*/u)[0].length;
// The function a line sits in, as the reader sees the file: the innermost body that opens above the line and closes at
// or after `endLine`. A body is a declared function or method (`declarations`), or a brace after `=>` or after a `)`
// whose parenthesis does not follow if, for, while, switch, catch or with: the callback of a test or of a handler is
// where such a line most often is, and it has no name to be declared by. { start, end } in line numbers, or null.
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
function enclosingFunction(path, text, rows, line, endLine) {
  const bodies = declarations(path, text, { members: true }).filter((d) => d.fn || d.what === 'fn').map((d) => ({ start: d.line, end: d.end }));
  const toks = tokens(rows);
  const open = []; // the brackets open so far: { v, at, line, fn }
  let closedParen = -1; // the token that opened the parenthesis just closed
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.line > line) break;
    if (t.k !== 'punct') continue;
    if (t.v === '(' || t.v === '[') open.push({ v: t.v, at: k });
    else if (t.v === '{') {
      const prev = toks[k - 1];
      const head = prev?.k === 'punct' && prev.v === ')' && closedParen > 0 ? toks[closedParen - 1] : null;
      const fn = (prev?.k === 'punct' && prev.v === '=>') || (head !== null && !(head.k === 'word' && (NOT_A_FUNCTION.has(head.v) || (head.v === 'await' && toks[closedParen - 2]?.v === 'for'))));
      open.push({ v: '{', at: k, line: t.line, fn });
    } else if (t.v === ')' || t.v === ']' || t.v === '}') {
      const o = open.pop();
      if (t.v === ')' && o) closedParen = o.at;
    }
  }
  // What is still open at the line holds it (a body that opens on the line itself is the call's own callback, and is
  // left out below with every body that does not start above the line).
  for (const o of open) {
    if (o.v !== '{' || !o.fn) continue;
    let depth = 0;
    let end = Infinity;
    for (let j = o.at; j < toks.length; j++) {
      if (toks[j].k !== 'punct') continue;
      if (toks[j].v === '{') depth++;
      else if (toks[j].v === '}' && --depth === 0) { end = toks[j].line; break; }
    }
    bodies.push({ start: o.line, end });
  }
  let best = null;
  for (const b of bodies) if (b.start < line && b.end >= endLine && (!best || b.start > best.start)) best = b;
  return best;
}

// Does a statement come after the call (which ends on line index `end`) in the same function? The first later line of
// code (a blank line, a comment and the text of a template are not) that is not a closer, a label or another branch of
// an if/try, indented no deeper than the call, before the function's last line.
function statementAfter(lines, rows, fn, end) {
  const base = indentOf(lines[end]);
  let alt = null; // indent of an else/catch/case line: the branch below it runs instead of this one, not after it
  for (let j = end + 1; j < lines.length && j + 1 < fn.end; j++) {
    const t = rows[j].code.trim();
    if (!t) continue;
    const ind = indentOf(lines[j]);
    const branch = /^\}\s*(?:else|catch|finally)\b|^(?:case|default)\b/u.test(t);
    if (alt !== null) {
      if (ind > alt || (ind === alt && branch)) continue;
      alt = null;
    }
    if (branch) { alt = ind; continue; }
    if (ind > base) continue;
    if (/^[})\]]|^(?:break|continue)\b/u.test(t)) continue;
    return true;
  }
  return false;
}

// The file-level half of a pattern marked afterFile (a loop whose callbacks nothing waits for): the call sits in a
// function, and a statement of that function follows it.
function followedHere(c, text) {
  const lines = text.split('\n');
  const idx = c.line - 1;
  if (!lines[idx] || lines[idx].trim() !== c.text.trim()) return false;
  const rows = lex(lines, 'js');
  const end = Math.min(Math.max(c.end, c.line), lines.length);
  const fn = enclosingFunction(c.file, text, rows, c.line, end);
  return !!fn && statementAfter(lines, rows, fn, end - 1);
}

// Candidate findings in one changed file, before the queryset check that may need the whole file.
const SKIP_PATH = /(?:^|\/)(?:\.semgrep|semgrep|docs?|examples?)\//u;
// A line that carries on the expression above it (an arrow body, an assignment's value, a returned expression).
const CONTINUES = { js: /(?:=>|[=(,+\-*?:&|]|\$\{|\breturn)$/u, py: /(?:[=(,+\-*\\]|\b(?:and|or|not|return|in|is|lambda))$/u };

// `patterns`: the shapes to look for. The published ones by default; the hosted version passes its own list.
export function candidates(file, patterns = PATTERNS) {
  const py = PY.test(file.filename);
  if ((!py && !JS.test(file.filename)) || SKIP_PATH.test(file.filename)) return [];
  const rows = newLines(file.patch);
  // What is code on each line, worked out once per hunk by the one reader (a hunk starts where the patch does, so
  // its first lines are read as code, as they always were): lexed[i] is the row of rows[i], null for a hunk header.
  const lexed = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].hunk) { lexed.push(null); i++; continue; }
    let j = i;
    while (j < rows.length && !rows[j].hunk) j++;
    lexed.push(...lex(rows.slice(i, j).map((r) => r.text), py ? 'py' : 'js'));
    i = j;
  }
  // The line as the patterns read it (trimmed), and the same characters as the lexer left them.
  const codeOf = (k) => { const lead = rows[k].text.length - rows[k].text.trimStart().length; return lexed[k].code.slice(lead, lead + rows[k].text.trim().length); };
  const out = [];
  let depth = 0;
  let js = { stack: [] }; // JavaScript: brackets open (scanStack)
  let prev = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.hunk) { depth = 0; js = { stack: [] }; prev = ''; continue; }
    const trimmed = r.text.trim();
    const x = lexed[i];
    // A Python line that opens or closes a triple-quoted string is skipped (a call that takes one, the line a
    // docstring ends on). The lines inside one, a comment and template text need no rule: they are not code, so no
    // call is found in them.
    if (py && /'{3}|"{3}/u.test(x.code)) continue;
    // A line that begins inside a template's ${ } or inside a call is not a statement.
    const startDepth = py ? depth : (lexed[i - 1]?.tplOpen || js.stack.at(-1) === 'p' ? 1 : 0);
    depth = Math.max(0, depth + depthChange(x, py));
    if (!py) js = scanStack(js, x);
    const before = prev;
    if (x.code.trim()) prev = x.code.trim();
    if (!r.added || startDepth > 0 || (py ? CONTINUES.py : CONTINUES.js).test(before) && !/^(?:case\b|default\s*:)/u.test(before)) continue;
    // A filter built from unpacked input as the only thing in a try block checks that the lookups are valid
    // (try: Model.objects.filter(**given) except FieldError: ...); the call is the point, its result is not.
    if (py && before === 'try:' && /\(\s*\*\*/u.test(trimmed)) continue;
    if (!trimmed || trimmed.startsWith('.')) continue;
    // The line under // @ts-expect-error is there to be an error (a type test): its result is not the point.
    const typeTest = !py && /^\/\/\s*@ts-(?:expect-error|ignore)\b/u.test(rows[i - 1]?.text?.trim() ?? '');
    // In JavaScript the expression may go on below: a ternary's ? or :, a chained call, an operator.
    if (!py) {
      let k = i + 1;
      while (k < rows.length && !rows[k].hunk && !lexed[k].code.trim()) k++;
      if (k < rows.length && !rows[k].hunk && /^(?:\?|:|\.|&&|\|\||\+|-(?!-)|\*|\/|%|\?\?)/u.test(lexed[k].code.trim())) continue;
    }
    // The whole statement: this line and, when it opens a call, the lines until the call closes (at most 15).
    // A pattern marked long (a callback with a body) reads on up to 400 lines, and says what comes after the call.
    const joined = (limit) => {
      let text = trimmed;
      let code = codeOf(i);
      let d = depthChange(x, py);
      let k = i + 1;
      for (; d > 0 && k < rows.length && k <= i + limit && !rows[k].hunk; k++) { text += `\n${rows[k].text.trim()}`; code += `\n${codeOf(k)}`; d += depthChange(lexed[k], py); }
      return { text, code, closed: d <= 0, next: k };
    };
    const short = joined(15);
    let long = null;
    for (const p of patterns) {
      if (!p.lang.test(file.filename)) continue;
      const { text: stmt, code, next } = p.long ? (long ??= joined(400)) : short;
      const m = p.find ? p.find(stmt) : stmt.match(p.head);
      if (!m) continue;
      if (typeTest && !p.tests) continue; // (a test pattern's line is the assertion; the error is in its arguments)
      if (p.skip?.test(m[1])) continue;
      if (p.unless?.test(stmt)) continue;
      if (p.args && argCount(code, m.open ?? m[1].length + 1 + m[2].length) < p.args) continue;
      // The call this pattern names must end the statement: nothing after it but a semicolon or a comment.
      const end = closeOf(code, m.open ?? m[1].length + 1 + m[2].length);
      if (end < 0) continue;
      const rest = code.slice(end).trim();
      if (rest && rest !== ';') continue;
      out.push({ pattern: p, method: m[2], recv: m[1], file: file.filename, line: r.line, end: rows[next - 1].line ?? r.line, text: r.text });
      break;
    }
  }
  return out;
}

// Findings for the files of a pull request. fileText(path) returns the file at the head commit, or null; it is asked
// only when a queryset candidate's receiver isn't shown to be one by the patch itself.
// only: the pattern ids to report, when given. patterns: the shapes to look for (see `candidates`).
export async function discardedResults(files, fileText = async () => null, { only = null, patterns = PATTERNS } = {}) {
  const out = [];
  for (const f of files) {
    if (f.status === 'removed' || !f.patch) continue;
    for (const c of candidates(f, patterns)) {
      if (only && !only.has(c.pattern.id)) continue;
      if (c.pattern.queryset && !QS_HINT.test(c.recv)) {
        const name = c.recv.match(/^[A-Za-z_][\w.]*/u)[0];
        const shown = newLines(f.patch).filter((r) => !r.hunk).map((r) => r.text).join('\n');
        if (!assignedFromQueryset(name, shown)) {
          const text = await fileText(f.filename);
          if (!text || !assignedFromQueryset(name, text)) continue;
        }
      }
      // A test runner that fails the shape itself (js-expect-promise under vitest or bun test): the file says which.
      if (c.pattern.notIn) {
        if (c.pattern.notIn.path.test(f.filename)) continue;
        const shown = newLines(f.patch).filter((r) => !r.hunk).map((r) => r.text).join('\n');
        if (c.pattern.notIn.text.test(shown) || c.pattern.notIn.text.test((await fileText(f.filename)) ?? '')) continue;
      }
      if (c.pattern.afterFile) {
        const text = await fileText(f.filename);
        if (!text || !followedHere(c, text)) continue;
      }
      out.push({ ref: `pattern:${c.pattern.id}`, file: c.file, line: c.line, why: c.pattern.why(c.method), rule: 'result thrown away', hash: lineHash(c.text), version: PATTERNS_VERSION });
    }
  }
  return out;
}
