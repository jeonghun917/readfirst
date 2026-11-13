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
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const CODE_WRITES = /\bopen\([^)]*,\s*['"][wax]|\.write_text\(|\.write_bytes\(|writeFileSync\(|writeFile\(|appendFileSync\(|\.writelines?\(|createWriteStream\(|File\.write|>>?\s*\$|\bdump\(/u;
const PATHISH = /(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,6}\b/gu;
const RUNNER = /^(?:python3?|node|ruby|perl|bash|sh|zsh|deno|bun)$/u;
const SHELLS = /^(?:bash|sh|zsh|dash|ksh)$/u;

// A word as the shell hands it to the command: quotes taken off, backslash escapes undone (`a\&b.js` is a&b.js; the
// backslash was kept until 2026-11-13) and $NAME / ${NAME} replaced by the value the command itself gave the variable
// (`vars`: name -> { value, exported }, or { value: null, why } when it set it to something not known here). What
// cannot be known before the command runs (a variable from outside it, a $( ) or `...`, ${NAME:-x}, $1) is kept in the
// text between two \0 characters and listed in `unknown` with why, so a path holding it is never named as a file.
const HOLE = '\0';
export function shellWord(word, vars = new Map()) {
  const s = String(word);
  const unknown = [];
  // text: what stands in the word; part: what is not known (for a variable set from something not known, that
  // something: `S=$(mktemp -d)` makes $S's part `$(mktemp -d)`); under: for a path mktemp makes, the folder it is made
  // in (a new name there, so nothing below it yet); values: for a loop over a literal list (`for r in a b`), the
  // values it takes, one per turn.
  const hole = (text, why, part = text, under, values) => { unknown.push({ text, part, why, ...(under !== undefined ? { under } : {}), ...(values ? { values } : {}) }); return `${HOLE}${text}${HOLE}`; };
  // The expansion that starts with the $ at i: [its text, the index past it]. quoted: inside "...", where $' and $" are
  // a plain $ (the `"` after it closes the quote: `"a$"` is a$; it was read as $"..." and the $ dropped, 2026-11-13).
  const dollar = (i, quoted = false) => {
    // $(( )) is arithmetic, worked out when it runs.
    if (s.startsWith('$((', i)) {
      let depth = 0;
      let e = s.length;
      for (let k = i + 1; k < s.length; k++) { if (s[k] === '(') depth++; else if (s[k] === ')' && --depth === 0) { e = k + 1; break; } }
      return [hole(s.slice(i, e), 'it is arithmetic, worked out when it runs'), e];
    }
    if (s[i + 1] === '(') {
      const end = closeOf(s, i);
      const e = end < 0 ? s.length : end;
      const under = end < 0 ? undefined : mktempUnder(s.slice(i + 2, e - 1), vars);
      // One the command was split inside (at a | or ; in it) is shown with … for the rest.
      const part = end < 0 ? `${s.slice(i, e).trimEnd()} …)` : s.slice(i, e);
      return [hole(s.slice(i, e), under === undefined ? 'it is the output of a command, known only when it runs' : 'a new name mktemp makes when it runs', part, under ?? undefined), e];
    }
    // $'...' (escapes worked out by the shell) is not read here; $"..." is "..." translated, read as "...".
    if (!quoted && s[i + 1] === "'") { let k = i + 2; while (k < s.length && s[k] !== "'") k += s[k] === '\\' ? 2 : 1; const e = Math.min(k + 1, s.length); return [hole(s.slice(i, e), "a $'...' string is not worked out here"), e]; }
    if (!quoted && s[i + 1] === '"') return ['', i + 1];
    const m = s.slice(i).match(/^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/u);
    if (m) {
      const name = m[1] ?? m[2];
      const v = vars.get(name);
      if (v && v.value != null) return [v.value, i + m[0].length];
      return [hole(m[0], v ? v.why : `${name} is not set by the command`, v?.part ?? m[0], v?.under, v?.values), i + m[0].length];
    }
    if (s[i + 1] === '{') { const k = s.indexOf('}', i); const e = k < 0 ? s.length : k + 1; return [hole(s.slice(i, e), 'a ${ } with an operator is not worked out here'), e]; }
    if (/[0-9@*#?$!-]/u.test(s[i + 1] ?? '')) return [hole(s.slice(i, i + 2), 'it is set by whoever runs the command'), i + 2];
    return ['$', i + 1];
  };
  const tick = (i) => { const k = s.indexOf('`', i + 1); const e = k < 0 ? s.length : k + 1; return [hole(s.slice(i, e), 'it is the output of a command, known only when it runs', k < 0 ? `${s.slice(i, e).trimEnd()} …\`` : s.slice(i, e)), e]; };
  let text = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "'") {
      const k = s.indexOf("'", i + 1);
      if (k < 0) { text += c; i++; continue; } // a quote that never closes is a plain character
      text += s.slice(i + 1, k);
      i = k + 1;
    } else if (c === '"') {
      const end = closeOf(s, i);
      if (end < 0) { text += c; i++; continue; }
      // Inside "...", a backslash escapes only $ ` " \ and a newline; $ and ` still expand.
      for (let j = i + 1; j < end - 1;) {
        if (s[j] === '\\' && /[$`"\\\n]/u.test(s[j + 1] ?? '')) { text += s[j + 1]; j += 2; } else if (s[j] === '$') { const [t, n] = dollar(j, true); text += t; j = n; } else if (s[j] === '`') { const [t, n] = tick(j); text += t; j = n; } else { text += s[j]; j++; }
      }
      i = end;
    } else if (c === '\\') { text += s[i + 1] ?? ''; i += 2; } else if (c === '$') { const [t, n] = dollar(i); text += t; i = n; } else if (c === '`') { const [t, n] = tick(i); text += t; i = n; } else { text += c; i++; }
  }
  return { text, unknown };
}
// The text of a word with no variables known: for command names and options.
const unquote = (w) => shellWord(w).text;

// The folder `mktemp` makes its new file or folder in, for the text of a $( ) that runs it, or undefined when the $( )
// runs something else; null when that folder is not known either. -p DIR and --tmpdir=DIR: DIR; -t, a bare --tmpdir,
// or no template: $TMPDIR, else the system's temporary folder; a template with a / in it: its folder; a template
// without one: where the command is ('.').
function mktempUnder(inner, vars) {
  const ws = words(inner.trim());
  if (unquote(ws[0] ?? '').split('/').pop() !== 'mktemp') return undefined;
  const value = (w) => { const r = shellWord(w, vars); return r.unknown.length ? null : r.text; };
  const tmp = () => vars.get('TMPDIR')?.value || tmpdir();
  let dir;
  let template;
  for (let k = 1; k < ws.length; k++) {
    const w = ws[k];
    if (w === '--tmpdir') dir = tmp();
    else if (w.startsWith('--tmpdir=')) dir = value(w.slice(9));
    else if (/^-[a-zA-Z]*p$/u.test(w)) dir = value(ws[++k] ?? '');
    else if (/^-[a-zA-Z]*t[a-zA-Z]*$/u.test(w)) dir ??= tmp();
    else if (!w.startsWith('-')) template = value(w);
  }
  if (dir !== undefined) return dir;
  if (template === undefined) return tmp();
  if (template === null) return null;
  return template.includes('/') ? dirname(template) : '.';
}

// Words that only set up the command after them: `FOO=1 sed -i ...`, `sudo tee f`, `env -i X=1 cp a b`,
// `timeout 10 sed -i ...`, `nohup cp ...`. The command is the first word past them; each wrapper's options that take a
// value are listed so the value is not read as the command (2026-11-09: every one of these hid its write).
const WRAPPERS = new Map([
  ['sudo', /^(?:-[ugpCDhRrT]|--(?:user|group|prompt|chdir|close-from|host|role|type))$/u],
  ['env', /^(?:-[uCS]|--(?:unset|chdir|split-string))$/u],
  ['nice', /^(?:-n|--adjustment)$/u],
  ['timeout', /^(?:-[sk]|--(?:signal|kill-after))$/u],
  ['ionice', /^-[cnp]$/u],
  ['exec', /^-a$/u],
  ['time', null], ['nohup', null], ['command', null], ['stdbuf', null], ['chronic', null],
]);
// A subshell or group opens with `(` or `{`: `(cd d && ...)` runs cd. The words that open a loop's or an if's body
// (`do`, `then`, `else`, ...) come before the command too: `for f in x; do sed -i ... f; done` runs sed (its write
// was not seen until 2026-11-13).
const KEYWORDS = /^(?:do|then|else|elif|if|while|until|!)$/u;
// A ( or { after such a word opens a subshell or group too: `do (cd h && ...)` runs cd (it ran nothing known until
// 2026-11-13, so ../s.txt after it was named from the folder before the cd).
function opening(ws) {
  let out = ws;
  for (;;) {
    if (!out.length) return out;
    const first = out[0].replace(/^[({]+/u, '');
    out = first ? [first, ...out.slice(1)] : out.slice(1);
    if (!out.length || !KEYWORDS.test(out[0])) return out;
    out = out.slice(1);
  }
}
// The files patch writes: the positional file after its options; -p/-i/-d/-o and the rest take a value.
function patchFiles(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (/^-[pidoDrBFVYz]$/u.test(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) out.push(args[i]);
  }
  // cut: not a list: patch writes its first positional argument; a second one is the patch it reads
  return out.slice(0, 1);
}
function unwrap(ws) {
  let i = 0;
  for (;;) {
    while (i < ws.length && /^[A-Za-z_]\w*=/u.test(ws[i])) i++;
    const name = unquote(ws[i] ?? '').split('/').pop();
    if (!WRAPPERS.has(name)) return ws.slice(i);
    const value = WRAPPERS.get(name);
    i++;
    while (i < ws.length && ws[i].startsWith('-') && ws[i] !== '--') { if (value?.test(ws[i])) i++; i++; }
    if (ws[i] === '--') i++;
    if (name === 'timeout' && i < ws.length) i++; // the duration
  }
}

// The working-tree files `git checkout` / `git restore` overwrite. After `--` every word is a path. `restore` takes
// paths only; `checkout` without `--` takes a branch, tag or commit too, so there a word counts only when it is a file
// here (`git checkout release-0.26` or `-B name.x` read as a write, 2026-11-09). `restore --staged` without
// --worktree changes only the index.
const GIT_VALUE = /^(?:-[bBs]|--orphan|--source|--conflict|--pathspec-from-file)$/u;
function gitPaths(args, exists) {
  const [sub, ...rest] = args;
  const flag = (long, short) => rest.some((w) => w === long || (/^-[a-zA-Z]+$/u.test(w) && w.includes(short)));
  if (sub === 'restore' && flag('--staged', 'S') && !flag('--worktree', 'W')) return [];
  const dd = rest.indexOf('--');
  if (dd >= 0) return rest.slice(dd + 1);
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (GIT_VALUE.test(rest[i])) { i++; continue; }
    if (rest[i].startsWith('-')) continue;
    if (sub === 'restore' || exists(rest[i])) out.push(rest[i]);
  }
  return out;
}

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

// A word runs on through quotes, a $( ) (one level of parentheses inside it) and backticks: `sed -i ... $(grep -rl x src
// docs)` was split inside the $( ), and its src and `docs)` were named as the files sed writes (2026-11-10). Such a word
// holds a $ or a backtick, so add() leaves it out: what it expands to is not known here.
// A backslash keeps the next character in the word: `my\ file.txt` is one word (it was two until 2026-11-13).
// A $( ), backtick or "..." the segment ends inside (the command was split at a | ; or && inside it:
// `S=$(echo b | tr b c)`) runs to the segment's end as one word, so `S=$(echo b` is still read as an assignment, of a
// value not known; until 2026-11-13 it was not, and S kept its old value.
const words = (segment) => segment.match(/(?:\\.|'[^']*'|"(?:\\.|[^"\\])*"|\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$\((?:[^()]|\([^()]*\))*$|`[^`]*$|"(?:\\.|[^"\\])*$|[^\s'"`\\])+/gu) ?? [];
// Where `cd target` moves from `from`: null when that cannot be known (a variable: `cd $D`, `cd "$(dirname x)"`), and
// relative paths after it are then not named at all rather than named under the wrong folder (2026-11-08: `cd $D`
// made the hook show `$D/a.test.js`).
// The folder after a cd-like word: pushd works as cd; `cd -`, a bare `cd`, `popd` and `pushd` with no folder leave
// it unknown (null), so relative paths after them are not named rather than named in the wrong folder.
const CD = /^(?:cd|pushd|popd)$/u;
const stepTo = (from, cmd, arg) => (cmd === 'popd' || !arg || arg === '-' || arg.startsWith('+') || arg.startsWith('-') ? null : moveTo(from, arg));
// target: the word as shellWord gives it; one holding something not known (between \0s) goes nowhere known.
const moveTo = (from, t) => {
  if (t.includes(HOLE)) return null;
  if (t === '~' || t.startsWith('~/')) return join(homedir(), t.slice(1));
  if (isAbsolute(t)) return t;
  return from == null ? null : resolve(from, t);
};

// Where the quoted text or $( ) that opens at i ends (the index past its last character), or -1 when it never closes.
// Quotes open again inside $( ), as the shell reads them; inside "..." a ' is a plain character.
function closeOf(s, i) {
  if (s[i] === "'") { const k = s.indexOf("'", i + 1); return k < 0 ? -1 : k + 1; }
  const sub = s[i] === '$';
  for (let j = i + (sub ? 2 : 1); j < s.length;) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (!sub && c === '"') return j + 1;
    if (sub && c === ')') return j + 1;
    if ((c === '$' && s[j + 1] === '(') || (sub && (c === '"' || c === "'"))) {
      const k = closeOf(s, j);
      if (k < 0) return -1;
      j = k;
      continue;
    }
    j++;
  }
  return -1;
}

// Quoted text blanked to spaces, same length, so positions found in it hold in the original. A $( ) inside "..." stays
// visible: it holds commands, and its own quotes are blanked in turn. A regex took `"$(python3 -c "` for one quoted string
// and the code after it for commands, so `i>=0` was a write to the file `=0` (2026-11-09). A quote that never closes is
// read as a plain character, as before.
function blank(s) {
  const out = s.split('');
  const hide = (from, to) => { for (let k = from; k < to; k++) out[k] = ' '; };
  const walk = (from, to) => {
    for (let i = from; i < to;) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c !== "'" && c !== '"') { i++; continue; }
      const end = closeOf(s, i);
      if (end < 0 || end > to) { i++; continue; }
      if (c === "'") hide(i, end);
      else {
        // "...": hidden, except the commands of each $( ) in it.
        let shown = i;
        for (let j = i + 1; j < end - 1;) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] !== '$' || s[j + 1] !== '(') { j++; continue; }
          const close = closeOf(s, j);
          if (close < 0 || close > end) break;
          hide(shown, j + 2);
          walk(j + 2, close - 1);
          shown = close - 1;
          j = close;
        }
        hide(shown, end);
      }
      i = end;
    }
  };
  walk(0, s.length);
  return out.join('');
}
// Command segments split at && || ; | and newlines outside quotes: node -e "a; fs.writeFileSync(...)" is one segment
// (split inside the quotes, the write call never reached its -e argument, 2026-11-08).
// An unquoted `#` at the start of a word begins a comment to the end of the line: `cp a b # c d` copies to b.
function withoutComments(text) {
  const b = blank(text);
  let out = '';
  let at = 0;
  for (const m of b.matchAll(/(?<=^|[ \t;])#[^\n]*/gmu)) { out += text.slice(at, m.index); at = m.index + m[0].length; }
  return out + text.slice(at);
}
// How a command segment opens and closes subshells, given how many are open before it: `lead` ( at its start, `body`
// the segment up to the first ) that closes one opened earlier, `closes` how many it closes, `tail` what follows the
// last of them (a redirect of the subshell's output), `opened` the ( left open at its end (`x=$(cd d` continues in the
// next segment). A ) with nothing open is not counted (a case pattern `a)`), and a pair that opens and closes inside
// the segment ($( ), (( ))) changes nothing.
function parens(segment, open) {
  const b = blank(segment);
  // The ( of a subshell opens after the words that open a loop's or an if's body too: `do (cd h && ...)`, after the
  // words that open its condition (`if (cd /a; ...); then`: its cd was taken past the `)`, and after `until` or `elif`
  // the `)` stuck to the folder, `/a)/g`), and after `time` (`time (cd /a; ...)` lost its cd inside it), until 2026-11-13.
  // Those words may stand inside such a ( too: `time (time (cd /a; ...))` opens two (the inner one was taken for a
  // ( that opens and closes inside the segment, so its cd was not followed, until 2026-11-13).
  let i = 0;
  let lead = 0;
  for (;;) {
    i += b.slice(i).match(/^\s*(?:(?:do|then|else|elif|if|while|until|!|time(?:\s+-p)?)\s+)*/u)[0].length;
    // (( )) is arithmetic, not two subshells, after those words too: `if ((x)); then cd /a; fi` was read as two
    // subshells whose ) put back the state from before the if, so the if and its cd were taken as sure (2026-11-13).
    if (b.startsWith('((', i)) { if (!lead) return { lead: 0, body: segment, closes: 0, tail: '', opened: 0 }; break; }
    if (b[i] !== '(') break;
    lead++;
    i++;
  }
  let depth = open + lead;
  let local = 0;
  let end = -1;
  let tailAt = segment.length;
  let closes = 0;
  for (let k = i; k < b.length; k++) {
    if (b[k] === '(') local++;
    else if (b[k] === ')') {
      if (local > 0) local--;
      else if (depth > 0) { depth--; closes++; if (end < 0) end = k; tailAt = k + 1; }
    }
  }
  return { lead, body: end < 0 ? segment : segment.slice(0, end), closes, tail: end < 0 ? '' : segment.slice(tailAt), opened: local };
}
// Each command of some shell text with the operator after it ('' after the last): `|` and `|&` mean its output goes
// to the next command, not to whoever ran it, and `&` that the command runs in the background.
const segmentsAndOps = (shell) => {
  const out = [];
  let at = 0;
  // No \s* before the separator: a blanked quote is all spaces and would be taken with it.
  // `>|` is a redirect, not a pipe; `|&` pipes stderr too and is one operator (2026-11-09).
  // A single & ends a command too (`cmd & sed -i x f` once read sed as cmd's arguments, so its write was not seen,
  // 2026-11-13); the & of &&, >&2, 2>&1, &>, <& and an escaped \& does not.
  for (const m of blank(shell).matchAll(/&&|\|\||;|(?<!>)\|&?|(?<![>&<\\])&(?![&>])|\n/gu)) { out.push({ text: shell.slice(at, m.index).trim(), op: m[0] }); at = m.index + m[0].length; }
  out.push({ text: shell.slice(at).trim(), op: '' });
  return out;
};
const segments = (shell) => segmentsAndOps(shell).map((s) => s.text);

// What a command does to the shell for the commands after it (state: { base, why, vars }): cd, pushd and popd move
// where relative paths start (base; null when that is not known, with `why`: { part, why }); NAME=value words alone set
// variables, in order (`A=/a B=$A/b`), and so do export, declare, typeset, local and readonly; a for-loop's variable,
// read's names and an unset variable have no value known here. NAME=value before a command is that command's alone and
// sets nothing after it. Returns true when the command did only that.
// Until 2026-11-13 variables had no value: after `S=/a; cd $S` relative writes were not named at all, and a write to
// `$F` was dropped, both without a word (every write into a worktree in readfirst's own sessions went that way).
// A value is believed only where the command surely sets it (review of #181, 2026-11-13: each of these left the old
// value named as if sure): a pipeline's stage runs in a subshell and sets nothing after it (`pipe`); an assignment after
// `||` or in a case arm (`maybe`) may not run, so a value it changes is not known; `+=` appends; eval, source and `.`
// may change any variable, and so may calling a function the command defines; printf -v, mapfile, readarray, getopts,
// let and (( )) set the names they are given to values not known here. A value over 4096 characters is not followed.
// Inside an if or a loop a value holds for the commands after it there (`if x; then S=/a; echo > $S/f`; until the
// second review of 2026-11-13 every block made it unknown); what the block changed is not known after it (`blocks`,
// howItRuns), and neither is what an && / || list changed after the command that may fail (`chain`, eachCommand:
// `test -d /a && cd /a; echo > f` was named /a/f). In a loop, a cd to a relative folder and `S=$S/x` are not
// known: each turn starts where the last ended. A loop over a literal list (`for r in a b`) gives its variable those
// values (`values`): a write through it is a write to each.
const ASSIGN = /^([A-Za-z_]\w*)(\+?)=/u;
const DECLARE = /^(?:export|declare|typeset|local|readonly)$/u;
const NAME = /^[A-Za-z_]\w*$/u;
const OPENS = /^(?:if|while|until|for|case|select)$/u;
const CLOSES = /^(?:fi|done|esac)$/u;
const LOOPS = /^(?:while|until|for|select)$/u;
// Whether the command runs in a loop's body, where each turn starts where the last one ended: not inside a ( ) opened
// in the loop, which starts each turn from the same place.
const turning = (state) => Boolean(state.blocks?.some((b) => LOOPS.test(b.kind) && (state.paren ?? 0) <= b.paren));
const copyVars = (vars) => new Map([...vars].map(([k, v]) => [k, { ...v }]));
const snapshot = (state) => ({ base: state.base, why: state.why, vars: copyVars(state.vars), fns: new Set(state.fns ?? []), fnInfo: new Map(state.fnInfo ?? []), fnBody: state.fnBody, fnDepth: state.fnDepth ?? 0, blocks: (state.blocks ?? []).map((b) => ({ ...b, changed: new Set(b.changed) })), chain: state.chain ?? null, dirs: [...(state.dirs ?? [])], cdText: state.cdText });
// Makes what changed since `from` (the state before a part of the command that may not run) not known: each variable
// whose value differs, or whose name is in `changed` (changed by an earlier branch), and the folder when it moved.
function unsure(state, from, why, changed = new Set(), moved = false) {
  for (const [k, v] of state.vars) {
    const o = from.vars.get(k);
    const same = o && o.value === v.value && (o.value != null || o.why === v.why);
    if (same && !changed.has(k)) continue;
    state.vars.set(k, { value: null, why: `${k} ${why}`, part: `$${k}`, exported: Boolean(v.exported) });
  }
  if (moved || state.base !== from.base) {
    state.base = null;
    state.why = { part: state.cdText ?? 'cd', why: `the folder ${why}`, prefix: '' };
  }
}
// Another branch of a block starts (`else`, `elif`, a case arm): it runs instead of the branch before it, so it starts
// from what was there before the block, and what that branch changed is kept in `changed` for the block's end.
// fall: the arm before ended with `;&` or `;;&`, so this one may also run after it: it starts from either, and what
// differs between the two is not known (until 2026-11-13 it started from before the case alone).
function branchAgain(state, top, fall = false) {
  for (const [k, v] of state.vars) { const o = top.at.vars.get(k); if (!o || o.value !== v.value || o.why !== v.why) top.changed.add(k); }
  top.moved ||= state.base !== top.at.base;
  if (fall) unsure(state, top.at, 'is set only on some paths through the command (inside case)');
  else Object.assign(state, { base: top.at.base, why: top.at.why, vars: copyVars(top.at.vars) });
}
// The head of a case (`case W in`) at the start of some shell text, and the words before it that open other things
// (`{`, `(`, `if`, `while`, `do`, `time` ...: `if case $v in a) cd /a;; esac; then`), as segments for eachCommand
// to read in turn (the words before, if any; the head; the rest, with the segment's operator `op`), or null. Until
// 2026-11-13 a head after `{`, `if` or a wrapper, or a nested one after an arm's pattern (`a) case $y in b) cd /b`), was
// not split off, so its arms were read as plain commands.
function caseHead(text, op) {
  const h = blank(text).match(/^(\s*(?:[({]\s*|(?:do|then|else|elif|if|while|until|!|time|command|builtin|sudo|nohup)\s+)*)(case\s[^]*?\sin)(?=\s+\S)/u);
  if (!h) return null;
  const head = [{ text: text.slice(h[1].length, h[0].length), op: ';' }, { text: text.slice(h[0].length), op }];
  return h[1].trim() ? [{ text: text.slice(0, h[1].length), op: '' }, ...head] : head;
}
// Whether calling a function the command defines may move where relative paths start: its body runs a cd-like command
// (cd, pushd, popd, source, `.`, eval, exec, builtin, command), a command named by a variable, or a function that
// may; or it was defined twice, or is not known. Until 2026-11-13 every call made the folder not known, though most
// functions only run commands (`run() { npm test; }; run; echo > log`).
const CD_LIKE = /^(?:cd|pushd|popd|source|\.|eval|exec|builtin|command)$/u;
function mayCd(state, name, seen = new Set()) {
  const info = state.fnInfo?.get(name);
  if (!info || info.cd) return true;
  seen.add(name);
  // A command named by a variable (`"$@"`, `$cmd`) is kept with its unknown part between \0s (shellWord): it may be cd.
  return [...info.cmds].some((c) => CD_LIKE.test(c) || c.startsWith('$') || c.includes(HOLE) || (state.fns?.has(c) && !seen.has(c) && mayCd(state, c, seen)));
}
// A function definition at the start of some words (`f()`, `f ()`, `f ( )`, `f(){`, `function f`, `function f ()`):
// its name and the words after the `()`, or null. Until 2026-11-13 `f ( )` was not one: `f ( ) { cd /a; }; f` was
// read as a call of f and a group that runs where it is written.
function definition(ws) {
  const named = ws[0] === 'function' ? 1 : 0;
  const m = (ws[named] ?? '').match(/^([A-Za-z_][\w-]*)(.*)$/su);
  if (!m) return null;
  let tail = m[2];
  let j = named + 1;
  while (tail.length < 2 && j < ws.length) {
    const joined = tail + ws[j];
    if (!'()'.startsWith(joined) && !joined.startsWith('()')) break;
    tail = joined;
    j++;
  }
  if (!tail.startsWith('()') && !(named && !tail)) return null;
  return { name: m[1], rest: [tail.slice(2), ...ws.slice(j)].filter(Boolean) };
}
// How much some words open { } groups (`depth`: each { less each }), and whether their first word is a `{` (`opens`).
// `{` and `}` are words of the shell's syntax only where a command could start: first, after `(`, `do`, `then`, `!`,
// `time`, a function's `()`, a `)` that closes, or the end of a block (`fi }`); anywhere else they are arguments.
// Until 2026-11-13 every word that began with } or ended with { was counted: `echo {` in a function's body made it
// one deeper, so the { } group after the function was taken for its body and its cd was not followed.
function braces(ws) {
  const q = [...ws];
  let depth = 0;
  let at = true;
  const opens = q[0] === '{';
  while (q.length) {
    let w = q.shift();
    if (at) {
      w = w.replace(/^\(+/u, '');
      if (!w) continue;
      if (w === '{') { depth++; continue; }
      if (/^\}(?:$|[)<>])/u.test(w)) { depth--; at = /^\}\)*$/u.test(w); continue; }
      if (KEYWORDS.test(w) || CLOSES.test(w)) continue;
      if (w === 'time') { while (q[0] === '-p') q.shift(); continue; }
      const def = definition([w, ...q]);
      if (def) { q.splice(0, q.length, ...def.rest); continue; }
    }
    // After a word that closes more ( than it opens (`/a)`), a command may start; after any other word an argument.
    const b = blank(w);
    at = (b.match(/\)/gu) ?? []).length > (b.match(/\(/gu) ?? []).length;
  }
  return { depth, opens };
}
// How a segment runs, from its words before opening() and the operators around it: { pipe, maybe }. It also keeps the
// blocks the segment opens and closes (state.blocks: what was there before each, to make what it changed not known
// at its end; `else`, `elif` and each case arm start again from before the block).
// The word that opens a block may follow `do`, `then`, `!` or a wrapper (`time for ...`, `do for ...`): until
// 2026-11-13 only the first word was looked at, so `time for f in $L; do S=/b; done` named $S as /b after the loop.
// An operator inside a $( ) or backticks (the shell text was split there: `S=$(echo b | tr b c)`) is not this
// command's: eachCommand passes '' for it.
function howItRuns(state, raw, before, after) {
  const pipe = /^\|&?$/u.test(before ?? '') || /^\|&?$/u.test(after ?? '');
  // A body whose { stands on the line after the name (`f()` then `{`) is the function's: follow reads the rest of it
  // as the body (it was read as a { } group that runs where it is written, so its cd moved the folder with no call,
  // until 2026-11-13). Here, where the { is still on the words. A blank or comment line between them is no command and
  // leaves it waiting (it took the wait away, so the body after `f ()`, a comment and `{` ran where it was written).
  // `body`: the segment is part of a function's body, which follow does not run. The depth is counted here, on the
  // words before opening() takes a leading { off them (`braces`).
  let body = (state.fnDepth ?? 0) > 0;
  const group = raw.length && (body || state.fnAwait) ? braces(raw) : null;
  if (state.fnAwait && raw.length) { state.fnAwait = false; body = group.opens; }
  if (body && group) state.fnDepth = Math.max(0, (state.fnDepth ?? 0) + group.depth);
  let ws = raw;
  for (;;) {
    const head = (ws[0] ?? '').replace(/^[({]+/u, '');
    ws = head ? [head, ...ws.slice(1)] : ws.slice(1);
    if (!/^(?:do|then|!)$/u.test(ws[0] ?? '')) break;
    ws = ws.slice(1);
  }
  const first = unwrap(ws)[0] ?? '';
  state.blocks ??= [];
  const top = state.blocks.at(-1);
  if (OPENS.test(first)) {
    // arm: a case waits for its next arm's pattern (each case its own: one nested in an arm has arms of its own).
    state.blocks.push({ kind: first, at: snapshot({ ...state, blocks: [] }), changed: new Set(), moved: false, paren: state.paren ?? 0, arm: first === 'case', fall: false });
  } else if (top?.kind === 'if' && /^(?:else|elif)$/u.test(first)) branchAgain(state, top);
  else if (top && CLOSES.test(first)) {
    state.blocks.pop();
    unsure(state, top.at, `is set only on some paths through the command (inside ${top.kind})`, top.changed, top.moved);
  }
  const maybe = before === '||';
  return { pipe, maybe, body };
}
// Each command of some shell text, with the subshells around it: visit(p, raw, how, op) gets parens()' view of the
// segment, its words, how it runs (howItRuns) and the operator after it; tail(text) gets what follows a `)` that closes
// a subshell. A ( ) restores the folder and variables of before it at its `)`. An operator inside a $( ) or backticks
// (still open on the stack of `outer`, or by an odd number of backticks) is not taken as a pipe, `||` or `;` of the
// command around it: `S=$(echo b | tr b c)` is an assignment, not a pipeline stage.
// A command after && or || runs only if the one before it did or did not fail: what the list changed from there on
// (state.chain: the state before that command) is not known once the list ends at ; & or a newline.
const CHAINED = /^(?:&&|\|\||\|&?)$/u;
function eachCommand(shell, state, visit, tail = () => {}) {
  const outer = [];
  let before = '';
  let ticks = false;
  const inSub = (list) => list.some((o) => o.sub);
  // `case W in a) cd /a;;` is one segment up to the first `;`: its head `case W in` opens the block, and the rest is
  // the first arm. Until 2026-11-13 the arm was not read: `a)` stood where the command name should be, so a cd in an
  // arm was not followed and a write after `esac` was named in the folder from before it. The words before a head
  // (`{`, `if`, `time`: caseHead) are read on their own first, so each opens what it opens.
  const queue = segmentsAndOps(shell).flatMap((s) => caseHead(s.text, s.op) ?? [s]);
  while (queue.length) {
    const seg = queue.shift();
    const { op } = seg;
    let { text } = seg;
    // An arm starts after `case W in` and after each `;;` (which leaves an empty segment): its `pattern)` is taken off,
    // and it starts again from before the case, as `else` does; after `;&` or `;;&` (an empty segment before a single
    // &) it may also run after the arm before it. What follows a pattern may itself begin a case (`a) case $y in b)`).
    const top = state.blocks?.at(-1);
    if (top?.kind === 'case' && !text.trim()) { top.arm = true; if (op === '&') top.fall = true; continue; }
    if (top?.kind === 'case' && top.arm && !/^\s*esac\b/u.test(text)) {
      const pattern = blank(text).match(/^\s*\(?[^()]*\)/u);
      // A pattern with alternatives (`a|b)`) was split at its `|`: the part before it is pattern, not a command.
      if (!pattern && op === '|') continue;
      top.arm = false;
      if (pattern) {
        branchAgain(state, top, top.fall);
        top.fall = false;
        const nested = caseHead(text.slice(pattern[0].length), op);
        if (nested) { queue.unshift(...nested); continue; }
        text = text.slice(pattern[0].length);
      }
    }
    const p = parens(text, outer.length);
    const subBefore = ticks || inSub(outer);
    if ((blank(text).match(/(?<!\\)`/gu) ?? []).length % 2) ticks = !ticks;
    for (let k = 0; k < p.lead; k++) outer.push(snapshot(state));
    state.paren = outer.length;
    const subAfter = ticks || p.opened > 0 || inSub(outer.slice(0, outer.length - p.closes));
    const raw = words(p.body);
    // depth: the blocks open where the list starts; a block the list opens (`a && for r in x; do`) holds the list open
    // through the ; of its own syntax.
    if (!subBefore && (before === '&&' || before === '||') && !state.chain) state.chain = { ...snapshot({ ...state, blocks: [], chain: null }), depth: state.blocks?.length ?? 0 };
    visit(p, raw, howItRuns(state, raw, subBefore ? '' : before, subAfter ? '' : op), op);
    for (let k = 0; k < p.closes; k++) Object.assign(state, outer.pop());
    tail(p.tail);
    // Not at the end of the text: nothing follows there, and a here-document's walk (stateAt) ends at the command it
    // feeds, inside the list (`cd $S && python3 - <<E` lost its folder for a while on 2026-11-13).
    if (!subAfter && state.chain && op && !CHAINED.test(op) && (state.blocks?.length ?? 0) <= state.chain.depth) { const from = state.chain; state.chain = null; unsure(state, from, 'is set only on some paths through the command (after && or ||)'); }
    for (let k = 0; k < p.opened; k++) outer.push({ ...snapshot(state), sub: true });
    before = op;
  }
  return state;
}

function follow(state, ws, { pipe = false, maybe = false, body = false } = {}) {
  // A pipeline's stage runs in a subshell: what it sets or where it goes does not stay.
  if (pipe) return follow(snapshot(state), ws, { body });
  state.fns ??= new Set();
  state.fnInfo ??= new Map();
  // time, command and builtin run what follows in this shell: `command cd /a`, `builtin cd /a` and `time { cd /a; }`
  // move it (until 2026-11-13 they were not read as a cd). `command -v cd` only asks where cd is.
  // A { } group or a ( ) subshell after them: what is inside is the command (parens keeps the subshell's folder), and
  // it may begin with them again: `time (time (cd /a; ...))` (only the first was taken off until 2026-11-13).
  for (let wrapped = false; ;) {
    if (/^(?:time|command|builtin)$/u.test(unquote(ws[0] ?? ''))) {
      wrapped = true;
      ws = ws.slice(1);
      while (/^-p$/u.test(ws[0] ?? '')) ws = ws.slice(1);
      if (/^-[vV]$/u.test(ws[0] ?? '')) return false;
    } else if (wrapped && /^[{(]/u.test(ws[0] ?? '')) {
      const group = ws[0].replace(/^[{(]+/u, '');
      ws = group ? [group, ...ws.slice(1)] : ws.slice(1);
    } else break;
  }
  // An assignment has no command name: `E=/s/eval` is not `eval` (it lost every variable for a while on 2026-11-13).
  const cmd = ASSIGN.test(ws[0] ?? '') ? '' : unquote(ws[0] ?? '').split('/').pop();
  const lose = (name, why) => state.vars.set(name, { value: null, why, part: `$${name}`, exported: Boolean(state.vars.get(name)?.exported) });
  const loseAll = (why) => { for (const k of state.vars.keys()) lose(k, why); };
  // A function's { } body runs when it is called, not where it is written: skipped here, and the command each line of
  // it starts with is kept (state.fnBody), for mayCd at the call; a call makes every variable not known.
  // howItRuns counts how deep the body is (`body`: this segment is in it).
  const firstOf = (line) => unquote(unwrap(opening(line))[0] ?? '');
  if (body) {
    const first = firstOf(ws);
    if (first && !first.startsWith('}')) state.fnBody?.cmds.add(first);
    return true;
  }
  // `name ()` and `name ( )` with spaces are definitions as `name()` is (`definition`; until 2026-11-13 `name ()` was
  // read as a call of name, and `name ( )` until later that day).
  const def = definition(ws);
  if (def) {
    // A name defined twice is not known: which body runs depends on where the call is.
    state.fnBody = { cd: state.fns.has(def.name), cmds: new Set() };
    state.fnInfo.set(def.name, state.fnBody);
    state.fns.add(def.name);
    // The body's first command may be on the same line as the name: `f() { cd /z; }`, read as a line of the body is
    // (`f() { if cd /z; then` runs cd: until 2026-11-13 `if` was kept, so a call of f was taken not to cd). A ( ) body
    // is a subshell: its cd never moves the caller (`f() (cd /z)`).
    const first = (def.rest[0] ?? '').startsWith('{') ? firstOf(def.rest) : '';
    if (first && !first.startsWith('}')) state.fnBody.cmds.add(first);
    state.fnDepth = Math.max(0, braces(ws).depth);
    state.fnAwait = !def.rest.length; // the body has not begun on this line
    return true;
  }
  // The function's body may cd too (mayCd): then where relative paths start is not known after the call either (until
  // 2026-11-13 `f() { cd /z; }; f; echo x > g` named g in the folder from before the call).
  if (state.fns.has(cmd)) {
    loseAll(`${cmd}, a function this command defines, may change it`);
    if (state.base != null && mayCd(state, cmd)) { state.base = null; state.why = { part: cmd, why: `${cmd}, a function this command defines, may cd`, prefix: '' }; }
    return false;
  }
  // The file source and `.` read may cd, as may what eval runs.
  if (/^(?:eval|source|\.)$/u.test(cmd)) {
    loseAll(`${cmd} may change it`);
    if (state.base != null) { state.base = null; state.why = { part: [cmd, ...ws.slice(1, 2)].join(' '), why: `${cmd} may cd`, prefix: '' }; }
    return false;
  }
  if (cmd === 'printf') { const v = ws.indexOf('-v'); if (v > 0 && NAME.test(ws[v + 1] ?? '')) lose(ws[v + 1], `printf -v sets ${ws[v + 1]} when it runs`); return false; }
  if (cmd === 'mapfile' || cmd === 'readarray') {
    const names = withoutRedirects(ws.slice(1)).filter((w, k, all) => NAME.test(w) && !/^-[dnOsuCc]$/u.test(all[k - 1] ?? ''));
    lose(names.at(-1) ?? 'MAPFILE', `${cmd} fills it when it runs`);
    return false;
  }
  if (cmd === 'getopts' && NAME.test(ws[2] ?? '')) { lose(ws[2], `getopts sets ${ws[2]} when it runs`); return false; }
  if (cmd === 'let' || cmd.startsWith('((')) {
    for (const m of ws.join(' ').matchAll(/([A-Za-z_]\w*)\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)|([A-Za-z_]\w*)\s*(?:\+\+|--)|(?:\+\+|--)\s*([A-Za-z_]\w*)/gu)) {
      const n = m[1] ?? m[2] ?? m[3];
      lose(n, `${n} is worked out by arithmetic when it runs`);
    }
    return true;
  }
  if (CD.test(cmd)) {
    const arg = ws[1] === undefined ? null : shellWord(ws[1], state.vars);
    const before = state.base;
    state.dirs ??= [];
    state.cdText = [cmd, ...ws.slice(1, 2)].join(' ');
    // `cd -` goes back to $OLDPWD; pushd keeps the folder it leaves and popd goes back to the last one kept (both were
    // not known until 2026-11-13).
    const to = cmd === 'cd' && arg?.text === '-' ? state.vars.get('OLDPWD')?.value ?? null
      : cmd === 'popd' && !arg ? (state.dirs.length ? state.dirs.pop() : null)
        : stepTo(state.base, cmd, arg?.text);
    if (cmd === 'pushd' && arg) state.dirs.push(before);
    // In a loop only a cd to an absolute folder goes to the same place each turn.
    const fixed = arg != null && !arg.text.includes(HOLE) && (isAbsolute(arg.text) || arg.text === '~' || arg.text.startsWith('~/'));
    const turns = !fixed && turning(state);
    state.base = maybe || turns ? null : to;
    if (turns && before != null) state.why = { part: state.cdText, why: `${cmd} inside a loop: each turn starts where the last one ended`, prefix: '' };
    else if (maybe && before != null) state.why = { part: state.cdText, why: `${cmd} runs only on some paths through the command`, prefix: '' };
    // prefix: the absolute folder known to hold where it went (`cd /r/$X` is under /r), '' when nothing is known; fresh:
    // it went into a new folder mktemp made there (`cd $(mktemp -d)`), so nothing is below it yet.
    if (state.base == null && !maybe && !turns) {
      const known = arg?.text.includes(HOLE) ? arg.text.slice(0, arg.text.indexOf(HOLE)) : '';
      const first = arg?.unknown[0];
      const made = !known && first?.under != null ? (isAbsolute(first.under) ? first.under : before != null ? resolve(before, first.under) : null) : null;
      const prefix = made ? `${made.replace(/\/$/u, '')}/` : known && isAbsolute(known) ? (known.endsWith('/') ? known : dirname(known)) : '';
      state.why = first ? { part: first.part, why: first.why, prefix, fresh: Boolean(made) } : before == null && state.why ? state.why : { part: state.cdText, why: `where ${state.cdText} goes is not known before it runs`, prefix: '' };
    }
    // The shell keeps where it was and where it is: `cd -` and $OLDPWD go back to the folder before.
    state.vars.set('OLDPWD', before != null ? { value: before, exported: true } : { value: null, why: 'the folder before is not known', part: '$OLDPWD' });
    state.vars.set('PWD', state.base != null ? { value: state.base, exported: true } : { value: null, why: state.why?.why ?? 'the folder is not known', part: state.why?.part ?? '$PWD' });
    return true;
  }
  const declare = DECLARE.test(cmd);
  if (!declare && !(ws.length && ws.every((w) => ASSIGN.test(w)))) {
    const unset = (name, why, values) => state.vars.set(name, { value: null, why, part: `$${name}`, ...(values ? { values } : {}) });
    // `for r in a b`: r takes a, then b. A list with anything the shell expands (a variable, a glob, braces, a $( ))
    // or of more than 64 words gives no values: the loop variable is then not known.
    const list = ws[2] === 'in' ? ws.slice(3) : [];
    const plain = list.length > 0 && list.length <= 64 && list.every((w) => !/[$`*?[{~]/u.test(w));
    if (cmd === 'for' && NAME.test(ws[1] ?? '')) unset(ws[1], `${ws[1]} is a loop variable`, plain ? list.map(unquote) : undefined);
    else if (cmd === 'read') ws.slice(1).filter((w) => NAME.test(w)).forEach((n) => unset(n, `${n} is read when the command runs`));
    else if (cmd === 'unset') ws.slice(1).filter((w) => NAME.test(w)).forEach((n) => unset(n, `${n} is unset`));
    return false;
  }
  // export -n takes the mark off: the shells it starts no longer see the variable.
  const unexport = cmd === 'export' && ws.slice(1).some((w) => /^-\w*n/u.test(w));
  const exported = !unexport && (cmd === 'export' || (declare && ws.slice(1).some((w) => /^-\w*x/u.test(w))));
  for (const w of declare ? ws.slice(1) : ws) {
    const m = w.match(ASSIGN);
    // `export S` with no value marks S for the shells it starts, set now or later (`export S; S=/a; bash -c ...`).
    if (!m) { if ((exported || unexport) && NAME.test(w)) { const old = state.vars.get(w); state.vars.set(w, old ? { ...old, exported } : { value: null, why: `${w} is not set by the command`, part: `$${w}`, exported }); } continue; }
    const [name, append] = [m[1], m[2] === '+'];
    const old = state.vars.get(name);
    // Once exported, a variable stays exported when it is set again.
    const keep = !unexport && (exported || Boolean(old?.exported));
    // In a loop, a value built from itself (`S=$S/x`, `S+=x`) grows each turn.
    if (turning(state) && (append || new RegExp(String.raw`\$\{?${name}\b`, 'u').test(w.slice(m[0].length)))) { state.vars.set(name, { value: null, why: `${name} is built from itself inside a loop: it grows each turn`, part: `$${name}`, exported: keep }); continue; }
    const v = shellWord(w.slice(m[0].length), state.vars);
    // A value that starts with a path mktemp makes keeps where it is made (`R=$(mktemp -d)`, `T=$R/w`).
    const first = v.unknown[0];
    const made = !append && first && v.text.startsWith(`${HOLE}${first.text}${HOLE}`) ? first.under : undefined;
    const under = made == null ? undefined : isAbsolute(made) ? made : state.base != null ? resolve(state.base, made) : undefined;
    let next = v.unknown.length ? { value: null, why: first.why, part: first.part, exported: keep, ...(under != null ? { under } : {}) } : { value: v.text, exported: keep };
    // S+=x adds to what S holds.
    if (append) next = old?.value != null && next.value != null ? { value: old.value + next.value, exported: keep } : old?.value == null && old ? { ...old, exported: keep } : next.value == null ? next : { value: null, why: `${name} is not set by the command`, part: `$${name}`, exported: keep };
    if (next.value != null && next.value.length > 4096) next = { value: null, why: `${name} is too long to follow`, part: `$${name}`, exported: keep };
    // On a path that may not run, the value is known only when it is the one already there.
    if (maybe && !(old && old.value != null && old.value === next.value)) next = { value: null, why: `${name} is set only on some paths through the command`, part: `$${name}`, exported: keep };
    state.vars.set(name, next);
  }
  return true;
}

// The files a command writes. A write whose place cannot be known before the command runs is left out here;
// shellWrites lists it.
export function bashWrites(command, cwd = process.cwd()) {
  return shellWrites(command, cwd).files;
}

// The files a command writes, the writes it makes where readfirst cannot tell before it runs, and the checkouts it
// makes: { files, unknown, repos }. unknown: [{ part, word, why, prefix, fresh?, direct? }]: what is not known, the word
// it is in, why, and the folder it is known to be under. A command starts with the variables `vars` gives (the hook:
// its environment); a here-document or a `bash -c` string is read with those of the shell around it that it sees.
export function shellWrites(command, cwd = process.cwd(), { vars = new Map(), why = null } = {}) {
  const found = new Set();
  const unknown = [];
  // The variables it starts with (the hook passes its own environment: Claude Code starts it with the session's), and
  // $PWD where it starts.
  // A fresh start has no blocks open and no functions (Object.assign from a here-document's walk once carried its
  // `for` into the walk of the whole command, 2026-11-13).
  const start = () => { const v = copyVars(vars); if (cwd != null) v.set('PWD', { value: cwd, exported: true }); return { base: cwd, why: cwd == null ? why : null, vars: v, fns: new Set(), fnInfo: new Map(), fnDepth: 0, blocks: [], chain: null, dirs: [], paren: 0 }; };
  const state = start();
  const here = (w) => { try { return isAbsolute(w) ? existsSync(w) : state.base != null && existsSync(resolve(state.base, w)); } catch { return false; } };
  // A glob with one * in its last part (dir/*.yml), relative to where the command runs; anything wider is not expanded.
  const glob = (pattern) => {
    const dir = dirname(pattern);
    if (state.base == null || dir.includes('*') || (pattern.split('*').length - 1) !== 1) return [];
    const [pre, post] = pattern.slice(dir === '.' ? 0 : dir.length + 1).split('*');
    try { return readdirSync(resolve(state.base, dir)).filter((f) => f.startsWith(pre) && f.endsWith(post)).map((f) => (dir === '.' ? f : join(dir, f))); } catch { return []; }
  };
  // The word's text with what it holds that is not known kept between \0s, and why for each such part.
  const holes = new Map();
  // The folder a known start of a path stands for: `/tmp/x/` and `/tmp/x/a` (part of a name) are under /tmp/x; a
  // relative start is under where the command is; an empty one under nothing known.
  const knownPrefix = (text) => {
    if (!text) return '';
    const abs = isAbsolute(text) ? text : state.base == null ? null : resolve(state.base, text) + (text.endsWith('/') ? '/' : '');
    if (!abs) return state.why?.prefix ?? '';
    return abs.endsWith('/') ? abs : dirname(abs);
  };
  const dq = (w) => { const r = shellWord(w, state.vars); for (const u of r.unknown) holes.set(u.text, u); return r.text; };
  const missing = (u) => { if (!unknown.some((k) => k.part === u.part && k.word === u.word)) unknown.push(u); };
  // repos: the checkouts the command makes (git worktree add, clone, init), as a folder or the known start of one;
  // madeAt: those whose folder is known in full.
  const repos = new Set();
  const madeAt = new Set();
  // The texts a word (as dq gives it) takes when everything not known in it is a variable of a loop over a literal list
  // (`for r in a b; do echo > w-$r/f`: w-a/f and w-b/f), one per turn; null otherwise, or past 64 texts (then the
  // write stays not known, never cut to some of them).
  const perTurn = (p) => {
    const parts = [...p.matchAll(/\0([^\0]*)\0/gu)].map((m) => holes.get(m[1]));
    if (!parts.length || !parts.every((u) => u?.values)) return null;
    let all = [p];
    for (const u of new Set(parts)) {
      all = all.flatMap((x) => u.values.map((v) => x.replaceAll(`${HOLE}${u.text}${HOLE}`, v)));
      if (all.length > 64) return null;
    }
    return all;
  };
  // w: a word as dq gives it.
  const add = (w) => {
    let p = String(w).replace(/^file:\/\//u, '');
    const shown = p.replaceAll(HOLE, '');
    if (!shown || shown.startsWith('-') || shown.startsWith('/dev/') || /^[a-z]+:\/\//u.test(shown)) return;
    const turns = perTurn(p);
    if (turns) { turns.forEach(add); return; }
    const h = p.match(/\0([^\0]*)\0/u);
    // prefix: the absolute folder the write is known to be under ('' when nothing is known), so the hook can tell
    // which repositories it could land in: `/tmp/x/$D/f` is under /tmp/x, `$OUT/f` anywhere.
    // A path that starts with one mktemp makes is a new name in that folder (fresh: nothing can be below it yet).
    if (h) {
      const u = holes.get(h[1]);
      const made = p.startsWith(HOLE) && u?.under != null ? (isAbsolute(u.under) ? u.under : state.base != null ? resolve(state.base, u.under) : null) : null;
      // direct: what is not known sits inside the file's own name, after known letters of it (`out-$k.txt`), so the
      // file is in the prefix folder itself, not below it. A part that starts a name (`/s/$r`, `$n.txt`) may hold a
      // whole path and is not direct.
      const q = p.replace(/\0[^\0]*\0/gu, HOLE);
      const lastSlash = q.lastIndexOf('/');
      const direct = !made && q.indexOf(HOLE) > lastSlash + 1;
      // within: what is not known sits inside one folder name of the path, between known letters (`/tmp/zz-$r/f`): the
      // write is below a folder of `dir` whose name starts with `pre` and ends with `post`, not below any folder of dir
      // (2026-11-13: the hook walked all of /tmp for it, 12 s, and asked about every repository there).
      const first = q.indexOf(HOLE);
      const last = q.lastIndexOf(HOLE);
      const from = q.lastIndexOf('/', first) + 1;
      const to = q.indexOf('/', last);
      const dir = !made && from > 0 && to > last && !q.slice(first, last).includes('/') && (isAbsolute(q) || state.base != null) ? knownPrefix(q.slice(0, from)) : '';
      const within = dir ? { dir, pre: q.slice(from, first), post: q.slice(last + 1, to) } : null;
      missing({ part: u?.part ?? h[1], word: shown, why: u?.why ?? 'it is not known before the command runs', prefix: made ? `${made.replace(/\/$/u, '')}/` : knownPrefix(p.slice(0, p.indexOf(HOLE))), ...(made ? { fresh: true } : {}), ...(direct ? { direct: true } : {}), ...(within ? { within } : {}) });
      return;
    }
    if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
    const relativeUnknown = () => missing({ part: state.why?.part ?? 'cd', word: p, why: state.why?.why ?? 'the folder it is relative to is not known', prefix: state.why?.prefix ?? '', ...(state.why?.fresh ? { fresh: true } : {}) });
    // A glob writes the files it matches (`sed -i ... src/*.js`): one * in the last part is expanded, anything wider
    // or a brace list is left out rather than named as a file called `*.js`.
    if (/[*?[{]/u.test(p)) { if (isAbsolute(p)) return; if (state.base == null) relativeUnknown(); else glob(p).forEach((f) => found.add(resolve(state.base, f))); return; }
    if (isAbsolute(p)) found.add(p);
    else if (state.base != null) found.add(resolve(state.base, p));
    else relativeUnknown();
  };
  // Where relative paths start, and what the variables are, after some shell text (here-documents already taken out
  // of it). A cd or an assignment inside ( ) ends at its `)`.
  const stateAt = (text) => { const st = start(); return eachCommand(text, st, (p, raw, how) => follow(st, opening(raw), how)); };
  // Shell text read inside this command (a here-document or a `bash -c` string), from where it runs and with the
  // variables it sees.
  const inner = (text, innerVars) => {
    const r = shellWrites(text, state.base, { vars: innerVars, why: state.why });
    r.files.forEach((f) => found.add(f));
    r.unknown.forEach(missing);
    r.repos.forEach((x) => repos.add(x));
  };
  const exportedOnly = (v) => new Map([...v].filter(([, x]) => x.exported));
  // Here-documents: their body is code (its write calls name their targets) or data (only the redirect counts).
  // Their paths start where the commands before them moved to: `cd repo && python3 - <<E` writes in repo (2026-11-08:
  // the hook showed another repository's notes for a relative path after a cd).
  let kept = ''; // the shell text up to this here-document, earlier bodies taken out
  let last = 0;
  // A backslash at the end of a line continues the command on the next one (`sed -i \\` + newline + `-e ... f`).
  const shell = withoutComments(String(command ?? '').replace(/\\\r?\n/gu, ' ')).replace(/([^\n]*?)<<-?\s*(['"]?)(\w+)['"]?([^\n]*)\n([\s\S]*?)\n\s*\3(?=\s|$)/gu, (all, head, quote, tag, rest, body, offset, text) => {
    kept += `${text.slice(last, offset)}${head}`;
    last = offset + all.length;
    Object.assign(state, stateAt(kept));
    kept += ` ${rest}`;
    // Only the command the here-document feeds: in `node x.mjs; cat > f <<E` it goes to cat (2026-11-08).
    const hw = words(segments(head).at(-1)).map(dq);
    const at = hw.findIndex((w) => RUNNER.test(w.split('/').pop()));
    // The script's arguments: words after the runner that are not options, the script itself ('-') or a redirect.
    const args = at < 0 ? [] : hw.slice(at + 1).filter((w) => w !== '-' && !w.startsWith('-') && !/^[<>|&]/u.test(w));
    // A shell fed a here-document runs its body as commands: read them as commands. With a quoted tag (<<'E') the
    // body is read by that shell alone, which sees only exported variables; without, the outer shell expands it first.
    if (at >= 0 && SHELLS.test(hw[at].split('/').pop())) inner(body, quote ? exportedOnly(state.vars) : state.vars);
    else if (at >= 0 && CODE_WRITES.test(body)) codeTargets(body, { args, exists: here, glob }).forEach(add);
    return `${head} ${rest}`;
  });
  Object.assign(state, start()); // the segments below follow the cds and assignments again themselves
  // Redirects anywhere in a segment, not 2> or >&, and not a > inside quotes (an arrow `=>` in node -e "..." code
  // is not a redirect): quoted text is blanked to find them, the target is read from the segment itself. &> and &>>
  // (stdout and stderr to a file) write too; the & before them once kept &> out.
  // 2> err.log, 1> out and >| write too (the digit and the | are part of the operator); 2>&1 and >&2 do not.
  const redirects = (segment) => {
    for (const m of blank(segment).matchAll(/(?<![\w=-])\d*>>?\|?(?!\s*&)/gu)) {
      // A target ends at the ) that closes a $( ): `"$(sort a > b.txt)"` writes b.txt. Quoted parts and escaped
      // characters run on in the word: `"$S"/f.txt`, `a\&b.js`.
      const t = segment.slice(m.index + m[0].length).match(/^\s*((?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|\$\(\((?:[^()]|\([^()]*\))*\)\)|\$\((?:[^()]|\([^()]*\))*\)|[^\s;&|)'"\\])+)/u);
      if (t) add(dq(t[1]));
    }
  };
  // how: { pipe, maybe } from howItRuns.
  const writesIn = (segment, how) => {
    const raw = words(segment);
    const opened = opening(raw);
    // Arithmetic and tests compare with > and <: `(( x > 0 ))`, `[[ a > b ]]` write nothing; (( )) may set variables.
    // After if, while and the like too (`if (( x > 0 ))` named a file 0: opening took the (( off with the if).
    let k = 0;
    while (KEYWORDS.test(raw[k] ?? '')) k++;
    if (/^(?:\(\(|\[\[)/u.test(opened[0] ?? '') || /^(?:\(\(|\[\[)/u.test(raw[k] ?? '')) { if ((raw[k] ?? '').startsWith('((')) follow(state, raw.slice(k), how); return; }
    // A redirect writes first, with the folder and variables from before the command: `y="$(sort a > b.txt)"` writes
    // b.txt. cd and assignments then change what the commands after them see, and write nothing more.
    redirects(segment);
    if (follow(state, opened, how)) return;
    const ws = unwrap(opened);
    const cmd = unquote(ws[0] ?? '').split('/').pop();
    const args = withoutRedirects(ws.slice(1)).map(dq);
    const files = args.filter((w) => !w.startsWith('-'));
    const o = OPTIONS[cmd] ? options(args, OPTIONS[cmd]) : null;
    // sed and perl write only in place; the script is the first file argument unless -e/-f gave it.
    if ((cmd === 'sed' || cmd === 'perl') && o.inPlace) (o.script ? o.files : o.files.slice(1)).forEach(add);
    else if (cmd === 'tee' || cmd === 'truncate') o.files.forEach(add);
    else if (cmd === 'patch') patchFiles(args).forEach(add);
    else if (['cp', 'mv', 'install'].includes(cmd) && o.values.t) add(o.values.t.at(-1));
    else if (cmd === 'rsync' && (args.some((w) => w === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/u.test(w)) || /^(?:[\w.@-]+:|rsync:\/\/)/u.test(o.files.at(-1) ?? ''))) { /* a dry run or a remote destination */ }
    else if (['cp', 'mv', 'install', 'rsync'].includes(cmd) && o.files.length >= 2) add(o.files.at(-1));
    else if (cmd === 'git') {
      // git's own options before the subcommand: -C <dir> runs it in that folder, -c <k=v> and --no-pager change nothing.
      let i = 0;
      let dir = '.';
      const cs = []; // the -C folders as given, for resolve (join drops the / of an absolute one)
      while (i < args.length && args[i].startsWith('-')) {
        if (args[i] === '-C') { dir = join(dir, args[i + 1] ?? ''); cs.push(args[i + 1] ?? ''); i += 2; } else if (args[i] === '-c') i += 2; else i++;
      }
      // An absolute -C folder is where git runs, not a folder under this one: join made `git -C /w checkout -- f` a
      // write to ./w/f, which once variables were followed showed this repository's notes for a path that does not
      // exist (2026-11-13).
      if (cs.some((c) => isAbsolute(c))) dir = resolve('/', ...cs);
      if (/^(?:checkout|restore)$/u.test(args[i] ?? '')) gitPaths(args.slice(i), (w) => here(join(dir, w))).forEach((p) => add(join(dir, p)));
      // A checkout the command makes (worktree add, clone, init): a write below it lands in a repository, though none
      // is there yet when the hook runs (`git worktree add $S/w-$rev` then a write into $S/w-$rev).
      const sub = args[i];
      const rest = args.slice(i + 1).filter((w, k, all) => !w.startsWith('-') && !/^-(?:b|B|-reason|-template|-separate-git-dir|-origin|o|-branch|-depth|c|-config)$/u.test(all[k - 1] ?? ''));
      const made = sub === 'worktree' && rest[0] === 'add' ? rest[1] : sub === 'clone' ? rest[1] ?? (rest[0] ?? '').replace(/\/$/u, '').split(/[/:]/u).pop().replace(/\.git$/u, '') : sub === 'init' ? rest[0] ?? '.' : undefined;
      for (const m of made ? perTurn(made) ?? [made] : []) {
        const at = !m.includes(HOLE) && (state.base != null || isAbsolute(m)) ? resolve(state.base ?? '/', ...cs, m) : null;
        repos.add(at ?? (m.includes(HOLE) ? knownPrefix(m.slice(0, m.indexOf(HOLE))) : ''));
        if (at) madeAt.add(at);
      }
    }
    // `bash -c '...'`, `sh -lc "..."`: the string is commands, read the same way, by a new shell that sees only the
    // exported variables (what "..." held was expanded before it started).
    else if (SHELLS.test(cmd) && args.findIndex((w) => /^-[a-z]*c[a-z]*$/u.test(w)) >= 0) {
      const script = args[args.findIndex((w) => /^-[a-z]*c[a-z]*$/u.test(w)) + 1];
      if (script !== undefined) inner(script, exportedOnly(state.vars));
    }
    else if (RUNNER.test(cmd) && args.some((w) => w === '-c' || w === '-e') && CODE_WRITES.test(segment)) {
      const i = args.findIndex((w) => w === '-c' || w === '-e');
      codeTargets(args[i + 1] ?? '', { args: args.slice(i + 2).filter((w) => !w.startsWith('-')), exists: here, glob }).forEach(add);
    }
  };
  // A cd inside ( ) ends at its `)`, and a redirect after the `)` is the outer shell's: in
  // `cd a && (cd b && make) > log && echo x > f` log and f are in a. The cd once carried on past the `)`, so the hook
  // showed another repository's notes for a write in this one, and the `)` stuck to the last word made `f.txt)` the
  // file (2026-11-09).
  // Variables set inside ( ) end there too: in `(S=/a; ...); echo > $S/g` the second $S is not the command's.
  eachCommand(shell, state, (p, raw, how) => writesIn(p.body, how), redirects);
  repos.delete('');
  // A file in a checkout the command itself makes is not there when the hook runs, so its notes cannot be read yet: it
  // is listed as not known, in that checkout (`git worktree add $S/w-a main && cp t.js $S/w-a/test/`). Only a checkout
  // whose folder is known: `$S/w-$rev` is somewhere below $S, and a file elsewhere there is not in it.
  for (const f of found) {
    const r = [...madeAt].find((x) => f.startsWith(`${x.replace(/\/$/u, '')}/`));
    if (r) { found.delete(f); missing({ part: r, word: f, why: 'it is in a checkout this command makes, not there yet', prefix: `${r.replace(/\/$/u, '')}/` }); }
  }
  return { files: [...found], unknown, repos: [...repos] };
}

// The files each `readfirst read` in a shell command asks for, and whether its whole output reaches whoever ran the
// command: { files (absolute), seen, why }. Not seen when stdout goes to a file or /dev/null (`>`, `>>`, `1>`, `&>`),
// into a pipe (`| head`, `| grep`: cut or filtered), to the background (`&`) or when --limit cuts the list. 2> and >&2
// leave stdout where it is. It is read from the command before it runs (a PreToolUse hook): a read that then fails
// (npx cannot install, the file is not tracked) still counts.
// The command is readfirst, readfirst@version or a path ending in readfirst.mjs, run directly or through npx or node,
// followed by `read`; any other way of running it (an alias, a script, inside $( )) is not seen here. Relative paths
// start where the cds before it moved to, or at --root when it is given, as `readfirst read` resolves them.
const READ_VALUES = new Set(['root', 'limit', 'timeout', 'base', 'out', 'for', 'labels', 'lang']);
export function bashReads(command, cwd = process.cwd(), { vars = new Map() } = {}) {
  const out = [];
  // cd and the variables the command sets are followed as bashWrites follows them (`S=/a; cd $S && readfirst read f`);
  // `vars`: those it starts with (the hook's environment).
  const state = { base: cwd, why: null, vars: copyVars(vars) };
  const shell = withoutComments(String(command ?? '').replace(/\\\r?\n/gu, ' '));
  eachCommand(shell, state, (p, raw, how, op) => {
    const opened = opening(raw);
    const ws = unwrap(opened).map((w) => shellWord(w, state.vars).text);
    const at = ws.findIndex((w) => /^(?:readfirst(?:@[\w.-]+)?|\S*readfirst\.mjs)$/u.test(w));
    const base = state.base;
    if (follow(state, opened, how)) { /* a cd or an assignment */ }
    else if (at >= 0 && ws[at + 1] === 'read' && ws.slice(0, at).every((w) => /^(?:\S*\/)?(?:npx|node)$|^(?:--yes|-y)$/u.test(w))) {
      const files = [];
      let root = null;
      let limit = false;
      // A pipe takes its output; `&` (the segments split there) sends it to the background, where it need not come
      // back with the call.
      let thrown = op === '|' || op === '|&' || op === '&';
      const args = ws.slice(at + 2);
      let names = false; // after `--` every word but a redirect is a file
      for (let i = 0; i < args.length; i++) {
        const w = args[i];
        const redirect = w.match(REDIRECT);
        if (redirect) {
          if (/^(?:1|&)?>/u.test(w) && !/^(?:1)?>&/u.test(w)) thrown = true;
          if (w.length === redirect[0].length) i++;
          continue;
        }
        if (names) { files.push(w); continue; }
        if (w === '--') { names = true; continue; }
        const opt = w.match(/^--([\w-]+)(=.*)?$/u);
        if (opt && READ_VALUES.has(opt[1])) {
          const value = opt[2] !== undefined ? opt[2].slice(1) : args[++i];
          if (opt[1] === 'root') root = value ?? null;
          if (opt[1] === 'limit') limit = true;
          continue;
        }
        if (w.startsWith('-')) continue;
        files.push(w);
      }
      const from = root ? (base == null && !isAbsolute(root) ? null : resolve(base ?? '/', root)) : base;
      const abs = files.filter((f) => !f.includes(HOLE) && !/[*?]/u.test(f)).map((f) => (isAbsolute(f) ? f : from == null ? null : resolve(from, f))).filter(Boolean);
      if (abs.length) out.push({ files: abs, seen: !thrown && !limit, why: thrown ? 'its output was sent elsewhere' : limit ? '--limit cut the list' : null });
    }
  });
  return out;
}
