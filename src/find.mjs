// readfirst find: before writing something new, what in the repository may already do it. A few words ("payment retry
// helper", "결제 재시도") are matched against the names of functions, classes and types in the code, file paths, and
// what the map says (group titles, rules, risks). Matching is by words, not meaning: no model and no index, so it
// finds `retryPayment` and `payments/retry.py` but not a function called `try_again`. It reads the checkout and
// writes nothing.
import { matcher, groupOf, MAP_PATH } from './map.mjs';
import { isTest, OTHER_CODE } from './readlist.mjs';

export const FIND_FORMAT = 'readfirst/find@1';

// Words that say what kind of change is wanted, not what it is about.
const STOP = new Set(('a an the to for of and or in on at by with from into via is are be it this that new add adding make making create creating write '
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
const meets = (q, w) => q === w || (Math.min(q.length, w.length) >= (/\p{Script=Hangul}/u.test(q) ? 2 : 3) && (w.startsWith(q) || q.startsWith(w)));

// Definitions by language: a name and the line it is on. Rough on purpose: a name a person would search for.
const DEFS = [
  { test: /\.(?:m?js|cjs|tsx?|jsx|mts|cts|vue|svelte)$/u, re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function)/u },
  { test: /\.py$/u, re: /^\s*(?:async\s+)?(?:def\s+([A-Za-z_]\w*)|class\s+([A-Za-z_]\w*))/u },
  { test: /\.go$/u, re: /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/u },
  { test: /\.rs$/u, re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn\s+([A-Za-z_]\w*)|(?:struct|enum|trait)\s+([A-Za-z_]\w*))/u },
  { test: /\.rb$/u, re: /^\s*(?:def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)|(?:class|module)\s+([A-Z]\w*))/u },
  { test: /\.php$/u, re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function\s+([A-Za-z_]\w*)|(?:class|interface|trait|enum)\s+([A-Za-z_]\w*))/u },
  { test: /\.exs?$/u, re: /^\s*(?:defp?\s+([a-z_]\w*[?!]?)|defmodule\s+([A-Z][\w.]*))/u },
  { test: /\.(?:java|kts?|cs)$/u, re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|override|suspend|async|virtual|data)\s+)*(?:(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)|fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)\s*\(|[\w<>[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\([^;]*$)/u },
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'main']);
const SKIP = /\.d\.ts$|\.min\.js$|(?:^|\/)(?:vendor|node_modules|dist|build|migrations)\//u;

export function definitions(path, body) {
  const lang = DEFS.find((d) => d.test.test(path));
  if (!lang || !body) return [];
  const out = [];
  body.split('\n').forEach((l, i) => {
    const m = l.match(lang.re);
    if (!m) return;
    const name = m.slice(1).find(Boolean);
    if (!name || KEYWORDS.has(name) || name.length < 3) return;
    out.push({ name, line: i + 1, kind: /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|pub)\s+)*(?:class|struct|interface|trait|enum|record|object|module|defmodule|type)\b/u.test(l) ? 'type' : 'function' });
  });
  return out;
}

// query: the words asked; files, imports (for how many files use each one), read(path), map (optional).
export function find({ query, files, imports = [], read = () => null, map = null, limit = 15 }) {
  const asked = [...new Set(words(query))];
  const ignored = matcher(map?.ignore ?? []);
  const code = files.filter((f) => f !== MAP_PATH && !SKIP.test(f) && !ignored(f) && DEFS.some((d) => d.test.test(f)));
  const users = new Map();
  for (const e of imports) if (!isTest(e.from)) users.set(e.to, (users.get(e.to) ?? 0) + 1);
  const group = (f) => (map ? groupOf(map, f)?.id ?? null : null);

  // Every place a word can be found, with its own words.
  const items = [];
  let defs = 0;
  for (const f of code) {
    const test = isTest(f);
    items.push({ kind: 'file', file: f, words: words(f.replace(/\.[^./]+$/u, '')), test });
    const at = words(f.replace(/\.[^./]+$/u, ''));
    for (const d of definitions(f, read(f))) { defs++; items.push({ kind: d.kind, name: d.name, file: f, line: d.line, words: words(d.name), path: at, test }); }
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
    const inName = asked.filter((q) => it.words.some((w) => meets(q, w)));
    if (!inName.length) continue;
    const inPath = asked.filter((q) => !inName.includes(q) && (it.path ?? []).some((w) => meets(q, w)));
    const matched = [...inName, ...inPath];
    // A name made only of the words asked for ("retryPayment" for "payment retry") is the closest match.
    const exact = it.words.length && it.words.every((w) => asked.some((q) => meets(q, w)));
    const score = inName.reduce((s, q) => s + weight(q), 0) + inPath.reduce((s, q) => s + weight(q) / 2, 0) + (exact ? 0.5 : 0);
    scored.push({ it, matched, exact, score });
  }
  // Most words matched first, then code before tests, then rarer words, then the most used.
  const order = (a, b) => b.matched.length - a.matched.length || Number(Boolean(a.it.test)) - Number(Boolean(b.it.test)) || b.score - a.score || (users.get(b.it.file) ?? 0) - (users.get(a.it.file) ?? 0) || String(a.it.file ?? a.it.id).localeCompare(String(b.it.file ?? b.it.id));
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
    searched: { files: code.length, definitions: defs, groups: map?.groups.length ?? 0, rules: map?.rules?.length ?? 0 },
    code: codeHits.slice(0, limit).map(({ it, matched, exact }) => ({ kind: it.kind, ...(it.name ? { name: it.name } : {}), file: it.file, ...(it.line ? { line: it.line } : {}), group: group(it.file), usedBy: users.get(it.file) ?? 0, test: it.test, matched, exact })),
    map: mapHits.slice(0, limit).map(({ it, matched }) => ({ kind: it.kind, ...(it.id ? { id: it.id } : {}), ...(it.group ? { group: it.group } : {}), text: it.text, matched })),
    more: { code: Math.max(0, codeHits.length - limit), map: Math.max(0, mapHits.length - limit) },
    notSearched: [...other].sort(),
  };
}

export function findText(r) {
  const out = [`# Already in the code? "${r.query}"`, ''];
  if (!r.words.length) return `${out.join('\n')}Only words like "add", "new" or "helper" were given: say what it is about ("payment retry", "csv export").\n`;
  out.push(`Searched ${r.searched.files} code files and ${r.searched.definitions} names${r.searched.groups ? `, and the map's ${r.searched.groups} groups and ${r.searched.rules} rules` : ''}, for: ${r.words.join(', ')}.`, '');
  const where = (h) => `\`${h.file}${h.line ? `:${h.line}` : ''}\``;
  if (r.code.length) {
    out.push('## Code that may already do this', '');
    for (const h of r.code) {
      const what = h.kind === 'file' ? `${where(h)} (file)` : `\`${h.name}\` (${h.kind}) in ${where(h)}`;
      const notes = [h.exact ? 'name matches' : `matches ${h.matched.join(', ')}`, h.usedBy ? `used by ${h.usedBy} file(s)` : null, h.test ? 'a test' : null, h.group ? `group ${h.group}` : null].filter(Boolean);
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
