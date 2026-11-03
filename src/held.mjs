// When each rule last held: `readfirst verify --record` writes .readfirst/held.json after a run in which every check of a
// rule passed, with the commit and the date. Committed with the code, it lets anyone see which promises were shown to
// hold, and where (read lists, audit), and which were never checked or changed since. Nothing else writes it.
import { matcher } from './map.mjs';

export const HELD_PATH = '.readfirst/held.json';
export const HELD_FORMAT = 'readfirst/held@1';

// The record as read from the checkout, or null when there is none (or it is not ours).
export function parseHeld(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && v.format === HELD_FORMAT && v.rules && typeof v.rules === 'object' ? v : null;
  } catch { return null; }
}

// The rules that held in this run: each covers a target, has checks, and every one of its checks ran and passed.
export function heldInRun(map, targets, results) {
  const passed = new Set(results.filter((r) => r.status === 'pass').map((r) => r.run));
  return (map.rules ?? []).filter((r) => (r.checks ?? []).length && targets.some(matcher(r.files)) && r.checks.every((c) => passed.has(c.run))).map((r) => r.id);
}

// The record with these rules set to this commit; rules the map no longer has are dropped.
export function recordHeld(held, ids, { commit, date, dirty = false, map }) {
  const keep = new Set((map?.rules ?? []).map((r) => r.id));
  const rules = Object.fromEntries(Object.entries(held?.rules ?? {}).filter(([id]) => !map || keep.has(id)));
  for (const id of ids) rules[id] = { commit, date, ...(dirty ? { dirty: true } : {}) };
  return { format: HELD_FORMAT, rules: Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))) };
}
