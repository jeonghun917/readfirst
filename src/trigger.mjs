// Triggered or not (the plan's step 2, owner 2026-11-09; readfirst 0.28.0). A risk or rule shown for a changed file is
// judged against the change itself, not only by the file: on readfirst#133 9 of 28 open risks applied to what the PR
// changed, and the other 19 were true about the file but about a symbol or a kind of change the PR never touched. Such
// an item is not dropped: it is listed as "not triggered" with the reason, one line each.
//
// What an item is about: the backticked names in its text that are declared in a file it is shown for, a file its text
// names or a changed file, and the `path:line` evidence in its text. It is triggered when the change touches one of
// them: a changed line inside the declaration (or the declaration that holds the evidence line), or the name in an added
// or removed line. An item that names nothing readfirst can find is triggered as before, by its files. When in doubt
// (a file with no readable patch, a deleted file) everything in it counts as touched.
import { codeRows, declarations as readDeclarations, entryAt, lex, reads, scopeOf, unfinished } from './code.mjs';
import { definitions, hasDefinitions } from './find.mjs';
import { groupOf, isOwnFile, matcher } from './map.mjs';

// The changed lines of one file from unified diff text: the new-side numbers of added lines and of the place a deletion
// was made, and the text of every added and removed line. Works on `git diff -U0` and on a pull request file's `patch`
// (which has context lines).
// `hunks` keep both sides' starts and lengths, so a line number written against the file before the change (a risk's
// evidence) can be carried to where that line is now (toNew).
// `at`, one per line of `text`: the new-side number of an added line, or minus the number of the line a removed line
// stood before, so each can be read as code in its place in the file (changedCode).
export function parsePatch(patch) {
  const lines = new Set();
  const text = [];
  const at = [];
  const hunks = [];
  let n = 0;
  let inHunk = false;
  for (const l of String(patch ?? '').split('\n')) {
    const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);
    if (h) {
      n = Number(h[3]);
      inHunk = true;
      hunks.push({ oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]), newStart: n, newCount: h[4] === undefined ? 1 : Number(h[4]) });
      continue;
    }
    if (!inHunk || l.startsWith('\\')) continue;
    if (l.startsWith('+')) { lines.add(n); text.push(l.slice(1)); at.push(n); n++; }
    else if (l.startsWith('-')) { lines.add(Math.max(1, n)); text.push(l.slice(1)); at.push(-Math.max(1, n)); }
    else n++;
  }
  return { lines, text, at, hunks, whole: false };
}

// Where line `at` of the file before the change is now: shifted by every hunk wholly above it; a line inside a hunk
// maps to that hunk's new start (it was changed, or sits among changed lines).
export function toNew(changes, at) {
  let shift = 0;
  for (const h of changes.hunks ?? []) {
    const oldEnd = h.oldStart + Math.max(h.oldCount, 1) - 1;
    if (oldEnd < at && !(h.oldCount === 0 && h.oldStart >= at)) shift += h.newCount - h.oldCount;
    else if (h.oldStart <= at && at <= oldEnd) return h.newStart;
  }
  return at + shift;
}

// The change from one text of a file to another, in parsePatch's shape, for an edit that has not been made yet (the
// PreToolUse hook knows the file and what the edit puts in it, and has no git diff of it): the shortest line diff
// (Myers), written out as -U0 hunks and read by parsePatch, so judge reads it as it reads `git diff`.
export function textChange(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  // The edit script, from the furthest-reaching path of each number of differences d (the classic O((N+M)D) walk).
  const max = a.length + b.length;
  const v = new Map([[1, 0]]);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= a.length && y >= b.length) { found = true; break; }
    }
  }
  // Back from the end: each step is a kept line, a removed one or an added one.
  const ops = [];
  let [x, y] = [a.length, b.length];
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1));
    const pk = down ? k + 1 : k - 1;
    const px = vd.get(pk) ?? 0;
    const py = px - pk;
    while (x > px && y > py) { ops.push(['=', a[x - 1]]); x--; y--; }
    if (d > 0) { if (down) { ops.push(['+', b[y - 1]]); y--; } else { ops.push(['-', a[x - 1]]); x--; } }
  }
  ops.reverse();
  // Hunks with no context, numbered as git numbers them (a hunk with no lines on one side starts at the line before it).
  const out = [];
  let [oldN, newN] = [1, 1];
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] === '=') { oldN++; newN++; i++; continue; }
    const [oldStart, newStart] = [oldN, newN];
    const body = [];
    while (i < ops.length && ops[i][0] !== '=') { body.push(`${ops[i][0]}${ops[i][1]}`); if (ops[i][0] === '-') oldN++; else newN++; i++; }
    const oldCount = oldN - oldStart;
    const newCount = newN - newStart;
    out.push(`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`, ...body);
  }
  return parsePatch(out.join('\n'));
}

// `git diff` output for many files, as path -> changes. A deleted or binary file is `whole`: all of it counts as touched.
export function parseGitDiff(out) {
  const files = new Map();
  for (const part of String(out ?? '').split(/^diff --git /mu).slice(1)) {
    const head = part.split(/^@@/mu)[0];
    const to = head.match(/^\+\+\+ (?:b\/(.+)|\/dev\/null)$/mu);
    const from = head.match(/^--- (?:a\/(.+)|\/dev\/null)$/mu);
    const names = part.match(/^a\/(\S+) b\/(\S+)/u);
    const path = to?.[1] ?? from?.[1] ?? names?.[2];
    if (!path) continue;
    const changes = parsePatch(part);
    if (to && !to[1]) changes.whole = true;
    if (/^Binary files /mu.test(head) || (!changes.lines.size && !changes.text.length)) changes.whole = true;
    files.set(path, changes);
  }
  return files;
}

const IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;
const FILE_LIKE = /\.(?:m?[jt]sx?|cjs|py|json|md|ya?ml|toml|lock|html|css|sh|txt)$/u;
const PATH_LINE = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]\w*):(\d+)\b/gu;
const PATH = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]\w*)(?![\w/-])/gu;
// The files a risk is about: paths in its first clause (its subject, the way unshownRisks reads it), with or without an
// extension (vendor/readfirst/VERSION), that the repository tracks or the change touches. A change to one triggers the
// risk whatever names the text also holds: "vendor/readfirst/VERSION names the CLI commit ..." read as not triggered,
// judged only by a const VERSION found in another file (until 0.32.0).
const SUBJECT_PATH = /(?<![\w@/.-])((?:[\w.-]+\/)+[\w.-]*\w|[\w-][\w.-]*\.[A-Za-z]\w{0,9})(?![\w/-]|:\d)/gu; // path:line is evidence, judged by its line
// readfirst's own files (the map) are left out, as in unshownRisks: a risk that quotes the map's path is not about it.
const subjectPaths = (text, has) => [...new Set([...String(text).split(/[;,]|:\s|\.\s/u)[0].matchAll(SUBJECT_PATH)].map((m) => m[1]).filter((p) => has(p) && !isOwnFile(p)))];
const CODE_SHAPE = '(?:[a-z]+[A-Z][\\w$]*|[a-z]+_[a-z0-9_]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+)';
const CODE_NAME = new RegExp(`(?<![\\w$.\\/-])${CODE_SHAPE}(?![\\w$\\/-])`, 'gu');
// Names joined by a slash ("not inside encodeToken/decodeToken", "parseArgs()/runMain()") are each a name: next to
// a `/` a name was refused, to keep the folders of a path out, so such a risk named nothing and was never judged.
// Every part must look like code (camelCase, snake_case, UPPER_CASE with an underscore), so `src/readlist` and
// `lib/fooBar/index` stay paths; a path with an extension (`src/fooBar/bazQux.js`) is taken out before this is read.
const JOINED = new RegExp(`(?<![\\w$.\\/-])${CODE_SHAPE}(?:\\(\\))?(?:\\/${CODE_SHAPE}(?:\\(\\))?)+(?![\\w$\\/-]|\\.\\w)`, 'gu');
const unjoin = (text) => text.replace(JOINED, (m) => m.replaceAll('/', ' '));
// A `files` entry that is one path, not a pattern (`*`, `?` and so `**` make a pattern; see patternToRegExp).
const exactPath = (p) => typeof p === 'string' && !/[*?]/u.test(p);
// The files an item gives when all of them are exact paths in which no declaration is found (a JSON or YAML file, a
// Dockerfile, a workflow): there is no name or line to judge such a risk by, so a change to one of those files is what
// touches it. With a pattern among them, or a declaration in any of them, the item is judged by its names as before.
const filesWithoutNames = (files, declIn) => (Array.isArray(files) && files.length && files.every((p) => exactPath(p) && !isOwnFile(p) && !declIn(p).length) ? files : []);
const NOT_CODE = /(?:^|\/)\.readfirst\/|\.(?:md|mdx|markdown|txt|rst|json|jsonl|ya?ml|toml|lock|ini|cfg|html?|css|svg|csv)$/iu;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Where each name is declared in a file, with the lines it spans: `line` to `end`, and `top`, the first line of the
// comment and decorators right above it. JavaScript, TypeScript, Python and the <script> blocks of .vue and .svelte
// files are read by the one reader (src/code.mjs): starts, ends and nesting from the file's structure. `fn`: a
// function, class or type, or a value set to a function; a plain constant is not one.
// Any other language find has patterns for (Go, Rust, Ruby, PHP, Elixir, Java, Kotlin, C#) has no reader of its
// structure here: a declaration starts where find's pattern matches a line and ends before the next one indented no
// deeper (`approx: true`). That is the wide reading, so a mistake reads as touched, never as a false "not triggered".
const BLANK_OR_COMMENT = /^\s*(?:$|\/\/|#(?!!)|\/?\*)/u;
// A file whose declarations are read with approximate ends.
export const approximateBounds = (path) => !reads(path) && hasDefinitions(path);
function declarations(path, body) {
  if (reads(path)) return readDeclarations(path, body).map((d) => ({ ...d, fn: d.fn || d.what !== 'var' }));
  const lines = body.split('\n');
  const indent = (n) => lines[n - 1].match(/^\s*/u)[0].length;
  const starts = definitions(path, body).map((d) => ({ name: d.name, line: d.line, fn: true }));
  lines.forEach((l, i) => {
    const m = l.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u);
    if (m && !starts.some((s) => s.line === i + 1)) starts.push({ name: m[1], line: i + 1, fn: false });
  });
  starts.sort((a, b) => a.line - b.line);
  const open = [];
  return starts.map((s, k) => {
    const next = starts.slice(k + 1).find((n) => indent(n.line) <= indent(s.line));
    let end = next ? next.line - 1 : lines.length;
    // The blank and comment lines just above the next declaration belong to it, not to this one.
    if (next) while (end > s.line && BLANK_OR_COMMENT.test(lines[end - 1])) end--;
    let top = s.line;
    while (top > 1 && lines[top - 2].trim() && BLANK_OR_COMMENT.test(lines[top - 2])) top--;
    while (open.length && open.at(-1).end < s.line) open.pop();
    const d = { ...s, top, end, approx: true, body: true, what: 'fn', depth: open.length, parent: open.at(-1)?.name ?? null, parentLine: open.at(-1)?.line ?? null };
    open.push(d);
    return d;
  });
}

// The changed lines of one file as code: each with strings, template text and comments as spaces. An added line is
// read at its place in the file as it is now (`rows`, the file's lexed lines), so a line inside a template or a block
// comment that began above it is text, not code. A removed line is read from the state the file has where it stood,
// and the removed lines after it go on from there. Without the file (or a change given without `at`), each line is
// read alone.
function changedCode(path, c, rows) {
  const lang = /\.py$/u.test(path) ? 'py' : 'js';
  let carry = null; // { before: the line a run of removed lines stood before, state }
  return c.text.map((text, i) => {
    const n = c.at?.[i];
    if (rows && n > 0 && rows[n - 1]?.text === text) { carry = null; return rows[n - 1].code; }
    if (rows && n < 0 && !rows[-n - 1]?.outside) {
      const state = carry?.before === n ? carry.state : (-n >= 2 ? rows[-n - 2]?.state ?? null : null);
      const row = lex([text], lang, state)[0];
      carry = { before: n, state: row.state };
      return row.code;
    }
    carry = null;
    return rows && n < 0 ? '' : lex([text], lang)[0].code; // a line removed from markup is not code; anything else is read alone
  });
}

const touches = (changes, from, to) => changes.whole || [...changes.lines].some((n) => n >= from && n <= to);

// The names an item's text gives: backticked identifiers, and outside backticks and paths the words that look like code
// (camelCase, snake_case, UPPER_CASE with an underscore): the map's risks mostly write `runHook swallows every error`,
// not `\`runHook\``.
// Also a name written as a call (`main()`, `api()`, not `file(s)`): it counts only where it is declared (declsOf), so
// a plain word in a call costs nothing unless the code declares it.
// A bare capital word with no underscore (CLI, API, URL, JSON, VERSION, FLAGS) is prose, not a name: such words
// counted as names from 0.30.0, and a risk about "the CLI version" then read as touched by a change to a line holding
// a constant called CLI. The contract is the one the text can keep: a name is in backticks, or has a shape only code
// has (camelCase, snake_case, UPPER_CASE with an underscore, a call). A risk about a constant FLAGS writes `FLAGS`.
const CALL = /(?<![\w$.\/-])([A-Za-z_$][\w$]*)\((?!s\)|es\))/gu;
// The bare capital words of a text, for the one place that says so when such a word is declared (unmatchedItems).
const BARE_CAPITALS = /(?<![\w$.\/-])[A-Z][A-Z0-9]{2,}(?![\w$\/-])/gu;
const bareCapitals = (text) => [...new Set([...unjoin(String(text).replace(/`[^`\n]*`/gu, ' ').replace(PATH, ' ')).matchAll(BARE_CAPITALS)].map((m) => m[0]))];
function spansOf(text) {
  const ticked = [...String(text).matchAll(/`([^`\n]+)`/gu)].flatMap((m) => unjoin(m[1].trim()).split(' ')).filter((s) => IDENT.test(s) && !FILE_LIKE.test(s));
  const prose = unjoin(String(text).replace(/`[^`\n]*`/gu, ' ').replace(PATH, ' '));
  const bare = [...prose.matchAll(CODE_NAME)].map((m) => m[0]);
  const calls = [...prose.matchAll(CALL)].map((m) => m[1]);
  return [...new Set([...ticked, ...bare, ...calls])];
}
// The files the given ones import, one step: a risk shown for src/action.mjs about settleMap (declared in src/map.mjs,
// which action.mjs imports) found no declaration and was shown unjudged on every change until 0.30.0.
function importedBy(paths, imports) {
  const from = new Set(paths);
  return [...new Set(imports.filter((e) => from.has(e.from)).map((e) => e.to))];
}
// Where `span` is declared among the files `where`. A plain lowercase word (`files`, `run`, `check`) is a word as often
// as a name: it counts only as a function the definitions reader found, and only in the files the item is shown for or
// names (`own`): a test added in the change that declares its own `run` helper made an audit risk about `run` read as
// touched (readfirst#139).
// An all-capitals word without an underscore (`MAP`, `PAY`, `HELP`) is common enough that a test's own `const MAP` in a
// changed file made a risk about readfirst's MAP status read as touched (measured on readfirst#143): it counts, like a
// plain word, only in the item's own files, as a constant or a function.
function declsOf(span, where, own, declIn) {
  const name = span.split('.').pop();
  const lower = /^[a-z][a-z0-9]*$/u.test(name);
  const plain = lower || /^[A-Z][A-Z0-9]*$/u.test(name);
  return where.filter((p) => !plain || own.has(p)).flatMap((p) => declIn(p).filter((d) => d.name === name && (!lower || d.fn)).map((d) => ({ ...d, path: p, plain })));
}
// Whether a `path:line` reference still points into what its item names in that file: 'ok' (inside one of them, or the
// comment right above it), 'drift' (the item names something declared there and the line is outside all of it: the code
// moved, or the line was wrong), 'unanchored' (it names nothing declared there, so a move cannot be seen).
function anchorOf(spans, path, at, declIn) {
  const decls = spans.flatMap((span) => declsOf(span, [path], new Set([path]), declIn));
  if (!decls.length) return { state: 'unanchored', decls };
  return { state: decls.some((d) => at >= d.top && at <= d.end) ? 'ok' : 'drift', decls };
}

// The entry of a table that evidence `path:at` points into, when the item's text names the entry by its key: a risk
// about the pattern `no-await` with evidence inside that pattern's entry of a long PATTERNS table is about that entry,
// not about the whole table and not about nothing. null when the line is in no table entry or the text does not name it.
function entryNamed(text, path, at, declIn, read) {
  const d = scopeOf(declIn(path), at);
  if (!d || d.approx || d.what !== 'var' || at < d.line) return null;
  const entry = entryAt(path, read(path) ?? '', d, at);
  if (!entry?.key || entry.key.length < 3) return null;
  return new RegExp(`(?<![\\w$-])${esc(entry.key)}(?![\\w$-])`, 'u').test(String(text)) ? entry : null;
}

// changes: path -> { lines, text, whole } (parseGitDiff, or parsePatch per pull request file). read(path) gives a file's
// text at the head of the change. files: the tracked files. Sets `trigger` on each row of list.risks and list.rules:
// { triggered, about, by } (about: what the item names; by: what of it the change touched), and returns the list.
export function judge(list, { changes, read = () => null, files = [], imports = [] }) {
  const tracked = new Set(files);
  const decl = new Map();
  const declIn = (path) => {
    if (!decl.has(path)) { const body = read(path); decl.set(path, body ? declarations(path, body) : []); }
    return decl.get(path);
  };
  const rowsOf = (path) => { const body = reads(path) ? read(path) : null; return body ? codeRows(path, body) : null; };
  // A file the reader cannot finish (it ends inside a template, a string or a comment) has no bounds to trust: all of
  // it counts as touched, like a file with no readable patch.
  const open = new Set([...changes.keys()].filter((path) => unfinished(rowsOf(path) ?? [])));
  const changeOf = (path) => { const c = changes.get(path); return c && open.has(path) ? { ...c, whole: true } : c; };
  // Names are looked for in the changed lines of code only: the map, docs and config name functions all the time, and
  // a map risk that mentions runHook made every risk about runHook read as touched (readfirst#142, on its own PR).
  // Comments and strings are left out too: the comments of this very file name changedFiles and runHook, and made the
  // risks about them read as touched on its own PR.
  const changedText = [...changes].filter(([path]) => !NOT_CODE.test(path)).flatMap(([path, c]) => changedCode(path, c, rowsOf(path)).map((code) => ({ path, code })));
  // in: only the changed lines of these files (a capital constant used in the item's own files, not a test's own MAP).
  const named = (name, inPaths = null) => { const re = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`, 'u'); return changedText.some((t) => (!inPaths || inPaths.has(t.path)) && re.test(t.code)); };
  // A changed file of another group does not lend its names to a group's risk: a vendored copy of this CLI, with a
  // NOT_CODE of its own, made a risk about the package's NOT_CODE read as touched (until 0.31.0). Its own files, the
  // files it names and what they import still count wherever they are.
  const groupOf = new Map((list.targets ?? []).map((t) => [t.path, t.group]));
  const judgeOne = (text, shownFor, group = null, ownFiles = null) => {
    const spans = spansOf(text);
    const mentioned = [...String(text).matchAll(PATH)].map((m) => m[1]).filter((p) => tracked.has(p));
    const changedHere = [...changes.keys()].filter((p) => !group || !groupOf.has(p) || groupOf.get(p) === group);
    const where = [...new Set([...shownFor, ...mentioned, ...changedHere, ...importedBy(shownFor, imports)])].filter((p) => tracked.has(p) || changes.has(p));
    const own = new Set([...shownFor, ...mentioned]);
    const about = [];
    const by = [];
    const drifted = [];
    const namedIn = new Set(); // files where a name the item gives is declared, or its evidence line sits
    for (const span of spans) {
      const found = declsOf(span, where, own, declIn);
      if (!found.length) continue;
      for (const d of found) namedIn.add(d.path);
      about.push(`\`${span}\``);
      const name = span.split('.').pop();
      const lower = /^[a-z][a-z0-9]*$/u.test(name);
      const used = found[0].plain ? !lower && named(name, own) : named(name);
      if (used || found.some((d) => changes.has(d.path) && touches(changeOf(d.path), d.line, d.end))) by.push(`\`${span}\``);
    }
    for (const m of String(text).matchAll(PATH_LINE)) {
      const [ref, path, at] = [m[0], m[1], Number(m[2])];
      if (!tracked.has(path) && !changes.has(path)) continue;
      namedIn.add(path);
      const c = changeOf(path);
      // The evidence was written against the file before the change: find where that line is now.
      const now = c ? toNew(c, at) : at;
      // A line outside everything the item names in that file may have moved with the code (src/cli.mjs:108 sat in
      // VERSION, not loadMapLenient, until 0.30.0), or may point elsewhere on purpose. It still judges the
      // item (dropping it could hide a real hit), and the verdict and `check` say it may have moved.
      // The line is about the declaration it belongs to, the comment above it included (scopeOf): the function around
      // a one-line local, not the local; or about one entry of a table, when the text names the entry's key. Only a
      // line no declaration holds is judged by the ten lines around it.
      const entry = entryNamed(text, path, now, declIn, read);
      if (!entry && anchorOf(spans, path, now, declIn).state === 'drift') drifted.push(ref);
      about.push(ref);
      if (!c) continue;
      const d = entry ?? scopeOf(declIn(path), now);
      const [from, to] = d ? [d.top ?? d.line, d.end] : [now - 10, now + 10];
      if (touches(c, from, to)) by.push(ref);
    }
    // A subject path judges the item only where nothing it names is found: "ClassIndex in lib/flows.mjs" is about
    // ClassIndex, not every change to lib/flows.mjs.
    // So do the item's own files when they are exact paths with nothing declared in them (filesWithoutNames).
    for (const path of [...subjectPaths(text, (p) => tracked.has(p) || changes.has(p)), ...filesWithoutNames(ownFiles, declIn).filter((p) => tracked.has(p) || changes.has(p))]) {
      if (about.includes(path) || namedIn.has(path)) continue;
      about.push(path);
      if (changes.has(path)) by.push(path);
    }
    const more = drifted.length ? { drifted } : {};
    if (!about.length) return { triggered: true, about, by, why: 'names no symbol or line readfirst can find: shown for its files', ...more };
    return by.length ? { triggered: true, about, by, ...more } : { triggered: false, about, by, why: `the change does not touch ${about.join(', ')}`, ...more };
  };
  for (const r of list.risks ?? []) r.trigger = judgeOne(r.text, r.for ?? [], r.group ?? null, r.files ?? null);
  for (const r of list.rules ?? []) r.trigger = judgeOne(r.rule, r.for ?? []);
  return list;
}

// Every `path:line` reference in the map's risks and rules whose line lies outside everything its item names in that
// file (`check` lists them, `readfirst fix` moves the ones whose move git can show), and those in a file where the item
// names nothing declared, whose moves cannot be seen at all. history(path, ref): the file's changes since the commit
// that wrote the reference, in parseGitDiff's shape, or null when it cannot be told. A line is moved only to where git
// carries it and only when that is inside what the item names: a reference that was wrong from the start, or points
// elsewhere on purpose, is left for a person.
export function evidenceDrift(map, { files = [], read = () => null, history = () => null } = {}) {
  const tracked = new Set(files);
  const cache = new Map();
  const declIn = (path) => {
    if (!cache.has(path)) { const body = read(path); cache.set(path, body ? declarations(path, body) : []); }
    return cache.get(path);
  };
  const items = [
    ...(map?.groups ?? []).flatMap((g) => (g.risks ?? []).map((r, i) => ({ where: `groups.${g.id}.risks[${i}]`, text: r?.text }))),
    ...(map?.rules ?? []).map((r) => ({ where: `rules.${r?.id}`, text: r?.rule })),
  ];
  const drift = [];
  const unanchored = [];
  for (const { where, text } of items) {
    if (typeof text !== 'string') continue;
    const spans = spansOf(text);
    for (const m of text.matchAll(PATH_LINE)) {
      const [ref, path, at] = [m[0], m[1], Number(m[2])];
      if (!tracked.has(path)) continue;
      if (entryNamed(text, path, at, declIn, read)) continue; // inside the table entry the text names by its key
      const a = anchorOf(spans, path, at, declIn);
      // Said only when the line sits inside a declaration, so there is a name to give: top-level code (a script's last
      // lines) has none, and saying so on every check would be noise nobody can act on.
      if (a.state === 'unanchored') { if (declIn(path).some((d) => at >= d.top && at <= d.end)) unanchored.push({ where, ref, path }); continue; }
      if (a.state === 'ok') continue;
      const c = history(path, ref);
      const moved = c ? toNew(c, at) : null;
      const now = moved !== null && moved !== at && a.decls.some((d) => moved >= d.top && moved <= d.end) ? moved : null;
      drift.push({ where, ref, path, at, now, names: [...new Set(a.decls.map((d) => d.name))], lines: a.decls.map((d) => d.line) });
    }
  }
  return { drift, unanchored };
}

// The text with `ref` (path:line) written as path:now, where it stands alone (src/a.mjs:16 is not part of src/a.mjs:168).
export function moveEvidence(text, ref, path, now) {
  return text.replace(new RegExp(`(?<![\\w/.-])${esc(ref)}(?!\\d)`, 'gu'), `${path}:${now}`);
}

// The map's risks and rules that can never be judged against a change: their text names no symbol declared in the files
// they are shown for (or files they name) and no file:line there, so diff and the PR comment show them for their files,
// unjudged, every time (26 of the open items on readfirst#143). Widest first: a risk shown for many files costs most.
// `audit` lists them so the map can be narrowed (name the function in backticks, or give file:line, or `files`).
export function unmatchedItems(map, { files = [], read = () => null, imports = [] } = {}) {
  const tracked = new Set(files);
  const cache = new Map();
  const declIn = (path) => {
    if (!cache.has(path)) { const body = read(path); cache.set(path, body ? declarations(path, body) : []); }
    return cache.get(path);
  };
  const items = [
    ...(map?.groups ?? []).flatMap((g) => (g.risks ?? []).map((r, i) => ({ where: `groups.${g.id}.risks[${i}]`, kind: 'risk', group: g.id, text: r?.text, own: r?.files ?? null, shown: files.filter((f) => (r?.files ? matcher(r.files)(f) : groupOf(map, f)?.id === g.id)) }))),
    ...(map?.rules ?? []).map((r) => ({ where: `rules.${r?.id}`, kind: 'rule', text: r?.rule, shown: r?.files ? files.filter(matcher(r.files)) : [] })),
  ];
  const out = [];
  for (const it of items) {
    if (typeof it.text !== 'string') continue;
    const mentioned = [...it.text.matchAll(PATH)].map((m) => m[1]).filter((p) => tracked.has(p));
    const own = new Set([...it.shown, ...mentioned]);
    const where = [...new Set([...own, ...importedBy(it.shown, imports)])];
    const named = spansOf(it.text).some((span) => declsOf(span, where, own, declIn).length);
    const lined = [...it.text.matchAll(PATH_LINE)].some((m) => tracked.has(m[1])) || subjectPaths(it.text, (p) => tracked.has(p)).length > 0 || filesWithoutNames(it.own, declIn).some((p) => tracked.has(p));
    // `backtick`: the bare capital words of its text that its files declare. Such a word is prose until it is in
    // backticks, so an item written before that rule (0.30.0 counted them) says here what would make it judged.
    if (!named && !lined) out.push({ where: it.where, kind: it.kind, group: it.group ?? null, files: it.shown.length, text: it.text, backtick: bareCapitals(it.text).filter((w) => declsOf(w, where, own, declIn).length) });
  }
  return out.sort((a, b) => b.files - a.files || a.where.localeCompare(b.where));
}
