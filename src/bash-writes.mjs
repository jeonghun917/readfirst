// The files a shell command writes, so the hook can show their read list before a Bash call as it does before an Edit.
// Agents change files with sed -i, redirects and short scripts as often as with an edit tool; a hook that only looked at
// Edit and Write saw none of those (readfirst's own sessions, 2026-11-07). Only where a command writes counts, not every
// file it names: reading a file into a scratch file, or running the tests, is not a write to the repository.
//   redirects (> f, >> f), sed -i / perl -i, tee, truncate, patch, the destination of cp / mv / install / rsync,
//   git checkout / restore of named paths, and code that writes (open(..., 'w'), writeFile, write_text...) run by
//   python, node, ruby, perl or a shell from -c / -e or a here-document: there the targets of its write calls count
//   (codeTargets), not every path-like word in it.
// A here-document fed to cat or tee is data; only where it goes counts. `cd dir &&` moves where relative paths start.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const CODE_WRITES = /\bopen\([^)]*,\s*['"][wax]|\.write_text\(|\.write_bytes\(|writeFileSync\(|writeFile\(|appendFileSync\(|\.writelines?\(|createWriteStream\(|File\.write|>>?\s*\$|\bdump\(/u;
const PATHISH = /(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,6}\b/gu;
const RUNNER = /^(?:python3?|node|ruby|perl|bash|sh|zsh|deno|bun)$/u;
const unquote = (w) => w.replace(/^(['"])(.*)\1$/u, '$2');

// A quoted string literal: group 1 the quote, group 2 the text.
const LIT = String.raw`(['"])((?:\\.|(?!\1)[^\\\n])*)\1`;
// Write calls whose first argument is what they write.
const WRITE_CALLS = [
  /\bopen\(\s*([^,()]+?)\s*,\s*(?:mode\s*=\s*)?['"][wax][^'"]*['"]/gu,
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\(\s*([^,()]+?)\s*[,)]/gu,
  /\bPath\(\s*([^()]+?)\s*\)\s*\.(?:write_text|write_bytes|open\(\s*['"][wax])/gu,
  /\b([A-Za-z_]\w*)\.(?:write_text|write_bytes)\(/gu,
  /\bFile\.write\(\s*([^,()]+?)\s*,/gu,
];
const ARGV = /^(?:sys\.argv|process\.argv)/u;

// What a script writes: the targets of its write calls, as a literal, a variable assigned a literal, a parameter of a
// function called with a literal, a for-loop over literals, or the script's own arguments (sys.argv, process.argv).
// A write whose target none of these names (an f-string, a glob, a path built at run time) falls back to the path-like
// words the script names that exist on disk (`exists`), so a real write is not missed.
// Before 0.26.0 every path-like word in a writing script counted: in readfirst's own sessions 96% of scripts were
// flagged, 4,106 paths for about 500 real targets, among them 0.015, /u.test and test data (2026-11-08).
export function codeTargets(code, { args = [], exists = () => false, glob = () => [] } = {}) {
  const out = new Set();
  const lit = new RegExp(String.raw`^\s*${LIT}`, 'u');
  const name = (n) => n.replace(/\$/gu, '\\$');
  const assigned = (n) => [...code.matchAll(new RegExp(String.raw`(?:^|[\s;(,])(?:const |let |var )?${name(n)}\s*=\s*(?:Path\()?${LIT}`, 'gmu'))].map((m) => m[2]);
  const passed = (n) => {
    const got = [];
    for (const m of code.matchAll(new RegExp(String.raw`(?:def|function)\s+(\w+)\s*\(\s*${name(n)}\b`, 'gu'))) for (const c of code.matchAll(new RegExp(String.raw`\b${m[1]}\(\s*${LIT}`, 'gu'))) got.push(c[2]);
    for (const m of code.matchAll(new RegExp(String.raw`for\s+${name(n)}\s+in\s+\[([^\]]*)\]`, 'gu'))) for (const c of m[1].matchAll(new RegExp(LIT, 'gu'))) got.push(c[2]);
    // for p in glob.glob('dir/*.ext') / sorted(glob(...)) / Path('dir').glob('*.ext'): the files it matches now.
    for (const m of code.matchAll(new RegExp(String.raw`for\s+${name(n)}\s+in\s+(?:sorted\()?(?:glob\.)?glob\(\s*${LIT}`, 'gu'))) got.push(...glob(m[2]));
    if (args.length && new RegExp(String.raw`${name(n)}\s*=\s*(?:sys\.argv|process\.argv)`, 'u').test(code)) got.push(...args);
    return got;
  };
  let unresolved = false;
  for (const re of WRITE_CALLS) for (const m of code.matchAll(re)) {
    const arg = m[1].trim();
    const l = arg.match(lit);
    if (l) { out.add(l[2]); continue; }
    if (ARGV.test(arg)) { if (args.length) args.forEach((a) => out.add(a)); else unresolved = true; continue; }
    const id = arg.match(/^[A-Za-z_$][\w$]*$/u)?.[0];
    const found = id ? [...assigned(id), ...passed(id)] : [];
    if (found.length) found.forEach((p) => out.add(p)); else unresolved = true;
  }
  if (unresolved) for (const w of code.match(PATHISH) ?? []) if (exists(w)) out.add(w);
  return [...out].filter((p) => p && !p.includes('$') && !p.includes('{'));
}

// Words of one command segment, quotes kept together; good enough for the shapes above, not a shell parser.
// A command's words without its redirects: `< x`, `2>/dev/null`, `>&2` and the word after a bare operator. The
// targets of > and >> are taken from the segment itself; the rest are not files this command's arguments name.
const REDIRECT = /^(?:\d+|&)?(?:<<<|<>|>>|>\||<|>)/u;
function withoutRedirects(ws) {
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    const m = ws[i].match(REDIRECT);
    if (!m) out.push(ws[i]);
    else if (ws[i].length === m[0].length) i++;
  }
  return out;
}

// How each command reads its options. next: letters whose value is the rest of the cluster or the next word; attached:
// letters whose value is the rest of the cluster only; digits: letters whose value is the digits after them (perl -l,
// -0: `-lne` is -l, -n, -e); inPlace: -i (with any suffix after it) and --in-place edit in
// place; long: long options with a value (--name=v or --name v) by the letter they stand for.
const OPTIONS = {
  sed: { next: 'efl', inPlace: true, long: { expression: 'e', file: 'f', 'line-length': 'l' } },
  perl: { next: 'eE', attached: 'MmIxCdD', digits: 'l0', inPlace: true, long: {} },
  tee: { next: '', long: {} },
  truncate: { next: 'sr', long: { size: 's', reference: 'r' } },
  cp: { next: 'tS', long: { 'target-directory': 't', suffix: 'S' } },
  mv: { next: 'tS', long: { 'target-directory': 't', suffix: 'S' } },
  install: { next: 'tSmog', long: { 'target-directory': 't', suffix: 'S', mode: 'm', owner: 'o', group: 'g' } },
  rsync: { next: 'eTf', long: { rsh: 'e', 'temp-dir': 'T', filter: 'f', exclude: 'x', include: 'x' } },
};
// { files: the words that are not options or option values, values: letter -> [values], inPlace, script: -e/-E/-f given }
function options(args, spec) {
  const files = [];
  const values = {};
  const put = (k, v) => { (values[k] ??= []).push(v ?? ''); };
  let inPlace = false;
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (ended || a === '-' || !a.startsWith('-')) { if (a !== '') files.push(a); continue; } // '': BSD sed's `-i ''`
    if (a === '--') { ended = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq < 0 ? undefined : eq);
      if (spec.inPlace && name === 'in-place') inPlace = true;
      else if (spec.long[name]) put(spec.long[name], eq < 0 ? args[++i] : a.slice(eq + 1));
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (spec.inPlace && c === 'i') { inPlace = true; break; } // the rest is the backup suffix
      if (spec.next.includes(c)) { put(c, a.slice(j + 1) || args[++i]); break; }
      if (spec.attached?.includes(c)) { put(c, a.slice(j + 1)); break; }
      if (spec.digits?.includes(c)) { const d = a.slice(j + 1).match(/^[0-7]*/u)[0]; put(c, d); j += d.length; }
    }
  }
  return { files, values, inPlace, script: Boolean(values.e || values.E || values.f) };
}

const words = (segment) => segment.match(/'[^']*'|"(?:\\.|[^"\\])*"|[^\s]+/gu) ?? [];
// Where `cd target` moves from `from`: null when that cannot be known (a variable: `cd $D`, `cd "$(dirname x)"`), and
// relative paths after it are then not named at all rather than named under the wrong folder (2026-11-08: `cd $D`
// made the hook show `$D/a.test.js`).
const moveTo = (from, target) => {
  const t = unquote(target);
  if (/[$`]/u.test(t)) return null;
  if (t === '~' || t.startsWith('~/')) return join(homedir(), t.slice(1));
  if (isAbsolute(t)) return t;
  return from == null ? null : resolve(from, t);
};

// Quoted text blanked to spaces, same length, so positions found in it hold in the original.
const blank = (s) => s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/gu, (q) => ' '.repeat(q.length));
// Command segments split at && || ; | and newlines outside quotes: node -e "a; fs.writeFileSync(...)" is one segment
// (split inside the quotes, the write call never reached its -e argument, 2026-11-08).
const segments = (shell) => {
  const out = [];
  let at = 0;
  // No \s* before the separator: a blanked quote is all spaces and would be taken with it.
  for (const m of blank(shell).matchAll(/&&|\|\||;|\||\n/gu)) { out.push(shell.slice(at, m.index).trim()); at = m.index + m[0].length; }
  out.push(shell.slice(at).trim());
  return out;
};

export function bashWrites(command, cwd = process.cwd()) {
  const found = new Set();
  let base = cwd;
  const here = (w) => { try { return isAbsolute(w) ? existsSync(w) : base != null && existsSync(resolve(base, w)); } catch { return false; } };
  // A glob with one * in its last part (dir/*.yml), relative to where the command runs; anything wider is not expanded.
  const glob = (pattern) => {
    const dir = dirname(pattern);
    if (base == null || dir.includes('*') || (pattern.split('*').length - 1) !== 1) return [];
    const [pre, post] = pattern.slice(dir === '.' ? 0 : dir.length + 1).split('*');
    try { return readdirSync(resolve(base, dir)).filter((f) => f.startsWith(pre) && f.endsWith(post)).map((f) => (dir === '.' ? f : join(dir, f))); } catch { return []; }
  };
  const add = (w) => {
    const p = unquote(String(w)).replace(/^file:\/\//u, '');
    if (!p || p.startsWith('-') || p.startsWith('/dev/') || /^[a-z]+:\/\//u.test(p) || p.includes('$')) return;
    if (isAbsolute(p)) found.add(p);
    else if (base != null) found.add(resolve(base, p));
  };
  // Where relative paths start after the `cd`s in some shell text (here-documents already taken out of it).
  const cdIn = (text) => {
    let b = cwd;
    for (const s of segments(text)) { const ws = words(s); if (unquote(ws[0] ?? '').split('/').pop() === 'cd' && ws[1]) b = moveTo(b, ws[1]); }
    return b;
  };
  // Here-documents: their body is code (its write calls name their targets) or data (only the redirect counts).
  // Their paths start where the commands before them moved to: `cd repo && python3 - <<E` writes in repo (2026-11-08:
  // the hook showed another repository's notes for a relative path after a cd).
  let kept = ''; // the shell text up to this here-document, earlier bodies taken out
  let last = 0;
  const shell = String(command ?? '').replace(/([^\n]*?)<<-?\s*['"]?(\w+)['"]?([^\n]*)\n([\s\S]*?)\n\s*\2(?=\s|$)/gu, (all, head, tag, rest, body, offset, text) => {
    kept += `${text.slice(last, offset)}${head}`;
    last = offset + all.length;
    base = cdIn(kept);
    kept += ` ${rest}`;
    // Only the command the here-document feeds: in `node x.mjs; cat > f <<E` it goes to cat (2026-11-08).
    const hw = words(segments(head).at(-1)).map(unquote);
    const at = hw.findIndex((w) => RUNNER.test(w.split('/').pop()));
    // The script's arguments: words after the runner that are not options, the script itself ('-') or a redirect.
    const args = at < 0 ? [] : hw.slice(at + 1).filter((w) => w !== '-' && !w.startsWith('-') && !/^[<>|&]/u.test(w));
    if (at >= 0 && CODE_WRITES.test(body)) codeTargets(body, { args, exists: here, glob }).forEach(add);
    return `${head} ${rest}`;
  });
  base = cwd; // the segments below follow the cds again themselves
  for (const segment of segments(shell)) {
    const ws = words(segment);
    if (!ws.length) continue;
    const cmd = unquote(ws[0]).split('/').pop();
    if (cmd === 'cd' && ws[1]) { base = moveTo(base, ws[1]); continue; }
    // Redirects anywhere in the segment, not 2> or >&, and not a > inside quotes (an arrow `=>` in node -e "..." code
    // is not a redirect): quoted text is blanked to find them, the target is read from the segment itself.
    for (const m of blank(segment).matchAll(/(?<![0-9&=-])>>?(?!\s*&)/gu)) {
      const t = segment.slice(m.index + m[0].length).match(/^\s*('[^']+'|"[^"]+"|[^\s;&|]+)/u);
      if (t) add(t[1]);
    }
    const args = withoutRedirects(ws.slice(1)).map(unquote);
    const files = args.filter((w) => !w.startsWith('-'));
    const o = OPTIONS[cmd] ? options(args, OPTIONS[cmd]) : null;
    // sed and perl write only in place; the script is the first file argument unless -e/-f gave it.
    if ((cmd === 'sed' || cmd === 'perl') && o.inPlace) (o.script ? o.files : o.files.slice(1)).forEach(add);
    else if (cmd === 'tee' || cmd === 'truncate') o.files.forEach(add);
    else if (cmd === 'patch') files.forEach(add);
    else if (['cp', 'mv', 'install'].includes(cmd) && o.values.t) add(o.values.t.at(-1));
    else if (['cp', 'mv', 'install', 'rsync'].includes(cmd) && o.files.length >= 2) add(o.files.at(-1));
    else if (cmd === 'git' && /^(?:checkout|restore)$/u.test(args[0] ?? '')) args.slice(args.indexOf('--') + 1 || 1).filter((w) => !w.startsWith('-') && w.includes('.')).forEach(add);
    else if (RUNNER.test(cmd) && args.some((w) => w === '-c' || w === '-e') && CODE_WRITES.test(segment)) {
      const i = args.findIndex((w) => w === '-c' || w === '-e');
      codeTargets(args[i + 1] ?? '', { args: args.slice(i + 2).filter((w) => !w.startsWith('-')), exists: here, glob }).forEach(add);
    }
  }
  return [...found];
}
