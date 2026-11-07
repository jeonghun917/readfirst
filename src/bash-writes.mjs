// The files a shell command writes, so the hook can show their read list before a Bash call as it does before an Edit.
// Agents change files with sed -i, redirects and short scripts as often as with an edit tool; a hook that only looked at
// Edit and Write saw none of those (readfirst's own sessions, 2026-11-07). Only where a command writes counts, not every
// file it names: reading a file into a scratch file, or running the tests, is not a write to the repository.
//   redirects (> f, >> f), sed -i / perl -i, tee, truncate, patch, the destination of cp / mv / install / rsync,
//   git checkout / restore of named paths, and code that writes (open(..., 'w'), writeFile, write_text...) run by
//   python, node, ruby, perl or a shell from -c / -e or a here-document: there every path the code names counts.
// A here-document fed to cat or tee is data; only where it goes counts. `cd dir &&` moves where relative paths start.
import { isAbsolute, resolve } from 'node:path';

const CODE_WRITES = /\bopen\([^)]*,\s*['"][wax]|\.write_text\(|\.write_bytes\(|writeFileSync\(|writeFile\(|appendFileSync\(|\.writelines?\(|createWriteStream\(|File\.write|>>?\s*\$|\bdump\(/u;
const PATHISH = /(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,6}\b/gu;
const RUNNER = /^(?:python3?|node|ruby|perl|bash|sh|zsh|deno|bun)$/u;
const unquote = (w) => w.replace(/^(['"])(.*)\1$/u, '$2');

// Words of one command segment, quotes kept together; good enough for the shapes above, not a shell parser.
const words = (segment) => segment.match(/'[^']*'|"(?:\\.|[^"\\])*"|[^\s]+/gu) ?? [];

export function bashWrites(command, cwd = process.cwd()) {
  const found = new Set();
  let base = cwd;
  const add = (w) => {
    const p = unquote(String(w)).replace(/^file:\/\//u, '');
    if (!p || p.startsWith('-') || p.startsWith('/dev/') || /^[a-z]+:\/\//u.test(p) || p.includes('$')) return;
    found.add(isAbsolute(p) ? p : resolve(base, p));
  };
  // Here-documents: their body is code (writes name their targets) or data (only the redirect counts).
  const shell = String(command ?? '').replace(/([^\n]*?)<<-?\s*['"]?(\w+)['"]?([^\n]*)\n([\s\S]*?)\n\s*\2(?=\s|$)/gu, (all, head, tag, rest, body) => {
    const runner = words(head).map(unquote).find((w) => RUNNER.test(w.split('/').pop()));
    if (runner && CODE_WRITES.test(body)) for (const w of body.match(PATHISH) ?? []) add(w);
    return `${head} ${rest}`;
  });
  for (const segment of shell.split(/\s*(?:&&|\|\||;|\||\n)\s*/u)) {
    const ws = words(segment);
    if (!ws.length) continue;
    const cmd = unquote(ws[0]).split('/').pop();
    if (cmd === 'cd' && ws[1]) { base = resolve(base, unquote(ws[1])); continue; }
    // Redirects anywhere in the segment, not 2> or >&.
    for (const m of segment.matchAll(/(?<![0-9&])>>?\s*(?!&)('[^']+'|"[^"]+"|[^\s;&|]+)/gu)) add(m[1]);
    const args = ws.slice(1).map(unquote);
    const files = args.filter((w) => !w.startsWith('-'));
    if ((cmd === 'sed' || cmd === 'perl') && args.some((w) => /^-[a-zA-Z]*i|^--in-place/u.test(w))) files.slice(cmd === 'sed' ? 1 : 1).forEach(add);
    else if (cmd === 'tee' || cmd === 'truncate' || cmd === 'patch') files.forEach(add);
    else if (['cp', 'mv', 'install', 'rsync'].includes(cmd) && files.length >= 2) add(files.at(-1));
    else if (cmd === 'git' && /^(?:checkout|restore)$/u.test(args[0] ?? '')) args.slice(args.indexOf('--') + 1 || 1).filter((w) => !w.startsWith('-') && w.includes('.')).forEach(add);
    else if (RUNNER.test(cmd) && args.some((w) => w === '-c' || w === '-e') && CODE_WRITES.test(segment)) for (const w of segment.match(PATHISH) ?? []) add(w);
  }
  return [...found];
}
