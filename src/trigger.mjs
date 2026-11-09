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
    const m = l.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u) ?? (/\.py$/u.test(path) ? l.match(/^([A-Z_][A-Z0-9_]*)\s*=/u) : null);
    if (m && !starts.some((s) => s.line === i + 1)) starts.push({ name: m[1], line: i + 1, fn: false });
  });
  starts.sort((a, b) => a.line - b.line);
  return starts.map((s, k) => {
    let end = (starts[k + 1]?.line ?? lines.length + 1) - 1;
    if (starts[k + 1]) while (end > s.line && BLANK_OR_COMMENT.test(lines[end - 1])) end--;
    return { ...s, end };
  });
}

const touches = (changes, from, to) => changes.whole || [...changes.lines].some((n) => n >= from && n <= to);

// changes: path -> { lines, text, whole } (parseGitDiff, or parsePatch per pull request file). read(path) gives a file's
// text at the head of the change. files: the tracked files. Sets `trigger` on each row of list.risks and list.rules:
// { triggered, about, by } (about: what the item names; by: what of it the change touched), and returns the list.
export function judge(list, { changes, read = () => null, files = [] }) {
  const tracked = new Set(files);
  const decl = new Map();
  const declIn = (path) => {
    if (!decl.has(path)) { const body = read(path); decl.set(path, body ? declarations(path, body) : []); }
    return decl.get(path);
  };
  const changedText = [...changes.values()].flatMap((c) => c.text);
  const named = (name) => { const re = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`, 'u'); return changedText.some((t) => re.test(t)); };
  const judgeOne = (text, shownFor) => {
    // Backticked names, and names that look like code without backticks (camelCase, snake_case, UPPER_CASE with an
    // underscore): the map's risks mostly write `runHook swallows every error`, not `\`runHook\``.
    const ticked = [...String(text).matchAll(/`([^`\n]+)`/gu)].map((m) => m[1].trim()).filter((s) => IDENT.test(s) && !FILE_LIKE.test(s));
    const bare = [...String(text).replace(/`[^`\n]*`/gu, ' ').replace(PATH, ' ').matchAll(CODE_NAME)].map((m) => m[0]);
    const spans = [...ticked, ...bare];
    const mentioned = [...String(text).matchAll(PATH)].map((m) => m[1]).filter((p) => tracked.has(p));
    const where = [...new Set([...shownFor, ...mentioned, ...changes.keys()])].filter((p) => tracked.has(p) || changes.has(p));
    const about = [];
    const by = [];
    for (const span of [...new Set(spans)]) {
      const name = span.split('.').pop();
      // A plain lowercase word (`files`, `run`, `check`) is a word as often as a name: it counts only as a function the
      // definitions reader found, and only by its own lines, never by appearing somewhere in the diff.
      // It is looked up only in the files the item is shown for or names: a test added in the change that declares its
      // own `run` helper made an audit risk about `run` read as touched (readfirst#139).
      const plain = /^[a-z][a-z0-9]*$/u.test(name);
      const own = new Set([...shownFor, ...mentioned]);
      const found = where.filter((p) => !plain || own.has(p)).flatMap((p) => declIn(p).filter((d) => d.name === name && (!plain || d.fn)).map((d) => ({ ...d, path: p })));
      if (!found.length) continue;
      about.push(`\`${span}\``);
      if ((!plain && named(name)) || found.some((d) => changes.has(d.path) && touches(changes.get(d.path), d.line, d.end))) by.push(`\`${span}\``);
    }
    for (const m of String(text).matchAll(PATH_LINE)) {
      const [ref, path, at] = [m[0], m[1], Number(m[2])];
      if (!tracked.has(path) && !changes.has(path)) continue;
      about.push(ref);
      const c = changes.get(path);
      if (!c) continue;
      // The evidence was written against the file before the change: find where that line is now.
      const now = toNew(c, at);
      const d = declIn(path).filter((x) => x.line <= now).at(-1);
      const [from, to] = d && now <= d.end ? [d.line, d.end] : [now - 10, now + 10];
      if (touches(c, from, to)) by.push(ref);
    }
    if (!about.length) return { triggered: true, about, by, why: 'names no symbol or line readfirst can find: shown for its files' };
    return by.length ? { triggered: true, about, by } : { triggered: false, about, by, why: `the change does not touch ${about.join(', ')}` };
  };
  for (const r of list.risks ?? []) r.trigger = judgeOne(r.text, r.for ?? []);
  for (const r of list.rules ?? []) r.trigger = judgeOne(r.rule, r.for ?? []);
  return list;
}
