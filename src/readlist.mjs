// The read list for files someone is about to change: the rules that cover them, the risks written for their group,
// the checks to run (the group's commands, the rules' commands, and the tests that import them), and who uses them.
import { evidenceFile, fixMap, groupOf, isOwnFile, matcher, modelName, risksNaming, vocabularyName } from './map.mjs';
import { sortRows, verdictLines } from './verdict.mjs';

export const READ_LIST_FORMAT = 'readfirst/read-list@1';
// Test files by folder or name, across the languages imports.mjs reads: JS/TS, Python, Go, Rust (tests/), Elixir,
// C# (*Tests.cs, *.Tests/ projects), Java/Kotlin (src/test/, *Test), Ruby (spec/, *_spec.rb) and PHP (*Test.php).
const TEST = /(^|\/)(?:tests?|__tests__|spec|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)test[-_][^/]*\.(?:[cm]?[jt]sx?|py)$|_test\.(?:py|go|exs|rb)$|_spec\.rb$|(^|\/)[^/]+\.(?:Unit|Integration)?Tests?\/|Tests?\.(?:cs|java|kt|php)$|(^|\/)src\/(?:test|androidTest|integrationTest)\//u;
export const isTest = (path) => TEST.test(path);

// Files whose imports readfirst reads (imports.mjs, langs.mjs), and code in languages it does not read. For the second
// kind, an empty "used by" or "tests" means unknown, not none.
export const READS_IMPORTS = /\.(?:m?js|cjs|tsx?|jsx|mts|cts|vue|svelte|py|go|rs|exs?|cs|java|kts?|rb|php)$/u;
export const OTHER_CODE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|m|mm|swift|scala|clj|cljs|hs|lua|dart|zig|nim|erl|fs|fsx|vb|r|jl|pl|pm|groovy)$/iu;
// Code that loads a module by a computed name: what it loads is not followed.
const COMPUTED_LOAD = {
  js: { test: /\.(?:m?js|cjs|tsx?|jsx|mts|cts|vue|svelte)$/u, re: /\b(?:import|require)\(\s*(?!['"][^'"\n]*['"]\s*[),])(?=[^)\s])/u },
  py: { test: /\.py$/u, re: /\b(?:importlib\.import_module|__import__|import_string)\(\s*(?!['"])(?=[^)\s])/u },
};

// A line with the insides of its string literals (and, in JavaScript, regex literals) blanked, so text that only
// mentions `require(` or `import(` (a pattern, a message) is not taken for code that loads a module.
export function codeOnly(line, js = true) {
  let out = '';
  let prev = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      out += c + c;
      i = j;
      prev = c;
      continue;
    }
    if (js && c === '/' && line[i + 1] !== '/' && line[i + 1] !== '*' && (/^$|[(,=:[!&|?{};+\-*%<>~^]$/u.test(prev) || /\b(?:return|typeof|case|in|of)$/u.test(out.trimEnd()))) {
      let j = i + 1;
      let cls = false;
      while (j < line.length && (cls || line[j] !== '/')) {
        if (line[j] === '\\') j++;
        else if (line[j] === '[') cls = true;
        else if (line[j] === ']') cls = false;
        j++;
      }
      if (j < line.length) { out += '/x/'; i = j; prev = '/'; continue; }
    }
    out += c;
    if (!/\s/u.test(c)) prev = c;
  }
  return out;
}

// What readfirst could not see about one file: a language whose imports it does not read, or a module loaded by a
// computed name. read(path) gives the file's text, or null.
export function unseenIn(path, read = () => null) {
  if (OTHER_CODE.test(path)) return [{ path, why: `readfirst does not read imports in .${path.split('.').pop()} files: who uses it and which tests reach it are unknown, not none` }];
  const kind = Object.values(COMPUTED_LOAD).find((k) => k.test.test(path));
  if (!kind) return [];
  const body = read(path);
  if (!body) return [];
  const lines = body.split('\n');
  const at = lines.findIndex((l) => !/^\s*(?:\/\/|#|\*)/u.test(l) && kind.re.test(l) && kind.re.test(codeOnly(l, kind === COMPUTED_LOAD.js)));
  return at < 0 ? [] : [{ path, line: at + 1, why: `line ${at + 1} loads a module by a computed name: what it loads is not followed` }];
}

// The read list for no files, so `diff --json` is always JSON.
export const emptyList = (commit = null) => ({ format: READ_LIST_FORMAT, commit, targets: [], rules: [], risks: [], hotspots: [], flows: [], vocabulary: [], checks: [], tests: [], usedBy: [], usedByIndirectly: 0, notCovered: [], unseen: [], deprecated: [], together: [], dependents: [], truncated: { tests: 0, usedBy: 0 } });

// read(path), optional, gives a file's text: with it, code that loads modules by computed names is listed as unseen.
// held, optional, is .readfirst/held.json: each rule then says the commit it last held at (null when never).
// broke, optional, is brokeBefore() from history.mjs (path -> { count, weight, top, last } or { notFetched: true }): each
// target it names gets that as `brokeBefore`. map may be null (no .readfirst/map.json): the list then carries no map
// entries and does not call files "not covered".
// `before`: the map as written, when `map` is settled. Settling drops a pattern that matches no file any more, so the
// last file moved out of a folder lost its group and that group's checks; a target that is gone is looked up there too.
// limit: how many tests and direct users to list (`--limit`, the Action's `limit` input); none by default, and a cut list
// says in `truncated` how many it left out. Before 0.27.1 it was 30 (10 in the hook, 5 in view) whether asked or not.
export function readList({ map: mapIn, files, imports, targets, commit = null, limit = Infinity, read = () => null, held = null, broke = {}, before = null }) {
  if (!targets.length || targets.some((t) => !t.trim())) throw new Error('give at least one file path, none empty');
  const mapped = mapIn !== null && mapIn !== undefined;
  const map = mapped ? mapIn : { format: 'readfirst/map@1', groups: [] };
  const tracked = new Set(files);
  const ignored = matcher(map.ignore ?? []);
  const importers = new Map();
  for (const e of imports) importers.set(e.to, [...(importers.get(e.to) ?? []), e]);

  const out = { format: READ_LIST_FORMAT, commit, targets: [], rules: [], risks: [], hotspots: [], flows: [], vocabulary: [], checks: [], tests: [], usedBy: [], usedByIndirectly: 0, notCovered: [], unseen: [], deprecated: [], together: [], dependents: [] };
  const seen = { rules: new Map(), risks: new Map(), hotspots: new Map(), flows: new Map(), vocabulary: new Map(), checks: new Map(), tests: new Map(), usedBy: new Map(), deprecated: new Map(), together: new Map(), dependents: new Map() };
  const note = (kind, key, item, target) => {
    const have = seen[kind].get(key);
    if (have) { if (!have.for.includes(target)) have.for.push(target); return; }
    const row = { ...item, for: [target] };
    seen[kind].set(key, row);
    out[kind].push(row);
  };
  const indirect = new Set();
  // Where `readfirst fix` would put files that are in no group; worked out only when such a file is asked about.
  let fixes = null;
  const suggestFor = (target) => {
    fixes ??= (() => { try { return fixMap(map, files).changes.map((c) => c.match(/^groups\.([^:]+): added (.+)$/u)).filter(Boolean).map((m) => ({ group: m[1], target: m[2] })); } catch { return []; } })();
    return fixes.find((c) => target === c.target || (c.target.endsWith('/**') && target.startsWith(c.target.slice(0, -2))));
  };

  for (const raw of targets) {
    const target = raw.replace(/^\.\//u, '').replace(/\\/gu, '/');
    if (isOwnFile(target)) { out.targets.push({ path: target, group: null, status: 'MAP' }); continue; }
    // A file that is not tracked (deleted in the change, or new and not added yet) still gets what the map says for its
    // place: its group's checks, rules, risks and requires entries, as editing a file beside it would.
    const gone = !tracked.has(target);
    const group = groupOf(map, target) ?? (gone && before?.groups ? groupOf(before, target) : null);
    out.targets.push({ path: target, group: group?.id ?? null, status: gone ? 'NOT_TRACKED' : group ? 'IN_MAP' : ignored(target) ? 'IGNORED' : 'NO_GROUP' });
    if (gone) out.notCovered.push({ path: target, why: 'not a tracked file at this commit (new, deleted or misspelt)' });
    else if (!group && mapped) {
      // (with no map at all there is nothing to be "not covered" by)
      const suggest = ignored(target) ? null : suggestFor(target);
      out.notCovered.push({ path: target, why: ignored(target) ? 'ignored by the map' : suggest ? `in no group: \`readfirst fix\` would add it to group ${suggest.group}` : 'in no group: run `readfirst check`' });
    }
    if (group) {
      if (group.deprecated) note('deprecated', group.id, { group: group.id, why: group.deprecated.why, use: group.deprecated.use ?? null }, target);
      for (const r of group.risks ?? []) if (!r.files || matcher(r.files)(target)) note('risks', `${group.id}\0${r.text}`, { group: group.id, text: r.text, named: Boolean(r.files), ...(r.files ? { files: r.files } : {}) }, target);
      for (const c of group.checks ?? []) note('checks', c.run, { run: c.run, why: c.why ?? `checks for ${group.title}`, from: `group ${group.id}` }, target);
    }
    // Risks of other groups whose files name this file (risksNaming): they show here too.
    for (const { group: g, risk: r } of risksNaming(map, target, group?.id ?? null)) note('risks', `${g.id}\0${r.text}`, { group: g.id, text: r.text, named: true, files: r.files }, target);
    (map.requires ?? []).forEach((r, i) => { if (matcher(r.when)(target)) note('together', i, { when: r.when, also: r.also, why: r.why }, target); });
    for (const d of map.dependents ?? []) if (matcher(d.files)(target)) note('dependents', `${d.repo}\0${d.files.join('\0')}`, { repo: d.repo, paths: d.paths ?? [], why: d.why }, target);
    for (const f of map.flows ?? []) if (f.file === target || f.reaches.some((r) => r.file === target)) note('flows', `${f.file}\0${f.line}\0${f.entry}`, { entry: f.entry, file: f.file, line: f.line, checks: f.checks, reaches: f.reaches }, target);
    // The repository's own words whose evidence is in this file: what readfirst treats as a check or a sink here.
    // The repository's models (0.22.0) whose evidence is in this file, shown in the same section.
    for (const m of Array.isArray(map.models) ? map.models : []) if (evidenceFile(m?.evidence) === target) note('vocabulary', `${m.is}\0${modelName(m)}`, { kind: m.is, name: modelName(m), ...(m.kind ? { label: m.kind } : {}), ...(m.match?.within ? { within: m.match.within } : {}), ...(m.check ? { check: m.check } : {}), ...(m.unless ? { unless: m.unless } : {}), evidence: m.evidence, why: m.why ?? null }, target);
    for (const [kind, list] of Object.entries(map.vocabulary ?? {})) for (const x of list ?? []) if (evidenceFile(x.evidence) === target) note('vocabulary', `${kind}\0${vocabularyName(x)}`, { kind, name: vocabularyName(x), ...(x.label ? { label: x.label } : {}), ...(x.when ? { when: x.when } : {}), ...(x.within ? { within: x.within } : {}), ...(x.check ? { check: x.check } : {}), ...(x.unless ? { unless: x.unless } : {}), evidence: x.evidence, why: x.why ?? null }, target);
    for (const h of map.hotspots ?? []) if (h.file === target) note('hotspots', `${h.file}\0${h.symbol}\0${h.line}`, { file: h.file, symbol: h.symbol, line: h.line, labels: h.labels, rules: h.rules ?? [], note: h.note ?? null }, target);
    for (const rule of map.rules ?? []) {
      if (!matcher(rule.files)(target)) continue;
      note('rules', rule.id, { id: rule.id, rule: rule.rule, why: rule.why ?? null, files: rule.files, ...(held && (rule.checks ?? []).length ? { held: held.rules?.[rule.id] ?? null } : {}) }, target);
      for (const c of rule.checks ?? []) note('checks', c.run, { run: c.run, why: c.why ?? `keeps rule ${rule.id}`, from: `rule ${rule.id}` }, target);
    }
    // Who reaches the target through imports: direct importers by line, then everything further up, for tests.
    const depth = new Map([[target, 0]]);
    const queue = [target];
    while (queue.length) {
      const at = queue.shift();
      for (const e of importers.get(at) ?? []) {
        if (depth.has(e.from)) continue;
        depth.set(e.from, depth.get(at) + 1);
        queue.push(e.from);
        if (at === target && !isTest(e.from)) note('usedBy', e.from, { path: e.from, line: e.line }, target);
        if (isTest(e.from)) note('tests', e.from, { path: e.from, via: at === target ? null : at }, target);
        else if (at !== target) indirect.add(e.from);
      }
    }
    if (gone) {
      // A deleted or moved-away file that tracked files still import: the change breaks them unless they change too.
      const users = out.usedBy.filter((u) => u.for.includes(target)).map((u) => u.path);
      const nc = out.notCovered.find((n) => n.path === target);
      if (users.length && nc) nc.why = `not a tracked file at this commit, but still imported by ${users.join(', ')}: change them too, or they break`;
      continue;
    }
    if (isTest(target)) note('tests', target, { path: target, via: null }, target);
    out.unseen.push(...unseenIn(target, read));
  }
  for (const t of out.targets) if (broke[t.path]) t.brokeBefore = broke[t.path];
  // Whether the files given include one the entry asks to change too: for a change (verify, the Action) the targets are
  // everything changed, so `changed: false` is a file left behind; for one file being read, it is a reminder.
  const given = out.targets.map((t) => t.path);
  for (const t of out.together) t.changed = given.some(matcher(t.also));
  out.hotspots.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const u of out.usedBy) indirect.delete(u.path);
  out.usedByIndirectly = indirect.size;
  out.tests.sort((a, b) => Number(a.via !== null) - Number(b.via !== null) || a.path.localeCompare(b.path));
  out.truncated = { tests: Math.max(0, out.tests.length - limit), usedBy: Math.max(0, out.usedBy.length - limit) };
  // cut: only when a limit was asked for; `truncated` counts the rest, said as "…and N more" (toMarkdown)
  out.tests = out.tests.slice(0, limit);
  // cut: see above
  out.usedBy = out.usedBy.slice(0, limit);
  return out;
}

// The "Broke before" section as lines: one bullet per file with scars, and one line for files whose history was not
// fetched. targets: [{ path, brokeBefore? }]. Nothing to show gives [].
export function brokeSection(targets, { title = 'Broke before', hint = ' (this clone is shallow: `git fetch --unshallow` fetches it)' } = {}) {
  const shown = targets.filter((t) => t.brokeBefore && !t.brokeBefore.notFetched);
  const missing = targets.filter((t) => t.brokeBefore?.notFetched);
  if (!shown.length && !missing.length) return [];
  const lines = [`## ${title}`, ''];
  for (const t of shown) {
    const b = t.brokeBefore;
    lines.push(`- \`${t.path}\`: broke before: ${b.count} fix${b.count === 1 ? '' : 'es'}, last ${b.last.date} ${b.last.sha} "${b.last.subject}"`);
    if (b.count > 1) for (const c of b.top) lines.push(`  - ${c.date} ${c.sha} ${c.kind}: "${c.subject}"`);
    if (b.others?.length) lines.push(`  - and ${b.others.length} more: ${b.others.map((c) => `${c.date} ${c.sha} ${c.kind}`).join(', ')}`);
  }
  if (missing.length) lines.push(`- history not fetched for ${missing.length === 1 ? `\`${missing[0].path}\`` : `${missing.length} files`}${hint}`);
  lines.push('');
  return lines;
}

// checklist: checks as task-list boxes (for PR comments); heading: the title line, or null for none; broke: false leaves
// out the "Broke before" section (the Action writes its own).
// fold (the Action's PR comment): risks that name a changed file stay open; group-wide risks, hot spots, tests and users
// go under <details> with their count, so a PR touching a big group is not a wall of text (readfirst#118: 17,051
// characters, 67% of them group-wide risks). Nothing is dropped.
// verdict (diff and the Action, a judged list): src/verdict.mjs's verdict first ({ lang, where, problems }), with the
// checks, the files to change too, what is being replaced and the other repositories in it; then the rules and risks
// the change touches, in full; then those readfirst could not match, in full (group-wide ones folded with fold); then
// everything else, folded with fold. Nothing is dropped: each row is in exactly one place.
export function toMarkdown(list, { checklist = false, heading, broke = true, fold = false, verdict = null } = {}) {
  const title = heading === undefined ? `# Read first: ${list.targets.map((t) => `\`${t.path}\``).join(', ')}` : heading;
  const lines = title === null ? [] : [title, ''];
  if (verdict) return verdictMarkdown(list, lines, { checklist, broke, fold, ...verdict });
  const { section, folded } = writer(lines, fold);
  const w = renderers(list, checklist);
  section('Being replaced', list.deprecated ?? [], w.deprecated);
  // Triggered or not (0.28.0, src/trigger.mjs): a row judged against the change and not triggered goes to its own section,
  // whole, with the reason; a triggered one says what of it the change touched. Rows never judged (read) show as before.
  const off = (r) => r.trigger?.triggered === false;
  const rules = list.rules.filter((r) => !off(r));
  const risks = list.risks.filter((r) => !off(r));
  section('Rules that must keep holding', rules, w.rule);
  if (fold) {
    section('Watch out', risks.filter((r) => r.named), w.risk);
    folded(risks.some((r) => r.named) ? 'More to watch out for in the groups of these files' : 'Watch out (the groups of these files)', risks.filter((r) => !r.named), w.risk);
  } else section('Watch out', risks, w.risk);
  folded('Not triggered by this change', [...list.rules.filter(off), ...list.risks.filter(off)], w.off);
  if (broke) lines.push(...brokeSection(list.targets));
  folded('Hot spots in this code', list.hotspots ?? [], w.hotspot);
  section('Outside input reaches this code', list.flows ?? [], w.flow);
  section('This repository\'s words', list.vocabulary ?? [], w.vocab);
  section('Change these too', list.together ?? [], w.together);
  section('Other repositories depend on this', list.dependents ?? [], w.dependent);
  section('Run these checks', list.checks, w.check);
  tail(list, lines, { folded, section, w, broke });
  return lines.join('\n');
}

// section: a plain "## title" section; folded: the same rows under <details> with their count (fold only; otherwise a
// plain section). Both push to `lines` and skip an empty list.
function writer(lines, fold) {
  const section = (title, rows, render) => {
    if (!rows.length) return;
    lines.push(`## ${title}`, '', ...rows.map(render), '');
  };
  const folded = (title, rows, render, more = []) => {
    if (!rows.length) return;
    if (!fold) { lines.push(`## ${title}`, '', ...rows.map(render), ...more, ''); return; }
    lines.push(`<details><summary>${title} (${rows.length})</summary>`, '', ...rows.map(render), ...more, '', '</details>', '');
  };
  return { section, folded };
}

// One line per row of each kind, the same in every layout of the read list.
function renderers(list, checklist) {
  const many = list.targets.length > 1;
  const forWhom = (row, also = null) => {
    const parts = [also, many ? row.for.join(', ') : null].filter(Boolean);
    return parts.length ? ` _(${parts.join(' · ')})_` : '';
  };
  const heldNote = (r) => (r.held ? ` _(held at ${r.held.commit.slice(0, 7)} on ${r.held.date})_` : r.held === null ? ' _(never recorded as holding)_' : '');
  const touched = (r) => (r.trigger?.by?.length ? ` _(the change touches ${r.trigger.by.join(', ')})_` : '');
  const said = { entry: 'is where outside input enters', check: 'decides who may do something', sink: 'does something that matters', neutral: 'looks like one but is none of these', checks: 'decides who may do something', sinks: 'does something that matters', notChecks: 'is not a check', entries: 'declares a route', checksIf: 'decides who may do something only where the code matches', notSinks: 'does not write or call out', once: 'keeps a job or webhook from running twice', sources: 'returns outside input' };
  const rule = (r) => `- **${r.id}**: ${r.rule}${r.why ? ` — why: ${r.why}` : ''}${heldNote(r)}${touched(r)}${forWhom(r)}`;
  const risk = (r) => `- ${r.text}${touched(r)}${forWhom(r, `group ${r.group}`)}`;
  return {
    forWhom,
    rule,
    risk,
    // A rule has an id, a risk a group: either kind, in the sections that hold both.
    either: (r) => (r.id && r.rule !== undefined ? rule(r) : risk(r)),
    off: (r) => `- not triggered (${r.trigger.why}): ${r.id && r.rule !== undefined ? `**${r.id}**: ${r.rule}` : r.text}${forWhom(r, r.group ? `group ${r.group}` : null)}`,
    deprecated: (d) => `- group **${d.group}** is being replaced${d.use ? `: use \`${d.use}\` instead` : ''} — ${d.why}${forWhom(d)}`,
    hotspot: (h) => `- \`${h.symbol}\` (\`${h.file}:${h.line}\`): ${h.labels.join(', ')}${h.rules.length ? `, under ${h.rules.map((r) => `**${r}**`).join(', ')}` : ''}${h.note ? `: ${h.note}` : ''}`,
    flow: (f) => `- **${f.entry}** (\`${f.file}:${f.line}\`) reaches ${f.reaches.map((r) => `\`${r.symbol}\` (\`${r.file}:${r.line}\`: ${r.labels.join(', ')}${r.tables?.length ? ` on ${r.tables.map((t) => `\`${t}\``).join(', ')}` : ''}${r.inputs?.length ? `, with input ${r.inputs.map((t) => `\`${t.replace(/`/gu, "'")}\``).join(', ')}` : ''})`).join(', ')}; ${f.checks.length ? `checked by ${f.checks.map((c) => `\`${c}\``).join(', ')}` : 'no check of who may do it found on the way'}${forWhom(f)}`,
    vocab: (v) => `- \`${v.name}\` (\`${v.evidence}\`) ${said[v.kind] ?? v.kind}${v.when ? ` \`${v.when.replace(/`/gu, "'")}\`` : ''}${v.within ? ` inside \`@${v.within}\`` : ''}${v.check ? `, checked by \`${v.check.replace(/`/gu, "'")}\`${v.unless ? ` unless \`${v.unless.replace(/`/gu, "'")}\`` : ''}` : ''}${v.label ? ` (${v.label})` : ''}${v.why ? `: ${v.why}` : ''}${forWhom(v)}`,
    together: (t) => `- ${t.also.map((a) => `\`${a}\``).join(' or ')}${t.changed ? ' (changed)' : ''} — ${t.why}${forWhom(t)}`,
    dependent: (d) => `- **${d.repo}**${d.paths.length ? ` (${d.paths.map((x) => `\`${x}\``).join(', ')})` : ''} — ${d.why}${forWhom(d)}`,
    check: (c) => `- ${checklist ? '[ ] ' : ''}\`${c.run}\` — ${c.why}${forWhom(c)}`,
    test: (t) => `- \`${t.path}\`${t.via ? ` (through \`${t.via}\`)` : ''}${forWhom(t)}`,
    usedBy: (u) => `- \`${u.path}:${u.line}\`${forWhom(u)}`,
    path: (n) => `- \`${n.path}\`: ${n.why}`,
  };
}

// The sections every layout ends with: tests, users, what the map does not cover and what readfirst could not see, then
// the line for a list with nothing in it.
function tail(list, lines, { folded, section, w, broke }) {
  folded('Tests that reach this code', list.tests, w.test, list.truncated?.tests ? [`- …and ${list.truncated.tests} more`] : []);
  folded('Used by', list.usedBy, w.usedBy, list.truncated?.usedBy ? [`- …and ${list.truncated.usedBy} more direct users`] : []);
  if (list.usedByIndirectly) lines.push(`${list.usedByIndirectly} more file(s) use this code indirectly.`, '');
  section('Not covered by the map', list.notCovered, w.path);
  section('Not seen by readfirst (an empty list above may mean unknown here)', list.unseen ?? [], w.path);
  if (!(broke && brokeSection(list.targets).length) && !list.rules.length && !list.risks.length && !(list.hotspots ?? []).length && !(list.flows ?? []).length && !(list.vocabulary ?? []).length && !list.checks.length && !list.tests.length && !list.usedBy.length && !list.notCovered.length && !(list.unseen ?? []).length && !(list.deprecated ?? []).length && !(list.together ?? []).length && !(list.dependents ?? []).length)
    lines.push('Nothing in the map is tied to these files.', '');
}

// Where the verdict layout shows each list of the read list. toMarkdown with a verdict returns before the plain layout,
// so a list added to the read list needs a place here and in verdictMarkdown, or diff and the PR comment would leave it
// out without a word (test/verdict.test.mjs fails on a list of emptyList() with no place).
export const VERDICT_PLACES = { targets: 'the heading', rules: 'touched, not matched or not triggered', risks: 'touched, not matched or not triggered', checks: 'the verdict', together: 'the verdict', deprecated: 'the verdict', dependents: 'the verdict', hotspots: 'folded', flows: 'folded', vocabulary: 'folded', tests: 'folded', usedBy: 'folded', notCovered: 'open, and counted in the verdict', unseen: 'open, and counted in the verdict' };

// The verdict layout (toMarkdown's `verdict`): the verdict, what the change touches, what could not be matched, then the
// rest. The checks, the files to change too, what is being replaced and the other repositories are in the verdict, so
// they are not listed again below it.
// top: false when the caller has put the verdict at the top itself (the Action, above the map's problems).
function verdictMarkdown(list, lines, { checklist, broke, fold, lang = 'en', where = 'pr', problems = [], brokeTargets = null, top = true }) {
  if (top) lines.push(...verdictLines(list, { lang, where, problems, broke: brokeTargets, checklist }));
  const { section, folded } = writer(lines, fold);
  const w = renderers(list, checklist);
  const { touched, off, open, groupWide } = sortRows(list);
  const rows = (xs) => xs.map((x) => x.row);
  section('Triggered by this change', rows(touched), w.either);
  if (fold) {
    section('Not matched against the change: shown for their files', rows(open), w.either);
    folded('More in the groups of these files, not matched against the change', rows(groupWide), w.risk);
  } else section('Not matched against the change: shown for their files', rows([...open, ...groupWide]), w.either);
  folded('Not triggered by this change', rows(off), w.off);
  if (broke) {
    // Folded with the number of files it names; the section's own lines, every one, inside.
    const b = brokeSection(list.targets);
    const scarred = list.targets.filter((t) => t.brokeBefore).length;
    if (b.length && fold) lines.push(`<details><summary>Broke before (${scarred} file${scarred === 1 ? '' : 's'})</summary>`, ...b.filter((l) => !l.startsWith('## ')), '</details>', '');
    else lines.push(...b);
  }
  folded('Hot spots in this code', list.hotspots ?? [], w.hotspot);
  folded('Outside input reaches this code', list.flows ?? [], w.flow);
  folded('This repository\'s words', list.vocabulary ?? [], w.vocab);
  tail(list, lines, { folded, section, w, broke });
  return lines.join('\n');
}
