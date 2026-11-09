// The map file: groups of files with what to check and what to watch out for, plus project rules.
// Paths are repository paths with forward slashes. A pattern is a path, a folder ending in "/**", or a "*" glob
// within one path segment ("src/*.js", "*.md"). Every tracked file belongs to exactly one group or to "ignore".

export const MAP_FORMAT = 'readfirst/map@1';
export const MAP_PATH = '.readfirst/map.json';
// readfirst's own files: the map, the record of when rules held (held.mjs) and the Cursor rules export writes
// (export.mjs). They belong to no group.
const OWN_FILES = new Set([MAP_PATH, '.readfirst/held.json']);
const OWN_PATTERN = /^\.cursor\/rules\/readfirst-[a-z0-9-]+\.mdc$/u;
export const isOwnFile = (path) => OWN_FILES.has(path) || OWN_PATTERN.test(path);
const OWN = { has: isOwnFile };
// Text without a leading UTF-8 byte order mark. Windows editors and PowerShell write one; JSON.parse refuses it, and npm
// reads such a package.json without complaint, so every file readfirst parses goes through this first.
export const unBom = (s) => (typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 2000) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

export function patternToRegExp(pattern) {
  // Within one segment: `*` is any run of characters, `?` one character; everything else is literal.
  const segment = (s) => s.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]');
  // `**/` is zero or more folders wherever it stands, also in front of a trailing `/**`.
  const body = (p) => p.split('**/').map(segment).join('(?:.*/)?');
  if (pattern.endsWith('/**')) return new RegExp(`^${body(pattern.slice(0, -3))}/`, 'u');
  if (pattern === '**') return /^/u;
  return new RegExp(`^${body(pattern)}$`, 'u');
}

export const matcher = (patterns) => {
  const res = patterns.map(patternToRegExp);
  return (path) => res.some((r) => r.test(path));
};

const strings = (v, where, p, max = 500) => {
  if (!Array.isArray(v) || !v.every((s) => text(s, max))) p.push(`${where}: a list of non-empty strings`);
  return Array.isArray(v) ? v.filter((s) => text(s, max)) : [];
};

// An unknown field one plural or a letter or two away from a known one names it: `file` for `files` was reported only as
// "unknown field", which on a first map read as the field being wrong rather than misspelled (owner's plan B,
// 2026-11-09). "unknown field" stays first in the text, as before.
const editDistance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};
export function nearField(key, keys) {
  const k = String(key).toLowerCase();
  const scored = keys.map((known) => {
    const n = known.toLowerCase();
    const plural = k === n || `${k}s` === n || k === `${n}s` || `${k}es` === n || k === `${n}es`;
    return { known, d: plural ? 0 : editDistance(k, n) };
  }).filter(({ known, d }) => d <= (known.length >= 5 ? 2 : 1)).sort((a, b) => a.d - b.d);
  // Two known fields equally near: name neither rather than guess.
  return scored.length && (scored.length === 1 || scored[0].d < scored[1].d) ? scored[0].known : null;
}
const only = (v, keys, where, p) => {
  for (const k of Object.keys(v)) {
    if (keys.includes(k)) continue;
    const near = nearField(k, keys);
    p.push(`${where}.${k}: unknown field${near ? `; did you mean \`${near}\`?` : ''}`);
  }
};

const checkList = (v, where, p) => {
  if (v === undefined) return;
  if (!Array.isArray(v)) { p.push(`${where}: a list`); return; }
  v.forEach((c, i) => {
    if (!isRecord(c) || !text(c.run, 500)) { p.push(`${where}[${i}]: { run, why? }`); return; }
    only(c, ['run', 'why'], `${where}[${i}]`, p);
    if (c.why !== undefined && !text(c.why)) p.push(`${where}[${i}].why: text`);
  });
};

// Hot spots: functions where code that does something risky (writes the database, moves money, calls out) meets a rule.
// Optional; written by tools, read by `read`. Each names a tracked file, a symbol in it and the line it starts on.
export const MAX_HOTSPOTS = 500;
function hotspotProblems(map, files, p) {
  if (!Array.isArray(map.hotspots)) { p.push('hotspots: a list'); return; }
  if (map.hotspots.length > MAX_HOTSPOTS) p.push(`hotspots: at most ${MAX_HOTSPOTS}`);
  const ruleIds = new Set((Array.isArray(map.rules) ? map.rules : []).map((r) => r?.id));
  const tracked = new Set(files);
  map.hotspots.forEach((h, i) => {
    const at = `hotspots[${i}]`;
    if (!isRecord(h)) { p.push(`${at}: { file, symbol, line, labels, rules?, note? }`); return; }
    only(h, ['file', 'symbol', 'line', 'labels', 'rules', 'note'], at, p);
    if (typeof h.file !== 'string' || !h.file) p.push(`${at}.file: a path`);
    else if (!tracked.has(h.file)) p.push(`${at}.file: ${h.file} is not a tracked file`);
    if (!text(h.symbol, 200)) p.push(`${at}.symbol: text`);
    if (!Number.isInteger(h.line) || h.line < 1) p.push(`${at}.line: a line number`);
    const labels = strings(h.labels, `${at}.labels`, p, 64);
    if (!labels.length) p.push(`${at}.labels: at least one label`);
    for (const l of labels) if (!ID.test(l)) p.push(`${at}.labels: ${l}: lowercase letters, digits and "-"`);
    if (h.rules !== undefined) for (const r of strings(h.rules, `${at}.rules`, p, 64)) if (!ruleIds.has(r)) p.push(`${at}.rules: no rule ${r}`);
    if (h.note !== undefined && !text(h.note, 500)) p.push(`${at}.note: text`);
  });
}

// Flows (optional): where outside input enters (a route, a webhook) and what it reaches, worked out from the code with
// no model. Each names the entry (`entry` text such as "POST /orders/:id", its file and line), the checks found on the
// way (`checks`: names of the functions or decorators that decide who may do it; empty when none was found) and the
// functions it reaches that do something that matters (`reaches`: file, symbol, line, labels such as db-write, and
// optionally `tables`: the database tables that code writes or reads, and `inputs`: the names that carry outside input
// to that code's calls, such as req.body or amount).
// Written by tools, read by `read`.
// No limit on how many (0.25.0; before, 500): the map stores every path, and what one run reads is the reader's own
// budget (owner, 2026-11-07: store everything, cap only the work of one run). The most measured was 451 (novu).
// OLD_MAX_FLOWS is what CLIs before 0.25.0 accept; pins.mjs warns when the pinned readfirst is older.
export const OLD_MAX_FLOWS = 500;
function flowProblems(map, files, p) {
  if (!Array.isArray(map.flows)) { p.push('flows: a list'); return; }
  const tracked = new Set(files);
  const place = (v, at) => {
    if (typeof v.file !== 'string' || !v.file) p.push(`${at}.file: a path`);
    else if (!tracked.has(v.file)) p.push(`${at}.file: ${v.file} is not a tracked file`);
    if (!Number.isInteger(v.line) || v.line < 1) p.push(`${at}.line: a line number`);
  };
  map.flows.forEach((f, i) => {
    const at = `flows[${i}]`;
    if (!isRecord(f)) { p.push(`${at}: { entry, file, line, checks, reaches }`); return; }
    only(f, ['entry', 'file', 'line', 'checks', 'reaches'], at, p);
    if (!text(f.entry, 200)) p.push(`${at}.entry: text`);
    place(f, at);
    if (!Array.isArray(f.checks) || !f.checks.every((c) => text(c, 200))) p.push(`${at}.checks: a list of names (empty when none was found)`);
    if (!Array.isArray(f.reaches) || !f.reaches.length) { p.push(`${at}.reaches: at least one { file, symbol, line, labels }`); return; }
    f.reaches.forEach((r, k) => {
      const rat = `${at}.reaches[${k}]`;
      if (!isRecord(r)) { p.push(`${rat}: { file, symbol, line, labels }`); return; }
      only(r, ['file', 'symbol', 'line', 'labels', 'tables', 'inputs'], rat, p);
      place(r, rat);
      if (!text(r.symbol, 200)) p.push(`${rat}.symbol: text`);
      if (r.inputs !== undefined) { const ins = strings(r.inputs, `${rat}.inputs`, p, 120); if (ins.length > 10) p.push(`${rat}.inputs: at most 10`); }
      if (r.tables !== undefined) for (const t of strings(r.tables, `${rat}.tables`, p, 200)) if (!/^[\w.$"-]+$/u.test(t)) p.push(`${rat}.tables: ${t}: a table name`);
      const labels = strings(r.labels, `${rat}.labels`, p, 64);
      if (!labels.length) p.push(`${rat}.labels: at least one label`);
      for (const l of labels) if (!ID.test(l)) p.push(`${rat}.labels: ${l}: lowercase letters, digits and "-"`);
    });
  });
}

// The repository's own words (optional), so a tool that reads code with no model knows what this repository calls
// things: which of its functions decide who may do something (`checks`), which calls do something that matters
// (`sinks`, with a label such as db-write), names that look like checks but are not (`notChecks`: a database session
// dependency), and entries that are open to anyone on purpose (`public`). A name may hold `*` ("*WithCtx").
// `evidence` is the file and line that show it ("api/auth.js:143"). Written by a person or by fill after reading the
// code, reviewed in the PR like the rest of the map. Older readfirst versions reject maps that have it.
export const MAX_VOCABULARY = 200;
const VOCAB_NAME = /^[A-Za-z_$*][\w$.*]{0,99}$/u;
// Since 0.21.0 also: how the repository declares its own routes (`entries`: a decorator such as "Post" inside a class
// decorated "RestController", or a call such as "api.register"; `check` and `unless` for the check each such route gets
// unless its declaration opts out), checks that hold only under a condition (`checksIf`:
// "PermissionDenied" counts only where the code matches `when`, a regular expression), calls that look like writes but
// are not (`notSinks`), what keeps a job or webhook from running twice (`once`), and functions whose return value is
// outside input (`sources`).
const VOCAB_KINDS = {
  checks: ['name', 'evidence', 'why'], sinks: ['call', 'label', 'evidence', 'why'], notChecks: ['name', 'why', 'evidence'], public: ['entry', 'why'],
  entries: ['decorator', 'call', 'within', 'check', 'unless', 'evidence', 'why'], checksIf: ['name', 'when', 'evidence', 'why'], notSinks: ['call', 'label', 'why', 'evidence'],
  once: ['name', 'evidence', 'why'], sources: ['call', 'evidence', 'why'],
};
const NAME_KEY = { sinks: 'call', notSinks: 'call', sources: 'call' };
// What a vocabulary entry is called, for messages and read lists.
export const vocabularyName = (x) => x?.name ?? x?.call ?? x?.decorator ?? x?.entry ?? null;
export const evidenceFile = (e) => (typeof e === 'string' ? e.replace(/:\d+$/u, '') : null);
function vocabularyProblems(map, files, p) {
  const v = map.vocabulary;
  if (!isRecord(v)) { p.push(`vocabulary: { ${Object.keys(VOCAB_KINDS).join(', ')} }`); return; }
  only(v, Object.keys(VOCAB_KINDS), 'vocabulary', p);
  const tracked = new Set(files);
  const evidence = (e, at, required) => {
    if (e === undefined) { if (required) p.push(`${at}.evidence: "file:line" where the code shows it`); return; }
    const m = typeof e === 'string' ? e.match(/^(.+):(\d+)$/u) : null;
    if (!m || Number(m[2]) < 1) p.push(`${at}.evidence: "file:line"`);
    else if (!tracked.has(m[1])) p.push(`${at}.evidence: ${m[1]} is not a tracked file`);
  };
  for (const [kind, keys] of Object.entries(VOCAB_KINDS)) {
    const list = v[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { p.push(`vocabulary.${kind}: a list`); continue; }
    if (list.length > MAX_VOCABULARY) p.push(`vocabulary.${kind}: at most ${MAX_VOCABULARY}`);
    list.forEach((x, i) => {
      const at = `vocabulary.${kind}[${i}]`;
      if (!isRecord(x)) { p.push(`${at}: { ${keys.join(', ')} }`); return; }
      only(x, keys, at, p);
      const nameOk = (name) => typeof name === 'string' && VOCAB_NAME.test(name) && !/^\**$/u.test(name);
      if (kind === 'public') {
        if (!text(x.entry, 200)) p.push(`${at}.entry: an entry such as "GET /api/explore/*"`);
      } else if (kind === 'entries') {
        if ((x.decorator === undefined) === (x.call === undefined)) p.push(`${at}: one of "decorator" (a decorator that makes the function below it a route) or "call" (a call that registers one)`);
        else if (!nameOk(x.decorator ?? x.call)) p.push(`${at}.${x.decorator !== undefined ? 'decorator' : 'call'}: a decorator or call name, "*" allowed`);
        if (x.within !== undefined && (x.decorator === undefined || !nameOk(x.within))) p.push(`${at}.within: the class decorator whose path prefixes the routes (only with "decorator")`);
        // `check`: what the framework the repository built decides for every route declared this way (its routes need a
        // signed-in user), and `unless`: a regular expression for the declarations that opt out (`skipAuth: true`).
        if (x.check !== undefined && !text(x.check, 100)) p.push(`${at}.check: the name of the check every route declared this way gets`);
        if (x.unless !== undefined) {
          let ok = x.check !== undefined && text(x.unless, 200);
          if (ok) { try { new RegExp(x.unless, 'u'); } catch { ok = false; } }
          if (!ok) p.push(`${at}.unless: a regular expression for the declarations that skip "check" (only with "check")`);
        }
      } else {
        const key = NAME_KEY[kind] ?? 'name';
        if (!nameOk(x[key])) p.push(`${at}.${key}: a function or call name, "*" allowed`);
      }
      if ((kind === 'sinks' || (kind === 'notSinks' && x.label !== undefined)) && (typeof x.label !== 'string' || !ID.test(x.label))) p.push(`${at}.label: lowercase letters, digits and "-" (db-write, money, ...)`);
      if (kind === 'checksIf') {
        let ok = text(x.when, 200);
        if (ok) { try { new RegExp(x.when, 'u'); } catch { ok = false; } }
        if (!ok) p.push(`${at}.when: a regular expression the entry's code must match for the check to count`);
      }
      if (x.why !== undefined || ['notChecks', 'public', 'checksIf', 'notSinks'].includes(kind)) if (!text(x.why, 300)) p.push(`${at}.why: text`);
      evidence(x.evidence, at, ['checks', 'sinks', 'entries', 'checksIf', 'once', 'sources'].includes(kind));
    });
  }
}

// What things in the code are (optional, since 0.22.0): the repository's own models, so a tool that reads code with no
// model knows them. One row picks something (`match`: a function or call name, a decorator with the class decorator
// around it, a base class, or a file pattern) and says what it is (`is`): where outside input enters (entry), what
// decides who may go on (check), what does something that matters (sink, with `kind` such as db-write), or something
// that looks like one of these and is not (neutral). `kind` narrows it (entry: route; check: auth); new kinds are new
// values, not new fields. An entry may name the check every such entry gets (`check`) and a regular expression for the
// declarations that opt out (`unless`). What must hold is a rule, not a model: an entry open on purpose is a rule with
// flow.must ["public"]. Built-in facts (Django, NestJS, a 401 answer) are not written here; the tool knows them.
export const MODEL_ROLES = ['entry', 'check', 'sink', 'neutral'];
const MATCH_KEYS = ['call', 'decorator', 'within', 'extends', 'file'];
export const MAX_MODELS = 400;
// What a model row matches, for messages and read lists.
export const modelName = (m) => (isRecord(m?.match) ? m.match.call ?? m.match.decorator ?? m.match.extends ?? m.match.file ?? null : null);
function modelProblems(map, files, p) {
  if (!Array.isArray(map.models)) { p.push('models: a list'); return; }
  if (map.models.length > MAX_MODELS) p.push(`models: at most ${MAX_MODELS}`);
  const tracked = new Set(files);
  const nameOk = (n) => typeof n === 'string' && VOCAB_NAME.test(n) && !/^\**$/u.test(n);
  map.models.forEach((m, i) => {
    const at = `models[${i}]`;
    if (!isRecord(m)) { p.push(`${at}: { match, is, kind?, evidence, why? }`); return; }
    only(m, ['match', 'is', 'kind', 'check', 'unless', 'evidence', 'why'], at, p);
    if (!isRecord(m.match)) p.push(`${at}.match: { call } or { decorator, within? } or { extends } or { file }`);
    else {
      only(m.match, MATCH_KEYS, `${at}.match`, p);
      const picked = ['call', 'decorator', 'extends', 'file'].filter((k) => m.match[k] !== undefined);
      if (picked.length !== 1) p.push(`${at}.match: exactly one of call, decorator, extends, file`);
      else if (picked[0] === 'file' ? !text(m.match.file, 300) || !files.some(matcher([m.match.file])) : !nameOk(m.match[picked[0]])) p.push(`${at}.match.${picked[0]}: ${picked[0] === 'file' ? 'a pattern that matches a tracked file' : 'a name, "*" allowed'}`);
      if (m.match.within !== undefined && (m.match.decorator === undefined || !nameOk(m.match.within))) p.push(`${at}.match.within: the class decorator around it (only with decorator)`);
    }
    if (!MODEL_ROLES.includes(m.is)) p.push(`${at}.is: one of ${MODEL_ROLES.join(', ')}`);
    if (m.kind !== undefined ? typeof m.kind !== 'string' || !ID.test(m.kind) : m.is === 'sink') p.push(`${at}.kind: lowercase letters, digits and "-"${m.is === 'sink' ? ' (db-write, money, ...), required for a sink' : ''}`);
    if (m.check !== undefined && (m.is !== 'entry' || !text(m.check, 100))) p.push(`${at}.check: the check every entry matched gets (only with is "entry")`);
    if (m.unless !== undefined) {
      let ok = m.check !== undefined && text(m.unless, 200);
      if (ok) { try { new RegExp(m.unless, 'u'); } catch { ok = false; } }
      if (!ok) p.push(`${at}.unless: a regular expression for the declarations that skip "check" (only with check)`);
    }
    if (m.is === 'neutral' ? !text(m.why, 300) : m.why !== undefined && !text(m.why, 300)) p.push(`${at}.why: text`);
    if (m.evidence === undefined) { if (m.is !== 'neutral') p.push(`${at}.evidence: "file:line" where the code shows it`); }
    else {
      const e = typeof m.evidence === 'string' ? m.evidence.match(/^(.+):(\d+)$/u) : null;
      if (!e || Number(e[2]) < 1) p.push(`${at}.evidence: "file:line"`);
      else if (!tracked.has(e[1])) p.push(`${at}.evidence: ${e[1]} is not a tracked file`);
    }
  });
}

// The vocabulary (readfirst 0.18.0 to 0.21.0) as models and rules: checks, sinks, notChecks and entries become models;
// public entries become rules with flow.must ["public"]; checksIf, notSinks, once and sources are dropped (no tool reads
// them). `readfirst fix` writes this; read and the hosted tools read both forms.
// The map with its vocabulary rewritten as models and rules (what `readfirst fix` does since 0.22.0).
export function migrateMap(map) {
  if (!isRecord(map) || map.vocabulary === undefined) return { map, changes: [] };
  const out = structuredClone(map);
  const { models, rules, dropped } = vocabularyToModels(out.vocabulary);
  const have = new Set((out.rules ?? []).map((x) => x?.id));
  const added = rules.filter((x) => !have.has(x.id));
  if (models.length) out.models = [...(Array.isArray(out.models) ? out.models : []), ...models];
  if (added.length) out.rules = [...(out.rules ?? []), ...added];
  delete out.vocabulary;
  const changes = [`vocabulary: rewritten as ${models.length} model${models.length === 1 ? '' : 's'} and ${added.length} rule${added.length === 1 ? '' : 's'} (public entries)`];
  if (dropped.length) changes.push(`vocabulary: dropped ${dropped.join(', ')} (no tool reads them)`);
  return { map: out, changes };
}

export function vocabularyToModels(vocabulary) {
  const v = isRecord(vocabulary) ? vocabulary : {};
  const list = (k) => (Array.isArray(v[k]) ? v[k].filter(isRecord) : []);
  const keep = (x) => ({ ...(x.evidence !== undefined ? { evidence: x.evidence } : {}), ...(x.why !== undefined ? { why: x.why } : {}) });
  const models = [
    ...list('entries').map((x) => ({ match: x.decorator !== undefined ? { decorator: x.decorator, ...(x.within !== undefined ? { within: x.within } : {}) } : { call: x.call }, is: 'entry', kind: 'route', ...(x.check !== undefined ? { check: x.check } : {}), ...(x.unless !== undefined ? { unless: x.unless } : {}), ...keep(x) })),
    ...list('checks').map((x) => ({ match: { call: x.name }, is: 'check', kind: 'auth', ...keep(x) })),
    ...list('sinks').map((x) => ({ match: { call: x.call }, is: 'sink', kind: x.label, ...keep(x) })),
    ...list('notChecks').map((x) => ({ match: { call: x.name }, is: 'neutral', ...keep(x) })),
  ];
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'entry';
  const rules = list('public').filter((x) => typeof x.entry === 'string').map((x) => ({ id: `public-${slug(x.entry)}`, rule: `${x.entry} is open to anyone on purpose`, ...(x.why !== undefined ? { why: x.why } : {}), files: ['**'], flow: { entry: x.entry, must: ['public'] } }));
  const dropped = ['checksIf', 'notSinks', 'once', 'sources'].filter((k) => list(k).length);
  return { models, rules, dropped };
}

// A rule written as structure (optional `flow` on a rule), so a tool can check it on the map's flows with no model:
// which flows it is about (`entry`: an entry such as "POST /api/orders/*" or a path "/api/pay*"; `reaches`: a label such
// as payments-api, `table:<name>`, or a function name; `*` allowed) and what each must have on the way (`must`):
// `check` (some check of who may do it), `check:<name>` (that one), `once` (a unique key, upsert or idempotency key, so
// running twice is safe), `no-input` (no outside input reaches the call).
const FLOW_MUST = /^(?:check(?::[\w$.*-]{1,100})?|once|no-input|public)$/u;
function ruleFlowProblems(flow, at, p) {
  if (!isRecord(flow)) { p.push(`${at}: { entry?, reaches?, must }`); return; }
  only(flow, ['entry', 'reaches', 'must'], at, p);
  if (flow.entry === undefined && flow.reaches === undefined) p.push(`${at}: entry or reaches, to say which flows it is about`);
  if (flow.entry !== undefined && !text(flow.entry, 200)) p.push(`${at}.entry: an entry such as "POST /api/orders/*"`);
  if (flow.reaches !== undefined && !text(flow.reaches, 200)) p.push(`${at}.reaches: a label, table:<name> or a function name`);
  const must = strings(flow.must, `${at}.must`, p, 120);
  if (!must.length) p.push(`${at}.must: at least one of check, check:<name>, once, no-input`);
  for (const m of must) if (!FLOW_MUST.test(m)) p.push(`${at}.must: ${m}: one of check, check:<name>, once, no-input, public`);
}

// Files that change together (optional): when a change touches a file matching `when`, it must also change one matching
// `also`, or `verify` fails ("package.json" with "server.json", a model with its migration). `also` may name files that
// do not exist yet (a new migration), so only `when` has to match a tracked file.
function requiresProblems(map, files, p) {
  if (!Array.isArray(map.requires)) { p.push('requires: a list'); return; }
  map.requires.forEach((r, i) => {
    const at = `requires[${i}]`;
    if (!isRecord(r)) { p.push(`${at}: { when, also, why }`); return; }
    only(r, ['when', 'also', 'why'], at, p);
    const when = strings(r.when, `${at}.when`, p);
    if (!when.length) p.push(`${at}.when: at least one path or pattern`);
    if (!strings(r.also, `${at}.also`, p).length) p.push(`${at}.also: at least one path or pattern`);
    if (!text(r.why)) p.push(`${at}.why: text`);
    for (const f of when) if (!files.some(matcher([f]))) p.push(`${at}.when: ${f} matches no tracked file`);
  });
}

// Other repositories that depend on files here (optional): `read` names them, `verify` reminds you of them. readfirst
// cannot see the other repository; the hosted version checks it.
export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
function dependentsProblems(map, files, p) {
  if (!Array.isArray(map.dependents)) { p.push('dependents: a list'); return; }
  map.dependents.forEach((d, i) => {
    const at = `dependents[${i}]`;
    if (!isRecord(d)) { p.push(`${at}: { files, repo, paths?, why }`); return; }
    only(d, ['files', 'repo', 'paths', 'why'], at, p);
    const own = strings(d.files, `${at}.files`, p);
    if (!own.length) p.push(`${at}.files: at least one path or pattern`);
    for (const f of own) if (!files.some(matcher([f]))) p.push(`${at}.files: ${f} matches no tracked file`);
    if (typeof d.repo !== 'string' || !REPO.test(d.repo)) p.push(`${at}.repo: owner/name`);
    if (d.paths !== undefined) strings(d.paths, `${at}.paths`, p);
    if (!text(d.why)) p.push(`${at}.why: text`);
  });
}

// Problems with the map against the list of tracked files. An empty list means the map is good.
export function mapProblems(map, files, { placement = true } = {}) {
  const p = [];
  if (!isRecord(map)) return ['map: a JSON object'];
  only(map, ['format', 'groups', 'rules', 'ignore', 'hotspots', 'flows', 'models', 'vocabulary', 'requires', 'dependents'], 'map', p);
  // `format` is required and has one value; the bare `format: "readfirst/map@1"` did not say which (plan B).
  if (map.format === undefined) p.push(`format: required: add "format": "${MAP_FORMAT}" to the map`);
  else if (map.format !== MAP_FORMAT) p.push(`format: must be "${MAP_FORMAT}", not ${JSON.stringify(map.format)}`);
  if (!Array.isArray(map.groups) || !map.groups.length) return [...p, 'groups: at least one group'];
  const ids = new Set();
  map.groups.forEach((g, i) => {
    const at = `groups[${i}]`;
    if (!isRecord(g)) { p.push(`${at}: an object`); return; }
    only(g, ['id', 'title', 'files', 'checks', 'risks', 'deprecated'], at, p);
    if (typeof g.id !== 'string' || !ID.test(g.id)) p.push(`${at}.id: lowercase letters, digits and "-"`);
    else if (ids.has(g.id)) p.push(`${at}.id: ${g.id} is used twice`);
    ids.add(g.id);
    if (!text(g.title, 200)) p.push(`${at}.title: text`);
    if (!strings(g.files, `${at}.files`, p).length) p.push(`${at}.files: at least one path or pattern`);
    checkList(g.checks, `${at}.checks`, p);
    // Code being replaced: why, and optionally what to use instead (a group id or a path). Optional; checked below once
    // every group id is known.
    if (g.deprecated !== undefined) {
      if (!isRecord(g.deprecated) || !text(g.deprecated.why)) p.push(`${at}.deprecated: { why, use? }`);
      else {
        only(g.deprecated, ['why', 'use'], `${at}.deprecated`, p);
        if (g.deprecated.use !== undefined && !text(g.deprecated.use, 500)) p.push(`${at}.deprecated.use: a group id or a path`);
      }
    }
    if (g.risks !== undefined) {
      if (!Array.isArray(g.risks)) p.push(`${at}.risks: a list`);
      else g.risks.forEach((r, j) => {
        if (!isRecord(r) || !text(r.text)) { p.push(`${at}.risks[${j}]: { text, files? }`); return; }
        only(r, ['text', 'files'], `${at}.risks[${j}]`, p);
        if (r.files !== undefined) strings(r.files, `${at}.risks[${j}].files`, p);
      });
    }
  });
  map.groups.forEach((g, i) => {
    const use = isRecord(g) && isRecord(g.deprecated) ? g.deprecated.use : undefined;
    if (typeof use === 'string' && use.trim() && !ids.has(use) && !files.some(matcher([use]))) p.push(`groups[${i}].deprecated.use: ${use} is no group id and matches no tracked file`);
  });
  if (map.rules !== undefined) {
    if (!Array.isArray(map.rules)) p.push('rules: a list');
    else {
      const ruleIds = new Set();
      map.rules.forEach((r, i) => {
        const at = `rules[${i}]`;
        if (!isRecord(r)) { p.push(`${at}: an object`); return; }
        only(r, ['id', 'rule', 'why', 'files', 'checks', 'flow'], at, p);
        if (typeof r.id !== 'string' || !ID.test(r.id)) p.push(`${at}.id: lowercase letters, digits and "-"`);
        else if (ruleIds.has(r.id)) p.push(`${at}.id: ${r.id} is used twice`);
        ruleIds.add(r.id);
        if (!text(r.rule)) p.push(`${at}.rule: text`);
        if (r.why !== undefined && !text(r.why)) p.push(`${at}.why: text`);
        if (!strings(r.files, `${at}.files`, p).length) p.push(`${at}.files: at least one path or pattern`);
        checkList(r.checks, `${at}.checks`, p);
        if (r.flow !== undefined) ruleFlowProblems(r.flow, `${at}.flow`, p);
        for (const f of Array.isArray(r.files) ? r.files.filter((x) => typeof x === 'string') : [])
          if (!files.some(matcher([f]))) p.push(`${at}.files: ${f} matches no tracked file`);
      });
    }
  }
  if (map.ignore !== undefined) strings(map.ignore, 'ignore', p);
  if (map.hotspots !== undefined) hotspotProblems(map, files, p);
  if (map.flows !== undefined) flowProblems(map, files, p);
  if (map.vocabulary !== undefined) vocabularyProblems(map, files, p);
  if (map.models !== undefined) modelProblems(map, files, p);
  if (map.requires !== undefined) requiresProblems(map, files, p);
  if (map.dependents !== undefined) dependentsProblems(map, files, p);
  if (p.length || !placement) return p;

  // Placement: each tracked file in exactly one group or ignored; each group pattern matches something.
  const ignored = matcher(map.ignore ?? []);
  const groupMatch = map.groups.map((g) => [g.id, matcher(g.files)]);
  const unplaced = [];
  for (const f of files) {
    if (OWN.has(f)) continue;
    const owners = groupMatch.filter(([, m]) => m(f)).map(([id]) => id);
    if (owners.length > 1) p.push(`${f}: in more than one group (${owners.join(', ')})`);
    else if (!owners.length && !ignored(f)) unplaced.push(f);
  }
  if (unplaced.length) p.push(`${unplaced.length} file(s) in no group and not ignored: ${unplaced.join(', ')}`);
  for (const g of map.groups) for (const pat of g.files)
    if (!files.some(matcher([pat]))) p.push(`groups.${g.id}.files: ${pat} matches no tracked file`);
  return p;
}

export function assertMap(map, files) {
  const p = mapProblems(map, files);
  if (p.length) throw new Error(`${MAP_PATH} has problems:\n- ${p.join('\n- ')}`);
  return map;
}

export const groupOf = (map, path) => map.groups.find((g) => matcher(g.files)(path)) ?? null;

// The risks of other groups whose own `files` name this path: a risk shows wherever its files point, also in another
// group (0.27.2). Before, only the path's own group was read, so a risk whose files named a file of another group showed
// nowhere, and the map passed check (readfirst's own map had the Bash hook's risks on src/cli.mjs, not on
// src/bash-writes.mjs, 2026-11-09). [{ group, risk }].
export function risksNaming(map, path, exceptGroup = null) {
  const out = [];
  for (const g of map?.groups ?? []) {
    if (g.id === exceptGroup) continue;
    for (const r of g.risks ?? []) if (Array.isArray(r.files) && r.files.length && matcher(r.files)(path)) out.push({ group: g, risk: r });
  }
  return out;
}

// Risks whose text names a tracked file that does not show them when it is read: [{ group, index, path, about }].
// `about` is true when the file is named in the risk's first clause (the subject: "src/x.mjs keeps ...", "Bash
// commands in the hook (src/bash-writes.mjs): ..."): the risk was written beside the wrong file and the file it is about
// gets nothing; `check` lists those first and `check --strict` fails on them. A file named further on is often a
// consequence ("so changing it also changes src/action.mjs"): listed after, never a failure, never left out. A path
// counts when it is written out (src/x.mjs) or as a file name only one tracked file has.
export function unshownRisks(map, files) {
  const tracked = new Set(files);
  const byName = new Map();
  for (const f of files) { const n = f.split('/').pop(); byName.set(n, byName.has(n) ? null : f); }
  const PATH = /(?<![\w@/.-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][\w]{0,9})(?![\w/-])/gu;
  const named = (text) => {
    const out = new Set();
    for (const m of text.matchAll(PATH)) {
      const t = m[1].replace(/^\.\//u, '').replace(/\.+$/u, '');
      const path = tracked.has(t) ? t : !t.includes('/') && byName.get(t) ? byName.get(t) : null;
      // readfirst's own files (the map, held.json, the Cursor export) show no risks at all: naming them is no misplacement.
      if (path && !isOwnFile(path)) out.add(path);
    }
    return out;
  };
  const out = [];
  for (const g of map?.groups ?? []) (g.risks ?? []).forEach((r, index) => {
    if (typeof r?.text !== 'string') return;
    const subject = named(r.text.split(/[:;,]|\. /u)[0]);
    for (const path of named(r.text)) {
      const own = groupOf(map, path)?.id === g.id && (!r.files || matcher(r.files)(path));
      const listed = Array.isArray(r.files) && matcher(r.files)(path);
      if (!own && !listed) out.push({ group: g.id, index, path, about: subject.has(path) });
    }
  });
  return out.sort((a, b) => Number(b.about) - Number(a.about));
}

// A first map from the file tree alone: one group per top folder (one per sub-folder under src/, lib/ and app/),
// tests together. Folders of only media or fonts get a group of their own too: code usually loads them, so the risks of
// that code belong there; "ignore" is left for a person to fill with what nothing depends on. Titles and risks are left
// for a person or an agent to write.
const MEDIA = /\.(?:png|jpe?g|gif|webp|svg|ico|mp3|wav|ogg|m4a|flac|mp4|webm|mov|woff2?|ttf|otf|eot|glb|gltf|fbx|blend|zip|pdf)$/iu;
export function draftMap(files, read = () => null) {
  const nested = new Set(['src', 'lib', 'app', 'packages', 'apps']);
  const keyOf = (path) => {
    const parts = path.split('/');
    if (parts.length === 1) return { key: 'root', pattern: null };
    if (/^(?:tests?|__tests__|spec|e2e)$/u.test(parts[0])) return { key: 'tests', pattern: `${parts[0]}/**` };
    if (nested.has(parts[0]) && parts.length > 2) return { key: `${parts[0]}-${parts[1]}`, pattern: `${parts[0]}/${parts[1]}/**` };
    return { key: parts[0], pattern: `${parts[0]}/**` };
  };
  const groups = new Map();
  const ignore = new Set();
  const byFolder = new Map();
  const projectChecks = draftChecks(files, read);
  for (const f of files) {
    if (OWN.has(f)) continue;
    const { key, pattern } = keyOf(f);
    // One key can come from several folders (test/, e2e/ and spec/ are all 'tests'): each keeps its pattern.
    const slot = byFolder.get(key) ?? { pattern, patterns: [], files: [] };
    if (pattern && !slot.patterns.includes(pattern)) slot.patterns.push(pattern);
    slot.files.push(f);
    byFolder.set(key, slot);
  }
  for (const [key, slot] of byFolder) {
    const media = Boolean(slot.pattern) && slot.files.every((f) => MEDIA.test(f));
    const id = key.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'group';
    const patterns = slot.pattern ? slot.patterns : slot.files;
    const prev = groups.get(id);
    const title = media
      ? `TODO: what loads the media files in ${slot.pattern} (binary, not read)`
      : `TODO: what ${slot.pattern ? slot.patterns.join(', ') : 'the top-level files'} ${slot.patterns.length === 1 ? 'is' : 'are'} for`;
    groups.set(id, { id, title, files: prev ? [...prev.files, ...patterns] : patterns, checks: media ? [] : projectChecks, risks: [] });
  }
  // A nested pattern ("src/a/**") and the parent's loose files ("src/x.js") must not overlap; loose files under a nested root
  // become their own group.
  for (const root of nested) {
    const loose = files.filter((f) => f.startsWith(`${root}/`) && f.split('/').length === 2);
    if (!loose.length) continue;
    const covered = groups.get(root);
    const hasNested = [...byFolder.values()].some((slot) => slot.pattern?.startsWith(`${root}/`) && slot.pattern !== `${root}/**`);
    if (covered && hasNested) covered.files = covered.files.filter((p) => p !== `${root}/**`).concat(loose);
  }
  // A folder that is a workspace package of its own (packages/db/package.json) gets that package's checks, run through the
  // package manager's workspace filter, so verify runs the package's tests instead of the whole repository's. Its title
  // comes from the package's description when it has one.
  for (const g of groups.values()) {
    const dir = g.files.length === 1 && /^(.+)\/\*\*$/u.exec(g.files[0])?.[1];
    if (!dir || !files.includes(`${dir}/package.json`)) continue;
    let pkg;
    try { pkg = JSON.parse(unBom(read(`${dir}/package.json`) ?? '')); } catch { continue; }
    const checks = workspaceChecks(files, dir, pkg);
    if (checks.length) g.checks = checks;
    const about = typeof pkg?.description === 'string' ? pkg.description.trim().replace(/\s+/gu, ' ') : '';
    if (about && g.title.startsWith('TODO:')) g.title = `${typeof pkg.name === 'string' ? `${pkg.name}: ` : ''}${about}`.slice(0, 200);
  }
  return { format: MAP_FORMAT, groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)), rules: [], ignore: [...ignore].sort() };
}

const packageManager = (has) => (has.has('pnpm-lock.yaml') ? 'pnpm' : has.has('yarn.lock') ? 'yarn' : has.has('bun.lockb') || has.has('bun.lock') ? 'bun' : 'npm');
const PLACEHOLDER = /no test specified/u;
// A script that keeps watching never exits: as a check it passes and then hangs until verify's timeout (900 s; the Stop
// hook's 600 s, at every stop). `jest --watch`, `vitest watch`, `tsc -w`, nodemon; `--watchAll=false` runs once. Such a
// script is not drafted as a check (verify sets CI=1, so a tool that watches only outside CI, like vitest, still counts).
const WATCHES = /(?:^|\s)--watch(?:All)?(?!=false)(?:[=\s]|$)|\btsc\b[^&|;]*\s-w(?:\s|$)|\bnodemon\b|\bvitest\s+(?:watch|dev)\b/u;
// A script that rewrites files is no check either: verify would change the working tree (`eslint --fix`,
// `prettier --write`, `jest -u` updating snapshots, 2026-11-09).
const REWRITES = /(?:^|\s)(?:--fix|--write|-u|--updateSnapshot|--update-snapshots?)(?:[=\s]|$)/u;
const runsOnce = (s) => typeof s === 'string' && !WATCHES.test(s) && !REWRITES.test(s);
// The scripts worth running as checks, in order, with what each covers.
const scriptChecks = (scripts, run) => [
  ...(runsOnce(scripts.test) && !PLACEHOLDER.test(scripts.test) ? [{ run: run('test'), why: 'the test suite' }] : []),
  ...['typecheck', 'type-check', 'check-types', 'lint'].filter((n) => runsOnce(scripts[n])).map((n) => ({ run: run(n), why: n === 'lint' ? 'lint rules' : 'types' })),
];

// One workspace package's own scripts, scoped to it: pnpm --filter, yarn workspace, bun --filter or npm -w.
export function workspaceChecks(files, dir, pkg) {
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const name = typeof pkg?.name === 'string' && pkg.name ? pkg.name : null;
  const pm = packageManager(new Set(files));
  // The name and folder come from the repository's files and the check runs in a shell: each is one quoted word unless
  // it is plain (`"name": "a; touch x"` became a command, and `packages/my pkg` two arguments, 2026-11-09).
  const q = (w) => (/^[\w@%+=:,./-]+$/u.test(w) ? w : `'${w.replace(/'/gu, "'\\''")}'`);
  const run = (script) => {
    if (pm === 'pnpm') return `pnpm --filter ${q(name ?? `./${dir}`)} ${script === 'test' ? 'test' : `run ${script}`}`;
    if (pm === 'yarn' && name) return `yarn workspace ${q(name)} ${script === 'test' ? 'test' : `run ${script}`}`;
    if (pm === 'bun' && name) return `bun --filter ${q(name)} run ${script}`;
    return script === 'test' ? `npm test -w ${q(dir)}` : `npm run ${script} -w ${q(dir)}`;
  };
  return scriptChecks(scripts, run).map((c) => ({ ...c, why: `${c.why} of ${name ?? dir}` }));
}

// Repairs the two ways a good map goes stale as code moves, without guessing at meaning:
// - a tracked file in no group joins the group of its nearest neighbour (same folder, else the closest parent folder);
//   a new folder whose files are all unplaced joins as "<folder>/**", a lone new file by its path;
// - a pattern that no longer matches any file is dropped (from a group, a risk or a rule), unless it is the last one.
// What it cannot decide (a file with no placed neighbour, a group or rule left with no files) stays for a person.
// Returns the fixed map, the changes as sentences, and the problems still left.
export function fixMap(map, files) {
  const out = structuredClone(map);
  const changes = [];
  const live = (pat) => files.some(matcher([pat]));
  for (const g of out.groups) {
    const keep = g.files.filter(live);
    for (const pat of g.files.filter((p) => !live(p))) {
      if (keep.length) changes.push(`groups.${g.id}: dropped ${pat} (matches no file)`);
    }
    if (keep.length) g.files = keep;
    for (const r of g.risks ?? []) if (Array.isArray(r.files)) {
      const k = r.files.filter(live);
      for (const pat of r.files.filter((p) => !live(p))) changes.push(`groups.${g.id} risk "${r.text.slice(0, 40)}": dropped ${pat}`);
      if (k.length) r.files = k; else delete r.files;
    }
  }
  for (const r of out.rules ?? []) {
    const keep = r.files.filter(live);
    for (const pat of r.files.filter((p) => !live(p))) if (keep.length) changes.push(`rules.${r.id}: dropped ${pat} (matches no file)`);
    if (keep.length) r.files = keep;
  }

  if (Array.isArray(out.hotspots)) {
    const tracked = new Set(files);
    const gone = out.hotspots.filter((h) => !tracked.has(h?.file));
    for (const h of gone) changes.push(`hotspots: dropped ${h?.symbol} in ${h?.file} (file gone)`);
    out.hotspots = out.hotspots.filter((h) => tracked.has(h?.file));
    if (!out.hotspots.length) delete out.hotspots;
  }
  if (Array.isArray(out.flows)) {
    const tracked = new Set(files);
    const live = (f) => tracked.has(f?.file) && Array.isArray(f?.reaches) && f.reaches.some((r) => tracked.has(r?.file));
    for (const f of out.flows.filter((x) => !live(x))) changes.push(`flows: dropped ${f?.entry} in ${f?.file} (file gone)`);
    out.flows = out.flows.filter(live).map((f) => ({ ...f, reaches: f.reaches.filter((r) => tracked.has(r?.file)) }));
    if (!out.flows.length) delete out.flows;
  }
  if (Array.isArray(out.models)) {
    const tracked = new Set(files);
    const gone = out.models.filter((m) => (m?.evidence !== undefined && !tracked.has(evidenceFile(m.evidence))) || (isRecord(m?.match) && typeof m.match.file === 'string' && !live(m.match.file)));
    for (const m of gone) changes.push(`models: dropped ${modelName(m)} (${m.evidence !== undefined && !tracked.has(evidenceFile(m.evidence)) ? `${evidenceFile(m.evidence)} gone` : 'matches no file'})`);
    out.models = out.models.filter((m) => !gone.includes(m));
    if (!out.models.length) delete out.models;
  }
  if (isRecord(out.vocabulary)) {
    const tracked = new Set(files);
    for (const kind of Object.keys(VOCAB_KINDS)) {
      if (!Array.isArray(out.vocabulary[kind])) continue;
      const gone = out.vocabulary[kind].filter((x) => x?.evidence !== undefined && !tracked.has(evidenceFile(x.evidence)));
      for (const x of gone) changes.push(`vocabulary.${kind}: dropped ${vocabularyName(x)} (${evidenceFile(x.evidence)} gone)`);
      out.vocabulary[kind] = out.vocabulary[kind].filter((x) => !gone.includes(x));
      if (!out.vocabulary[kind].length) delete out.vocabulary[kind];
    }
    if (!Object.keys(out.vocabulary).length) delete out.vocabulary;
  }

  const ignored = matcher(out.ignore ?? []);
  const owner = (f) => out.groups.find((g) => matcher(g.files)(f));
  const unplaced = files.filter((f) => !OWN.has(f) && !ignored(f) && !owner(f));
  const dir = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
  const placedIn = (d) => files.filter((f) => !OWN.has(f) && dir(f) === d && owner(f));
  const doneDirs = new Set();
  for (const f of unplaced) {
    if (owner(f)) continue; // placed by a folder pattern added earlier in this loop
    // The nearest folder, going up, that holds a placed file decides the group.
    let d = dir(f);
    let neighbours = placedIn(d);
    while (!neighbours.length && d) { d = dir(d); neighbours = placedIn(d); }
    if (!neighbours.length) continue;
    const counts = new Map();
    for (const n of neighbours) { const g = owner(n); counts.set(g, (counts.get(g) ?? 0) + 1); }
    const group = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    // A whole new folder (nothing in it or under it placed or ignored) joins as one pattern.
    const own = dir(f);
    const under = files.filter((x) => x.startsWith(`${own}/`));
    const fresh = own && own !== d && !doneDirs.has(own) && under.every((x) => unplaced.includes(x));
    const pat = fresh ? `${own}/**` : f;
    if (fresh) doneDirs.add(own);
    group.files.push(pat);
    changes.push(`groups.${group.id}: added ${pat}`);
  }
  return { map: out, changes, problems: mapProblems(out, files) };
}

// A map that is only behind the code (new files that have a neighbour's group, patterns for deleted files) is settled
// the way `fix` would settle it, without writing anything; only what fix cannot decide stays a problem. Read lists,
// check and the Action use the settled map, so adding a file to an existing folder never fails a pull request.
// A new top-level folder is the one placement fix guesses at (it joins the root files' group), so it stays a problem:
// someone should give it a group.
export function settleMap(map, files) {
  const problems = mapProblems(map, files);
  if (!problems.length) return { map, problems: [], settled: [] };
  let fixed;
  try { fixed = fixMap(map, files); } catch { return { map, problems, settled: [] }; }
  const owned = matcher(map.groups.flatMap((g) => g.files));
  const newTop = fixed.changes.map((c) => c.match(/^groups\.[^:]+: added (([^/]+)\/.*)$/u)).filter((m) => m && !files.some((f) => f.startsWith(`${m[2]}/`) && owned(f)));
  const left = [...fixed.problems, ...newTop.map((m) => `new top-level folder ${m[2]}/ is in no group: give it one (\`readfirst fix\` would put ${m[1]} with the root files)`)];
  return { map: left.length ? map : fixed.map, problems: left.length ? problems.filter((p) => !/in no group|matches no/u.test(p)).concat(left) : [], settled: left.length ? fixed.changes.filter((c) => !newTop.some((m) => c.endsWith(`added ${m[1]}`))) : fixed.changes };
}

// The project's own check commands, found in its build files, so a first map already says what to run. Repository-wide
// on purpose: narrowing a check to the group it covers is left to a person or an agent.
export function draftChecks(files, read = () => null) {
  const has = new Set(files);
  const out = [];
  const add = (run, why) => { if (!out.some((c) => c.run === run)) out.push({ run, why }); };
  if (has.has('package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(unBom(read('package.json') ?? '{}')).scripts ?? {}; } catch { scripts = {}; }
    const pm = packageManager(has);
    const run = (name) => (pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name === 'test' && pm !== 'bun' ? 'test' : `run ${name}`}`);
    for (const c of scriptChecks(scripts, run)) add(c.run, c.why);
  }
  const makefile = has.has('Makefile') ? read('Makefile') ?? '' : '';
  // A rule, not a variable: `test:=1` and `test := 1` set one and `make test` would do nothing and pass.
  if (/^test\s*:(?!=)/mu.test(makefile)) add('make test', 'the test suite (Makefile)');
  if (has.has('go.mod')) add('go test ./...', 'the Go tests');
  if (has.has('Cargo.toml')) add('cargo test', 'the Rust tests');
  const py = has.has('pyproject.toml') || has.has('setup.py') || has.has('pytest.ini');
  if (py && files.some((f) => /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/u.test(f))) add(has.has('poetry.lock') ? 'poetry run pytest' : has.has('uv.lock') ? 'uv run pytest' : 'pytest', 'the Python tests'); // the project's own environment
  if (files.some((f) => /\.(?:sln|csproj|fsproj)$/u.test(f))) add('dotnet test', 'the .NET tests');
  if (has.has('mix.exs')) add('mix test', 'the Elixir tests');
  if (has.has('gradlew') || has.has('build.gradle') || has.has('build.gradle.kts')) add(has.has('gradlew') ? './gradlew test' : 'gradle test', 'the JVM tests (Gradle)');
  else if (has.has('pom.xml')) add(has.has('mvnw') ? './mvnw test' : 'mvn test', 'the JVM tests (Maven)');
  if (has.has('Gemfile')) {
    if (files.some((f) => /(?:^|\/)spec\/.*_spec\.rb$/u.test(f))) add('bundle exec rspec', 'the Ruby specs');
    else if (files.some((f) => /(?:^|\/)test\/.*_test\.rb$/u.test(f))) add(has.has('bin/rails') ? 'bin/rails test' : 'bundle exec rake test', 'the Ruby tests');
  }
  if (has.has('composer.json')) {
    let scripts = {};
    try { scripts = JSON.parse(unBom(read('composer.json') ?? '{}')).scripts ?? {}; } catch { scripts = {}; }
    if (scripts.test) add('composer test', 'the PHP tests');
    else if (has.has('phpunit.xml') || has.has('phpunit.xml.dist')) add('vendor/bin/phpunit', 'the PHP tests');
  }
  return out;
}
