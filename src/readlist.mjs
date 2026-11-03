// The read list for files someone is about to change: the rules that cover them, the risks written for their group,
// the checks to run (the group's commands, the rules' commands, and the tests that import them), and who uses them.
import { fixMap, groupOf, matcher, MAP_PATH } from './map.mjs';

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

// What readfirst could not see about one file: a language whose imports it does not read, or a module loaded by a
// computed name. read(path) gives the file's text, or null.
export function unseenIn(path, read = () => null) {
  if (OTHER_CODE.test(path)) return [{ path, why: `readfirst does not read imports in .${path.split('.').pop()} files: who uses it and which tests reach it are unknown, not none` }];
  const kind = Object.values(COMPUTED_LOAD).find((k) => k.test.test(path));
  if (!kind) return [];
  const body = read(path);
  if (!body) return [];
  const lines = body.split('\n');
  const at = lines.findIndex((l) => !/^\s*(?:\/\/|#|\*)/u.test(l) && kind.re.test(l));
  return at < 0 ? [] : [{ path, line: at + 1, why: `line ${at + 1} loads a module by a computed name: what it loads is not followed` }];
}

// The read list for no files, so `diff --json` is always JSON.
export const emptyList = (commit = null) => ({ format: READ_LIST_FORMAT, commit, targets: [], rules: [], risks: [], hotspots: [], checks: [], tests: [], usedBy: [], usedByIndirectly: 0, notCovered: [], unseen: [], truncated: { tests: 0, usedBy: 0 } });

// read(path), optional, gives a file's text: with it, code that loads modules by computed names is listed as unseen.
export function readList({ map, files, imports, targets, commit = null, limit = 30, read = () => null }) {
  if (!targets.length || targets.some((t) => !t.trim())) throw new Error('give at least one file path, none empty');
  const tracked = new Set(files);
  const ignored = matcher(map.ignore ?? []);
  const importers = new Map();
  for (const e of imports) importers.set(e.to, [...(importers.get(e.to) ?? []), e]);

  const out = { format: READ_LIST_FORMAT, commit, targets: [], rules: [], risks: [], hotspots: [], checks: [], tests: [], usedBy: [], usedByIndirectly: 0, notCovered: [], unseen: [] };
  const seen = { rules: new Map(), risks: new Map(), hotspots: new Map(), checks: new Map(), tests: new Map(), usedBy: new Map() };
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
    if (!tracked.has(target) && target !== MAP_PATH) {
      out.targets.push({ path: target, group: null, status: 'NOT_TRACKED' });
      out.notCovered.push({ path: target, why: 'not a tracked file at this commit (new, deleted or misspelt)' });
      continue;
    }
    if (target === MAP_PATH) { out.targets.push({ path: target, group: null, status: 'MAP' }); continue; }
    const group = groupOf(map, target);
    out.targets.push({ path: target, group: group?.id ?? null, status: group ? 'IN_MAP' : ignored(target) ? 'IGNORED' : 'NO_GROUP' });
    if (!group) {
      const suggest = ignored(target) ? null : suggestFor(target);
      out.notCovered.push({ path: target, why: ignored(target) ? 'ignored by the map' : suggest ? `in no group: \`readfirst fix\` would add it to group ${suggest.group}` : 'in no group: run `readfirst check`' });
    } else {
      for (const r of group.risks ?? []) if (!r.files || matcher(r.files)(target)) note('risks', `${group.id}\0${r.text}`, { group: group.id, text: r.text }, target);
      for (const c of group.checks ?? []) note('checks', c.run, { run: c.run, why: c.why ?? `checks for ${group.title}`, from: `group ${group.id}` }, target);
    }
    for (const h of map.hotspots ?? []) if (h.file === target) note('hotspots', `${h.file}\0${h.symbol}\0${h.line}`, { file: h.file, symbol: h.symbol, line: h.line, labels: h.labels, rules: h.rules ?? [], note: h.note ?? null }, target);
    for (const rule of map.rules ?? []) {
      if (!matcher(rule.files)(target)) continue;
      note('rules', rule.id, { id: rule.id, rule: rule.rule, why: rule.why ?? null, files: rule.files }, target);
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
    if (isTest(target)) note('tests', target, { path: target, via: null }, target);
    out.unseen.push(...unseenIn(target, read));
  }
  out.hotspots.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const u of out.usedBy) indirect.delete(u.path);
  out.usedByIndirectly = indirect.size;
  out.tests.sort((a, b) => Number(a.via !== null) - Number(b.via !== null) || a.path.localeCompare(b.path));
  out.truncated = { tests: Math.max(0, out.tests.length - limit), usedBy: Math.max(0, out.usedBy.length - limit) };
  out.tests = out.tests.slice(0, limit);
  out.usedBy = out.usedBy.slice(0, limit);
  return out;
}

// checklist: checks as task-list boxes (for PR comments); heading: the title line, or null for none.
export function toMarkdown(list, { checklist = false, heading } = {}) {
  const title = heading === undefined ? `# Read first: ${list.targets.map((t) => `\`${t.path}\``).join(', ')}` : heading;
  const lines = title === null ? [] : [title, ''];
  const many = list.targets.length > 1;
  const forWhom = (row, also = null) => {
    const parts = [also, many ? row.for.join(', ') : null].filter(Boolean);
    return parts.length ? ` _(${parts.join(' · ')})_` : '';
  };
  const section = (title, rows, render) => {
    if (!rows.length) return;
    lines.push(`## ${title}`, '', ...rows.map(render), '');
  };
  section('Rules that must keep holding', list.rules, (r) => `- **${r.id}**: ${r.rule}${r.why ? ` — why: ${r.why}` : ''}${forWhom(r)}`);
  section('Watch out', list.risks, (r) => `- ${r.text}${forWhom(r, `group ${r.group}`)}`);
  section('Hot spots in this code', list.hotspots ?? [], (h) => `- \`${h.symbol}\` (\`${h.file}:${h.line}\`): ${h.labels.join(', ')}${h.rules.length ? `, under ${h.rules.map((r) => `**${r}**`).join(', ')}` : ''}${h.note ? `: ${h.note}` : ''}`);
  section('Run these checks', list.checks, (c) => `- ${checklist ? '[ ] ' : ''}\`${c.run}\` — ${c.why}${forWhom(c)}`);
  section('Tests that reach this code', list.tests, (t) => `- \`${t.path}\`${t.via ? ` (through \`${t.via}\`)` : ''}${forWhom(t)}`);
  if (list.truncated?.tests) lines.splice(lines.length - 1, 0, `- …and ${list.truncated.tests} more`);
  section('Used by', list.usedBy, (u) => `- \`${u.path}:${u.line}\`${forWhom(u)}`);
  if (list.truncated?.usedBy) lines.splice(lines.length - 1, 0, `- …and ${list.truncated.usedBy} more direct users`);
  if (list.usedByIndirectly) lines.push(`${list.usedByIndirectly} more file(s) use this code indirectly.`, '');
  section('Not covered by the map', list.notCovered, (n) => `- \`${n.path}\`: ${n.why}`);
  section('Not seen by readfirst (an empty list above may mean unknown here)', list.unseen ?? [], (n) => `- \`${n.path}\`: ${n.why}`);
  if (!list.rules.length && !list.risks.length && !(list.hotspots ?? []).length && !list.checks.length && !list.tests.length && !list.usedBy.length && !list.notCovered.length && !(list.unseen ?? []).length)
    lines.push('Nothing in the map is tied to these files.', '');
  return lines.join('\n');
}
