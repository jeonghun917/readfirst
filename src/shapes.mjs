// The bug shapes `readfirst scan` looks for, without a model: a line that computes a new value and drops it (a Django
// QuerySet .filter(), a string .replace() or .strip()), and a test assertion on a promise that nothing waits for.
// These are the shapes already published in readfirst's write-ups; the hosted version (readfirst-cloud, Pro and the
// one-off audit) runs more, and keeps this file's copy of them in step (lib/discarded.mjs there).
import { createHash } from 'node:crypto';
import { blockLines } from './lex.mjs';

export const PATTERNS_VERSION = 'patterns-7';
export const MAX_DISCARDED = 5;
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
    // Vitest 1 and 2 wait for hanging assertions at the end of the test, which hides it; Vitest 3 fails the test.
    // Test files only matter here, so the audit and the pattern bank read them for this pattern (tests: true).
    id: 'js-expect-promise', lang: JS, tests: true,
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

// Brackets opened minus closed on a line, outside strings and comments (roughly: enough to tell a statement from a
// line inside a call). In JavaScript a brace opens a block far more often than a value, so only ( and [ count there:
// counting braces made every line of a function body look like the inside of a call.
function depthChange(text, py) {
  let d = 0;
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || (!py && c === '`')) { q = c; continue; }
    if ((py && c === '#') || (!py && c === '/' && text[i + 1] === '/')) break;
    if ((py ? '([{' : '([').includes(c)) d++;
    else if ((py ? ')]}' : ')]').includes(c)) d--;
  }
  return d;
}

// JavaScript statement context: a stack of the brackets still open, 'b' for a block brace (a function or control-flow body,
// whose lines are statements again even inside a call: `items.forEach((x) => {`) and 'p' for ( [ and a brace that
// opens an object literal or a type. A line is a statement start when the top of the stack is a block or empty. `tpl`
// carries an open template literal over to the next line. Returns the new { stack, tpl }.
function scanStack(state, text) {
  const stack = state.stack.slice();
  let q = state.tpl ? '`' : null;
  let last = state.last ?? ''; // the last significant character so far, carried over from the lines above
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\') i++; else if (c === q) { q = null; last = 'x'; } continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && text[i + 1] === '/') break;
    if (c === '(' || c === '[') { stack.push('p'); last = c; continue; }
    if (c === ')' || c === ']') { stack.pop(); last = c; continue; }
    if (c === '{') {
      const before = text.slice(0, i).trimEnd() || last;
      const object = /(?:[(\[,=:?{&|!+\-*%<.]|\breturn|\bcase|\byield|\bawait|\btypeof|\bin|\bof)$/u.test(before) && !/=>$/u.test(before);
      stack.push(object ? 'p' : 'b');
      last = c;
      continue;
    }
    if (c === '}') { stack.pop(); last = c; continue; }
    if (!/\s/u.test(c)) last = c;
  }
  return { stack, tpl: q === '`', last };
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

// From an opening bracket, the index just past its match in the joined statement text, or -1.
function closeOf(s, open, py) {
  let d = 0;
  let q = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || (!py && c === '`')) { q = c; continue; }
    if (c === '(') d++;
    else if (c === ')' && --d === 0) return i + 1;
  }
  return -1;
}

// How many arguments the call that opens at `open` has: top-level commas outside strings, plus one; 0 for ().
function argCount(s, open) {
  let d = 0;
  let q = null;
  let n = 0;
  let any = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; if (d === 1) any = true; continue; }
    if (c === '(' || c === '[' || c === '{') { if (d === 1) any = true; d++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (--d === 0) return any ? n + 1 : 0; continue; }
    if (d === 1) { if (c === ',') n++; else if (!/\s/u.test(c)) any = true; }
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
// The function a line sits in, found by indentation (prettier-style code): up through the blocks that are not functions
// (if, for, try, case) to the first line that opens one. { header, at } or null.
function enclosingFunction(lines, idx) {
  let cur = indentOf(lines[idx]);
  for (let k = idx - 1; k >= 0 && cur > 0; k--) {
    if (!lines[k].trim() || indentOf(lines[k]) >= cur) continue;
    cur = indentOf(lines[k]);
    const t = lines[k].trim();
    if (/^(?:if|else|for|while|try|catch|finally|switch|do)\b|^\}\s*(?:else|catch|finally)\b|^(?:case|default)\b/u.test(t)) continue;
    if (/\bfunction\b|=>\s*\{$|\)(?::\s*[^{]+)?\s*\{$/u.test(t)) return { header: t, at: k };
  }
  return null;
}

// Does a statement come after the call (lines idx..end) in the same function? The first later line that is not blank, a
// closer, a label or another branch of an if/try, indented no deeper than the call, before the function ends.
function statementAfter(lines, fn, end) {
  const base = indentOf(lines[end]);
  const top = indentOf(lines[fn.at]);
  let alt = null; // indent of an else/catch/case line: the branch below it runs instead of this one, not after it
  for (let j = end + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (!t) continue;
    const ind = indentOf(lines[j]);
    if (ind <= top) return false;
    const branch = /^\}\s*(?:else|catch|finally)\b|^(?:case|default)\b/u.test(t);
    if (alt !== null) {
      if (ind > alt || (ind === alt && branch)) continue;
      alt = null;
    }
    if (branch) { alt = ind; continue; }
    if (ind > base) continue;
    if (/^[})\]]|^(?:break|continue)\b|^(?:\/\/|\/\*|\*)/u.test(t)) continue;
    return true;
  }
  return false;
}

// The file-level half of js-foreach-async: the loop sits in a function, and a statement of that function follows it.
function followedHere(c, text) {
  const lines = text.split('\n');
  const idx = c.line - 1;
  if (!lines[idx] || lines[idx].trim() !== c.text.trim()) return false;
  const fn = enclosingFunction(lines, idx);
  return !!fn && statementAfter(lines, fn, Math.min(Math.max(c.end, c.line), lines.length) - 1);
}

// Candidate findings in one changed file, before the queryset check that may need the whole file.
const SKIP_PATH = /(?:^|\/)(?:\.semgrep|semgrep|docs?|examples?)\//u;
// A line that carries on the expression above it (an arrow body, an assignment's value, a returned expression).
const CONTINUES = { js: /(?:=>|[=(,+\-*?:&|]|\$\{|\breturn)$/u, py: /(?:[=(,+\-*\\]|\b(?:and|or|not|return|in|is|lambda))$/u };

export function candidates(file) {
  const py = PY.test(file.filename);
  if ((!py && !JS.test(file.filename)) || SKIP_PATH.test(file.filename)) return [];
  const rows = newLines(file.patch);
  // Where the triple-quoted strings (Python) and block comments (JavaScript) are, worked out once per hunk by a scan that
  // knows strings from comments (lib/lex.mjs): a quote or comment marker inside a string is not taken for one.
  const blocks = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].hunk) { blocks.push(null); i++; continue; }
    let j = i;
    while (j < rows.length && !rows[j].hunk) j++;
    blocks.push(...blockLines(rows.slice(i, j).map((r) => r.text), py));
    i = j;
  }
  const out = [];
  let depth = 0;
  let js = { stack: [], tpl: false }; // JavaScript: brackets open (scanStack)
  let prev = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.hunk) { depth = 0; js = { stack: [], tpl: false }; prev = ''; continue; }
    const trimmed = r.text.trim();
    // Lines in or touching a Python triple-quoted string are skipped (docstrings hold example code); in JavaScript the
    // lines a block comment spans are, and the line that closes one starts a new statement.
    const b = blocks[i];
    if (py ? b.touches : b.startsIn || b.endsIn) { if (!py && b.startsIn && !b.endsIn) prev = ''; continue; }
    const startDepth = py ? depth : (js.tpl || js.stack.at(-1) === 'p' ? 1 : 0);
    depth = Math.max(0, depth + depthChange(r.text, py));
    if (!py) js = scanStack(js, r.text);
    const before = prev;
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) prev = trimmed.replace(py ? /\s+#.*$/u : /\s+\/\/.*$/u, '');
    if (!r.added || startDepth > 0 || (py ? CONTINUES.py : CONTINUES.js).test(before) && !/^(?:case\b|default\s*:)/u.test(before)) continue;
    // A filter built from unpacked input as the only thing in a try block checks that the lookups are valid
    // (try: Model.objects.filter(**given) except FieldError: ...); the call is the point, its result is not.
    if (py && before === 'try:' && /\(\s*\*\*/u.test(trimmed)) continue;
    if (!trimmed || trimmed.startsWith('.')) continue;
    // The line under // @ts-expect-error is there to be an error (a type test): its result is not the point.
    const typeTest = !py && /^\/\/\s*@ts-(?:expect-error|ignore)\b/u.test(rows[i - 1]?.text?.trim() ?? '');
    // In JavaScript the expression may go on below: a ternary's ? or :, a chained call, an operator.
    if (!py) {
      const below = rows.slice(i + 1).find((x) => x.hunk || x.text.trim());
      if (below && !below.hunk && /^(?:\?|:|\.|&&|\|\||\+|-(?!-)|\*|\/(?![/*])|%|\?\?)/u.test(below.text.trim())) continue;
    }
    // The whole statement: this line and, when it opens a call, the lines until the call closes (at most 15).
    // A pattern marked long (a callback with a body) reads on up to 400 lines, and says what comes after the call.
    const joined = (limit) => {
      let text = trimmed;
      let d = depthChange(r.text, py);
      let k = i + 1;
      for (; d > 0 && k < rows.length && k <= i + limit && !rows[k].hunk; k++) { text += `\n${rows[k].text.trim()}`; d += depthChange(rows[k].text, py); }
      return { text, closed: d <= 0, next: k };
    };
    const short = joined(15);
    let long = null;
    for (const p of PATTERNS) {
      if (!p.lang.test(file.filename)) continue;
      const { text: stmt, next } = p.long ? (long ??= joined(400)) : short;
      const m = p.find ? p.find(stmt) : stmt.match(p.head);
      if (!m) continue;
      if (typeTest && !p.tests) continue; // (a test pattern's line is the assertion; the error is in its arguments)
      if (p.skip?.test(m[1])) continue;
      if (p.unless?.test(stmt)) continue;
      if (p.args && argCount(stmt, m.open ?? m[1].length + 1 + m[2].length) < p.args) continue;
      // The call this pattern names must end the statement: nothing after it but a semicolon or a comment.
      const end = closeOf(stmt, m.open ?? m[1].length + 1 + m[2].length, py);
      if (end < 0) continue;
      const rest = stmt.slice(end).trim();
      if (rest && !/^;?\s*(?:(?:#|\/\/).*)?$/u.test(rest)) continue;
      out.push({ pattern: p, method: m[2], recv: m[1], file: file.filename, line: r.line, end: rows[next - 1].line ?? r.line, text: r.text });
      break;
    }
  }
  return out;
}

// Findings for the files of a pull request. fileText(path) returns the file at the head commit, or null; it is asked
// only when a queryset candidate's receiver isn't shown to be one by the patch itself.
// muted: pattern ids left out (lib/pattern-health.mjs: patterns people almost never act on in live PRs).
export async function discardedResults(files, fileText = async () => null, { muted = new Set(), only = null } = {}) {
  const out = [];
  for (const f of files) {
    if (f.status === 'removed' || !f.patch) continue;
    for (const c of candidates(f)) {
      if (muted.has(c.pattern.id) || (only && !only.has(c.pattern.id))) continue;
      if (c.pattern.queryset && !QS_HINT.test(c.recv)) {
        const name = c.recv.match(/^[A-Za-z_][\w.]*/u)[0];
        const shown = newLines(f.patch).filter((r) => !r.hunk).map((r) => r.text).join('\n');
        if (!assignedFromQueryset(name, shown)) {
          const text = await fileText(f.filename);
          if (!text || !assignedFromQueryset(name, text)) continue;
        }
      }
      if (c.pattern.afterFile) {
        const text = await fileText(f.filename);
        if (!text || !followedHere(c, text)) continue;
      }
      out.push({ ref: `pattern:${c.pattern.id}`, file: c.file, line: c.line, why: c.pattern.why(c.method), rule: 'result thrown away', hash: lineHash(c.text), version: PATTERNS_VERSION });
      if (out.length === MAX_DISCARDED) return out;
    }
  }
  return out;
}
