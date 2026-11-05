// Which tracked file imports which, read from the code. Only imports that resolve to a tracked file count: packages from
// outside the repository and unresolved specifiers are left out. JavaScript/TypeScript (import, export from, import(),
// require; relative paths, the repository's own workspace packages and tsconfig/jsconfig "paths" aliases) and Python
// (import a.b, from a.b import c, relative from . imports, and "a.b.c" strings that name a module of the repository,
// as hooks and settings do) are read here; Go, Rust, Elixir, C#, Java/Kotlin, Ruby and PHP in langs.mjs.
import { posix } from 'node:path';
import { moreEdges } from './langs.mjs';

const JS = /\.(?:m?js|cjs|tsx?|jsx|mts|cts|vue|svelte)$/u;
const PY = /\.py$/u;
// The names before `from` are runs of name characters separated by whitespace: a class that also took whitespace
// overlapped `\s+` and backtracked (cubic) on a long whitespace run after the keyword (self-review, readfirst#89).
const JS_IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}$,]+(?:\s+[\w*{}$,]+)*\s+from\s*)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/gu;
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
  const pyRoots = pythonRoots(files);
  // An absolute import: from a source root, else, in a Python 2 file, from the importing file's folder (Python 2's
  // implicit relative import). In Python 3 code, "import logging" next to a logging.py is still the standard library.
  const pyAbsolute = (dotted, from, py2) => {
    for (const root of pyRoots) { const to = pyModule(dotted, root); if (to) return to; }
    const here = posix.dirname(from);
    return py2 && here !== '.' ? pyModule(dotted, here) : undefined;
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
      const py2 = isPython2(body);
      for (const m of body.matchAll(PY_IMPORT)) {
        const line = lineAt(body, m.index + m[0].search(/\S/u));
        if (m[1] !== undefined) {
          const dots = m[1].match(/^\.*/u)[0].length;
          const mod = m[1].slice(dots);
          // Relative: one dot is this package. Absolute: from the repository root, or from a src/ layout.
          const names = m[2].replace(/[()]|#[^\n]*/gu, '').split(',').map((s) => s.trim().split(/\s+/u)[0]).filter((s) => s && s !== '*');
          if (dots) {
            const root = posix.join(posix.dirname(from), ...Array(dots - 1).fill('..'));
            if (mod) add(from, pyModule(mod, root), line);
            // "from pkg import mod" may name sub-modules.
            for (const name of names) add(from, pyModule(mod ? `${mod}.${name}` : name, root), line);
          } else {
            add(from, pyAbsolute(mod, from, py2), line);
            for (const name of names) add(from, pyAbsolute(`${mod}.${name}`, from, py2), line);
          }
        } else {
          for (const name of m[3].split(',').map((s) => s.trim().split(/\s+/u)[0]).filter(Boolean))
            add(from, pyAbsolute(name, from, py2), line);
        }
      }
    }
  }
  dottedEdges(files, read, pyModule, pyRoots, add);
  moreEdges([...files].sort(), read, add);
  return out;
}

// Syntax only Python 2 accepts: a print statement, "except E, e:", "raise E, msg", "<>", a backquote repr. A file
// that opts into absolute imports is read as Python 3 whatever else it holds.
const PY2_ONLY = /^[ \t]*print[ \t]+(?![ \t]*[(=])\S|^[ \t]*except[ \t]+[\w.]+[ \t]*,[ \t]*\w+[ \t]*:|^[ \t]*raise[ \t]+[\w.]+[ \t]*,|[\w)\]][ \t]*<>[ \t]*[\w(\['"]|`\w+`/mu;
function isPython2(body) {
  return !/^from[ \t]+__future__[ \t]+import[^\n]*\babsolute_import\b/mu.test(body) && PY2_ONLY.test(body.replace(/(['"])\1\1[\s\S]*?\1\1\1/gu, '').replace(/#[^\n]*/gu, ''));
}

// Where absolute Python imports start: the repository root, src/, and each folder that holds a Django manage.py
// (backend/manage.py means "from feeds.models import Feed" is backend/feeds/models.py).
function pythonRoots(files) {
  const roots = new Set(['', 'src']);
  for (const f of files) {
    const m = f.match(/^(.+)\/manage\.py$/u);
    if (m && !f.includes('node_modules/')) roots.add(m[1]);
  }
  return [...roots];
}

// Python projects name code by dotted path in strings: Frappe hooks.py ("app.module.function"), frappe.call from
// JavaScript, Django settings and urls, Celery task names. A string counts when its first part is a top-level Python
// package of the repository and the longest leading part names one of its modules.
function dottedEdges(files, read, pyModule, pyRoots, add) {
  const top = new Map();
  for (const f of files) {
    const m = f.match(/^(?:(.*)\/)?([A-Za-z_]\w*)\/__init__\.py$/u);
    if (m && pyRoots.includes(m[1] ?? '') && !top.has(m[2])) top.set(m[2], m[1] ?? '');
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
