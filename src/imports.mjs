// Which tracked file imports which, read from the code. Only imports that resolve to a tracked file count: packages from
// outside the repository and unresolved specifiers are left out. JavaScript/TypeScript (import, export from, import(),
// require; relative paths, the repository's own workspace packages and tsconfig/jsconfig "paths" aliases) and Python
// (import a.b, from a.b import c, relative from . imports, and "a.b.c" strings that name a module of the repository,
// as hooks and settings do) are read here; Go, Rust, Elixir, C#, Java/Kotlin, Ruby and PHP in langs.mjs.
import { posix } from 'node:path';
import { moreEdges } from './langs.mjs';

const JS = /\.(?:m?js|cjs|tsx?|jsx|mts|cts|vue|svelte)$/u;
const PY = /\.py$/u;
const JS_IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s*)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/gu;
// `from a import (b,\n c)` may span lines inside its parentheses.
const PY_IMPORT = /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[\w*, \t]+)|import[ \t]+([\w., \t]+))/gmu;
const JS_EXT = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.vue', '.svelte', '/index.js', '/index.ts', '/index.tsx', '/index.mjs'];

const lineAt = (body, index) => body.slice(0, index).split('\n').length;
const dirOf = (f) => (posix.dirname(f) === '.' ? '' : posix.dirname(f));
const within = (dir, file) => dir === '' || file.startsWith(`${dir}/`);

// tsconfig.json allows comments and trailing commas.
export function parseJsonc(text) {
  if (text === null || text === undefined) return null;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.slice(i).match(/^"(?:[^"\\\n]|\\.)*"/u);
      if (!end) return null;
      out += end[0]; i += end[0].length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 1;
    } else out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1')); } catch { return null; }
}

// Bare specifiers that point back into the repository: a workspace package by the name in its package.json
// ("@acme/db", "@acme/db/schema"), or a "paths" alias from the tsconfig/jsconfig that covers the importing file ("@/lib/x").
// When a bare import is not a workspace package, ask the npm registry for its entry point.
export async function registryEntry(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
  if (!res.ok) return null;
  const pkg = await res.json();
  return pkg.module ?? pkg.main ?? null;
}

function jsResolver(files, tracked, read) {
  const jsCandidates = (base) => [...JS_EXT.map((e) => base + e), base.replace(/\.(m|c)?js$/u, '.$1ts'), base.replace(/\.js$/u, '.tsx')];
  const firstTracked = (bases) => {
    for (const b of bases) {
      const hit = jsCandidates(posix.normalize(b)).find((c) => tracked.has(c));
      if (hit) return hit;
    }
    return undefined;
  };
  const pkgs = [];
  for (const f of files) {
    if (!/(?:^|\/)package\.json$/u.test(f) || f.includes('node_modules/')) continue;
    let j;
    try { j = JSON.parse(read(f) ?? ''); } catch { continue; }
    if (typeof j?.name !== 'string' || !j.name || dirOf(f) === '') continue;
    const dot = typeof j.exports === 'string' ? j.exports : j.exports?.['.'];
    const exp = typeof dot === 'string' ? [dot] : dot && typeof dot === 'object' ? ['types', 'import', 'default', 'require'].map((k) => dot[k]).filter((v) => typeof v === 'string') : [];
    // An entry pointing at build output (dist/index.js) is read as the source next to it (src/index.ts).
    const entries = [j.source, ...exp, j.types, j.typings, j.module, j.main].filter((v) => typeof v === 'string')
      .flatMap((e) => [e, e.replace(/^\.?\/?(?:dist|build|lib|out)\//u, 'src/').replace(/\.d\.ts$/u, '.ts')]);
    pkgs.push({ name: j.name, dir: dirOf(f), entries: [...entries, 'src/index', 'index'] });
  }
  pkgs.sort((a, b) => b.name.length - a.name.length);
  const aliases = [];
  for (const f of files) {
    if (!/(?:^|\/)(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json$/u.test(f) || f.includes('node_modules/')) continue;
    const opts = parseJsonc(read(f))?.compilerOptions;
    if (!opts?.paths || typeof opts.paths !== 'object') continue;
    const base = posix.join(dirOf(f), opts.baseUrl ?? '.');
    for (const [pattern, targets] of Object.entries(opts.paths)) {
      if (Array.isArray(targets)) aliases.push({ scope: dirOf(f), pattern, targets: targets.filter((t) => typeof t === 'string').map((t) => posix.join(base, t)) });
    }
  }
  // The nearest config wins, as it would for the compiler.
  aliases.sort((a, b) => b.scope.length - a.scope.length);
  return (from, spec) => {
    for (const a of aliases) {
      if (!within(a.scope, from)) continue;
      const star = a.pattern.indexOf('*');
      let rest = null;
      if (star < 0) rest = spec === a.pattern ? '' : null;
      else if (spec.startsWith(a.pattern.slice(0, star)) && spec.endsWith(a.pattern.slice(star + 1))) rest = spec.slice(star, spec.length - (a.pattern.length - star - 1));
      if (rest === null) continue;
      const hit = firstTracked(a.targets.map((t) => t.replace('*', rest)));
      if (hit) return hit;
    }
    const pkg = pkgs.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (!pkg) return undefined;
    const sub = spec.slice(pkg.name.length + 1);
    return sub
      ? firstTracked([posix.join(pkg.dir, sub), posix.join(pkg.dir, 'src', sub)])
      : firstTracked(pkg.entries.map((e) => posix.join(pkg.dir, e.replace(/\.(?:m|c)?js$|\.tsx?$/u, ''))));
  };
}

export function importEdges(files, read) {
  const tracked = new Set(files);
  const out = [];
  const seen = new Set();
  const add = (from, to, line) => {
    if (!to || to === from || seen.has(`${from}\0${to}`)) return;
    seen.add(`${from}\0${to}`);
    out.push({ from, to, line });
  };
  const pyModule = (dotted, baseDir) => {
    const base = posix.join(baseDir, ...dotted.split('.').filter(Boolean));
    return [`${base}.py`, `${base}/__init__.py`].find((c) => tracked.has(c));
  };
  let bare = null;
  for (const from of [...files].sort()) {
    if (JS.test(from)) {
      const body = read(from);
      if (body === null) continue;
      for (const m of body.matchAll(JS_IMPORT)) {
        const spec = (m[1] ?? m[2] ?? m[3]).split('?')[0];
        if (!spec.startsWith('.')) {
          if (spec.startsWith('node:') || /^[a-z]+:/u.test(spec)) continue;
          bare ??= jsResolver(files, tracked, read);
          add(from, bare(from, spec), lineAt(body, m.index));
          continue;
        }
        const base = posix.normalize(posix.join(posix.dirname(from), spec));
        // TypeScript sources import "./x.js" for the file "./x.ts".
        const candidates = [...JS_EXT.map((e) => base + e), base.replace(/\.(m|c)?js$/u, '.$1ts'), base.replace(/\.js$/u, '.tsx')];
        add(from, candidates.find((c) => tracked.has(c)), lineAt(body, m.index));
      }
    } else if (PY.test(from)) {
      const body = read(from);
      if (body === null) continue;
      for (const m of body.matchAll(PY_IMPORT)) {
        const line = lineAt(body, m.index + m[0].search(/\S/u));
        if (m[1] !== undefined) {
          const dots = m[1].match(/^\.*/u)[0].length;
          const mod = m[1].slice(dots);
          // Relative: one dot is this package. Absolute: from the repository root, or from a src/ layout.
          const roots = dots ? [posix.join(posix.dirname(from), ...Array(dots - 1).fill('..'))] : ['', 'src'];
          for (const root of roots) {
            const target = mod ? pyModule(mod, root) : null;
            if (target) { add(from, target, line); }
            // "from pkg import mod" may name sub-modules.
            for (const name of m[2].replace(/[()]|#[^\n]*/gu, '').split(',').map((s) => s.trim().split(/\s+/u)[0]).filter((s) => s && s !== '*'))
              add(from, pyModule(mod ? `${mod}.${name}` : name, root), line);
            if (target) break;
          }
        } else {
          for (const name of m[3].split(',').map((s) => s.trim().split(/\s+/u)[0]).filter(Boolean))
            add(from, pyModule(name, '') ?? pyModule(name, 'src'), line);
        }
      }
    }
  }
  dottedEdges(files, tracked, read, pyModule, add);
  moreEdges([...files].sort(), read, add);
  return out;
}

// Python projects name code by dotted path in strings: Frappe hooks.py ("app.module.function"), frappe.call from
// JavaScript, Django settings and urls, Celery task names. A string counts when its first part is a top-level Python
// package of the repository and the longest leading part names one of its modules.
function dottedEdges(files, tracked, read, pyModule, add) {
  const top = new Map();
  for (const f of files) {
    const m = f.match(/^(?:(src)\/)?([A-Za-z_]\w*)\/__init__\.py$/u);
    if (m) top.set(m[2], m[1] ?? '');
  }
  if (!top.size) return;
  const DOTTED = /["'`]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)["'`]/gu;
  for (const from of files) {
    if (!/\.(?:py|m?js|tsx?|json)$/u.test(from) || from.includes('node_modules/')) continue;
    const body = read(from);
    if (body === null || body.length > 2_000_000) continue;
    for (const m of body.matchAll(DOTTED)) {
      const parts = m[1].split('.');
      if (!top.has(parts[0])) continue;
      for (let n = parts.length; n >= 2; n--) {
        const to = pyModule(parts.slice(0, n).join('.'), top.get(parts[0]));
        if (to) { add(from, to, lineAt(body, m.index)); break; }
      }
    }
  }
}
