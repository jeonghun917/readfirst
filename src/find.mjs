// readfirst find: before writing something new, what in the repository may already do it. A few words ("payment retry
// helper", "결제 재시도") are matched against the names of functions, classes and types in the code, the comment that
// says what each does, file paths, and what the map says (group titles, rules, risks). Matching is by words, not meaning: no model and no index, so it
// finds `retryPayment` and `payments/retry.py` but not a function called `try_again`. It reads the checkout and
// writes nothing.
import { matcher, groupOf, MAP_PATH } from './map.mjs';
import { isTest, OTHER_CODE } from './readlist.mjs';
import { codeRows, declarations, reads, tokens } from './code.mjs';

export const FIND_FORMAT = 'readfirst/find@1';

// Words that say what kind of change is wanted, not what it is about.
const STOP = new Set(('a an the to for of and or in on at by with from into via is are be it this that where new add adding make making create creating write '
  + 'build implement implementing helper helpers util utils utility function functions method class module file code thing logic support handle handling '
  + 'some any each all get set use using want need should would could can way something').split(' '));

// "retryPayment", "retry_payment", "payments/retry.py" and "결제를 재시도" all become words.
export function words(text) {
  const out = [];
  const spaced = String(text).replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2');
  for (let w of spaced.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    // Hangul is left whole: a particle or ending ("결제를", "재시도하기") still meets its stem by prefix (see meets).
    if (!/^\p{Script=Hangul}+$/u.test(w)) w = stem(w);
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

// Plural and verb endings, so "retries", "retrying" and "retried" meet "retry".
function stem(w) {
  if (w.length <= 3 || /\d/u.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ied') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && /(?:ss|x|ch|sh)es$/u.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}

// Two words meet when they are equal or one starts the other (pay / payment, 결제 / 결제창), the shorter at least 3
// letters (2 for Hangul).
export const meets = (q, w) => q === w || (Math.min(q.length, w.length) >= (/\p{Script=Hangul}/u.test(q) ? 2 : 3) && (w.startsWith(q) || q.startsWith(w)));

// Definitions by language: a name and the line it is on. JavaScript, TypeScript, Python and the <script> blocks of
// .vue and .svelte files are read by the one reader (src/code.mjs), from the file's structure. The languages below
// have no such reader here: a pattern per line, rough on purpose (a name a person would search for), and wrong where
// a line inside a string or a comment is shaped like a declaration.
const DEFS = [
  { test: /\.go$/u, re: /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/u },
  { test: /\.rs$/u, re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn\s+([A-Za-z_]\w*)|(?:struct|enum|trait)\s+([A-Za-z_]\w*))/u },
  { test: /\.rb$/u, re: /^\s*(?:def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)|(?:class|module)\s+([A-Z]\w*))/u },
  { test: /\.php$/u, re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function\s+([A-Za-z_]\w*)|(?:class|interface|trait|enum)\s+([A-Za-z_]\w*))/u },
  { test: /\.exs?$/u, re: /^\s*(?:defp?\s+([a-z_]\w*[?!]?)|defmodule\s+([A-Z][\w.]*))/u },
  { test: /\.(?:java|kts?|cs)$/u, re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|override|suspend|async|virtual|data)\s+)*(?:(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)|fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)\s*\(|[\w<>[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\([^;]*$)/u },
];
// Whether find has patterns for this file's language.
export const hasDefinitions = (path) => reads(path) || DEFS.some((d) => d.test.test(path));
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'main', 'function', 'super', 'await', 'typeof']);
const SKIP = /\.d\.ts$|\.min\.js$|(?:^|\/)(?:vendor|node_modules|dist|build|migrations)\//u;

// The comment that says what a definition does: the comment lines right above it (decorators may sit between), or a
// Python docstring right below. At most 600 characters.
const COMMENT = /^\s*(?:\/\/+|#(?!!)|\/\*+|\*(?!\/)|--)\s?(.*?)\s*(?:\*\/)?\s*$/u;
const DOCSTRING = /^\s*[rubf]*("""|''')(.*)$/iu;
function docOf(lines, i, py, top = null) {
  const above = [];
  // top: the first line of the comment and decorators above it, as the reader found it (a decorator is no comment).
  if (top !== null) { for (let k = top - 1; k < i; k++) { const m = lines[k].match(COMMENT); if (m) above.push(m[1]); } }
  else for (let k = i - 1; k >= 0 && above.length < 12; k--) {
    const l = lines[k];
    if (/^\s*@/u.test(l) && !above.length) continue;
    const m = l.match(COMMENT);
    if (!m) break;
    above.unshift(m[1]);
  }
  let text = above.join(' ');
  const open = py ? (lines[i + 1] ?? '').match(DOCSTRING) : null;
  if (open) {
    const parts = [open[2]];
    for (let k = i + 2; k < lines.length && k < i + 12 && !parts.at(-1).includes(open[1]); k++) parts.push(lines[k]);
    text = `${text} ${parts.join(' ').split(open[1])[0]}`;
  }
  return text.trim().slice(0, 600);
}

// What find lists of a file the reader reads: functions, classes and types by name. Its own choices are a filter over
// the reader's declarations: a value that is not a function is nothing to reuse; names under three letters, private
// `#names` and its noise words are left out. What a CommonJS module puts on `exports` is listed whatever it is set to,
// and so is a property set to a function in the object a module exports as a whole (`module.exports = { parse:
// function () {} }`, `export default { methods: { save: () => {} } }`). A property of any other object is not: an
// options object passed to a call (`run({ out: (s) => s })`) would flood the list.
// The comment that says what each does comes from the reader's `top` (the comment and decorators right above) and a
// Python docstring right below. The list also carries the file's own header comment (`header`), which says what the
// module is for: find matches it for the file as a whole, once, not for each definition in it.
function readDefinitions(path, body) {
  const lines = body.split('\n');
  const py = /\.py$/u.test(path);
  const decls = declarations(path, body, { members: true });
  const out = decls
    .filter((d) => (d.what !== 'var' || d.fn || d.ofModule) && (!d.member || d.ofModule) && !d.name.startsWith('#') && !KEYWORDS.has(d.name) && d.name.length >= 3)
    .map((d) => ({ name: d.name, line: d.line, doc: docOf(lines, d.line - 1, py, d.top), kind: ['class', 'type', 'alias', 'enum'].includes(d.what) ? 'type' : 'function' }));
  out.header = headerOf(path, body, lines, decls);
  return out;
}

// The constants of a file that hold a list or a table of names (`const HTTP_CLIENTS = ['axios', 'got']`,
// `RATE_LIMITS = {"slack": 1}`, `new Set([...])`): a value find's definitions leave out, though it is what another
// list of the same names repeats. Each: the constant's name, line, comment and `values`, the names written in it:
// its strings with no space in them and its object keys. Only constants of the file's top level (or what a module
// exports) whose value has a bracket and at least two such names; a list inside a function is the function's.
// Kept apart from `definitions`, which the find gate (newCode in src/cli.mjs) and the trigger engine also read: a new
// list is not new code for them.
function listsOf(path, body) {
  if (!body || !reads(path)) return [];
  const lines = body.split('\n');
  const rows = codeRows(path, body);
  const py = /\.py$/u.test(path);
  const out = [];
  for (const d of declarations(path, body, { members: true })) {
    if (d.what !== 'var' || d.fn || d.depth || (d.member && !d.ofModule) || d.name.startsWith('#') || d.name.length < 3) continue;
    const toks = tokens(rows, d.line - 1, d.end);
    const eq = toks.findIndex((t) => t.k === 'punct' && t.v === '=');
    const value = eq < 0 ? [] : toks.slice(eq + 1);
    if (!value.some((t) => t.k === 'punct' && (t.v === '[' || t.v === '{'))) continue;
    const values = [];
    value.forEach((t, k) => {
      // A name is a string with no space in it ('node-fetch', 'api.stripe.com'): a sentence or a file's text in a
      // string is something else, and a table of test fixtures would otherwise match every query.
      if (t.k === 'val' && t.text && t.endLine === t.line && !/\s/u.test(t.text)) values.push(t.text.replace(/\\./gu, ' '));
      else if (t.k === 'word' && value[k + 1]?.v === ':' && ['{', ','].includes(value[k - 1]?.v)) values.push(t.v);
    });
    if (values.length < 2) continue;
    out.push({ name: d.name, line: d.line, doc: docOf(lines, d.line - 1, py, d.top), values });
  }
  return out;
}
// The comment a file opens with, when it is not the comment of its first declaration: the lines of comment from the
// first line (after a `#!` line) up to the first line of code or the first blank line after text.
function headerOf(path, body, lines, decls) {
  const rows = codeRows(path, body);
  const out = [];
  let i = lines[0]?.startsWith('#!') ? 1 : 0;
  for (; i < lines.length; i++) {
    if (rows[i].outside) { if (out.length) break; continue; }
    if (rows[i].code.trim()) break;
    if (!lines[i].trim()) { if (out.length) break; continue; }
    if (decls.some((d) => d.top <= i + 1 && i + 1 < d.line)) return '';
    out.push(lines[i].match(COMMENT)?.[1] ?? lines[i].trim());
  }
  return out.join(' ').trim().slice(0, 600); // cut: a description, not a list; find matches words in its first 600 characters
}

export function definitions(path, body) {
  if (!body) return [];
  if (reads(path)) return readDefinitions(path, body);
  const lang = DEFS.find((d) => d.test.test(path));
  if (!lang) return [];
  const out = [];
  const lines = body.split('\n');
  const py = /\.py$/u.test(path);
  lines.forEach((l, i) => {
    const m = l.match(lang.re);
    if (!m) return;
    const name = m.slice(1).find(Boolean);
    if (!name || KEYWORDS.has(name) || name.length < 3) return;
    out.push({ name, line: i + 1, doc: docOf(lines, i, py), kind: /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|pub)\s+)*(?:class|struct|interface|trait|enum|record|object|module|defmodule|type)\b/u.test(l) ? 'type' : 'function' });
  });
  return out;
}

// query: the words asked; files, imports (for how many files use each one), read(path), map (optional).
export function find({ query, files, imports = [], read = () => null, map = null, limit = 15 }) {
  const asked = [...new Set(words(query))];
  const ignored = matcher(map?.ignore ?? []);
  const code = files.filter((f) => f !== MAP_PATH && !SKIP.test(f) && !ignored(f) && hasDefinitions(f));
  const users = new Map();
  for (const e of imports) if (!isTest(e.from)) users.set(e.to, (users.get(e.to) ?? 0) + 1);
  const group = (f) => (map ? groupOf(map, f)?.id ?? null : null);
  // Code in a group marked deprecated is still listed, after the rest, with what to use instead.
  const replaced = (f) => (map && f ? groupOf(map, f)?.deprecated ?? null : null);

  // Every place a word can be found, with its own words.
  const items = [];
  let defs = 0;
  let lists = 0;
  for (const f of code) {
    const test = isTest(f);
    const at = words(f.replace(/\.[^./]+$/u, ''));
    const found = definitions(f, read(f));
    // A file is found by its path, and by the comment it opens with: often the only place that says what a module's
    // functions are for ("strings and comments carried across lines" for a file whose functions are named by what
    // they return).
    items.push({ kind: 'file', file: f, words: at, doc: words(found.header ?? ''), test });
    for (const d of found) { defs++; items.push({ kind: d.kind, name: d.name, file: f, line: d.line, words: words(d.name), path: at, doc: words(d.doc), test }); }
    // A constant holding a list or table is found by its name and by the names written in it ("axios" in
    // HTTP_CLIENTS), so a third list of the same HTTP libraries is not written beside two.
    for (const l of listsOf(f, read(f))) { lists++; items.push({ kind: 'list', name: l.name, file: f, line: l.line, words: words(l.name), path: at, doc: words(l.doc), values: words(l.values.join(' ')), test }); }
  }
  for (const g of map?.groups ?? []) items.push({ kind: 'group', id: g.id, text: g.title, words: words(`${g.id} ${g.title}`) });
  for (const r of map?.rules ?? []) items.push({ kind: 'rule', id: r.id, text: r.rule, words: words(`${r.id} ${r.rule} ${r.why ?? ''}`) });
  for (const g of map?.groups ?? []) for (const r of g.risks ?? []) items.push({ kind: 'risk', group: g.id, text: r.text, words: words(r.text) });

  // Rarer words count for more: "payment" in a shop's code says little, "refund" says more.
  const df = new Map(asked.map((q) => [q, items.filter((it) => it.words.some((w) => meets(q, w))).length]));
  const weight = (q) => Math.log((items.length + 1) / (1 + df.get(q)));
  const scored = [];
  for (const it of items) {
    // A definition is found by its name; the folder and file it sits in (webhook/transport for signature_for_payload)
    // add the other words, at half weight.
    // The comment above it ("Table references in a piece of code" for lineRefs) counts too, below the name: names are
    // short and say less than what the code is for.
    const inName = asked.filter((q) => it.words.some((w) => meets(q, w)));
    const inDoc = asked.filter((q) => !inName.includes(q) && (it.doc ?? []).some((w) => meets(q, w)));
    // The names a list holds count as its comment does: what it is about, below its own name.
    const inValues = asked.filter((q) => !inName.includes(q) && !inDoc.includes(q) && (it.values ?? []).some((w) => meets(q, w)));
    if (!inName.length && !inDoc.length && !inValues.length) continue;
    const inPath = asked.filter((q) => !inName.includes(q) && !inDoc.includes(q) && !inValues.includes(q) && (it.path ?? []).some((w) => meets(q, w)));
    const matched = [...inName, ...inDoc, ...inValues, ...inPath];
    // A name made only of the words asked for ("retryPayment" for "payment retry") is the closest match.
    const exact = it.words.length && it.words.every((w) => asked.some((q) => meets(q, w)));
    const score = inName.reduce((s, q) => s + weight(q), 0) + inPath.reduce((s, q) => s + weight(q) / 2, 0) + [...inDoc, ...inValues].reduce((s, q) => s + weight(q) * 0.6, 0) + (exact ? 0.5 : 0);
    scored.push({ it, matched, exact, score, inDoc, inValues });
  }
  // Most words matched first, then code before tests and code being replaced, then rarer words, then the most used.
  const order = (a, b) => b.matched.length - a.matched.length || Number(Boolean(a.it.test)) - Number(Boolean(b.it.test)) || Number(Boolean(replaced(a.it.file))) - Number(Boolean(replaced(b.it.file))) || b.score - a.score || (users.get(b.it.file) ?? 0) - (users.get(a.it.file) ?? 0) || String(a.it.file ?? a.it.id).localeCompare(String(b.it.file ?? b.it.id));
  // With several words asked, a hit on only one of them is listed only when nothing matches more.
  const best = Math.max(0, ...scored.map((s) => s.matched.length));
  const keep = (s) => asked.length < 2 || s.matched.length >= Math.min(best, 2);
  const codeHits = scored.filter((s) => !['group', 'rule', 'risk'].includes(s.it.kind) && keep(s)).sort(order);
  const mapHits = scored.filter((s) => ['group', 'rule', 'risk'].includes(s.it.kind) && keep(s)).sort(order);
  const other = new Set(files.filter((f) => OTHER_CODE.test(f) && !ignored(f)).map((f) => f.split('.').pop().toLowerCase()));
  return {
    format: FIND_FORMAT,
    query,
    words: asked,
    searched: { files: code.length, definitions: defs, lists, groups: map?.groups.length ?? 0, rules: map?.rules?.length ?? 0 },
    // cut: `more` counts the rest of both lists, said as "…and N more (--limit)"
    code: codeHits.slice(0, limit).map(({ it, matched, exact, inDoc, inValues }) => ({ kind: it.kind, ...(it.name ? { name: it.name } : {}), file: it.file, ...(it.line ? { line: it.line } : {}), group: group(it.file), usedBy: users.get(it.file) ?? 0, test: it.test, matched, exact, ...(inDoc.length ? { inComment: inDoc } : {}), ...(inValues.length ? { inValues } : {}), ...(replaced(it.file) ? { deprecated: { use: replaced(it.file).use ?? null } } : {}) })),
    // cut: see above
    map: mapHits.slice(0, limit).map(({ it, matched }) => ({ kind: it.kind, ...(it.id ? { id: it.id } : {}), ...(it.group ? { group: it.group } : {}), text: it.text, matched })),
    more: { code: Math.max(0, codeHits.length - limit), map: Math.max(0, mapHits.length - limit) },
    notSearched: [...other].sort(),
  };
}

export function findText(r) {
  const out = [`# Already in the code? "${r.query}"`, ''];
  if (!r.words.length) return `${out.join('\n')}Only words like "add", "new" or "helper" were given: say what it is about ("payment retry", "csv export").\n`;
  out.push(`Searched ${r.searched.files} code files and ${r.searched.definitions} names${r.searched.lists ? ` and ${r.searched.lists} constant lists` : ''}${r.searched.groups ? `, and the map's ${r.searched.groups} groups and ${r.searched.rules} rules` : ''}, for: ${r.words.join(', ')}.`, '');
  const where = (h) => `\`${h.file}${h.line ? `:${h.line}` : ''}\``;
  if (r.code.length) {
    out.push('## Code that may already do this', '');
    for (const h of r.code) {
      const what = h.kind === 'file' ? `${where(h)} (file)` : `\`${h.name}\` (${h.kind}) in ${where(h)}`;
      const notes = [h.exact ? 'name matches' : `matches ${h.matched.join(', ')}${h.inComment?.length ? ` (${h.inComment.join(', ')} in its comment)` : ''}${h.inValues?.length ? ` (${h.inValues.join(', ')} among the names it holds)` : ''}`, h.usedBy ? `used by ${h.usedBy} file(s)` : null, h.test ? 'a test' : null, h.deprecated ? `being replaced${h.deprecated.use ? `: use ${h.deprecated.use}` : ''}` : null, h.group ? `group ${h.group}` : null].filter(Boolean);
      out.push(`- ${what} — ${notes.join(' · ')}`);
    }
    if (r.more.code) out.push(`- …and ${r.more.code} more (\`--limit\`)`);
    out.push('');
  }
  if (r.map.length) {
    out.push('## What the map says about it', '');
    for (const h of r.map) out.push(`- ${h.kind === 'rule' ? `rule **${h.id}**` : h.kind === 'group' ? `group **${h.id}**` : `risk in group ${h.group}`}: ${h.text.length > 160 ? `${h.text.slice(0, 160)}…` : h.text}`);
    if (r.more.map) out.push(`- …and ${r.more.map} more`);
    out.push('');
  }
  if (!r.code.length && !r.map.length) out.push(`Nothing matched. Names are matched by words, not meaning: try other words for the same thing${r.words.some((w) => /\p{Script=Hangul}/u.test(w)) ? ', and the English words the code would use ("payment retry" for 결제 재시도)' : ''}.`, '');
  else out.push('If one of these already does it, use or extend it instead of writing another. `readfirst read <file>` gives its rules and checks.', '');
  if (r.notSearched.length) out.push(`Not searched: .${r.notSearched.join(', .')} files (names in these languages are not read).`, '');
  return out.join('\n');
}
