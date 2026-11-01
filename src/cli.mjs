// readfirst: what to read and check before changing a file.
//   readfirst init [--agent]       write a first .readfirst/map.json from the file tree (and the agent-notes line)
//   readfirst prompt               the brief for a coding agent to fill in titles, checks, risks and rules
//   readfirst check                the map covers every tracked file and is well formed
//   readfirst fix                  place new files and drop patterns for deleted ones, then check
//   readfirst read <file>...       the read list for files you are about to change
//   readfirst diff [--base <ref>]  the read list for the files changed since <ref> (default: origin/main, else main)
//   readfirst hook [--install]     a Claude Code PreToolUse hook: the read list for the file an Edit or Write is about to change
// Options: --root <dir> (default: the current git repository), --json, --limit <n>.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { importEdges } from './imports.mjs';
import { assertMap, draftMap, fixMap, MAP_PATH, mapProblems } from './map.mjs';
import { agentBrief } from './prompt.mjs';
import { emptyList, readList, toMarkdown } from './readlist.mjs';

const HELP = `readfirst — what to read and check before changing a file

  readfirst init [--agent]       write a first ${MAP_PATH} from the file tree
  readfirst prompt               brief for your coding agent to fill in the map
  readfirst check                check the map covers every tracked file
  readfirst fix                  place new files, drop patterns for deleted ones
  readfirst read <file>...       read list for files you are about to change
  readfirst diff [--base <ref>]  read list for files changed since <ref>
  readfirst hook [--install]     Claude Code hook: the read list before each edit (--install adds it to .claude/settings.json)

Options: --root <dir>, --json, --limit <n>, --force (init: replace the map),
         --agent (init: add the read-first line to CLAUDE.md / AGENTS.md / .cursorrules)`;

function parse(argv) {
  const args = { _: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--force') args.force = true;
    else if (a === '--agent') args.agent = true;
    else if (a === '--install') args.install = true;
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
export const AGENT_LINE = 'Before changing a file, run `npx readfirst read <file>` and follow what it says: keep the rules, read the risks, run the checks it lists. Before you finish, run `npx readfirst diff` and run every check it lists. When you learn something a newcomer would get wrong, add it as a risk in .readfirst/map.json.';
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
    io.out(agentBrief(loadMap(root, files)));
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
  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}
