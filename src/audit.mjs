// readfirst audit: the whole repository against its map, once, as a report. It changes nothing and fails nothing
// (`check` is the gate). What it looks for:
//   - the map's own problems, as `check` would report them;
//   - rules and risks that may be out of date: the line that holds one was last written before many commits changed
//     the files it covers (git blame on the map, git log on the files);
//   - hot spots whose function is no longer at the line the map gives, and hot spots nothing checks: no check in their
//     group or in a rule that covers them, and no test that reaches their file;
//   - what was never filled in: groups still titled "TODO:" from `init`, rules no check verifies;
//   - code no test reaches through imports, the most used first;
//   - what readfirst could not see: languages whose imports it does not read, modules loaded by computed names;
//   - where the code broke most in the last 12 months (git log only, so it works with no map at all).
// Every part is computed from the checkout and its git history; nothing runs.
import { MAP_PATH, matcher, groupOf, risksNaming } from './map.mjs';
import { brokeMost, BROKE_MOST_MIN_COMMITS, BROKE_MOST_MIN_SCORE } from './history.mjs';
import { unmatchedItems } from './trigger.mjs';
import { isTest, OTHER_CODE, READS_IMPORTS, unseenIn } from './readlist.mjs';

export const AUDIT_FORMAT = 'readfirst/audit@1';
// A rule or risk is listed once this many commits changed its files after the line was written.
export const STALE_COMMITS = 10;
const TOP = 15;
// The text report gives the first TOP rows of a long list in full and names every other one on one line: nothing is cut
// (2026-11-09; before, it said "…and N more" and pointed at --json, which held the same first 15). --json has all rows.
// cut: TOP rows in full, the rest named on one line
const firstThenNamed = (rows, line, name, what = 'more') => [...rows.slice(0, TOP).map(line), ...(rows.length > TOP ? [`- …and ${rows.length - TOP} ${what}: ${rows.slice(TOP).map(name).join(', ')}`] : [])];
// Not code a test is expected to reach: generated, vendored, examples and docs, tool folders (.semgrep/, .github/),
// test setup, and the files that configure or start the project.
const SKIP_CODE = /\.d\.ts$|\.min\.js$|(?:^|\/)(?:vendor|node_modules|dist|build|migrations|examples?|docs?|fixtures)\/|(?:^|\/)\.[^/]+\/|(?:^|\/)(?:conftest|setup|manage|noxfile|fabfile)\.py$|\.config\.[cm]?[jt]s$|(?:^|\/)(?:Gruntfile|Gulpfile|gulpfile)\.js$/u;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// git blame --line-porcelain output: for each line of the file (0-based), { hash, time } of the commit that last wrote
// it, or null for a line not committed yet.
export function parseBlame(text) {
  const out = [];
  let cur = null;
  for (const l of String(text ?? '').split('\n')) {
    const h = l.match(/^([0-9a-f]{40}) \d+ (\d+)/u);
    if (h) { cur = { hash: h[1], line: Number(h[2]) }; continue; }
    if (!cur) continue;
    if (l.startsWith('committer-time ')) cur.time = Number(l.slice(15));
    else if (l.startsWith('\t')) { out[cur.line - 1] = /^0+$/u.test(cur.hash) ? null : { hash: cur.hash, time: cur.time }; cur = null; }
  }
  return out;
}

// git log --format=%x01%H %ct --name-only: newest first, [{ hash, time, files }].
export function parseLog(text) {
  return String(text ?? '').split('\x01').filter((c) => c.trim()).map((c) => {
    const [head, ...rest] = c.split('\n');
    const [hash, time] = head.trim().split(' ');
    return { hash, time: Number(time), files: rest.map((f) => f.trim()).filter(Boolean) };
  });
}

// Code nothing else uses: in a module other files import, an export (JavaScript, TypeScript) or a top-level def or
// class (Python) whose name no other file holds and its own file does not use. Names a framework calls by convention
// (route verbs, loaders, config) and decorated Python functions (a route, a task, a fixture) are left out; a name built
// at run time (getattr, a computed import) is not seen, so each one is a place to look, not a verdict.
const CONVENTION = /^(?:default|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|loader|action|config|metadata|generateMetadata|generateStaticParams|getServerSideProps|getStaticProps|getStaticPaths|middleware|handler|main|setup|teardown|run|Meta)$/u;
export function unusedCode({ code, users, read }) {
  const texts = new Map(code.map((f) => [f, read(f) ?? '']));
  const where = new Map(); // identifier -> files that hold it
  for (const [f, t] of texts) for (const w of new Set(t.match(/[A-Za-z_$][\w$]*/gu) ?? [])) { if (!where.has(w)) where.set(w, new Set()); where.get(w).add(f); }
  const out = [];
  for (const [f, t] of texts) {
    if (!(users.get(f) > 0)) continue; // a file nothing imports is an entry point or a script, not a library
    const lines = t.split('\n');
    const names = [];
    if (/\.py$/u.test(f)) {
      lines.forEach((l, i) => {
        const m = l.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/u);
        if (m && !/^\s*@/u.test(lines[i - 1] ?? '') && !/^test_?/u.test(m[1])) names.push({ name: m[1], line: i + 1 });
      });
      const all = t.match(/__all__\s*=\s*[[(]([^\])]*)/u);
      if (all) for (const n of all[1].matchAll(/['"](\w+)['"]/gu)) { const k = names.findIndex((x) => x.name === n[1]); if (k >= 0) names.splice(k, 1); }
    } else {
      lines.forEach((l, i) => {
        const m = l.match(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/u);
        if (m) names.push({ name: m[1], line: i + 1 });
        const list = l.match(/^export\s*\{([^}]*)\}\s*;?\s*$/u);
        if (list) for (const part of list[1].split(',')) { const n = part.trim().split(/\s+as\s+/u).pop(); if (/^[A-Za-z_$][\w$]*$/u.test(n ?? '')) names.push({ name: n, line: i + 1 }); }
      });
    }
    for (const { name, line } of names) {
      if (CONVENTION.test(name)) continue;
      const holders = where.get(name) ?? new Set();
      if ([...holders].some((h) => h !== f)) continue;
      const own = (t.match(new RegExp(`(?<![\\w$])${name.replace(/\$/gu, '\\$')}(?![\\w$])`, 'gu')) ?? []).length;
      if (own > 1) continue; // used in its own file; only the export is unneeded
      out.push({ path: f, name, line });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

// map: the map (settled), or null when there is none (only "Broke most" is then worked out), problems: what check reports,
// files: tracked files, imports: import edges, read(path): text or null, blame: parseBlame of the map file (or []),
// history: parseLog since the oldest blamed line (or []), broke: parseScarLog of the last 12 months (or []).
export function audit({ map, problems = [], files, imports, read = () => null, blame = [], history = [], commit = null, held = null, broke = [] }) {
  if (!map) return { format: AUDIT_FORMAT, commit, files: files.length, noMap: true, brokeMost: brokeMostRows(null, broke, files) };
  const lines = (read(MAP_PATH) ?? '').split('\n');
  const writtenAt = (value) => {
    const needle = JSON.stringify(value);
    const i = lines.findIndex((l) => l.includes(needle));
    return i < 0 ? undefined : blame[i];
  };
  const stale = [];
  const since = (written, covers) => {
    const after = history.filter((c) => c.time > written.time && c.hash !== written.hash && c.files.some(covers));
    return { commits: after.length, files: new Set(after.flatMap((c) => c.files.filter(covers))).size };
  };
  // What an item relies on: the files its own files import (one step), outside its own files. A rule can go stale when
  // what it relies on changes, not only when its own files do (connections, the other half).
  const reliedOn = (covers) => {
    const mine = new Set(files.filter(covers));
    const out = new Set();
    for (const e of imports ?? []) if (mine.has(e.from) && !mine.has(e.to)) out.add(e.to);
    return (p) => out.has(p);
  };
  const add = (row, value, covers) => {
    const w = writtenAt(value);
    if (!w) return; // not committed yet, or not found as written: nothing to compare with
    const s = since(w, covers);
    const r = since(w, reliedOn(covers));
    // Measured 2026-11-08: flagging on what an item relies on alone added 11 items here and 3 in readfirst-cloud, nearly
    // all through hub modules (action.mjs imports cli.mjs, changed 41 times), not real staleness. So it is said beside an
    // item already flagged by its own files, never a reason on its own.
    if (s.commits >= STALE_COMMITS) stale.push({ ...row, written: { commit: w.hash.slice(0, 7), date: new Date(w.time * 1000).toISOString().slice(0, 10) }, commits: s.commits, files: s.files, relied: { commits: r.commits, files: r.files } });
  };
  for (const r of map.rules ?? []) add({ kind: 'rule', id: r.id, text: r.rule }, r.rule, matcher(r.files));
  for (const g of map.groups) for (const r of g.risks ?? []) add({ kind: 'risk', group: g.id, text: r.text }, r.text, matcher(r.files ?? g.files));
  stale.sort((a, b) => b.commits - a.commits);

  const hotspots = [];
  for (const h of map.hotspots ?? []) {
    const body = read(h.file);
    if (body === null) continue;
    const ls = body.split('\n');
    const name = esc(h.symbol.split('.').pop());
    const word = new RegExp(`\\b${name}\\b`, 'u');
    if (word.test(ls[h.line - 1] ?? '')) continue;
    const def = new RegExp(`(?:\\b(?:def|function|class|fn|func|const|let|var)\\s+\\*?\\s*${name}\\b|^\\s*(?:(?:public|private|protected|static|async|export|override)\\s+)*${name}\\s*[(=:])`, 'u');
    let at = ls.findIndex((l) => def.test(l));
    if (at < 0) at = ls.findIndex((l) => word.test(l));
    hotspots.push({ file: h.file, symbol: h.symbol, line: h.line, status: at < 0 ? 'GONE' : 'MOVED', now: at < 0 ? null : at + 1 });
  }

  const placeholders = map.groups.filter((g) => /^TODO:/u.test(g.title)).map((g) => g.id);
  const unchecked = (map.rules ?? []).filter((r) => !(r.checks ?? []).length).map((r) => r.id);

  // Code no test reaches: forward through imports from every test file. In Go a test sits in its package's folder and
  // needs no import, so a _test.go beside a file reaches it.
  const ignored = matcher(map.ignore ?? []);
  const code = files.filter((f) => f !== MAP_PATH && READS_IMPORTS.test(f) && !isTest(f) && !SKIP_CODE.test(f) && !ignored(f));
  const next = new Map();
  const users = new Map();
  for (const e of imports) {
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    if (!isTest(e.from)) users.set(e.to, (users.get(e.to) ?? 0) + 1);
  }
  const reached = new Set();
  const queue = files.filter(isTest);
  for (const f of queue) reached.add(f);
  while (queue.length) for (const to of next.get(queue.shift()) ?? []) if (!reached.has(to)) { reached.add(to); queue.push(to); }
  const goTested = new Set(files.filter((f) => /_test\.go$/u.test(f)).map((f) => f.slice(0, f.lastIndexOf('/') + 1)));
  const untested = code.filter((f) => !reached.has(f) && !(f.endsWith('.go') && goTested.has(f.slice(0, f.lastIndexOf('/') + 1))));
  const byGroup = new Map();
  for (const f of untested) { const g = groupOf(map, f)?.id ?? null; byGroup.set(g, (byGroup.get(g) ?? 0) + 1); }

  // Risky code with nothing to show it still works: a hot spot whose file no check of the map names and no test reaches.
  // A check that half the groups or more share (the whole test suite) says nothing about this file in particular.
  const shared = new Map();
  for (const g of map.groups) for (const c of new Set((g.checks ?? []).map((x) => x.run))) shared.set(c, (shared.get(c) ?? 0) + 1);
  const ownCheck = (c) => map.groups.length < 2 || shared.get(c.run) < map.groups.length / 2;
  const guarded = (file) => (groupOf(map, file)?.checks ?? []).some(ownCheck) || (map.rules ?? []).some((r) => (r.checks ?? []).length && matcher(r.files)(file));
  const unguarded = (map.hotspots ?? []).filter((h) => !guarded(h.file) && !reached.has(h.file) && !isTest(h.file)
    && !(h.file.endsWith('.go') && goTested.has(h.file.slice(0, h.file.lastIndexOf('/') + 1))))
    .map((h) => ({ file: h.file, symbol: h.symbol, line: h.line, labels: h.labels }));

  // Code being replaced that is still in use: files outside the deprecated group (and not tests) that import it.
  const replacing = map.groups.filter((g) => g.deprecated).map((g) => {
    const inside = matcher(g.files);
    const users = [...new Set(imports.filter((e) => inside(e.to) && !inside(e.from) && !isTest(e.from)).map((e) => e.from))].sort();
    return { group: g.id, use: g.deprecated.use ?? null, why: g.deprecated.why, users: users.length, files: users };
  });

  // When rules last held (verify --record): never recorded, or their files changed in commits after that.
  let lastHeld = null;
  if (held) {
    const times = new Map(history.map((c) => [c.hash, c.time]));
    lastHeld = { never: [], changed: [] };
    for (const r of map.rules ?? []) {
      if (!(r.checks ?? []).length) continue;
      const h = held.rules?.[r.id];
      if (!h) { lastHeld.never.push(r.id); continue; }
      const covers = matcher(r.files);
      const at = times.get(h.commit) ?? Date.parse(h.date) / 1000;
      const after = history.filter((c) => c.time > at && c.hash !== h.commit && c.files.some(covers)).length;
      if (after) lastHeld.changed.push({ id: r.id, commit: h.commit.slice(0, 7), date: h.date, commits: after });
    }
    lastHeld.changed.sort((a, b) => b.commits - a.commits);
  }

  const other = new Map();
  for (const f of files) if (OTHER_CODE.test(f) && !ignored(f) && !SKIP_CODE.test(f)) { const ext = f.split('.').pop().toLowerCase(); other.set(ext, (other.get(ext) ?? 0) + 1); }
  const computed = code.flatMap((f) => unseenIn(f, read));
  // Tests count as users: an export only a test names is still listed under "no test reaches" if untested, not here.
  // A file the map says another repository depends on (`dependents`) may be used there: such names are listed apart.
  const elsewhere = (f) => (map.dependents ?? []).filter((d) => matcher(d.files)(f)).map((d) => d.repo);
  const unused = unusedCode({ code: files.filter((f) => f !== MAP_PATH && /\.(?:[cm]?[jt]sx?|py)$/u.test(f) && !SKIP_CODE.test(f) && !ignored(f)), users: new Map([...users]), read }).filter((u) => !isTest(u.path)).map((u) => (elsewhere(u.path).length ? { ...u, dependents: [...new Set(elsewhere(u.path))] } : u));

  return {
    format: AUDIT_FORMAT, commit, files: files.length,
    problems,
    stale,
    hotspots,
    unguarded,
    // Risks and rules no change can ever judge (src/trigger.mjs): shown by file, unjudged, on every diff and PR.
    unmatched: unmatchedItems(map, { files, read, imports }),
    replacing,
    held: lastHeld,
    placeholders,
    unchecked,
    brokeMost: brokeMostRows(map, broke, files),
    untested: {
      code: code.length,
      reached: code.length - untested.length,
      files: untested.map((f) => ({ path: f, group: groupOf(map, f)?.id ?? null, usedBy: users.get(f) ?? 0 })).sort((a, b) => b.usedBy - a.usedBy || a.path.localeCompare(b.path)),
      byGroup: [...byGroup].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count),
    },
    unused: { names: unused, count: unused.length },
    unseen: {
      languages: [...other].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count),
      computed,
      computedCount: computed.length,
    },
  };
}

// The "Broke most" rows with whether a map risk or rule covers each file (null when there is no map).
function brokeMostRows(map, log, files) {
  const exists = new Set(files);
  return brokeMost(log, exists).map((r) => {
    if (!map) return r;
    const group = groupOf(map, r.path);
    const risk = (group?.risks ?? []).some((x) => !x.files || matcher(x.files)(r.path)) || risksNaming(map, r.path, group?.id ?? null).length > 0;
    const rules = (map.rules ?? []).filter((x) => matcher(x.files)(r.path)).map((x) => x.id);
    return { ...r, covered: { risk, rules } };
  });
}

export const PRO_LINE = 'A whole-repository scan for results thrown away (a filter, replace or strip whose result is dropped, so the line does nothing) runs on readfirst Pro: https://readfirst-cloud.vercel.app/#pricing';

export function auditText(a) {
  const out = [`# readfirst audit: ${a.files} files${a.commit ? ` at ${a.commit.slice(0, 7)}` : ''}`, ''];
  const section = (title, rows) => { if (rows.length) out.push(`## ${title}`, '', ...rows, ''); };
  const covers = (r) => (!r.covered ? '' : r.covered.risk || r.covered.rules.length ? ` _(map: ${[r.covered.risk ? 'a risk' : null, r.covered.rules.length ? `rule ${r.covered.rules.join(', ')}` : null].filter(Boolean).join(' and ')})_` : ' _(no map risk or rule covers it)_');
  const brokeRows = a.brokeMost.map((r) => `- \`${r.path}\`: weight ${r.score}, ${r.commits} fixes, last ${r.last.date} ${r.last.sha} "${r.last.subject}"${covers(r)}`);
  if (a.noMap) {
    section(`Broke most (last 12 months; ${BROKE_MOST_MIN_COMMITS}+ fixes and weight ${BROKE_MOST_MIN_SCORE}+)`, brokeRows);
    if (!brokeRows.length) out.push('No file broke often enough in the last 12 months to list (or this clone has too little history).', '');
    out.push('There is no .readfirst/map.json. `readfirst init` writes a first map, and audit then also checks it against the code.', '', '---', PRO_LINE, '');
    return out.join('\n');
  }
  section(`Broke most (last 12 months; ${BROKE_MOST_MIN_COMMITS}+ fixes and weight ${BROKE_MOST_MIN_SCORE}+)`, brokeRows);
  section('Map problems (as `readfirst check` reports them)', a.problems.map((p) => `- ${p}`));
  section(`Rules and risks that may be out of date (${STALE_COMMITS}+ commits changed their files since they were written)`, firstThenNamed(a.stale, (s) =>
    `- ${s.kind === 'rule' ? `rule **${s.id}**` : `risk in group ${s.group}`}: "${s.text.length > 100 ? `${s.text.slice(0, 100)}…` : s.text}" — written ${s.written.date} (${s.written.commit}); ${s.commits} commits changed ${s.files} of its files since${s.relied?.commits ? `, and ${s.relied.commits} changed ${s.relied.files} file${s.relied.files === 1 ? '' : 's'} they import` : ''}. Still true?`, (s) => (s.kind === 'rule' ? `rule ${s.id}` : `risk in ${s.group} "${s.text.length > 50 ? `${s.text.slice(0, 50)}…` : s.text}"`)));
  section('Hot spots no longer at their line', a.hotspots.map((h) => `- \`${h.symbol}\` in \`${h.file}\`: map says line ${h.line}, ${h.status === 'MOVED' ? `now line ${h.now}` : 'not found in the file'}`));
  section('Rules and risks no change can judge (they name no function or file:line readfirst finds in their files, so diff and the PR comment show them unjudged; name the function in backticks or give file:line)', (a.unmatched ?? []).map((u) => `- ${u.where}${u.files ? ` (shown for ${u.files} file${u.files === 1 ? '' : 's'})` : ''}: ${u.text}`));
  section('Hot spots nothing checks (no test reaches their file, and no check of their own in the map)', firstThenNamed(a.unguarded, (h) =>
    `- \`${h.symbol}\` in \`${h.file}:${h.line}\`: ${h.labels.join(', ')}`, (h) => `\`${h.symbol}\` (\`${h.file}:${h.line}\`)`));
  // cut: the files past TOP are named on the same line
  section('Code being replaced that is still used', a.replacing.filter((d) => d.users).map((d) => `- group **${d.group}**${d.use ? ` (use \`${d.use}\`)` : ''}: imported by ${d.users} file(s) outside it: ${d.files.slice(0, TOP).map((f) => `\`${f}\``).join(', ')}${d.files.length > TOP ? `, and ${d.files.length - TOP} more: ${d.files.slice(TOP).map((f) => `\`${f}\``).join(', ')}` : ''}`));
  if (a.held) section('When rules last held (.readfirst/held.json)', [
    ...firstThenNamed(a.held.changed, (h) => `- rule **${h.id}**: held at ${h.commit} on ${h.date}; ${h.commits} commit(s) changed its files since. Run \`readfirst verify --record\` again.`, (h) => h.id, 'more rules changed since they held'),
    ...(a.held.never.length ? [`- never recorded as holding: ${a.held.never.join(', ')}`] : []),
  ]);
  section('Not filled in yet', [
    ...(a.placeholders.length ? [`- ${a.placeholders.length} group(s) still have the TODO title from init: ${a.placeholders.join(', ')}. \`readfirst prompt\` gives your agent the brief.`] : []),
    ...(a.unchecked.length ? [`- ${a.unchecked.length} rule(s) with no check that shows they hold: ${a.unchecked.join(', ')}`] : []),
  ]);
  const u = a.untested;
  if (u.code) section(`Code no test reaches through imports (${u.code - u.reached} of ${u.code} files)`, [
    ...firstThenNamed(u.files, (f) => `- \`${f.path}\`${f.usedBy ? ` — used by ${f.usedBy} file(s)` : ''}${f.group ? ` _(group ${f.group})_` : ''}`, (f) => `\`${f.path}\``),
    ...(u.byGroup.length > 1 ? ['', `By group: ${u.byGroup.map((g) => `${g.group ?? '(no group)'} ${g.count}`).join(', ')}`] : []),
  ]);
  if (a.unused?.count) section(`Code nothing else uses (${a.unused.count}: exported or top-level, named in no other file and not used in its own)`, [
    ...firstThenNamed(a.unused.names, (u) => `- \`${u.name}\` in \`${u.path}:${u.line}\`${u.dependents?.length ? ` — the map says ${u.dependents.join(', ')} depends on this file: look there before deleting` : ''}`, (u) => `\`${u.name}\` (\`${u.path}:${u.line}\`)`),
    '',
    `A name built at run time (getattr, a computed import, a string key) is not seen: check before deleting.${a.unseen.computedCount ? ` This repository loads ${a.unseen.computedCount} module(s) by computed names.` : ''}`,
  ]);
  section('Not seen by readfirst', [
    ...a.unseen.languages.map((l) => `- ${l.count} .${l.ext} file(s): imports in this language are not read, so their users and tests are unknown`),
    ...firstThenNamed(a.unseen.computed, (c) => `- \`${c.path}:${c.line}\` loads a module by a computed name: what it loads is not followed`, (c) => `\`${c.path}:${c.line}\``, 'more computed loads'),
  ]);
  if (out.length === 2) out.push('Nothing to report: the map matches the code.', '');
  out.push('---', PRO_LINE, '');
  return out.join('\n');
}
