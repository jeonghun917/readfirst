// The read list for files someone is about to change: the rules that cover them, the risks written for their group,
// the checks to run (the group's commands, the rules' commands, and the tests that import them), and who uses them.
import { groupOf, matcher, MAP_PATH } from './map.mjs';

export const READ_LIST_FORMAT = 'readfirst/read-list@1';
const TEST = /(^|\/)(?:tests?|__tests__|spec|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)test[-_][^/]*\.(?:[cm]?[jt]sx?|py)$|_test\.(?:py|go)$/u;
export const isTest = (path) => TEST.test(path);

export function readList({ map, files, imports, targets, commit = null, limit = 30 }) {
  if (!targets.length || targets.some((t) => !t.trim())) throw new Error('give at least one file path, none empty');
  const tracked = new Set(files);
  const ignored = matcher(map.ignore ?? []);
  const importers = new Map();
  for (const e of imports) importers.set(e.to, [...(importers.get(e.to) ?? []), e]);

  const out = { format: READ_LIST_FORMAT, commit, targets: [], rules: [], risks: [], checks: [], tests: [], usedBy: [], usedByIndirectly: 0, notCovered: [] };
  const seen = { rules: new Map(), risks: new Map(), checks: new Map(), tests: new Map(), usedBy: new Map() };
  const note = (kind, key, item, target) => {
    const have = seen[kind].get(key);
    if (have) { if (!have.for.includes(target)) have.for.push(target); return; }
    const row = { ...item, for: [target] };
    seen[kind].set(key, row);
    out[kind].push(row);
  };
  const indirect = new Set();

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
      out.notCovered.push({ path: target, why: ignored(target) ? 'ignored by the map' : 'in no group: run `readfirst check`' });
    } else {
      for (const r of group.risks ?? []) if (!r.files || matcher(r.files)(target)) note('risks', `${group.id}\0${r.text}`, { group: group.id, text: r.text }, target);
      for (const c of group.checks ?? []) note('checks', c.run, { run: c.run, why: c.why ?? `checks for ${group.title}`, from: `group ${group.id}` }, target);
    }
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
  }
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
  section('Run these checks', list.checks, (c) => `- ${checklist ? '[ ] ' : ''}\`${c.run}\` — ${c.why}${forWhom(c)}`);
  section('Tests that reach this code', list.tests, (t) => `- \`${t.path}\`${t.via ? ` (through \`${t.via}\`)` : ''}${forWhom(t)}`);
  if (list.truncated?.tests) lines.splice(lines.length - 1, 0, `- …and ${list.truncated.tests} more`);
  section('Used by', list.usedBy, (u) => `- \`${u.path}:${u.line}\`${forWhom(u)}`);
  if (list.truncated?.usedBy) lines.splice(lines.length - 1, 0, `- …and ${list.truncated.usedBy} more direct users`);
  if (list.usedByIndirectly) lines.push(`${list.usedByIndirectly} more file(s) use this code indirectly.`, '');
  section('Not covered by the map', list.notCovered, (n) => `- \`${n.path}\`: ${n.why}`);
  if (!list.rules.length && !list.risks.length && !list.checks.length && !list.tests.length && !list.usedBy.length && !list.notCovered.length)
    lines.push('Nothing in the map is tied to these files.', '');
  return lines.join('\n');
}
