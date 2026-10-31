// Which tracked file imports which, read from the code. Only imports that resolve to a tracked file count: packages and
// unresolved specifiers are left out. JavaScript/TypeScript (import, export from, import(), require) and Python
// (import a.b, from a.b import c, relative from . imports) are read.
import { posix } from 'node:path';

const JS = /\.(?:m?js|cjs|tsx?|jsx|mts|cts|vue|svelte)$/u;
const PY = /\.py$/u;
const JS_IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s*)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/gu;
// `from a import (b,\n c)` may span lines inside its parentheses.
const PY_IMPORT = /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[\w*, \t]+)|import[ \t]+([\w., \t]+))/gmu;
const JS_EXT = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.vue', '.svelte', '/index.js', '/index.ts', '/index.tsx', '/index.mjs'];

const lineAt = (body, index) => body.slice(0, index).split('\n').length;

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
  for (const from of [...files].sort()) {
    if (JS.test(from)) {
      const body = read(from);
      if (body === null) continue;
      for (const m of body.matchAll(JS_IMPORT)) {
        const spec = (m[1] ?? m[2] ?? m[3]).split('?')[0];
        if (!spec.startsWith('.')) continue;
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
  return out;
}
