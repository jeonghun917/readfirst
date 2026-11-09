// What the hooks keep between calls, so the first touch of a file in a large repository does not rebuild the import
// graph and re-read git history from nothing each time (sentry, 22,494 files: 6.7 s for the graph, about 0.3 s of
// `git log` per file; the hook has 15 s). A speed-up only: whatever cannot be shown to match the files as they are now
// is computed again, never served stale.
// Kept in the hook's state folder (the temp folder), one file per repository, readable and writable by this user only;
// a file another user owns is ignored. Nothing is written in the checkout.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importEdges } from './imports.mjs';
import { brokeBefore } from './history.mjs';

const sha = (s) => createHash('sha1').update(s).digest('hex');
const cacheFile = (stateDir, root, kind) => join(stateDir, `readfirst-${kind}-${sha(root).slice(0, 16)}.json`);

function load(at) {
  try {
    const st = statSync(at);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    return JSON.parse(readFileSync(at, 'utf8'));
  } catch { return null; }
}
function save(at, value) {
  try {
    const tmp = `${at}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, at);
  } catch { /* a cache that cannot be written is only slower */ }
}

// Files whose import edges come from their own text and the list of files, plus the config files the resolver reads
// (tsconfig paths and baseUrl, package.json imports and workspaces, Python roots). Edges of other languages (Go
// packages, C# namespaces, Java packages, ...) depend on other files' text, so a change to one of those rebuilds all.
const OWN_TEXT = /\.(?:m?js|cjs|tsx?|jsx|mts|cts|vue|svelte|py|json)$/u;
const CONFIG = /(?:^|\/)(?:package\.json|[jt]sconfig[^/]*\.json|pyproject\.toml|setup\.py|setup\.cfg)$/u;

// The import graph of `files` as `read` gives their text. head: the commit the clean files are at (null: no cache);
// dirty: the files whose text differs from head. Edges from clean files are taken from the cache when the file list,
// the config files and head are the same; edges from files changed now or at the last call are read again.
export function cachedEdges({ root, files, read, head, dirty, stateDir, version = '' }) {
  if (!head || !stateDir) return importEdges(files, read);
  const configs = files.filter((f) => CONFIG.test(f) && dirty.has(f)).map((f) => `${f}\0${read(f) ?? ''}`).join('\0');
  const key = sha(`${version}\0${head}\0${files.join('\0')}\0${configs}`);
  const at = cacheFile(stateDir, root, 'edges');
  const old = load(at);
  const redo = new Set([...dirty, ...(old?.key === key && Array.isArray(old.dirty) ? old.dirty : [])]);
  let edges;
  if (old?.key === key && Array.isArray(old.edges) && [...redo].every((f) => OWN_TEXT.test(f))) {
    const kept = old.edges.filter(([from]) => !redo.has(files[from])).map(([from, to, line]) => ({ from: files[from], to: files[to], line }));
    const fresh = importEdges(files, (f) => (redo.has(f) || CONFIG.test(f) ? read(f) : null)).filter((e) => redo.has(e.from));
    edges = [...kept, ...fresh];
  } else edges = importEdges(files, read);
  const index = new Map(files.map((f, i) => [f, i]));
  const packed = edges.filter((e) => index.has(e.from) && index.has(e.to)).map((e) => [index.get(e.from), index.get(e.to), e.line]);
  if (packed.length === edges.length) save(at, { key, dirty: [...dirty], edges: packed });
  return edges;
}

// brokeBefore for these paths at head, from the cache where it has them. Results are kept per path for one head.
export function cachedBrokeBefore({ root, paths, tracked, head, stateDir }) {
  if (!head || !stateDir) return brokeBefore(root, paths, tracked);
  const at = cacheFile(stateDir, root, 'broke');
  const old = load(at);
  const known = old?.head === head && old.paths && typeof old.paths === 'object' ? old.paths : {};
  // Object.hasOwn, not `in`: a file named `constructor` or `toString` is a path, not a property of every object.
  const missing = paths.filter((p) => !Object.hasOwn(known, p));
  if (missing.length) {
    const found = brokeBefore(root, missing, tracked);
    for (const p of missing) known[p] = found[p] ?? null;
    save(at, { head, paths: known });
  }
  return Object.fromEntries(paths.filter((p) => Object.hasOwn(known, p) && known[p]).map((p) => [p, known[p]]));
}
