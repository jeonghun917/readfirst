// Who uses which file, for languages whose imports name modules, packages or types rather than paths: Go, Rust,
// Elixir, C#, Java/Kotlin, Ruby and PHP. Like the JavaScript and Python readers in imports.mjs, only edges that land on
// a tracked file count; anything that names a package from outside the repository is left out. Each reader is a
// careful approximation of the language's own rules, good enough to find the tests and callers of a file.
import { posix } from 'node:path';

const lineAt = (body, index) => body.slice(0, index).split('\n').length;
const dirOf = (f) => posix.dirname(f);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// Comments are blanked (same length, so line numbers stay right) before looking for names in code.
const blank = (body, re) => body.replace(re, (m) => m.replace(/[^\n]/gu, ' '));
const noComments = (body) => blank(body, /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu);

// Go: `import "module/path/pkg"` reaches every non-test .go file of that package's folder. The module path comes from
// the nearest go.mod.
function goEdges(files, read, add) {
  const mods = files.filter((f) => /(?:^|\/)go\.mod$/u.test(f)).map((f) => {
    const m = (read(f) ?? '').match(/^module\s+(\S+)/mu);
    return m ? { dir: dirOf(f) === '.' ? '' : dirOf(f), path: m[1] } : null;
  }).filter(Boolean).sort((a, b) => b.path.length - a.path.length);
  if (!mods.length) return;
  const byDir = new Map();
  for (const f of files) if (/\.go$/u.test(f) && !/_test\.go$/u.test(f)) byDir.set(dirOf(f), [...(byDir.get(dirOf(f)) ?? []), f]);
  for (const from of files.filter((f) => /\.go$/u.test(f))) {
    const body = read(from);
    if (body === null) continue;
    const specs = [];
    for (const m of body.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gmu)) for (const s of m[1].matchAll(/"([^"\n]+)"/gu)) specs.push([s[1], m.index + m[0].indexOf(s[0])]);
    for (const m of body.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"\n]+)"/gmu)) specs.push([m[1], m.index]);
    for (const [spec, at] of specs) {
      const mod = mods.find((x) => spec === x.path || spec.startsWith(`${x.path}/`));
      if (!mod) continue;
      const dir = posix.join(mod.dir, spec.slice(mod.path.length).replace(/^\//u, '')) || '.';
      for (const to of byDir.get(dir === '' ? '.' : dir) ?? []) add(from, to, lineAt(body, at));
    }
  }
}

// Rust: `mod x;` declares a child module file; `use crate::a::b` (and `super::`, `self::`, or the crate's own name
// from tests/) reaches the file of the longest module path that exists.
function rustEdges(files, read, add) {
  const tracked = new Set(files);
  const rs = files.filter((f) => /\.rs$/u.test(f));
  if (!rs.length) return;
  const crates = files.filter((f) => /(?:^|\/)Cargo\.toml$/u.test(f)).map((f) => {
    const name = (read(f) ?? '').match(/^\s*name\s*=\s*"([^"]+)"/mu)?.[1]?.replace(/-/gu, '_');
    const root = dirOf(f) === '.' ? '' : dirOf(f);
    return { root, name, src: posix.join(root, 'src') };
  });
  const crateOf = (f) => crates.filter((c) => !c.root || f.startsWith(`${c.root}/`)).sort((a, b) => b.root.length - a.root.length)[0] ?? { root: '', name: null, src: 'src' };
  const moduleFile = (dir, parts) => {
    for (let n = parts.length; n > 0; n--) {
      const base = posix.join(dir, ...parts.slice(0, n));
      const hit = [`${base}.rs`, `${base}/mod.rs`].find((c) => tracked.has(c));
      if (hit) return hit;
    }
    return null;
  };
  // The folder a file's own child modules live in: src/a.rs and src/a/mod.rs both keep theirs in src/a/.
  const childDir = (f) => (/(?:^|\/)(?:mod|lib|main)\.rs$/u.test(f) ? dirOf(f) : f.replace(/\.rs$/u, ''));
  const modulePath = (f, c) => {
    const rel = posix.relative(c.src, f).replace(/\.rs$/u, '').split('/');
    if (['lib', 'main'].includes(rel.at(-1)) && rel.length === 1) return [];
    if (rel.at(-1) === 'mod') rel.pop();
    return rel;
  };
  for (const from of rs) {
    const body = read(from);
    if (body === null) continue;
    const code = noComments(body);
    const c = crateOf(from);
    for (const m of code.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gmu)) add(from, moduleFile(childDir(from), [m[1]]), lineAt(body, m.index));
    // `use a::b::{c, d::e}` is read as a::b::c and a::b::d::e (one level of braces).
    const paths = [];
    for (const m of code.matchAll(/\buse\s+((?:crate|super|self|\w+)(?:::\w+)*)(?:::\{([^}]*)\})?/gu)) {
      const inner = (m[2] ?? '').split(',').map((x) => x.trim().replace(/\s+as\s+\w+$/u, '')).filter((x) => /^\w+(?:::\w+)*$/u.test(x) && x !== 'self');
      for (const p of inner.length ? inner.map((x) => `${m[1]}::${x}`) : [m[1]]) paths.push([p, m.index]);
    }
    for (const [path, index] of paths) {
      const m = { index };
      const parts = path.split('::');
      let base;
      if (parts[0] === 'crate' || (c.name && parts[0] === c.name)) base = [];
      else if (parts[0] === 'self') base = modulePath(from, c);
      else if (parts[0] === 'super') { base = modulePath(from, c); while (parts[0] === 'super') { parts.shift(); base = base.slice(0, -1); } parts.unshift('_'); }
      else continue;
      // Nothing below the crate root names a file: the crate root itself (lib.rs, else main.rs) is what is used.
      add(from, moduleFile(c.src, [...base, ...parts.slice(1)]) ?? (base.length ? null : [posix.join(c.src, 'lib.rs'), posix.join(c.src, 'main.rs')].find((x) => tracked.has(x) && x !== from)), lineAt(body, m.index));
    }
  }
}

// Elixir: modules are found by `defmodule`; any dotted module name the code names (alias, import, use, require or a
// call such as MyApp.Billing.charge) reaches the file that defines it. `alias A.{B, C}` is expanded.
function elixirEdges(files, read, add) {
  const ex = files.filter((f) => /\.exs?$/u.test(f));
  const defines = new Map();
  const bodies = new Map();
  for (const f of ex) {
    const body = read(f);
    if (body === null) continue;
    bodies.set(f, body);
    for (const m of body.matchAll(/^\s*defmodule\s+([A-Z][\w.]*)/gmu)) if (!defines.has(m[1])) defines.set(m[1], f);
  }
  if (!defines.size) return;
  for (const [from, body] of bodies) {
    const code = blank(body, /#[^\n]*/gu);
    for (const m of code.matchAll(/\balias\s+([A-Z][\w.]*)\.\{([^}]*)\}/gu))
      for (const n of m[2].split(',').map((s) => s.trim()).filter(Boolean)) add(from, defines.get(`${m[1]}.${n}`), lineAt(body, m.index));
    for (const m of code.matchAll(/(?<![\w.])([A-Z]\w*(?:\.[A-Z]\w*)+)/gu)) {
      // The longest defined prefix: MyApp.Billing.Invoice.new names MyApp.Billing.Invoice.
      const parts = m[1].split('.');
      for (let n = parts.length; n > 0; n--) {
        const to = defines.get(parts.slice(0, n).join('.'));
        if (to) { add(from, to, lineAt(body, m.index)); break; }
      }
    }
  }
}

// Types by namespace, for C# and Java/Kotlin: a file reaches the files declaring types it names, when that type's
// namespace (package) is its own or one it imports. Names are matched as whole words, outside comments and strings.
function typeEdges(files, read, add, { ext, nsRe, typeRe, importRe, wildcard }) {
  const src = files.filter((f) => ext.test(f));
  if (!src.length) return;
  const types = new Map(); // namespace -> Map(type -> file)
  const info = new Map();
  for (const f of src) {
    const body = read(f);
    if (body === null) continue;
    const code = blank(noComments(body), /"(?:[^"\\\n]|\\.)*"/gu);
    const ns = code.match(nsRe)?.[1] ?? '';
    const declared = new Set([...code.matchAll(typeRe)].map((m) => m[1]));
    if (!declared.size && /\.(?:java|kt)$/u.test(f)) declared.add(posix.basename(f).replace(/\.\w+$/u, ''));
    const space = types.get(ns) ?? new Map();
    for (const t of declared) if (!space.has(t)) space.set(t, f);
    types.set(ns, space);
    info.set(f, { body, code, ns, declared });
  }
  for (const [from, { body, code, ns, declared }] of info) {
    const spaces = new Set([ns]);
    const single = new Map();
    for (const m of code.matchAll(importRe)) {
      const name = m[1];
      if (wildcard(name)) spaces.add(wildcard(name));
      else if (types.has(name)) spaces.add(name);
      else { const i = name.lastIndexOf('.'); if (i > 0) single.set(name.slice(i + 1), name.slice(0, i)); }
    }
    // C#: an enclosing namespace's types are visible too (Company.App.Billing sees Company.App).
    for (let n = ns; n.includes('.'); ) { n = n.slice(0, n.lastIndexOf('.')); spaces.add(n); }
    const candidates = new Map();
    for (const s of spaces) for (const [t, f] of types.get(s) ?? []) if (!candidates.has(t)) candidates.set(t, f);
    for (const [t, s] of single) { const f = types.get(s)?.get(t); if (f) candidates.set(t, f); }
    for (const [t, to] of candidates) {
      if (to === from || declared.has(t)) continue;
      const m = new RegExp(`\\b${escape(t)}\\b`, 'u').exec(code);
      if (m) add(from, to, lineAt(body, m.index));
    }
  }
}

const csharpEdges = (files, read, add) => typeEdges(files, read, add, {
  ext: /\.cs$/u,
  nsRe: /^\s*namespace\s+([\w.]+)/mu,
  typeRe: /\b(?:class|record|interface|struct|enum)\s+(\w+)/gu,
  importRe: /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/gmu,
  wildcard: () => null,
});

const jvmEdges = (files, read, add) => typeEdges(files, read, add, {
  ext: /\.(?:java|kt)$/u,
  nsRe: /^\s*package\s+([\w.]+)/mu,
  typeRe: /\b(?:class|interface|enum|record|object)\s+(\w+)/gu,
  importRe: /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;?/gmu,
  wildcard: (name) => (name.endsWith('.*') ? name.slice(0, -2) : null),
});

// Ruby: require_relative and require of a file in lib/, plus Rails-style constants (Billing::Invoice) found by the file
// path that autoloading would use (app/*/billing/invoice.rb, lib/billing/invoice.rb).
const camel = (s) => s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
function rubyEdges(files, read, add) {
  const tracked = new Set(files);
  const rb = files.filter((f) => /\.rb$/u.test(f));
  if (!rb.length) return;
  const constants = new Map();
  for (const f of rb) {
    const m = f.match(/^(?:app\/[^/]+|lib)\/(.+)\.rb$/u);
    if (m && !f.startsWith('app/views/')) constants.set(m[1].split('/').map(camel).join('::'), f);
  }
  for (const from of rb) {
    const body = read(from);
    if (body === null) continue;
    const code = blank(body, /#[^\n{]*$/gmu);
    for (const m of code.matchAll(/\brequire_relative\s+['"]([^'"]+)['"]/gu)) {
      const p = posix.normalize(posix.join(dirOf(from), m[1]));
      add(from, [p, `${p}.rb`].find((c) => tracked.has(c)), lineAt(body, m.index));
    }
    for (const m of code.matchAll(/\brequire\s+['"]([^'"]+)['"]/gu)) add(from, [`lib/${m[1]}.rb`, `${m[1]}.rb`].find((c) => tracked.has(c)), lineAt(body, m.index));
    for (const m of code.matchAll(/(?<![\w:])((?:[A-Z]\w*::)*[A-Z]\w*)/gu)) add(from, constants.get(m[1]), lineAt(body, m.index));
  }
}

// PHP: `use Vendor\Pkg\Class;` and fully qualified names, mapped to files through composer.json's PSR-4 prefixes.
function phpEdges(files, read, add) {
  const tracked = new Set(files);
  const php = files.filter((f) => /\.php$/u.test(f));
  if (!php.length) return;
  const prefixes = [];
  for (const c of files.filter((f) => /(?:^|\/)composer\.json$/u.test(f))) {
    let j;
    try { j = JSON.parse(read(c) ?? '{}'); } catch { continue; }
    for (const section of [j.autoload, j['autoload-dev']]) for (const [ns, dirs] of Object.entries(section?.['psr-4'] ?? {}))
      for (const d of [dirs].flat()) prefixes.push({ ns: ns.replace(/\\+$/u, ''), dir: posix.join(dirOf(c), d) });
  }
  prefixes.sort((a, b) => b.ns.length - a.ns.length);
  const fileOf = (fq) => {
    const name = fq.replace(/^\\/u, '');
    for (const p of prefixes) if (name === p.ns || name.startsWith(`${p.ns}\\`)) {
      const f = posix.join(p.dir, `${name.slice(p.ns.length + 1).replace(/\\/gu, '/')}.php`);
      if (tracked.has(f)) return f;
    }
    return null;
  };
  if (!prefixes.length) return;
  for (const from of php) {
    const body = read(from);
    if (body === null) continue;
    const code = noComments(body);
    for (const m of code.matchAll(/^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/gmu)) add(from, fileOf(m[1]), lineAt(body, m.index));
    for (const m of code.matchAll(/\\?\b([A-Z]\w*(?:\\[A-Z]\w*)+)\b/gu)) add(from, fileOf(m[1]), lineAt(body, m.index));
  }
}

export const LANGUAGES = ['Go', 'Rust', 'Elixir', 'C#', 'Java', 'Kotlin', 'Ruby', 'PHP'];

export function moreEdges(files, read, add) {
  for (const reader of [goEdges, rustEdges, elixirEdges, csharpEdges, jvmEdges, rubyEdges, phpEdges]) reader(files, read, add);
}
