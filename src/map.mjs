// The map file: groups of files with what to check and what to watch out for, plus project rules.
// Paths are repository paths with forward slashes. A pattern is a path, a folder ending in "/**", or a "*" glob
// within one path segment ("src/*.js", "*.md"). Every tracked file belongs to exactly one group or to "ignore".

export const MAP_FORMAT = 'readfirst/map@1';
export const MAP_PATH = '.readfirst/map.json';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 2000) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

export function patternToRegExp(pattern) {
  // Within one segment: `*` is any run of characters, `?` one character; everything else is literal.
  const segment = (s) => s.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]');
  if (pattern.endsWith('/**')) return new RegExp(`^${segment(pattern.slice(0, -3))}/`, 'u');
  if (pattern === '**') return /^/u;
  const body = pattern.split('**/').map(segment).join('(?:.*/)?');
  return new RegExp(`^${body}$`, 'u');
}

export const matcher = (patterns) => {
  const res = patterns.map(patternToRegExp);
  return (path) => res.some((r) => r.test(path));
};

const strings = (v, where, p, max = 500) => {
  if (!Array.isArray(v) || !v.every((s) => text(s, max))) p.push(`${where}: a list of non-empty strings`);
  return Array.isArray(v) ? v.filter((s) => text(s, max)) : [];
};

const only = (v, keys, where, p) => {
  for (const k of Object.keys(v)) if (!keys.includes(k)) p.push(`${where}.${k}: unknown field`);
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

// Problems with the map against the list of tracked files. An empty list means the map is good.
export function mapProblems(map, files) {
  const p = [];
  if (!isRecord(map)) return ['map: a JSON object'];
  only(map, ['format', 'groups', 'rules', 'ignore'], 'map', p);
  if (map.format !== MAP_FORMAT) p.push(`format: "${MAP_FORMAT}"`);
  if (!Array.isArray(map.groups) || !map.groups.length) return [...p, 'groups: at least one group'];
  const ids = new Set();
  map.groups.forEach((g, i) => {
    const at = `groups[${i}]`;
    if (!isRecord(g)) { p.push(`${at}: an object`); return; }
    only(g, ['id', 'title', 'files', 'checks', 'risks'], at, p);
    if (typeof g.id !== 'string' || !ID.test(g.id)) p.push(`${at}.id: lowercase letters, digits and "-"`);
    else if (ids.has(g.id)) p.push(`${at}.id: ${g.id} is used twice`);
    ids.add(g.id);
    if (!text(g.title, 200)) p.push(`${at}.title: text`);
    if (!strings(g.files, `${at}.files`, p).length) p.push(`${at}.files: at least one path or pattern`);
    checkList(g.checks, `${at}.checks`, p);
    if (g.risks !== undefined) {
      if (!Array.isArray(g.risks)) p.push(`${at}.risks: a list`);
      else g.risks.forEach((r, j) => {
        if (!isRecord(r) || !text(r.text)) { p.push(`${at}.risks[${j}]: { text, files? }`); return; }
        only(r, ['text', 'files'], `${at}.risks[${j}]`, p);
        if (r.files !== undefined) strings(r.files, `${at}.risks[${j}].files`, p);
      });
    }
  });
  if (map.rules !== undefined) {
    if (!Array.isArray(map.rules)) p.push('rules: a list');
    else {
      const ruleIds = new Set();
      map.rules.forEach((r, i) => {
        const at = `rules[${i}]`;
        if (!isRecord(r)) { p.push(`${at}: an object`); return; }
        only(r, ['id', 'rule', 'why', 'files', 'checks'], at, p);
        if (typeof r.id !== 'string' || !ID.test(r.id)) p.push(`${at}.id: lowercase letters, digits and "-"`);
        else if (ruleIds.has(r.id)) p.push(`${at}.id: ${r.id} is used twice`);
        ruleIds.add(r.id);
        if (!text(r.rule)) p.push(`${at}.rule: text`);
        if (r.why !== undefined && !text(r.why)) p.push(`${at}.why: text`);
        if (!strings(r.files, `${at}.files`, p).length) p.push(`${at}.files: at least one path or pattern`);
        checkList(r.checks, `${at}.checks`, p);
        for (const f of Array.isArray(r.files) ? r.files.filter((x) => typeof x === 'string') : [])
          if (!files.some(matcher([f]))) p.push(`${at}.files: ${f} matches no tracked file`);
      });
    }
  }
  if (map.ignore !== undefined) strings(map.ignore, 'ignore', p);
  if (p.length) return p;

  // Placement: each tracked file in exactly one group or ignored; each group pattern matches something.
  const ignored = matcher(map.ignore ?? []);
  const groupMatch = map.groups.map((g) => [g.id, matcher(g.files)]);
  const unplaced = [];
  for (const f of files) {
    if (f === MAP_PATH) continue;
    const owners = groupMatch.filter(([, m]) => m(f)).map(([id]) => id);
    if (owners.length > 1) p.push(`${f}: in more than one group (${owners.join(', ')})`);
    else if (!owners.length && !ignored(f)) unplaced.push(f);
  }
  if (unplaced.length) p.push(`${unplaced.length} file(s) in no group and not ignored: ${unplaced.slice(0, 10).join(', ')}${unplaced.length > 10 ? ', ...' : ''}`);
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

// A first map from the file tree alone: one group per top folder (one per sub-folder under src/, lib/ and app/),
// tests together. Folders of only media or fonts get a group of their own too: code usually loads them, so the risks of
// that code belong there; "ignore" is left for a person to fill with what nothing depends on. Titles and risks are left
// for a person or an agent to write.
const MEDIA = /\.(?:png|jpe?g|gif|webp|svg|ico|mp3|wav|ogg|m4a|flac|mp4|webm|mov|woff2?|ttf|otf|eot|glb|gltf|fbx|blend|zip|pdf)$/iu;
export function draftMap(files) {
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
  for (const f of files) {
    if (f === MAP_PATH) continue;
    const { key, pattern } = keyOf(f);
    const slot = byFolder.get(key) ?? { pattern, files: [] };
    slot.files.push(f);
    byFolder.set(key, slot);
  }
  for (const [key, slot] of byFolder) {
    const media = Boolean(slot.pattern) && slot.files.every((f) => MEDIA.test(f));
    const id = key.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'group';
    const patterns = slot.pattern ? [slot.pattern] : slot.files;
    const prev = groups.get(id);
    const title = media
      ? `TODO: what loads the media files in ${slot.pattern} (binary, not read)`
      : `TODO: what ${slot.pattern ?? 'the top-level files'} ${slot.pattern ? 'is' : 'are'} for`;
    groups.set(id, { id, title, files: prev ? [...prev.files, ...patterns] : patterns, checks: [], risks: [] });
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
  return { format: MAP_FORMAT, groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)), rules: [], ignore: [...ignore].sort() };
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

  const ignored = matcher(out.ignore ?? []);
  const owner = (f) => out.groups.find((g) => matcher(g.files)(f));
  const unplaced = files.filter((f) => f !== MAP_PATH && !ignored(f) && !owner(f));
  const dir = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
  const placedIn = (d) => files.filter((f) => f !== MAP_PATH && dir(f) === d && owner(f));
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
