// What the map view needs, per file: its group, its read list in short form, and its marks. The page itself is drawn
// by view-city.mjs.
import { groupOf, matcher, risksNaming } from './map.mjs';
import { readList } from './readlist.mjs';

// What the page needs, per file: its group, its read list in short form, and its marks.
export function viewData({ map, files, imports, name = 'repository' }) {
  const placed = files.filter((f) => groupOf(map, f));
  const byGroup = new Map(map.groups.map((g) => [g.id, []]));
  const fileRows = {};
  for (const f of placed) {
    const g = groupOf(map, f);
    byGroup.get(g.id).push(f);
    // Every test and user: with a limit of 5 the page showed five tests as if they were all, and counted five users.
    const list = readList({ map, files, imports, targets: [f] });
    fileRows[f] = {
      g: g.id,
      rules: list.rules.map((r) => [r.id, r.rule, r.why ?? '']),
      risks: list.risks.map((r) => r.text),
      checks: list.checks.map((c) => [c.run, c.why ?? '']),
      tests: list.tests.map((t) => t.path),
      users: list.usedBy.length + list.usedByIndirectly,
      // A risk "on" a file: one that names the file, not one that covers its whole group.
      own: (g.risks ?? []).filter((r) => r.files && matcher(r.files)(f)).length + risksNaming(map, f, g.id).length,
    };
  }
  const links = new Map();
  for (const e of imports) {
    const a = fileRows[e.from]?.g; const b = fileRows[e.to]?.g;
    if (!a || !b || a === b) continue;
    const key = [a, b].sort().join('\0');
    links.set(key, (links.get(key) ?? 0) + 1);
  }
  return {
    name,
    links: [...links].map(([k, n]) => { const [a, b] = k.split('\0'); return { a, b, n }; }),
    groups: map.groups.map((g) => {
      const mine = byGroup.get(g.id) ?? [];
      return {
        id: g.id, title: g.title, files: mine,
        // The group's own risks (with the files they name, if any), its checks, and every rule that covers one of its files.
        risks: (g.risks ?? []).map((r) => [r.text, r.files ?? []]),
        checks: (g.checks ?? []).map((c) => [c.run, c.why ?? '']),
        rules: (map.rules ?? []).filter((r) => mine.some(matcher(r.files))).map((r) => [r.id, r.rule, r.why ?? '']),
      };
    }).filter((g) => g.files.length),
    rules: (map.rules ?? []).length,
    files: fileRows,
  };
}
