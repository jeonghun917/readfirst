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
import { definitions } from './find.mjs';
import { groupOf, matcher } from './map.mjs';
import { codeOnly } from './readlist.mjs';

// The changed lines of one file from unified diff text: the new-side numbers of added lines and of the place a deletion
// was made, and the text of every added and removed line. Works on `git diff -U0` and on a pull request file's `patch`
// (which has context lines).
// `hunks` keep both sides' starts and lengths, so a line number written against the file before the change (a risk's
// evidence) can be carried to where that line is now (toNew).
export function parsePatch(patch) {
  const lines = new Set();
  const text = [];
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
    if (l.startsWith('+')) { lines.add(n); text.push(l.slice(1)); n++; }
    else if (l.startsWith('-')) { lines.add(Math.max(1, n)); text.push(l.slice(1)); }
    else n++;
  }
  return { lines, text, hunks, whole: false };
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
const CODE_NAME = /(?<![\w$.\/-])(?:[a-z]+[A-Z][\w$]*|[a-z]+_[a-z0-9_]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+)(?![\w$\/-])/gu;
const NOT_CODE = /(?:^|\/)\.readfirst\/|\.(?:md|mdx|markdown|txt|rst|json|jsonl|ya?ml|toml|lock|ini|cfg|html?|css|svg|csv)$/iu;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Where each name is declared in a file, with the lines it spans: up to the next declaration (the definitions reader in
// find.mjs gives starts only), so a change anywhere in a function's body touches that function. The blank and comment
// lines just above the next declaration belong to it, not to this one: a new function with its comment added after
// changedFiles made changedFiles read as changed (found trying it on readfirst#139). `fn`: a function or type, as the
// definitions reader found it; a top-level const or a Python CONSTANT is not one.
const BLANK_OR_COMMENT = /^\s*(?:$|\/\/|#(?!!)|\/?\*)/u;
function declarations(path, body) {
  const lines = body.split('\n');
  const starts = definitions(path, body).map((d) => ({ name: d.name, line: d.line, fn: true }));
  lines.forEach((l, i) => {
    // Also a top-level function find leaves out on purpose (KEYWORDS: `main` is noise in a search, not in a risk about
    // what main() does).
    const m = l.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u) ?? (/\.py$/u.test(path) ? l.match(/^([A-Z_][A-Z0-9_]*)\s*=/u) : l.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u));
    if (m && !starts.some((s) => s.line === i + 1)) starts.push({ name: m[1], line: i + 1, fn: /\bfunction\b/u.test(l) });
  });
  starts.sort((a, b) => a.line - b.line);
  return starts.map((s, k) => {
    // Its own end when it can be found (the closing brace, or in Python the next line indented no deeper): an inner
    // helper declared inside main() ran to the end of main, and runHook stopped at its inner save() (readfirst#142).
    const own = /\.py$/u.test(path) ? pyEnd(lines, s.line) : braceEnd(path, lines, s.line);
    let end = (starts[k + 1]?.line ?? lines.length + 1) - 1;
    if (starts[k + 1]) while (end > s.line && BLANK_OR_COMMENT.test(lines[end - 1])) end--;
    // `top`: the comment lines right above it, which describe it: evidence written at a function's comment is about it.
    let top = s.line;
    while (top > 1 && lines[top - 2].trim() && BLANK_OR_COMMENT.test(lines[top - 2])) top--;
    // Nothing runs past the next declaration that starts a line unindented: braceEnd can miss a statement's end (its
    // semicolon inside a template line it cannot read) and find the next function's braces instead.
    const next = starts.slice(k + 1).find((n) => /^\S/u.test(lines[n.line - 1]));
    let limit = next ? next.line - 1 : lines.length;
    if (next) while (limit > s.line && BLANK_OR_COMMENT.test(lines[limit - 1])) limit--;
    return { ...s, top, end: Math.min(own ?? end, limit) };
  });
}
// The line of the brace that closes the block opened on or after line `at` (1-based), counting braces in code only;
// a one-line declaration (`const x = 1;`, an arrow without a body) ends on its line. null when it does not close.
function braceEnd(path, lines, at) {
  let depth = 0;
  let opened = false;
  for (let i = at - 1; i < lines.length; i++) {
    const code = codeText(path, lines[i]);
    for (const c of code) {
      if (c === '{') { depth++; opened = true; } else if (c === '}') depth--;
    }
    if (opened && depth <= 0) return i + 1;
    // A statement with no block of its own ends at its semicolon, on whichever line: a const set to a template or a
    // call over several lines ran on to the next function's closing brace (readfirst-cloud's ensureTable, 0.30.0).
    if (!opened && /;\s*$/u.test(code)) return i + 1;
  }
  return null;
}
// Python: the last line before the next non-blank line indented no deeper than the declaration.
function pyEnd(lines, at) {
  const indent = (l) => l.match(/^\s*/u)[0].length;
  const base = indent(lines[at - 1]);
  let last = at;
  for (let i = at; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indent(lines[i]) <= base) return last;
    last = i + 1;
  }
  return last;
}

// A changed line as code: a comment line is nothing, strings and regex literals are blanked (codeOnly), and a comment at
// the end of the line is cut.
const codeText = (path, l) => {
  if (BLANK_OR_COMMENT.test(l)) return '';
  const js = !/\.py$/u.test(path);
  return codeOnly(l, js).replace(js ? /\/\/.*$/u : /#.*$/u, '');
};

const touches = (changes, from, to) => changes.whole || [...changes.lines].some((n) => n >= from && n <= to);

// The names an item's text gives: backticked identifiers, and outside backticks and paths the words that look like code
// (camelCase, snake_case, UPPER_CASE with an underscore): the map's risks mostly write `runHook swallows every error`,
// not `\`runHook\``.
// Also a name written as a call (`main()`, `api()`, not `file(s)`) and an all-capitals word of three or more letters
// (`MARKER`, `FLAGS`): the map's risks write them bare, and none counted until 0.30.0, so a risk about `parse()` and its
// FLAGS was never judged. Every one of them counts only where it is declared (declsOf), so an acronym such as JSON or a
// plain word in a call costs nothing unless the code declares it.
const CALL = /(?<![\w$.\/-])([A-Za-z_$][\w$]*)\((?!s\)|es\))/gu;
const CAPS = /(?<![\w$.\/-])[A-Z][A-Z0-9]{2,}(?![\w$\/-])/gu;
function spansOf(text) {
  const ticked = [...String(text).matchAll(/`([^`\n]+)`/gu)].map((m) => m[1].trim()).filter((s) => IDENT.test(s) && !FILE_LIKE.test(s));
  const prose = String(text).replace(/`[^`\n]*`/gu, ' ').replace(PATH, ' ');
  const bare = [...prose.matchAll(CODE_NAME)].map((m) => m[0]);
  const calls = [...prose.matchAll(CALL)].map((m) => m[1]);
  const caps = [...prose.matchAll(CAPS)].map((m) => m[0]);
  return [...new Set([...ticked, ...bare, ...calls, ...caps])];
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
  // Names are looked for in the changed lines of code only: the map, docs and config name functions all the time, and
  // a map risk that mentions runHook made every risk about runHook read as touched (readfirst#142, on its own PR).
  // Comments and strings are left out too: the comments of this very file name changedFiles and runHook, and made the
  // risks about them read as touched on its own PR.
  const changedText = [...changes].filter(([path]) => !NOT_CODE.test(path)).flatMap(([path, c]) => c.text.map((l) => ({ path, code: codeText(path, l) })));
  // in: only the changed lines of these files (a capital constant used in the item's own files, not a test's own MAP).
  const named = (name, inPaths = null) => { const re = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`, 'u'); return changedText.some((t) => (!inPaths || inPaths.has(t.path)) && re.test(t.code)); };
  const judgeOne = (text, shownFor) => {
    const spans = spansOf(text);
    const mentioned = [...String(text).matchAll(PATH)].map((m) => m[1]).filter((p) => tracked.has(p));
    const where = [...new Set([...shownFor, ...mentioned, ...changes.keys(), ...importedBy(shownFor, imports)])].filter((p) => tracked.has(p) || changes.has(p));
    const own = new Set([...shownFor, ...mentioned]);
    const about = [];
    const by = [];
    const drifted = [];
    for (const span of spans) {
      const found = declsOf(span, where, own, declIn);
      if (!found.length) continue;
      about.push(`\`${span}\``);
      const name = span.split('.').pop();
      const lower = /^[a-z][a-z0-9]*$/u.test(name);
      const used = found[0].plain ? !lower && named(name, own) : named(name);
      if (used || found.some((d) => changes.has(d.path) && touches(changes.get(d.path), d.line, d.end))) by.push(`\`${span}\``);
    }
    for (const m of String(text).matchAll(PATH_LINE)) {
      const [ref, path, at] = [m[0], m[1], Number(m[2])];
      if (!tracked.has(path) && !changes.has(path)) continue;
      const c = changes.get(path);
      // The evidence was written against the file before the change: find where that line is now.
      const now = c ? toNew(c, at) : at;
      // A line outside everything the item names in that file may have moved with the code (src/cli.mjs:108 sat in
      // VERSION, not loadMapLenient, until 0.30.0), or may point elsewhere on purpose. It still judges the
      // item (dropping it could hide a real hit), and the verdict and `check` say it may have moved.
      if (anchorOf(spans, path, now, declIn).state === 'drift') drifted.push(ref);
      about.push(ref);
      if (!c) continue;
      const d = declIn(path).filter((x) => x.line <= now).at(-1);
      const [from, to] = d && now <= d.end ? [d.line, d.end] : [now - 10, now + 10];
      if (touches(c, from, to)) by.push(ref);
    }
    const more = drifted.length ? { drifted } : {};
    if (!about.length) return { triggered: true, about, by, why: 'names no symbol or line readfirst can find: shown for its files', ...more };
    return by.length ? { triggered: true, about, by, ...more } : { triggered: false, about, by, why: `the change does not touch ${about.join(', ')}`, ...more };
  };
  for (const r of list.risks ?? []) r.trigger = judgeOne(r.text, r.for ?? []);
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
    ...(map?.groups ?? []).flatMap((g) => (g.risks ?? []).map((r, i) => ({ where: `groups.${g.id}.risks[${i}]`, kind: 'risk', group: g.id, text: r?.text, shown: files.filter((f) => (r?.files ? matcher(r.files)(f) : groupOf(map, f)?.id === g.id)) }))),
    ...(map?.rules ?? []).map((r) => ({ where: `rules.${r?.id}`, kind: 'rule', text: r?.rule, shown: r?.files ? files.filter(matcher(r.files)) : [] })),
  ];
  const out = [];
  for (const it of items) {
    if (typeof it.text !== 'string') continue;
    const mentioned = [...it.text.matchAll(PATH)].map((m) => m[1]).filter((p) => tracked.has(p));
    const own = new Set([...it.shown, ...mentioned]);
    const where = [...new Set([...own, ...importedBy(it.shown, imports)])];
    const named = spansOf(it.text).some((span) => declsOf(span, where, own, declIn).length);
    const lined = [...it.text.matchAll(PATH_LINE)].some((m) => tracked.has(m[1]));
    if (!named && !lined) out.push({ where: it.where, kind: it.kind, group: it.group ?? null, files: it.shown.length, text: it.text });
  }
  return out.sort((a, b) => b.files - a.files || a.where.localeCompare(b.where));
}
