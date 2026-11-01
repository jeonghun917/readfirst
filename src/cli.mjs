// readfirst: what to read and check before changing a file.
//   readfirst init [--agent]       write a first .readfirst/map.json from the file tree (and the agent-notes line)
//   readfirst prompt               the brief for a coding agent to fill in titles, checks, risks and rules
//   readfirst prompt --labels <lang>  the brief for personal labels (a translation and plain notes) for the view
//   readfirst check                the map covers every tracked file and is well formed
//   readfirst fix                  place new files and drop patterns for deleted ones, then check
//   readfirst read <file>...       the read list for files you are about to change
//   readfirst diff [--base <ref>]  the read list for the files changed since <ref> (default: origin/main, else main)
//   readfirst verify [--base <ref>] run the checks the read list names for the changed files; exit 1 if one fails
//   readfirst hook [--install]     a Claude Code PreToolUse hook: the read list for the file an Edit or Write is about to change
//   readfirst view [--out <file>]  the map as a city in one HTML page (default .readfirst/local/view.html)
// Options: --root <dir> (default: the current git repository), --json, --limit <n>.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { importEdges } from './imports.mjs';
import { assertMap, draftMap, fixMap, MAP_PATH, mapProblems } from './map.mjs';
import { agentBrief } from './prompt.mjs';
import { keepLocal, labelsBrief, LOCAL_DIR, readLabels } from './labels.mjs';
import { viewData } from './view.mjs';
import { cityData, viewHtmlCity } from './view-city.mjs';
import { emptyList, readList, toMarkdown } from './readlist.mjs';

const HELP = `readfirst — what to read and check before changing a file

  readfirst init [--agent]       write a first ${MAP_PATH} from the file tree
  readfirst prompt               brief for your coding agent to fill in the map
  readfirst check                check the map covers every tracked file
  readfirst fix                  place new files, drop patterns for deleted ones
  readfirst read <file>...       read list for files you are about to change
  readfirst diff [--base <ref>]  read list for files changed since <ref>
  readfirst verify [--base <ref>]  run the checks for the files changed since <ref> (--dry-run lists them)
  readfirst hook [--install]     Claude Code hook: the read list before each edit (--install adds it to .claude/settings.json)
  readfirst view [--out <file>]  the map as a city in one HTML page
  readfirst prompt --labels <lang>  brief for your agent to write personal labels for the view (e.g. ko, en)

Options: --root <dir>, --json, --limit <n>, --timeout <s> (verify, per check; default 900), --force (init: replace the map),
         --agent (init: add the read-first line to CLAUDE.md / AGENTS.md / .cursorrules)`;

function parse(argv) {
  const args = { _: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--force') args.force = true;
    else if (a === '--agent') args.agent = true;
    else if (a === '--install') args.install = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--')) { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); args[a.slice(2)] = v; }
    else args._.push(a);
  }
  return args;
}

// stderr is captured, not shown: a repository with no commits yet makes `rev-parse HEAD` complain, and that is expected.
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function repoFiles(root) {
  // Tracked files plus new files not ignored by .gitignore, so a file being added can be looked up before its commit.
  return git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)
    .filter((f) => existsSync(join(root, f))).sort();
}

export const readText = (root) => (path) => {
  try { return readFileSync(join(root, path), 'utf8'); } catch { return null; }
};

export function readMapFile(root) {
  const at = join(root, MAP_PATH);
  if (!existsSync(at)) throw new Error(`no ${MAP_PATH} here: run \`readfirst init\` first`);
  try { return JSON.parse(readFileSync(at, 'utf8')); } catch (e) { throw new Error(`${MAP_PATH} is not valid JSON: ${e.message}`); }
}

function loadMap(root, files) {
  return assertMap(readMapFile(root), files);
}

// read and diff keep working while the map is only behind the code (new files in no group, patterns for deleted files):
// they warn and point at `readfirst fix`. A map that is broken in itself still stops them.
function loadMapLenient(root, files, io) {
  const map = readMapFile(root);
  const broken = mapProblems(map, files, { placement: false });
  if (broken.length) throw new Error(`${MAP_PATH} has problems:\n- ${broken.join('\n- ')}`);
  const behind = mapProblems(map, files);
  if (behind.length) io.err(`note: ${MAP_PATH} is behind the code (${behind.length} problem${behind.length > 1 ? 's' : ''}); \`readfirst fix\` repairs most of it.\n`);
  return map;
}

// The one line that makes a coding agent use readfirst, added to the agent notes the project already has (CLAUDE.md,
// AGENTS.md, .cursorrules), or to a new AGENTS.md when it has none. A file that already mentions readfirst is left alone.
export const AGENT_LINE = 'Before changing a file, run `npx readfirst read <file>` and follow what it says: keep the rules, read the risks, run the checks it lists. Before you finish, run `npx readfirst verify`: it runs the checks the map lists for everything you changed; fix what fails. When you learn something a newcomer would get wrong, add it as a risk in .readfirst/map.json.';
function addAgentLine(root) {
  const notes = ['CLAUDE.md', 'AGENTS.md', '.cursorrules'].filter((f) => existsSync(join(root, f)));
  const wrote = [];
  for (const f of notes.length ? notes : ['AGENTS.md']) {
    const at = join(root, f);
    const now = existsSync(at) ? readFileSync(at, 'utf8') : '';
    if (/readfirst/u.test(now)) continue;
    writeFileSync(at, `${now}${now && !now.endsWith('\n') ? '\n' : ''}${now ? '\n' : ''}${AGENT_LINE}\n`);
    wrote.push(f);
  }
  return wrote;
}

function changedFiles(root, base) {
  const ref = base ?? ['origin/main', 'main', 'origin/master', 'master'].find((r) => { try { git(root, 'rev-parse', '--verify', '--quiet', r); return true; } catch { return false; } });
  if (!ref) throw new Error('no base branch found: pass --base <ref>');
  const since = git(root, 'merge-base', ref, 'HEAD').trim();
  const names = new Set([
    ...git(root, 'diff', '--name-only', since).split('\n'),
    ...git(root, 'ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean));
  return { ref, files: [...names].sort() };
}

// Runs each check with the shell in the repository root, one after another, and keeps the end of the output of the ones
// that fail. readfirst writes nothing itself; the commands are the map's own and may write, as they would by hand.
export function verifyChecks(root, checks, { dryRun = false, timeout = 900, progress = () => {} } = {}) {
  const out = [];
  for (const c of checks) {
    const row = { run: c.run, why: c.why, for: c.for ?? [] };
    if (dryRun) { out.push({ ...row, status: 'listed' }); continue; }
    progress(`running ${c.run}\n`);
    const started = Date.now();
    const r = spawnSync(c.run, { cwd: root, shell: true, encoding: 'utf8', timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: process.env.CI ?? '1' } });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const timedOut = r.error?.code === 'ETIMEDOUT';
    const status = timedOut ? 'timeout' : r.status === 0 ? 'pass' : 'fail';
    const tail = status === 'pass' ? undefined : `${r.stdout ?? ''}${r.stderr ?? ''}${r.error && !timedOut ? r.error.message : ''}`.trimEnd().split('\n').slice(-30).join('\n');
    out.push({ ...row, status, code: r.status, seconds, ...(tail !== undefined ? { output: tail } : {}) });
  }
  return out;
}

function verifyText(report, dryRun) {
  if (!report.files.length) return `no files changed since ${report.base}: nothing to verify.\n`;
  if (!report.checks.length) return `${report.files.length} changed file(s) since ${report.base}; the map lists no checks for them.\n`;
  if (dryRun) return `checks for ${report.files.length} changed file(s) since ${report.base}:\n${report.checks.map((c) => `- ${c.run}${c.why ? ` — ${c.why}` : ''}`).join('\n')}\n`;
  const mark = { pass: 'pass', fail: 'FAIL', timeout: 'TIMEOUT' };
  let s = `\nverify: ${report.checks.length} check(s) for ${report.files.length} changed file(s) since ${report.base}\n`;
  for (const c of report.checks) s += `${mark[c.status]}  ${c.run}  (${c.seconds}s)\n`;
  for (const c of report.checks.filter((x) => x.status !== 'pass')) s += `\n--- ${c.run} (${c.status}${c.code != null ? `, exit ${c.code}` : ''}); last lines:\n${c.output}\n`;
  s += report.ok ? '\nall checks passed.\n' : `\n${report.checks.filter((c) => c.status !== 'pass').length} check(s) failed.\n`;
  return s;
}

// The read list as a few factual lines for an agent's context: rules, risks and checks, nothing else.
export function brief(list) {
  const lines = [];
  for (const r of list.rules) lines.push(`Rule ${r.id}: ${r.rule}${r.why ? ` (why: ${r.why})` : ''}`);
  for (const r of list.risks) lines.push(`Risk: ${r.text}`);
  for (const c of list.checks) lines.push(`Check to run after the change: ${c.run}${c.why ? ` (${c.why})` : ''}`);
  if (list.tests.length) lines.push(`Tests that reach this file: ${list.tests.slice(0, 5).map((t) => t.path).join(', ')}`);
  return lines;
}

// Claude Code PreToolUse hook. Reads the hook's JSON on stdin; for an Edit, Write or MultiEdit of a file the map covers,
// prints the read list as additionalContext, once per file per session. Never blocks the edit: any problem means no output.
export function runHook(input, { now = Date.now(), stateDir = tmpdir() } = {}) {
  try {
    const event = JSON.parse(input);
    const file = event.tool_input?.file_path;
    if (!file || !/^(?:Edit|Write|MultiEdit)$/u.test(event.tool_name ?? '')) return null;
    const cwd = event.cwd ?? process.cwd();
    const root = git(cwd, 'rev-parse', '--show-toplevel').trim();
    const path = (isAbsolute(file) ? relative(root, file) : file).replace(/\\/gu, '/');
    if (path.startsWith('..') || path === MAP_PATH || !existsSync(join(root, MAP_PATH))) return null;
    const seenAt = join(stateDir, `readfirst-hook-${String(event.session_id ?? 'none').replace(/[^\w-]/gu, '')}.json`);
    let seen = {};
    try { seen = JSON.parse(readFileSync(seenAt, 'utf8')); } catch { seen = {}; }
    if (seen[path] && now - seen[path] < 6 * 3600_000) return null;
    const files = repoFiles(root);
    const map = readMapFile(root);
    if (mapProblems(map, files, { placement: false }).length) return null;
    const list = readList({ map, files: files.includes(path) ? files : [...files, path].sort(), imports: importEdges(files, readText(root)), targets: [path], limit: 10 });
    const lines = brief(list);
    seen[path] = now;
    try { writeFileSync(seenAt, JSON.stringify(seen)); } catch { /* best effort */ }
    if (!lines.length) return null;
    const shown = lines.slice(0, 12);
    if (lines.length > shown.length) shown.push(`${lines.length - shown.length} more in \`npx readfirst read ${path}\``);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `readfirst notes for ${path} (from ${MAP_PATH}):\n- ${shown.join('\n- ')}` } });
  } catch {
    return null;
  }
}

export const HOOK_COMMAND = 'npx --yes readfirst hook';
// Adds the hook to the project's .claude/settings.json, keeping everything already there.
export function installHook(root) {
  const at = join(root, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(at)) {
    try { settings = JSON.parse(readFileSync(at, 'utf8')); } catch { throw new Error('.claude/settings.json is not valid JSON; fix it first'); }
  }
  const pre = ((settings.hooks ??= {}).PreToolUse ??= []);
  if (pre.some((m) => (m.hooks ?? []).some((h) => /readfirst hook/u.test(h.command ?? '')))) return false;
  pre.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 15 }] });
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(at, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, stdin = () => readFileSync(0, 'utf8')) {
  const args = parse(argv);
  const [cmd, ...rest] = args._;
  if (args.help || !cmd) { io.out(`${HELP}\n`); return cmd || args.help ? 0 : 2; }
  if (cmd === 'hook' && !args.install) {
    const out = runHook(stdin());
    if (out) io.out(`${out}\n`);
    return 0;
  }
  const root = args.root ?? git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const files = repoFiles(root);
  const commit = (() => { try { return git(root, 'rev-parse', 'HEAD').trim(); } catch { return null; } })();

  if (cmd === 'init') {
    const at = join(root, MAP_PATH);
    if (existsSync(at) && args.force !== true) throw new Error(`${MAP_PATH} already exists (pass --force to replace it)`);
    const map = draftMap(files, readText(root));
    mkdirSync(join(root, '.readfirst'), { recursive: true });
    writeFileSync(at, `${JSON.stringify(map, null, 2)}\n`);
    const checks = map.groups.find((g) => g.checks.length)?.checks ?? [];
    io.out(`wrote ${MAP_PATH}: ${map.groups.length} group${map.groups.length === 1 ? "" : "s"}${checks.length ? `, checks found: ${checks.map((c) => c.run).join(', ')}` : ''}.\n`);
    if (args.agent) {
      const wrote = addAgentLine(root);
      io.out(wrote.length ? `added the read-first line to ${wrote.join(', ')}.\n` : 'your agent notes already mention readfirst.\n');
      io.out('Using Claude Code? `readfirst hook --install` hands it the read list automatically before each edit.\n');
    }
    io.out(`Next: run \`readfirst prompt\` and give the brief to your coding agent, or fill in titles, checks, risks and rules by hand.${args.agent ? '' : '\nTip: `readfirst init --agent` also adds the one line your coding agent needs to CLAUDE.md or AGENTS.md.'}\n`);
    return 0;
  }
  if (cmd === 'prompt') {
    const map = loadMap(root, files);
    if (args.labels) {
      if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/u.test(args.labels)) throw new Error('--labels needs a language code, e.g. ko or en');
      io.out(labelsBrief(map, args.labels));
      return 0;
    }
    io.out(agentBrief(map));
    return 0;
  }
  if (cmd === 'view') {
    const map = loadMapLenient(root, files, io);
    const imports = importEdges(files, readText(root));
    keepLocal(root);
    const out = args.out ? (isAbsolute(args.out) ? args.out : join(process.cwd(), args.out)) : join(root, LOCAL_DIR, 'view.html');
    const labels = readLabels(root, io.err);
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, viewHtmlCity(cityData(viewData({ map, files, imports, name: basename(root) }), imports, labels)));
    const langs = Object.keys(labels);
    io.out(`wrote ${relative(process.cwd(), out) || out}${langs.length ? ` with labels: ${langs.join(', ')}` : ''}. Open it in a browser (it loads three.js from a CDN).\n`);
    if (!langs.length) io.out('Tip: `readfirst prompt --labels ko` (or en) gives your agent a brief for a translation and plain notes, seen only on this machine.\n');
    return 0;
  }
  if (cmd === 'check') {
    const problems = mapProblems(readMapFile(root), files);
    if (args.json) io.out(`${JSON.stringify({ ok: !problems.length, problems }, null, 2)}\n`);
    else io.out(problems.length ? `${MAP_PATH} has ${problems.length} problem(s):\n- ${problems.join('\n- ')}\n` : `${MAP_PATH} is good: ${files.length} files.\n`);
    return problems.length ? 1 : 0;
  }
  if (cmd === 'hook') {
    io.out(installHook(root) ? 'added the readfirst hook to .claude/settings.json: Claude Code now sees the read list before each edit.\n' : '.claude/settings.json already has the readfirst hook.\n');
    return 0;
  }
  if (cmd === 'fix') {
    const { map, changes, problems } = fixMap(readMapFile(root), files);
    if (changes.length) writeFileSync(join(root, MAP_PATH), `${JSON.stringify(map, null, 2)}\n`);
    if (args.json) io.out(`${JSON.stringify({ ok: !problems.length, changes, problems }, null, 2)}\n`);
    else {
      io.out(changes.length ? `updated ${MAP_PATH}:\n- ${changes.join('\n- ')}\n` : 'nothing to fix automatically.\n');
      io.out(problems.length ? `still to fix by hand:\n- ${problems.join('\n- ')}\n` : `${MAP_PATH} is good: ${files.length} files.\n`);
    }
    return problems.length ? 1 : 0;
  }
  if (cmd === 'read' || cmd === 'diff') {
    const map = loadMapLenient(root, files, io);
    let targets = rest;
    if (cmd === 'diff') {
      const changed = changedFiles(root, args.base);
      targets = changed.files;
      if (!targets.length) {
        io.out(args.json ? `${JSON.stringify(emptyList(commit), null, 2)}\n` : `no files changed since ${changed.ref}.\n`);
        return 0;
      }
    }
    const limit = Number(args.limit ?? 30);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit needs a whole number of 1 or more');
    const list = readList({ map, files, imports: importEdges(files, readText(root)), targets, commit, limit });
    io.out(args.json ? `${JSON.stringify(list, null, 2)}\n` : `${toMarkdown(list)}\n`);
    return 0;
  }
  if (cmd === 'verify') {
    const map = loadMapLenient(root, files, io);
    const changed = changedFiles(root, args.base);
    const list = changed.files.length
      ? readList({ map, files, imports: importEdges(files, readText(root)), targets: changed.files, commit, limit: 1 })
      : emptyList(commit);
    const timeout = Number(args.timeout ?? 900);
    if (!(timeout > 0)) throw new Error('--timeout needs a number of seconds above 0');
    const result = verifyChecks(root, list.checks, { dryRun: args.dryRun, timeout, progress: args.json ? () => {} : io.out });
    const report = { format: 'readfirst/verify@1', commit, base: changed.ref, files: changed.files, ok: result.every((c) => c.status === 'pass' || c.status === 'listed'), checks: result };
    if (args.json) io.out(`${JSON.stringify(report, null, 2)}\n`);
    else io.out(verifyText(report, args.dryRun));
    return report.ok ? 0 : 1;
  }
  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}
