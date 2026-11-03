// readfirst audit: the whole repository against its map, once, as a report. It changes nothing and fails nothing
// (`check` is the gate). What it looks for:
//   - the map's own problems, as `check` would report them;
//   - rules and risks that may be out of date: the line that holds one was last written before many commits changed
//     the files it covers (git blame on the map, git log on the files);
//   - hot spots whose function is no longer at the line the map gives, and hot spots nothing checks: no check in their
//     group or in a rule that covers them, and no test that reaches their file;
//   - what was never filled in: groups still titled "TODO:" from `init`, rules no check verifies;
//   - code no test reaches through imports, the most used first;
//   - what readfirst could not see: languages whose imports it does not read, modules loaded by computed names.
// Every part is computed from the checkout and its git history; nothing runs.
import { MAP_PATH, matcher, groupOf } from './map.mjs';
import { isTest, OTHER_CODE, READS_IMPORTS, unseenIn } from './readlist.mjs';

export const AUDIT_FORMAT = 'readfirst/audit@1';
// A rule or risk is listed once this many commits changed its files after the line was written.
export const STALE_COMMITS = 10;
const TOP = 15;
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

// map: the map (settled), problems: what check reports, files: tracked files, imports: import edges, read(path): text or
// null, blame: parseBlame of the map file (or []), history: parseLog since the oldest blamed line (or []).
export function audit({ map, problems = [], files, imports, read = () => null, blame = [], history = [], commit = null }) {
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
  const add = (row, value, covers) => {
    const w = writtenAt(value);
    if (!w) return; // not committed yet, or not found as written: nothing to compare with
    const s = since(w, covers);
    if (s.commits >= STALE_COMMITS) stale.push({ ...row, written: { commit: w.hash.slice(0, 7), date: new Date(w.time * 1000).toISOString().slice(0, 10) }, commits: s.commits, files: s.files });
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

  const other = new Map();
  for (const f of files) if (OTHER_CODE.test(f) && !ignored(f) && !SKIP_CODE.test(f)) { const ext = f.split('.').pop().toLowerCase(); other.set(ext, (other.get(ext) ?? 0) + 1); }
  const computed = code.flatMap((f) => unseenIn(f, read));

  return {
    format: AUDIT_FORMAT, commit, files: files.length,
    problems,
    stale,
    hotspots,
    unguarded,
    placeholders,
    unchecked,
    untested: {
      code: code.length,
      reached: code.length - untested.length,
      files: untested.map((f) => ({ path: f, group: groupOf(map, f)?.id ?? null, usedBy: users.get(f) ?? 0 })).sort((a, b) => b.usedBy - a.usedBy || a.path.localeCompare(b.path)).slice(0, TOP),
      byGroup: [...byGroup].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count),
    },
    unseen: {
      languages: [...other].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count),
      computed: computed.slice(0, TOP),
      computedCount: computed.length,
    },
  };
}

export const PRO_LINE = 'A whole-repository scan for results thrown away (a filter, replace or strip whose result is dropped, so the line does nothing) runs on readfirst Pro: https://readfirst-cloud.vercel.app/#pricing';

export function auditText(a) {
  const out = [`# readfirst audit: ${a.files} files${a.commit ? ` at ${a.commit.slice(0, 7)}` : ''}`, ''];
  const section = (title, rows) => { if (rows.length) out.push(`## ${title}`, '', ...rows, ''); };
  section('Map problems (as `readfirst check` reports them)', a.problems.map((p) => `- ${p}`));
  section(`Rules and risks that may be out of date (${STALE_COMMITS}+ commits changed their files since they were written)`, [...a.stale.slice(0, TOP).map((s) =>
    `- ${s.kind === 'rule' ? `rule **${s.id}**` : `risk in group ${s.group}`}: "${s.text.length > 100 ? `${s.text.slice(0, 100)}…` : s.text}" — written ${s.written.date} (${s.written.commit}); ${s.commits} commits changed ${s.files} of its files since. Still true?`), ...(a.stale.length > TOP ? [`- …and ${a.stale.length - TOP} more (\`readfirst audit --json\` lists all)`] : [])]);
  section('Hot spots no longer at their line', a.hotspots.map((h) => `- \`${h.symbol}\` in \`${h.file}\`: map says line ${h.line}, ${h.status === 'MOVED' ? `now line ${h.now}` : 'not found in the file'}`));
  section('Hot spots nothing checks (no test reaches their file, and no check of their own in the map)', a.unguarded.slice(0, TOP).map((h) =>
    `- \`${h.symbol}\` in \`${h.file}:${h.line}\`: ${h.labels.join(', ')}`).concat(a.unguarded.length > TOP ? [`- …and ${a.unguarded.length - TOP} more`] : []));
  section('Not filled in yet', [
    ...(a.placeholders.length ? [`- ${a.placeholders.length} group(s) still have the TODO title from init: ${a.placeholders.slice(0, 10).join(', ')}${a.placeholders.length > 10 ? ', …' : ''}. \`readfirst prompt\` gives your agent the brief.`] : []),
    ...(a.unchecked.length ? [`- ${a.unchecked.length} rule(s) with no check that shows they hold: ${a.unchecked.slice(0, 10).join(', ')}${a.unchecked.length > 10 ? ', …' : ''}`] : []),
  ]);
  const u = a.untested;
  if (u.code) section(`Code no test reaches through imports (${u.code - u.reached} of ${u.code} files)`, [
    ...u.files.map((f) => `- \`${f.path}\`${f.usedBy ? ` — used by ${f.usedBy} file(s)` : ''}${f.group ? ` _(group ${f.group})_` : ''}`),
    ...(u.code - u.reached > u.files.length ? [`- …and ${u.code - u.reached - u.files.length} more`] : []),
    ...(u.byGroup.length > 1 ? ['', `By group: ${u.byGroup.slice(0, 10).map((g) => `${g.group ?? '(no group)'} ${g.count}`).join(', ')}`] : []),
  ]);
  section('Not seen by readfirst', [
    ...a.unseen.languages.map((l) => `- ${l.count} .${l.ext} file(s): imports in this language are not read, so their users and tests are unknown`),
    ...a.unseen.computed.map((c) => `- \`${c.path}:${c.line}\` loads a module by a computed name: what it loads is not followed`),
    ...(a.unseen.computedCount > a.unseen.computed.length ? [`- …and ${a.unseen.computedCount - a.unseen.computed.length} more computed loads`] : []),
  ]);
  if (out.length === 2) out.push('Nothing to report: the map matches the code.', '');
  out.push('---', PRO_LINE, '');
  return out.join('\n');
}
