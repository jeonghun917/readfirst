// readfirst: what to read and check before changing a file.
//   readfirst init [--agent] [--ci] write a first .readfirst/map.json from the file tree (and, with --agent, what setup does; the Action)
//   readfirst setup [--for a,b]    wire the agents this repository uses: the agent-notes line, the Claude Code hook, MCP configs
//   readfirst prompt               the brief for a coding agent to fill in titles, checks, risks and rules
//   readfirst prompt --labels <lang>  the brief for personal labels (a translation and plain notes) for the view
//   readfirst check                the map covers every tracked file and is well formed
//   readfirst fix                  place new files and drop patterns for deleted ones, then check
//   readfirst export --cursor      the map as Cursor rules (.cursor/rules/readfirst-<group>.mdc); --check: fail if stale
//   readfirst audit                the whole repository against the map, as a report: stale rules, moved hot spots,
//                                  what was never filled in, code no test reaches, what readfirst could not see
//   readfirst scan                 published bug shapes across the code (a QuerySet .filter() whose result is dropped, an
//                                  expect(...).resolves nobody awaits); no map needed, no model, writes nothing
//   readfirst find <words>...      before writing something new: functions, files and map entries that may already do it
//   readfirst read <file>...       the read list for files you are about to change
//   readfirst diff [--base <ref>]  the read list for the files changed since <ref> (default: origin/main, else main)
//   readfirst verify [--base <ref>] run the checks the read list names for the changed files; exit 1 if one fails
//                                  (--record: write the rules whose checks all passed to .readfirst/held.json, with the commit)
//   readfirst hook [--install]     a Claude Code PreToolUse hook: the read list for the file an Edit or Write is about to change
//                                  (--install --verify also adds a Stop hook, `hook --stop`, that runs verify before Claude Code finishes)
//   readfirst mcp                  an MCP server on stdio: read_list, changed_read_list and check_map as tools for any agent
//   readfirst pending              map edits waiting on an unmerged upkeep branch (from local refs, as of the last fetch)
//   readfirst view [--out <file>]  the map as a city in one HTML page (default .readfirst/local/view.html)
// Options: --root <dir> (default: the current git repository), --json, --limit <n>, --version; --name=value works too.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { importEdges } from './imports.mjs';
import { scan, scanTextReport } from './scan.mjs';
import { MAP_PATH, draftChecks, draftMap, fixMap, mapProblems, matcher, migrateMap, settleMap, unBom, unshownRisks } from './map.mjs';
import { agentBrief } from './prompt.mjs';
import { pendingDue, pendingLine, pendingUpkeep } from './pending.mjs';
import { bashWrites } from './bash-writes.mjs';
import { pinFiles, pinnedReadfirst, pinProblems } from './pins.mjs';
import { audit, auditText, parseBlame, parseLog } from './audit.mjs';
import { find, findText } from './find.mjs';
import { CURSOR_DIR, cursorPlan } from './export.mjs';
import { AGENTS, detectAgents, outsideRepo, setupAgents } from './agents.mjs';
import { HELD_PATH, heldInRun, parseHeld, recordHeld } from './held.mjs';
import { keepLocal, labelsBrief, LOCAL_DIR, readLabels } from './labels.mjs';
import { viewData } from './view.mjs';
import { mcpHandler, serveMcp } from './mcp.mjs';
import { cityData, viewHtmlCity } from './view-city.mjs';
import { emptyList, readList, toMarkdown } from './readlist.mjs';
import { brokeBefore, readScarLog } from './history.mjs';
import { cachedBrokeBefore, cachedEdges } from './hook-cache.mjs';

const HELP = `readfirst — what to read and check before changing a file

  readfirst init [--agent] [--ci] write a first ${MAP_PATH} from the file tree
  readfirst setup [--for a,b]    wire the agents this repository uses: the read-first line, the Claude Code hook,
                                 the MCP server for Cursor, VS Code, Gemini CLI, Codex and OpenCode (project files only)
  readfirst prompt               brief for your coding agent to fill in the map
  readfirst check [--strict]     check the map covers every tracked file (new files beside placed ones pass; --strict fails on them)
  readfirst fix                  place new files, drop patterns for deleted ones
  readfirst audit                the whole repository against the map: stale rules, moved hot spots, code no test reaches
  readfirst export --cursor      write the map as Cursor rules, one .mdc per group (--check: fail if they are out of date)
  readfirst scan                 look for known bug shapes: results thrown away, test assertions nobody awaits (no map needed)
  readfirst find <words>...      before writing something new: what in the code may already do it
  readfirst read <file>...       read list for files you are about to change
  readfirst diff [--base <ref>]  read list for files changed since <ref>
  readfirst verify [--base <ref>]  run the checks for the files changed since <ref> (--dry-run lists them;
                                 --record notes in .readfirst/held.json which rules held, at which commit)
  readfirst hook [--install]     Claude Code hook: the read list before each edit (--install adds it to .claude/settings.json;
                                 --install --verify also runs the checks for edited files before Claude Code finishes)
  readfirst view [--out <file>]  the map as a city in one HTML page
  readfirst mcp                  MCP server on stdio for Cursor, Codex, Windsurf and other agents
  readfirst pending              map edits waiting on an unmerged upkeep branch (local refs, as of the last fetch)
  readfirst prompt --labels <lang>  brief for your agent to write personal labels for the view (e.g. ko, en)

Options: --root <dir>, --json, --limit <n>, --timeout <s> (verify, per check; default 900), --force (init: replace the map),
         --version; an option's value can also follow an = (--base=main),
         --agent (init: also run setup), --for (setup: the agents to wire, e.g. cursor,codex),
         --ci (init: add .github/workflows/readfirst.yml, the Action with auto-fix)`;

// The on/off flags (name -> key in args) and the options that take a value. Anything else that starts with `--` is an
// error: an unknown option used to take the next word as its value, so `hook --new-flag --stop` quietly ran the wrong hook.
const FLAGS = { json: 'json', force: 'force', agent: 'agent', install: 'install', 'dry-run': 'dryRun', record: 'record', cursor: 'cursor', check: 'check', strict: 'strict', verify: 'verify', ci: 'ci', stop: 'stop', gate: 'gate', help: 'help', version: 'version' };
const VALUES = new Set(['root', 'limit', 'timeout', 'base', 'out', 'for', 'labels']);
export function parse(argv) {
  const args = { _: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Everything after `--` is a name, never an option: the MCP server passes file names and words from the agent.
    if (a === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (a === '-h') { args.help = true; continue; }
    if (!a.startsWith('--')) { args._.push(a); continue; }
    // --name=value is the same as --name value.
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (Object.hasOwn(FLAGS, name)) {
      if (eq >= 0) throw new Error(`--${name} takes no value`);
      args[FLAGS[name]] = true;
    } else if (VALUES.has(name)) {
      const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new Error(`--${name} needs a value`);
      args[name] = v;
    } else throw new Error(`unknown option --${name} (\`readfirst --help\` lists them)`);
  }
  return args;
}

export const VERSION = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// The command word: the first argument that is not an option or an option's value.
function firstWord(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') return argv[i + 1];
    if (!a.startsWith('-')) return a;
    if (VALUES.has(a.slice(2))) i++;
  }
  return undefined;
}

// stderr is captured, not shown: a repository with no commits yet makes `rev-parse HEAD` complain, and that is expected.
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function repoFiles(root) {
  // Tracked files plus new files not ignored by .gitignore, so a file being added can be looked up before its commit.
  return git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)
    .filter((f) => existsSync(join(root, f))).sort();
}

export const readText = (root) => (path) => {
  try { return unBom(readFileSync(join(root, path), 'utf8')); } catch { return null; }
};

export function readMapFile(root) {
  const at = join(root, MAP_PATH);
  if (!existsSync(at)) throw new Error(`no ${MAP_PATH} here: run \`readfirst init\` first`);
  try { return JSON.parse(unBom(readFileSync(at, 'utf8'))); } catch (e) { throw new Error(`${MAP_PATH} is not valid JSON: ${e.message}`); }
}

// prompt's map: what `check` passes, prompt takes. New files beside placed ones and patterns for deleted files are
// settled the way fix would (settleMap), as check does; what check fails on still stops it. It used to take only a map
// with nothing to settle, so `check` passed and `prompt` refused the same tree (a new TODO.md, init --agent's files).
function loadMap(root, files) {
  const { map, problems } = settleMap(readMapFile(root), files);
  if (problems.length) throw new Error(`${MAP_PATH} has problems (\`readfirst check\` lists them, \`readfirst fix\` repairs most):\n- ${problems.join('\n- ')}`);
  return map;
}

// A file readfirst writes in the checkout must be in it: a symlinked .readfirst or .cursor/rules, or a symlinked file,
// carries the write outside the repository (export, init and fix did, 2026-11-09). setup prints what to add instead;
// these stop before writing anything.
function mustBeInside(root, ...paths) {
  const away = paths.map((p) => [p, outsideRepo(root, p)]).filter(([, a]) => a);
  if (away.length) throw new Error(`${away.map(([p, a]) => `${p} leads outside the repository (to ${a})`).join('; ')}: nothing was written`);
}

// Import edges over the tracked files plus the targets that are gone (deleted or moved away): a file that still imports a
// deleted one then shows as its user, the break that matters most (2026-11-09: diff and verify listed no users at all).
export const edgesWith = (files, targets, read) => importEdges([...new Set([...files, ...targets])].sort(), read);

// read and diff keep working while the map is only behind the code (new files in no group, patterns for deleted files):
// they warn and point at `readfirst fix`. A map that is broken in itself still stops them.
// Without a map, read and diff still work: `readfirst read` then shows where the code broke before, from git history, and
// loadMapLenient gives null (the read list leaves map entries out). With allowNone false a missing map throws as before.
function loadMapLenient(root, files, io, { allowNone = false } = {}) {
  if (allowNone && !existsSync(join(root, MAP_PATH))) {
    io.err(`note: no ${MAP_PATH} here, so only git history is shown; \`readfirst init\` writes a first map.\n`);
    return null;
  }
  const map = readMapFile(root);
  const broken = mapProblems(map, files, { placement: false });
  if (broken.length) throw new Error(`${MAP_PATH} has problems:\n- ${broken.join('\n- ')}`);
  const { map: settled, problems: behind, settled: placed } = settleMap(map, files);
  if (behind.length) io.err(`note: ${MAP_PATH} is behind the code (${behind.length} problem${behind.length > 1 ? 's' : ''}); \`readfirst fix\` repairs most of it.\n`);
  else if (placed.length) io.err(`note: ${placed.length} change${placed.length > 1 ? 's' : ''} not yet written in ${MAP_PATH} (new files placed by their neighbours); \`readfirst fix\` writes ${placed.length > 1 ? 'them' : 'it'} down.\n`);
  if (settled !== map) asWritten.set(settled, map);
  return settled;
}
// The map as written, for a map loadMapLenient settled (readList's `before`).
const asWritten = new WeakMap();

// The one line that makes a coding agent use readfirst, added to the agent notes the project already has (CLAUDE.md,
// AGENTS.md, .cursorrules), or to a new AGENTS.md when it has none. A file that already mentions readfirst is left alone.
export const AGENT_LINE = 'Before changing a file, run `npx readfirst read <file>` and follow what it says: keep the rules, read the risks, run the checks it lists. Before writing a new function or module, run `npx readfirst find <what it does>` and reuse what already exists. Before you finish, run `npx readfirst verify`: it runs the checks the map lists for everything you changed; fix what fails. When you learn something a newcomer would get wrong, add it as a risk in .readfirst/map.json.';
// Adds the line to one notes file (created when missing). Returns whether it wrote, or, for a file that is really
// outside the repository (a symlink), the line for the user to add it by hand.
function addLineTo(root, f) {
  const away = outsideRepo(root, f);
  if (away) return `${f} was left alone (it is outside the repository, at ${away}); add this line to it by hand: ${AGENT_LINE}`;
  const at = join(root, f);
  const now = existsSync(at) ? readFileSync(at, 'utf8') : '';
  if (/readfirst/u.test(now)) return false;
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, `${now}${now && !now.endsWith('\n') ? '\n' : ''}${now ? '\n' : ''}${AGENT_LINE}\n`);
  return true;
}
function addAgentLine(root) {
  const notes = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', 'GEMINI.md', '.windsurfrules', '.github/copilot-instructions.md'].filter((f) => existsSync(join(root, f)));
  const results = (notes.length ? notes : ['AGENTS.md']).map((f) => [f, addLineTo(root, f)]);
  return { wrote: results.filter(([, r]) => r === true).map(([f]) => f), manual: results.map(([, r]) => r).filter((r) => typeof r === 'string') };
}

// The agent notes line, plus each detected (or named) agent wired to readfirst: the Claude Code hook, and the MCP server
// in the project's own config for Cursor, VS Code, Gemini CLI, Codex and OpenCode (src/agents.mjs).
function setup(root, only) {
  const agents = only ? only.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean) : detectAgents(root);
  const unknown = agents.filter((a) => !AGENTS.includes(a));
  if (unknown.length) throw new Error(`unknown agent: ${unknown.join(', ')} (one of ${AGENTS.join(', ')})`);
  const { wrote, manual } = addAgentLine(root);
  // A settings file setup cannot rewrite (comments, not an object, outside the repository) is left alone and the hook
  // printed, as for the other agents' configs: throwing here stopped init --agent half-way, after the notes were written.
  if (agents.includes('claude')) {
    try { if (installHook(root)) wrote.push('.claude/settings.json'); } catch (e) { manual.push(`${e.message}; ${hookSnippet()}`); }
  }
  const done = setupAgents(root, agents, { addLine: (f) => addLineTo(root, f) });
  return { agents, wrote: [...new Set([...wrote, ...done.wrote])], manual: [...new Set([...manual, ...done.manual])] };
}
function setupReport({ agents, wrote, manual }) {
  return [
    agents.length ? `agents found: ${agents.join(', ')}.` : 'no agent settings found in this repository; added the line to the agent notes only (name them with --for, e.g. --for cursor,codex).',
    wrote.length ? `wrote: ${wrote.join(', ')}.` : 'everything was already set up.',
    ...manual.map((m) => `by hand: ${m}`),
    ...(agents.includes('codex') ? ['Codex reads .codex/config.toml only in a project you have marked as trusted.'] : []),
  ].join('\n') + '\n';
}

// The files changed since the branch left its base. `here` is true when the base found is the branch you are on (main
// with no origin/main): then only uncommitted changes show, and commits you made read as nothing changed, so verify
// and diff say so instead of passing.
const exists = (root, ref) => { try { git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`); return true; } catch { return false; } };
// What diff and verify say on the base branch itself: a note when there are uncommitted changes, an error when there are
// none (it cannot tell your commits from the base, and "nothing to verify" would pass a failing check).
function onBaseItself(changed, io) {
  if (!changed.here) return;
  const why = `you are on ${changed.ref}, the base branch itself, and there is no origin/${changed.ref}: readfirst cannot tell your commits from the base`;
  const how = 'pass --base <ref> (the commit you started from, or HEAD~1)';
  if (!changed.files.length) throw new Error(`${why}, and nothing is uncommitted; ${how}`);
  io.err(`note: ${why}, so only uncommitted changes are counted; ${how} to count your commits too.\n`);
}
function changedFiles(root, base) {
  if (base !== undefined && !exists(root, base)) throw new Error(`no branch or commit named ${base} here (\`git branch -a\` lists them)`);
  const ref = base ?? ['origin/main', 'main', 'origin/master', 'master'].find((r) => exists(root, r));
  if (!ref) throw new Error('no base branch found: pass --base <ref>');
  let current = null;
  try { current = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD').trim(); } catch { /* detached */ }
  const here = base === undefined && ref === current;
  let since;
  try { since = git(root, 'merge-base', ref, 'HEAD').trim(); } catch {
    throw new Error(`cannot find where this branch left ${ref}, often because the clone is shallow: fetch more history (git fetch --deepen=100, or fetch-depth: 0 in actions/checkout) or pass --base <ref>`);
  }
  const names = new Set([
    // -z: without it git quotes names with non-ASCII characters ("src/caf\303\251.js"), which then match nothing.
    // --no-renames: a moved file is its old path and its new one, so the group it left still runs its checks.
    ...git(root, 'diff', '--name-only', '--no-renames', '-z', since).split('\0'),
    ...git(root, 'ls-files', '-z', '--others', '--exclude-standard').split('\0'),
  ].filter(Boolean));
  return { ref, since, here, current, files: [...names].sort() };
}

// A check that fails because the dependencies are not installed reads as broken code (a fresh clone or a new worktree:
// ERR_MODULE_NOT_FOUND, "Cannot find package", ModuleNotFoundError; owner's plan B, 2026-11-09). What the output shows,
// said as what it looks like: a change that adds an import of a package not yet in the manifest fails the same way.
export function dependencyHint(root, output = '') {
  const pkg = output.match(/Cannot find package '([^']+)'/u)?.[1] ?? output.match(/Cannot find module '([^./][^']*)'/u)?.[1];
  const py = output.match(/ModuleNotFoundError: No module named '([^']+)'/u)?.[1];
  const file = output.match(/Cannot find module '([./][^']*)'/u)?.[1];
  const noModules = existsSync(join(root, 'package.json')) && !existsSync(join(root, 'node_modules'));
  if (pkg) return `the package ${pkg} is not installed${noModules ? ', and there is no node_modules here (a fresh clone or a new worktree?)' : ''}: install the dependencies (npm ci, or the project's own install step) and run it again; if this change added the import, add the package to package.json too`;
  if (py) return `the Python module ${py} is not installed here (no virtualenv active, or a fresh clone?): install the dependencies and run it again; if this change added the import, add it to the requirements too`;
  if (file) return `a file it imports is not there: ${file} (a wrong import path, or a build step that has not run)`;
  if (noModules && /ERR_MODULE_NOT_FOUND/u.test(output)) return 'there is no node_modules here (a fresh clone or a new worktree?): install the dependencies and run it again';
  return null;
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
    const all = status === 'pass' ? '' : `${r.stdout ?? ''}${r.stderr ?? ''}${r.error && !timedOut ? r.error.message : ''}`.trimEnd();
    const tail = status === 'pass' ? undefined : all.split('\n').slice(-30).join('\n');
    const hint = status === 'fail' ? dependencyHint(root, all) : null;
    out.push({ ...row, status, code: r.status, seconds, ...(tail !== undefined ? { output: tail } : {}), ...(hint ? { hint } : {}) });
  }
  return out;
}

function verifyText(report, dryRun) {
  if (!report.files.length) return `no files changed since ${report.base}: nothing to verify.\n`;
  let s = '';
  if (!report.checks.length) s += `${report.files.length} changed file(s) since ${report.base}; the map lists no checks for them.\n`;
  else if (dryRun) s += `checks for ${report.files.length} changed file(s) since ${report.base}:\n${report.checks.map((c) => `- ${c.run}${c.why ? ` — ${c.why}` : ''}`).join('\n')}\n`;
  else {
    const mark = { pass: 'pass', fail: 'FAIL', timeout: 'TIMEOUT' };
    s += `\nverify: ${report.checks.length} check(s) for ${report.files.length} changed file(s) since ${report.base}\n`;
    for (const c of report.checks) s += `${mark[c.status]}  ${c.run}  (${c.seconds}s)\n`;
    for (const c of report.checks.filter((x) => x.status !== 'pass')) s += `\n--- ${c.run} (${c.status}${c.code != null ? `, exit ${c.code}` : ''}); last lines:\n${c.output}\n${c.hint ? `It looks like ${c.hint}.\n` : ''}`;
  }
  s += doneText(report);
  if (!dryRun) {
    const failed = report.checks.filter((c) => c.status !== 'pass').length;
    const left = report.missing.length;
    s += report.ok ? (report.checks.length || report.together.length ? '\nall checks passed.\n' : '') : `\n${[failed ? `${failed} check(s) failed` : null, left ? `${left} file(s) the map says change together were left out` : null].filter(Boolean).join('; ')}.\n`;
  }
  return s;
}

// The rest of what "done" means beyond the checks: files that change together, rules nothing checks, and other
// repositories that depend on what changed. Only the first fails verify; the others are said out loud.
export function doneReport(map, list) {
  const missing = list.together.filter((t) => !t.changed);
  const unverified = list.rules.filter((r) => !((map.rules ?? []).find((x) => x.id === r.id)?.checks ?? []).length).map((r) => r.id);
  return { together: list.together, missing, unverified, dependents: list.dependents };
}

function doneText(r) {
  let s = '';
  for (const t of r.missing) s += `\nNOT CHANGED TOGETHER: ${t.for.join(', ')} changed, but none of ${t.also.join(', ')} did — ${t.why}\n`;
  if (r.unverified.length) s += `\nno check covers rule(s) ${r.unverified.join(', ')}: nothing here shows they still hold. Give them a check in the map.\n`;
  for (const d of r.dependents) s += `\nother repository: ${d.repo}${d.paths.length ? ` (${d.paths.join(', ')})` : ''} depends on ${d.for.join(', ')} — ${d.why}. readfirst cannot see it from here: check it before you call this done.\n`;
  return s;
}

// The read list as factual lines for an agent's context: what to do first (being replaced, change together, other
// repositories, checks), then what to know (rules, risks, where it broke, tests, what readfirst could not see). Every
// line is given (0.27.1: no "N more"); with several files, a line for only some of them names them.
export function brief(list) {
  const lines = [];
  const all = (list.targets ?? []).length;
  const forSome = (row) => (all > 1 && row.for && row.for.length < all ? ` [${row.for.join(', ')}]` : '');
  for (const d of list.deprecated ?? []) lines.push(`Being replaced: group ${d.group}${d.use ? `; use ${d.use} instead` : ''} (${d.why}). Do not add to it.${forSome(d)}`);
  for (const t of list.together ?? []) lines.push(`Change together: when this file changes, also change ${t.also.join(' or ')} (${t.why}). verify fails otherwise.${forSome(t)}`);
  for (const d of list.dependents ?? []) lines.push(`Another repository depends on this: ${d.repo}${d.paths.length ? ` (${d.paths.join(', ')})` : ''} (${d.why}).${forSome(d)}`);
  for (const c of list.checks) lines.push(`Check to run after the change: ${c.run}${c.why ? ` (${c.why})` : ''}${forSome(c)}`);
  for (const r of list.rules) lines.push(`Rule ${r.id}: ${r.rule}${r.why ? ` (why: ${r.why})` : ''}${forSome(r)}`);
  for (const r of list.risks) lines.push(`Risk: ${r.text}${forSome(r)}`);
  for (const t of list.targets ?? []) {
    const b = t.brokeBefore;
    if (b && !b.notFetched) lines.push(`Broke before: ${b.count} fix${b.count === 1 ? '' : 'es'} in ${t.path}, last ${b.last.date} ${b.last.sha} "${b.last.subject}"`);
    else if (b) lines.push(`Broke before: history not fetched for ${t.path} (shallow clone)`);
  }
  if (list.tests.length) lines.push(`Tests that reach ${all > 1 ? 'these files' : 'this file'}: ${list.tests.map((t) => `${t.path}${forSome(t)}`).join(', ')}`);
  if (lines.length) for (const u of list.unseen ?? []) lines.push(`Not seen by readfirst: ${u.why}`);
  return lines;
}

// Which files the PreToolUse hook has seen in a session, by absolute path: the Stop hook verifies those. A session can
// start in a folder above several repositories, so each file belongs to the repository that holds it, not to the
// session's folder. Older state files hold paths relative to the session's repository; they still read.
// Hooks of one session run at the same time (an agent's parallel edits), so the state is append-only: each call adds one
// line per file it marked ([key, time] as JSON) in a single write, and nobody rewrites what another call wrote. The
// whole-object .json file older versions wrote (last writer wins) is still read, never written.
const seenFile = (stateDir, session, ext = 'lines') => join(stateDir, `readfirst-hook-${String(session ?? 'none').replace(/[^\w-]/gu, '')}.${ext}`);
// The files marked in a session (key -> time), or null when it has no state at all.
function readSeen(stateDir, session) {
  let seen = null;
  try { const old = JSON.parse(readFileSync(seenFile(stateDir, session, 'json'), 'utf8')); if (old && typeof old === 'object' && !Array.isArray(old)) seen = { ...old }; } catch { /* none */ }
  let text = null;
  try { text = readFileSync(seenFile(stateDir, session), 'utf8'); } catch { return seen; }
  seen ??= {};
  for (const line of text.split('\n')) {
    try {
      const [key, at] = JSON.parse(line);
      if (typeof key === 'string' && typeof at === 'number') seen[key] = Math.max(seen[key] ?? 0, at);
    } catch { /* a line cut short */ }
  }
  return seen;
}
function addSeen(stateDir, session, before, seen) {
  const lines = Object.entries(seen).filter(([k, at]) => before[k] !== at).map((e) => `${JSON.stringify(e)}\n`);
  if (lines.length) appendFileSync(seenFile(stateDir, session), lines.join(''));
}
const repoOf = (dir) => { try { return git(dir, 'rev-parse', '--show-toplevel').trim() || null; } catch { return null; } };
// The path with its folder resolved through symlinks, as git's top level is: the nearest existing folder is resolved and
// the rest (a new file, new folders) kept. Without it a file reached through a linked folder is outside its repository.
function physical(abs) {
  let dir = dirname(abs);
  const rest = [basename(abs)];
  while (!existsSync(dir) && dirname(dir) !== dir) { rest.unshift(basename(dir)); dir = dirname(dir); }
  try { return join(realpathSync(dir), ...rest); } catch { return abs; }
}

// Claude Code PreToolUse hook. Reads the hook's JSON on stdin; for an Edit, Write or MultiEdit of a file, or a Bash
// command that writes files (src/bash-writes.mjs), prints the read list of the files as additionalContext, once per file
// per session: every file the call writes, each repository's lines once, nothing cut (0.27.1; before, the first 10 files
// and 12 lines per file). Never blocks by default; with --gate (`hook --gate`) the first call that touches a file it has
// not shown is refused with the read list as the reason, and the same call goes through when made again, as welsmere's
// map gate does. Any problem means no output.
// budget: how long it may spend looking up (the hook has 15 s). Files it had no time for are named, marked for the Stop
// hook's checks, and looked up on the next call that writes them; with --gate the call is refused so it is made again.
// A call that writes nothing readfirst can name (a script, a build) still marks when the session started in that
// repository, so the Stop hook checks the files changed after it.
export function runHook(input, { now = Date.now(), stateDir = tmpdir(), gate = false, budget = 10_000 } = {}) {
  try {
    const event = JSON.parse(input);
    const cwd = event.cwd ?? process.cwd();
    const tool = event.tool_name ?? '';
    const file = event.tool_input?.file_path;
    const targets = [...new Set((/^(?:Edit|Write|MultiEdit)$/u.test(tool) && file ? [isAbsolute(file) ? file : resolve(cwd, file)]
      : tool === 'Bash' ? bashWrites(event.tool_input?.command, cwd) : []).map(physical))];
    const seen = readSeen(stateDir, event.session_id) ?? {};
    const before = { ...seen };
    const save = () => { try { addSeen(stateDir, event.session_id, before, seen); return true; } catch { return false; } };
    if (!targets.length) {
      const root = repoOf(cwd);
      if (root && !seen[`start:${root}`]) { seen[`start:${root}`] = now; save(); }
      return null;
    }
    const deadline = Date.now() + budget;
    const { notes, late } = notesFor(targets, seen, now, { deadline, stateDir });
    const waiting = pendingNotes(targets, seen, now);
    const saved = save();
    const lateLine = late.length ? `readfirst: no time left in this call (the hook has ${Math.round(budget / 1000)} s) to look up ${late.join(', ')}. ${gate ? 'Make the same call again and readfirst goes on with them;' : 'The next call that writes them gets their notes, and'} the Stop hook checks them all the same; \`npx readfirst read ${late.join(' ')}\` gives them now.` : null;
    if (!notes.length && !waiting.length && !lateLine) return null;
    // Waiting map edits are a word to pass on, never a reason to refuse an edit: --gate denies only for the notes.
    const text = [...notes, ...(lateLine ? [lateLine] : []), ...waiting].join('\n\n');
    // A gate whose state cannot be saved would refuse the same call forever (a full or read-only temp folder): it passes
    // the notes as context instead.
    if (gate && (notes.length || lateLine) && saved) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `readfirst: read this before changing these files, then make the same call again.\n\n${text}` } });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });
  } catch {
    return null;
  }
}

// The repository of a path: that of its nearest existing folder (a new file's folder may not exist yet). `known` keeps
// the answers of one call, so a command writing many files in one folder asks git once.
function rootOf(abs, known = new Map()) {
  let dir = dirname(abs);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  if (!known.has(dir)) known.set(dir, repoOf(dir));
  return known.get(dir);
}

// Once per session for each repository edited: map edits waiting a week or ten merges on its upkeep branch
// (src/pending.mjs). The repository is found from the file, as in notesFor.
function pendingNotes(targets, seen, now) {
  const out = [];
  const known = new Map();
  for (const root of new Set(targets.map((abs) => rootOf(abs, known)))) {
    const key = `pending:${root}`;
    if (!root || seen[key]) continue;
    seen[key] = now;
    const p = pendingUpkeep(root, { now });
    if (pendingDue(p)) out.push(`readfirst: ${pendingLine(p)}.`);
  }
  return out;
}

// What a repository's notes are read from, worked out once per call: its files, map, import graph (kept between calls
// by src/hook-cache.mjs) and the commit its clean files are at.
function hookContext(root, stateDir) {
  const files = repoFiles(root);
  // Without a map the hook still says where the file broke before. A map broken in itself (a rule naming a renamed file,
  // bad JSON) used to make the hook silent for the whole repository: now it says so, with what the map still gives.
  let map = null;
  let broken = [];
  if (existsSync(join(root, MAP_PATH))) {
    try { map = readMapFile(root); broken = mapProblems(map, files, { placement: false }); } catch (e) { map = null; broken = [e.message]; }
  }
  let head = null;
  try { head = git(root, 'rev-parse', '--verify', '-q', 'HEAD').trim() || null; } catch { head = null; }
  let dirty = new Set();
  try { dirty = new Set(git(root, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all').split('\0').filter(Boolean).map((l) => l.slice(3))); } catch { head = null; }
  let imports = null;
  const edges = () => (imports ??= cachedEdges({ root, files, read: readText(root), head, dirty, stateDir, version: VERSION() }));
  return { files, map, broken, head, edges };
}

// The read lists of the files a call writes, one block per repository (its lines once, each marked with the files it is
// for when there are several), or nothing for a repository with nothing to say. Files shown in the last six hours,
// outside a repository, the map itself and .git/ are left out. Marks each file looked up as seen; a file it had no time
// for is marked `touched:` (the Stop hook checks it) and returned in `late`.
function notesFor(targets, seen, now, { deadline = Infinity, stateDir } = {}) {
  const known = new Map();
  const byRoot = new Map();
  for (const abs of targets) {
    const root = rootOf(abs, known);
    if (!root) continue;
    const path = relative(root, abs).replace(/\\/gu, '/');
    if (path.startsWith('..') || path === MAP_PATH || path.startsWith('.git/')) continue;
    const key = join(root, path);
    if (seen[key] && now - seen[key] < 6 * 3600_000) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    if (!byRoot.get(root).includes(path)) byRoot.get(root).push(path);
  }
  const notes = [];
  const late = [];
  for (const [root, paths] of byRoot) {
    const later = (rest) => { for (const p of rest) { seen[`touched:${join(root, p)}`] = now; late.push(p); } };
    if (Date.now() > deadline) { later(paths); continue; }
    const ctx = hookContext(root, stateDir);
    const all = [...new Set([...ctx.files, ...paths])].sort();
    const tracked = new Set(all);
    const done = [];
    const broke = {};
    for (const [i, path] of paths.entries()) {
      if (Date.now() > deadline) { later(paths.slice(i)); break; }
      Object.assign(broke, cachedBrokeBefore({ root, paths: [path], tracked, head: ctx.head, stateDir }));
      done.push(path);
    }
    if (!done.length) continue;
    const listFor = (m) => readList({ map: m, files: all, imports: m ? ctx.edges() : [], targets: done, read: readText(root), held: parseHeld(readText(root)(HELD_PATH)), broke });
    let map = ctx.map;
    let list;
    try { list = listFor(map); } catch { map = null; list = listFor(null); }
    const lines = brief(list);
    if (ctx.broken.length) lines.unshift(brokenMapLine(ctx.broken));
    for (const p of done) seen[join(root, p)] = now;
    if (!lines.length) continue;
    notes.push(`readfirst notes for ${done.join(', ')}${map ? ` (from ${MAP_PATH})` : ''}:\n- ${lines.join('\n- ')}`);
  }
  return { notes, late };
}

// The check commands of the map as the base branch has it. The Stop hook runs a command without anyone asking, so it
// runs only these: a command a branch adds or changes in the map is repository content nobody has merged yet.
// Also why a command is not trusted, for the message.
// The base can move with the session's own commits: on main with no origin/main it is HEAD, and after the session
// pushes to main, origin/main is too. So the map is read at the last base commit older than the session's first mark,
// never one the session made: a check command the session committed to the map ran in 0.26.4 (2026-11-09). No such
// commit: nothing is trusted.
function trustedRuns(root, firstSeen) {
  let ref;
  let since;
  let here;
  let current;
  try { ({ ref, since, here, current } = changedFiles(root)); } catch { return { runs: new Set(), why: 'there is no base branch (main or master) to take trusted commands from' }; }
  // Only when the base is the branch the session commits to (main itself, or origin/main while on main): a feature
  // branch's merge-base holds no commit of the session.
  const ownBase = here || (current && ref === `origin/${current}`);
  if (ownBase && Number.isFinite(firstSeen)) {
    let before = '';
    try { before = git(root, 'rev-list', '-1', `--before=@${Math.floor(firstSeen / 1000) - 1}`, since).trim(); } catch { /* no commits */ }
    if (!before) return { runs: new Set(), why: `no commit of ${ref} is older than this session's first edit` };
    since = before;
  } else if (ownBase) return { runs: new Set(), why: `you are on ${ref} itself, and this session's start is unknown` };
  try {
    const map = JSON.parse(unBom(git(root, 'show', `${since}:${MAP_PATH}`)));
    return { runs: new Set([...(map.groups ?? []), ...(map.rules ?? [])].flatMap((x) => (x.checks ?? []).map((c) => c.run))), why: "the base branch's map does not list them yet" };
  } catch {
    return { runs: new Set(), why: `the base branch (${ref}) has no ${MAP_PATH} yet` };
  }
}

// The line that says the map is broken in itself, for both hooks.
const brokenMapLine = (broken) => `${MAP_PATH} is broken (${broken.length} problem${broken.length === 1 ? '' : 's'}; first: ${broken[0]}), so read, diff and verify stop until it is fixed: \`npx readfirst check\` lists the problems and \`npx readfirst fix\` repairs most.`;

// Claude Code Stop hook (opt-in, `hook --install --verify`): before Claude Code ends its turn, run the map's checks for the
// files it edited in this session that are still changed. A failing check blocks the stop once, with the failure as the
// reason, so the agent fixes it; on the second stop of the same turn it lets go, so a check it cannot fix never traps
// the session. Only commands the base branch's map already lists run; others are named for `readfirst verify`, which
// someone runs on purpose. Nothing edited, nothing changed or no checks: no output.
export function runStopHook(input, { stateDir = tmpdir(), timeout = 600 } = {}) {
  let event;
  try { event = JSON.parse(input); } catch { return null; }
  if (event.stop_hook_active) return null;
  const seen = readSeen(stateDir, event.session_id);
  if (!seen) return null;
  // Edited files by repository: absolute paths by the repository that holds them, older relative ones by the session's.
  const byRoot = new Map();
  const firstSeen = new Map(); // the earliest time a file of each repository was marked
  const here = repoOf(event.cwd ?? process.cwd());
  for (const recorded of Object.keys(seen)) {
    // `pending:` (upkeep said) and `notrun:` (checks said not run) are notes, not files; `start:<root>` is when the
    // session first wrote in a repository through a command readfirst cannot read; `touched:<file>` a file the hook had
    // no time to look up. The last two are checked like any edited file.
    const tag = recorded.match(/^(pending|notrun|start|touched):(.*)$/su);
    if (tag && (tag[1] === 'pending' || tag[1] === 'notrun')) continue;
    if (tag?.[1] === 'start') {
      if (!byRoot.has(tag[2])) byRoot.set(tag[2], []);
      firstSeen.set(tag[2], Math.min(firstSeen.get(tag[2]) ?? Infinity, seen[recorded]));
      continue;
    }
    // Keys recorded before paths were resolved through symlinks are resolved here.
    const raw = tag ? tag[2] : recorded;
    const key = isAbsolute(raw) ? physical(raw) : raw;
    const root = isAbsolute(key) ? repoOf(existsSync(dirname(key)) ? dirname(key) : here ?? '/') : here;
    if (!root) continue;
    const path = isAbsolute(key) ? relative(root, key).replace(/\\/gu, '/') : key;
    if (path.startsWith('..')) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    if (!byRoot.get(root).includes(path)) byRoot.get(root).push(path);
    firstSeen.set(root, Math.min(firstSeen.get(root) ?? Infinity, seen[recorded]));
  }
  const passed = [];
  const blocks = [];
  // Checks that did not run block once for a state of the files: the mark says so to the next stop.
  const said = (key) => Boolean(seen[key]);
  const say = (key) => { try { addSeen(stateDir, event.session_id, {}, { [key]: Date.now() }); } catch { /* blocks again next time */ } };
  for (const [root, edited] of [...byRoot].sort(([a], [b]) => a.localeCompare(b))) {
    const r = stopFor(root, edited, timeout, byRoot.size > 1, firstSeen.get(root), { said, say });
    if (r?.pass) passed.push(r.pass);
    if (r?.block) blocks.push(r.block);
  }
  if (blocks.length) return JSON.stringify({ decision: 'block', reason: blocks.join('\n\n') });
  if (passed.length) return JSON.stringify({ systemMessage: passed.join('\n') });
  return null;
}

// The Stop hook for one repository: its map's checks for the files edited there that are still changed.
function stopFor(root, edited, timeout, named, since, { said = () => false, say = () => {} } = {}) {
  try {
    if (!existsSync(join(root, MAP_PATH))) return null;
    const at = named ? ` in ${basename(root)}` : '';
    const dirty = new Set(git(root, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all').split('\0').filter(Boolean).map((l) => l.slice(3)));
    // Files changed since the session first wrote here that no tool call named (a script, a generator, a build): a check
    // that never ran on them is a check skipped. Two seconds of slack for file systems that keep whole seconds.
    const unnamed = Number.isFinite(since)
      ? [...dirty].filter((f) => !edited.includes(f) && f !== MAP_PATH && (() => { try { return statSync(join(root, f)).mtimeMs >= since - 2000; } catch { return false; } })()).sort()
      : [];
    edited = [...edited, ...unnamed];
    // On the base branch itself (main with no origin/main), with no base branch, or after a push to main, a file committed in the session looks
    // unchanged, and committing before the stop skipped its checks: the files of commits made since the session first
    // marked a file in this repository count too.
    let changed = [];
    let known = true;
    try { const c = changedFiles(root); changed = c.files; known = !c.here; } catch { known = false; }
    // git keeps whole seconds: `committed` (files that count as edited) takes the mark's own second too, so nothing the
    // session committed is missed; `committedAfter` (files that satisfy a "change together") takes only commits from a
    // later second, so a commit made before the session never stands in for a partner it left behind.
    const committed = new Set();
    const committedAfter = new Set();
    if (Number.isFinite(since)) {
      try {
        for (const block of git(root, 'log', `--since=@${Math.floor(since / 1000)}`, '--format=%x01%ct', '--name-only', '-z', 'HEAD').split('\x01').filter(Boolean)) {
          const [ct, ...names] = block.split(/[\0\n]/u).filter(Boolean);
          for (const n of names) { committed.add(n); if (Number(ct) * 1000 > since) committedAfter.add(n); }
        }
      } catch { /* no commits */ }
    }
    const targets = edited.filter((f) => dirty.has(f) || changed.includes(f) || committed.has(f)).sort();
    if (!targets.length) return null;
    const files = repoFiles(root);
    // A map broken in itself blocks the stop once with what is wrong; whatever it still gives is checked.
    let map = null;
    let broken = [];
    try { map = readMapFile(root); broken = mapProblems(map, files, { placement: false }); } catch (e) { broken = [e.message]; }
    let list = null;
    if (map) try { list = readList({ map, files, imports: edgesWith(files, targets, readText(root)), targets }); } catch { list = null; }
    const brokenLine = broken.length ? `readfirst${at}: ${brokenMapLine(broken)}${list ? '' : ' The checks for the files you edited were not run.'} Fix it before you finish.` : null;
    if (!list) return brokenLine ? { block: brokenLine } : null;
    // Files left behind: what the map says changes together with an edited file, against everything changed so far,
    // the session's own commits included: they make a file count as edited, so its partner in the same commits counts
    // as changed too (a pair committed together was reported as left behind until 0.27.1).
    const all = [...new Set([...dirty, ...changed, ...committedAfter])];
    const missing = list.together.filter((t) => !all.some(matcher(t.also)));
    if (!list.checks.length && !missing.length) return brokenLine ? { block: brokenLine } : null;
    const trusted = trustedRuns(root, since);
    const skipped = list.checks.filter((c) => !trusted.runs.has(c.run)).map((c) => c.run);
    const result = verifyChecks(root, list.checks.filter((c) => trusted.runs.has(c.run)), { timeout });
    const failed = result.filter((c) => c.status !== 'pass');
    const notRun = skipped.length ? ` Not run, because ${trusted.why}: ${skipped.map((r) => `\`${r}\``).join(', ')}; run \`npx readfirst verify\` to run them on purpose.` : '';
    const byCommand = unnamed.filter((f) => targets.includes(f));
    const fromCommands = byCommand.length ? ` Changed in this session by commands readfirst could not read, so checked too: ${byCommand.join(', ')}.` : '';
    // Checks that did not run block the stop once for this state of the files (0.27.1: they used to pass it with a note).
    const state = skipped.length ? `notrun:${root}:${treeState(root, dirty)}` : null;
    const blockNotRun = state && !said(state);
    if (blockNotRun) say(state);
    if (!failed.length && !missing.length && !brokenLine && !blockNotRun) return { pass: `readfirst verify${at}: ${result.length} check(s) passed for ${targets.length} edited file(s).${notRun}${fromCommands}` };
    return { block: [
      ...(brokenLine ? [brokenLine] : []),
      ...(failed.length ? [`readfirst verify${at}: ${failed.length} of ${result.length} check(s) the map lists for the files you edited failed. Fix them before you finish.${notRun}${fromCommands}`] : []),
      ...(blockNotRun && !failed.length ? [`readfirst verify${at}: ${skipped.length} check(s) the map lists for the files you edited did not run (${result.length} ran and passed).${notRun} Run it, or say why they need not run, before you finish.${fromCommands}`] : []),
      ...missing.map((t) => `readfirst${at}: ${t.for.join(', ')} changed, but none of ${t.also.join(', ')} did. The map says they change together: ${t.why}. Change it too, or say why it does not apply, before you finish.`),
      ...failed.map((c) => `\n--- ${c.run} (${c.status}${c.code != null ? `, exit ${c.code}` : ''})${c.why ? ` covers ${c.why}` : ''}; last lines:\n${c.output ?? ''}${c.hint ? `\nIt looks like ${c.hint}.` : ''}`),
    ].join('\n') };
  } catch {
    return null;
  }
}

// The state of a repository's files, as a short hash: HEAD and each changed file with its size and time.
function treeState(root, dirty) {
  let head = '';
  try { head = git(root, 'rev-parse', '--verify', '-q', 'HEAD').trim(); } catch { head = ''; }
  const parts = [...dirty].sort().map((f) => { try { const st = statSync(join(root, f)); return `${f}\0${st.size}\0${st.mtimeMs}`; } catch { return `${f}\0gone`; } });
  return createHash('sha1').update([head, ...parts].join('\0')).digest('hex').slice(0, 16);
}

export const WORKFLOW_PATH = '.github/workflows/readfirst.yml';
// The Action as `init --ci` writes it: on each PR, the read-list comment, and new files placed in the map on the PR's
// branch (auto-fix). Never over a workflow that is already there.
// Returns whether it wrote; a path that is really outside the repository (a symlinked .github) is left alone.
export function writeWorkflow(root) {
  const at = join(root, WORKFLOW_PATH);
  if (existsSync(at) || outsideRepo(root, WORKFLOW_PATH)) return false;
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, [
    '# readfirst: one comment per PR with the rules, risks and checks for the files it changes,',
    '# and new files placed in .readfirst/map.json on the PR branch (auto-fix). https://github.com/jeonghun917/readfirst',
    'name: readfirst',
    'on: pull_request',
    'permissions:',
    '  contents: write       # auto-fix commits the map update to the PR branch',
    '  pull-requests: write  # the comment',
    'jobs:',
    '  readfirst:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    '        with:',
    '          fetch-depth: 200  # the comment lists files that broke before, from git history',
    '      - uses: jeonghun917/readfirst@v0',
    '        with:',
    '          auto-fix: true',
    '',
  ].join('\n'));
  return true;
}

export const HOOK_COMMAND = 'npx --yes readfirst hook';
export const STOP_HOOK_COMMAND = 'npx --yes readfirst hook --stop';
// Adds the hook to the project's .claude/settings.json, keeping everything already there. With verify, also the Stop
// hook that runs the checks before Claude Code finishes.
// What to add by hand when installHook leaves the file alone.
const hookSnippet = (verify = false) => `add ${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 15 }] }], ...(verify ? { Stop: [{ hooks: [{ type: 'command', command: STOP_HOOK_COMMAND, timeout: 1800 }] }] } : {}) } })} to it by hand`;
export function installHook(root, { verify = false } = {}) {
  const at = join(root, '.claude', 'settings.json');
  const away = outsideRepo(root, '.claude/settings.json');
  if (away) throw new Error(`.claude/settings.json was left alone (it is outside the repository, at ${away})`);
  let settings = {};
  if (existsSync(at)) {
    try { settings = JSON.parse(unBom(readFileSync(at, 'utf8'))); } catch { throw new Error('.claude/settings.json was left alone (it is not plain JSON: comments or a trailing comma?)'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('.claude/settings.json was left alone (it is not a JSON object)');
  }
  const pre = ((settings.hooks ??= {}).PreToolUse ??= []);
  const has = (list) => list.some((m) => (m.hooks ?? []).some((h) => /readfirst hook/u.test(h.command ?? '')));
  let added = false;
  if (!has(pre)) { pre.push({ matcher: 'Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 15 }] }); added = true; }
  if (verify) {
    const stop = (settings.hooks.Stop ??= []);
    if (!has(stop)) { stop.push({ hooks: [{ type: 'command', command: STOP_HOOK_COMMAND, timeout: 1800 }] }); added = true; }
  }
  if (!added) return false;
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(at, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, stdin = () => readFileSync(0, 'utf8')) {
  // A hook that cannot read its own command line, or fails before it starts, warns and lets the call through: exit 2
  // from a PreToolUse hook refuses the tool call, so one option this readfirst did not know (an older one under a newer
  // settings.json) stopped every Edit and Bash call of the session, including the ones that would fix it (2026-11-08).
  const hookCall = firstWord(argv) === 'hook' && !argv.includes('--install');
  const letThrough = (e) => {
    io.out(`${JSON.stringify({ systemMessage: `readfirst ${VERSION()} hook: ${e.message}. The hook did nothing and let this call through; fix the hook command in .claude/settings.json.` })}\n`);
    return 0;
  };
  let args;
  try { args = parse(argv); } catch (e) { if (hookCall) return letThrough(e); throw e; }
  const [cmd, ...rest] = args._;
  if (args.version) { io.out(`${VERSION()}\n`); return 0; }
  if (args.help || !cmd) { io.out(`${HELP}\n`); return cmd || args.help ? 0 : 2; }
  if (cmd === 'hook' && !args.install) {
    try {
      const out = args.stop ? runStopHook(stdin()) : runHook(stdin(), { gate: args.gate });
      if (out) io.out(`${out}\n`);
    } catch (e) { return letThrough(e); }
    return 0;
  }
  if (cmd === 'mcp') {
    // The server starts and answers initialize and tools/list anywhere, also outside a git repository (directories
    // start it in an empty container to check it). The repository is looked up at each tool call.
    const version = VERSION();
    const run = (argv) => {
      let out = ''; let err = ''; let code;
      try {
        const root = args.root ?? (() => {
          try { return git(process.cwd(), 'rev-parse', '--show-toplevel').trim(); } catch { throw new Error(`not inside a git repository (${process.cwd()}): start the server in your repository, or pass --root <dir>`); }
        })();
        code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: (s) => { err += s; } });
      } catch (e) { code = 2; err += e.message; }
      return { code, out, err };
    };
    serveMcp({ handle: mcpHandler({ run, version }), input: process.stdin, output: process.stdout });
    return 0;
  }
  const root = args.root ?? git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const files = repoFiles(root);
  const commit = (() => { try { return git(root, 'rev-parse', 'HEAD').trim(); } catch { return null; } })();

  if (cmd === 'init') {
    const at = join(root, MAP_PATH);
    if (existsSync(at) && args.force !== true) throw new Error(`${MAP_PATH} already exists (pass --force to replace it)`);
    mustBeInside(root, MAP_PATH);
    // The agent notes, agent configs and the workflow are written first and the files listed again, so the map places
    // them: written after it, they were in no group and the very next step (prompt, check) stopped there (2026-11-08).
    const later = [];
    if (args.agent) later.push(setupReport(setup(root, args.for)));
    if (args.ci) later.push(writeWorkflow(root) ? `wrote ${WORKFLOW_PATH}: a PR comment with the read list, and new files placed in the map on the PR branch.\n` : outsideRepo(root, WORKFLOW_PATH) && !existsSync(join(root, WORKFLOW_PATH)) ? `${WORKFLOW_PATH} was left alone: it is outside the repository, at ${outsideRepo(root, WORKFLOW_PATH)}.\n` : `${WORKFLOW_PATH} already exists; left as it is.\n`);
    const now = later.length ? repoFiles(root) : files;
    const map = draftMap(now, readText(root));
    mkdirSync(join(root, '.readfirst'), { recursive: true });
    writeFileSync(at, `${JSON.stringify(map, null, 2)}\n`);
    const repoChecks = draftChecks(now, readText(root)).map((c) => c.run);
    const scoped = map.groups.filter((g) => g.checks.length && g.checks.some((c) => !repoChecks.includes(c.run))).length;
    io.out(`wrote ${MAP_PATH}: ${map.groups.length} group${map.groups.length === 1 ? '' : 's'}${repoChecks.length ? `, checks found: ${repoChecks.join(', ')}` : ''}${scoped ? `; ${scoped} workspace package${scoped === 1 ? '' : 's'} got ${scoped === 1 ? 'its' : 'their'} own checks` : ''}.\n`);
    for (const line of later) io.out(line);
    const next = [
      'run `readfirst prompt` and give the brief to your coding agent (or fill in titles, risks and rules by hand)',
      ...(args.agent ? [] : ['`readfirst setup` wires the agents this repository uses (Claude Code, Cursor, VS Code, Gemini CLI, Codex, OpenCode) to readfirst']),
      'Claude Code: `readfirst hook --install` gives it the read list before each edit (`--verify` also runs the checks before it finishes)',
      ...(args.ci ? [] : ['`readfirst init --ci` would add the GitHub Action that comments on PRs and keeps the map in step']),
    ];
    io.out(`Next:\n${next.map((n) => `- ${n}`).join('\n')}\n`);
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
    if (!args.out) mustBeInside(root, `${LOCAL_DIR}/view.html`); // --out is where the person asked for it
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, viewHtmlCity(cityData(viewData({ map, files, imports, name: basename(root) }), imports, labels)));
    const langs = Object.keys(labels);
    io.out(`wrote ${relative(process.cwd(), out) || out}${langs.length ? ` with labels: ${langs.join(', ')}` : ''}. Open it in a browser (it loads three.js from a CDN).\n`);
    if (!langs.length) io.out('Tip: `readfirst prompt --labels ko` (or en) gives your agent a brief for a translation and plain notes, seen only on this machine.\n');
    return 0;
  }
  if (cmd === 'pending') {
    const p = pendingUpkeep(root);
    if (args.json) io.out(`${JSON.stringify({ pending: p, due: pendingDue(p) }, null, 2)}\n`);
    else io.out(p ? `${pendingLine(p)}.\n` : 'No map edits waiting on an upkeep branch (as of the last fetch).\n');
    return 0;
  }
  if (cmd === 'check') {
    // Placing new files next to their neighbours and dropping patterns for deleted files is what `fix` does; check
    // settles those the same way and passes. --strict fails on them too.
    const map = readMapFile(root);
    const settledMap = args.strict ? { problems: mapProblems(map, files), settled: [] } : settleMap(map, files);
    const { settled } = settledMap;
    // The map must also pass the readfirst the repository's CI runs, which may be older than this one.
    const read = readText(root);
    // Risks that name a file which does not show them (0.27.2): those about it first, and with --strict a problem; those
    // that only mention it after them. All are said.
    const unshown = unshownRisks(map, files);
    const line = (u) => `groups.${u.group}.risks[${u.index}] ${u.about ? 'is about' : 'mentions'} ${u.path}, but reading ${u.path} does not show it: add ${u.path} to its files (with the paths it should keep showing for), or write it where ${u.path} is`;
    const about = unshown.filter((u) => u.about).map(line);
    const mentions = unshown.filter((u) => !u.about).map(line);
    const problems = [...settledMap.problems, ...pinProblems(map, pinnedReadfirst(new Map(pinFiles(files).map((f) => [f, read(f)])))), ...(args.strict ? about : [])];
    if (args.json) io.out(`${JSON.stringify({ ok: !problems.length, problems, settled, unshown }, null, 2)}\n`);
    else {
      if (problems.length) io.out(`${MAP_PATH} has ${problems.length} problem(s):\n- ${problems.join('\n- ')}\n`);
      else io.out(`${MAP_PATH} is good: ${files.length} files.\n`);
      if (settled.length) io.out(`settled without writing (\`readfirst fix\` writes it down):\n- ${settled.join('\n- ')}\n`);
      if (about.length && !args.strict) io.out(`risks about a file that does not show them (it gets nothing when it is read; --strict fails on them):\n- ${about.join('\n- ')}\n`);
      if (mentions.length) io.out(`risks that mention a file which does not show them (often a consequence; add the file to their files if whoever changes it should read them):\n- ${mentions.join('\n- ')}\n`);
    }
    return problems.length ? 1 : 0;
  }
  // setup and hook --install may add files (.claude/settings.json, AGENTS.md, .cursor/mcp.json) that an existing map
  // does not place yet, and then `check` fails on them. They do not write the map (only-init-and-fix-write): they say
  // how to place them (2026-11-08).
  const placeHint = () => {
    if (!existsSync(join(root, MAP_PATH))) return '';
    try {
      const missing = mapProblems(readMapFile(root), repoFiles(root)).length;
      return missing ? 'the map does not place every file yet (`npx readfirst check` lists them): run `npx readfirst fix`, or commit and let the Action\'s auto-fix do it.\n' : '';
    } catch { return ''; }
  };
  if (cmd === 'setup') {
    io.out(setupReport(setup(root, args.for)) + placeHint());
    return 0;
  }
  if (cmd === 'hook') {
    let added;
    try { added = installHook(root, { verify: args.verify }); } catch (e) { throw new Error(`${e.message}; ${hookSnippet(args.verify)}`); }
    io.out((added
      ? `added the readfirst hook to .claude/settings.json: Claude Code now sees the read list before each edit${args.verify ? ', and cannot finish while a check for a file it edited fails (it gets one try to fix it)' : ''}.\n`
      : '.claude/settings.json already has the readfirst hook.\n') + placeHint());
    return 0;
  }
  if (cmd === 'fix') {
    // A map with the old vocabulary is rewritten as models and rules first (0.22.0).
    const migrated = migrateMap(readMapFile(root));
    const fixed = fixMap(migrated.map, files);
    const { map, problems } = fixed;
    const changes = [...migrated.changes, ...fixed.changes];
    if (changes.length) { mustBeInside(root, MAP_PATH); writeFileSync(join(root, MAP_PATH), `${JSON.stringify(map, null, 2)}\n`); }
    if (args.json) io.out(`${JSON.stringify({ ok: !problems.length, changes, problems }, null, 2)}\n`);
    else {
      io.out(changes.length ? `updated ${MAP_PATH}:\n- ${changes.join('\n- ')}\n` : 'nothing to fix automatically.\n');
      io.out(problems.length ? `still to fix by hand:\n- ${problems.join('\n- ')}\n` : `${MAP_PATH} is good: ${files.length} files.\n`);
    }
    return problems.length ? 1 : 0;
  }
  if (cmd === 'find') {
    const query = rest.join(' ').trim();
    if (!query) throw new Error('say what you are about to write, e.g. `readfirst find payment retry`');
    const limit = Number(args.limit ?? 15);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit needs a whole number of 1 or more');
    // The map adds its groups, rules and risks to the search; without one (or with a broken one) the code alone is searched.
    let map = null;
    try { const m = readMapFile(root); if (!mapProblems(m, files, { placement: false }).length) map = m; } catch { map = null; }
    const report = find({ query, files, imports: importEdges(files, readText(root)), read: readText(root), map, limit });
    io.out(args.json ? `${JSON.stringify(report, null, 2)}\n` : findText(report));
    return 0;
  }
  if (cmd === 'export') {
    if (!args.cursor) throw new Error('say what to export: `readfirst export --cursor`');
    const map = loadMapLenient(root, files, io);
    const dir = join(root, CURSOR_DIR);
    const existing = existsSync(dir) ? readdirSync(dir).map((f) => `${CURSOR_DIR}/${f}`) : [];
    const plan = cursorPlan(map, files, readText(root), existing);
    if (args.check) {
      const stale = [...plan.write, ...plan.remove];
      io.out(stale.length ? `${stale.length} Cursor rule file(s) no longer match ${MAP_PATH}: ${stale.join(', ')}. Run \`readfirst export --cursor\`.\n` : `Cursor rules match ${MAP_PATH} (${Object.keys(plan.want).length} file(s)).\n`);
      return stale.length ? 1 : 0;
    }
    mustBeInside(root, ...plan.write, ...plan.remove);
    if (plan.write.length) mkdirSync(dir, { recursive: true });
    for (const p of plan.write) writeFileSync(join(root, p), plan.want[p]);
    for (const p of plan.remove) unlinkSync(join(root, p));
    io.out(plan.write.length || plan.remove.length
      ? `${plan.write.length ? `wrote ${plan.write.join(', ')}` : ''}${plan.write.length && plan.remove.length ? '; ' : ''}${plan.remove.length ? `removed ${plan.remove.join(', ')}` : ''}.\nCommit them; \`readfirst export --cursor --check\` in CI keeps them in step with the map.\n`
      : `Cursor rules already match ${MAP_PATH} (${Object.keys(plan.want).length} file(s)).\n`);
    return 0;
  }
  if (cmd === 'scan') {
    const report = scan(files, readText(root));
    io.out(args.json ? `${JSON.stringify(report, null, 2)}\n` : scanTextReport(report));
    return 0;
  }
  if (cmd === 'audit') {
    // Without a map the audit still lists where the code broke most, from git history alone.
    const noMap = !existsSync(join(root, MAP_PATH));
    const broke = readScarLog(root);
    if (noMap) {
      const report = audit({ map: null, files, imports: [], commit, broke });
      io.out(args.json ? `${JSON.stringify(report, null, 2)}\n` : auditText(report));
      return 0;
    }
    const map = readMapFile(root);
    const broken = mapProblems(map, files, { placement: false });
    const { map: settled, problems } = broken.length ? { map, problems: broken } : settleMap(map, files);
    if (broken.length) {
      io.out(args.json ? `${JSON.stringify({ format: 'readfirst/audit@1', commit, files: files.length, problems: broken }, null, 2)}\n` : `${MAP_PATH} has problems; fix them first (\`readfirst check\`):\n- ${broken.join('\n- ')}\n`);
      return 1;
    }
    // Who last wrote each line of the map, and every commit since the oldest of those lines with the files it changed.
    let blame = [];
    let history = [];
    try {
      blame = parseBlame(git(root, 'blame', '--line-porcelain', '--', MAP_PATH));
      const heldTimes = Object.values(parseHeld(readText(root)(HELD_PATH))?.rules ?? {}).map((h) => Date.parse(h.date) / 1000 - 86400).filter(Number.isFinite);
      const oldest = Math.min(...blame.filter(Boolean).map((b) => b.time), ...heldTimes);
      if (Number.isFinite(oldest)) history = parseLog(git(root, 'log', '--no-merges', `--since=${new Date((oldest - 1) * 1000).toISOString()}`, '--format=%x01%H %ct', '--name-only', 'HEAD'));
    } catch { /* the map is not committed yet, or no history: nothing is stale */ }
    const report = audit({ map: settled, problems, files, imports: importEdges(files, readText(root)), read: readText(root), blame, history, commit, held: parseHeld(readText(root)(HELD_PATH)), broke });
    io.out(args.json ? `${JSON.stringify(report, null, 2)}\n` : auditText(report));
    return 0;
  }
  if (cmd === 'read' || cmd === 'diff') {
    const map = loadMapLenient(root, files, io, { allowNone: true });
    // A path is taken as the shell gives it: an absolute path, or one from the current folder (`read math.js` inside
    // src/). It used to be read from the repository root only, so both came back "not a tracked file". With --root (the
    // MCP server, scripts) a relative path stays relative to the root, as before.
    const top = (() => { try { return realpathSync(root); } catch { return resolve(root); } })();
    const fromHere = (given) => {
      const p = given.replace(/\\/gu, '/');
      if (!isAbsolute(p) && args.root) return p;
      const rel = relative(top, physical(isAbsolute(p) ? p : resolve(process.cwd(), p))).replace(/\\/gu, '/');
      return rel && !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel) ? rel : p;
    };
    let targets = rest.map(fromHere);
    // read looks at HEAD; diff at the commit where the branch left its base, so the branch's own "fix: ..." commits are not
    // counted as the file having broken before.
    let rev = 'HEAD';
    if (cmd === 'diff') {
      const changed = changedFiles(root, args.base);
      onBaseItself(changed, io);
      rev = changed.since;
      targets = changed.files;
      if (!targets.length) {
        io.out(args.json ? `${JSON.stringify(emptyList(commit), null, 2)}\n` : `no files changed since ${changed.ref}.\n`);
        return 0;
      }
    }
    // No limit unless asked for: a cut list says how many it left out.
    const limit = args.limit === undefined ? Infinity : Number(args.limit);
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit needs a whole number of 1 or more');
    const broke = brokeBefore(root, targets, new Set(files), rev);
    const list = readList({ map, files, imports: edgesWith(files, targets, readText(root)), targets, commit, limit, read: readText(root), held: parseHeld(readText(root)(HELD_PATH)), broke, before: map && asWritten.get(map) });
    io.out(args.json ? `${JSON.stringify(list, null, 2)}\n` : `${toMarkdown(list)}\n`);
    return 0;
  }
  if (cmd === 'verify') {
    const map = loadMapLenient(root, files, io);
    const changed = changedFiles(root, args.base);
    onBaseItself(changed, io);
    const list = changed.files.length
      ? readList({ map, files, imports: edgesWith(files, changed.files, readText(root)), targets: changed.files, commit, limit: 1, before: asWritten.get(map) })
      : emptyList(commit);
    const timeout = Number(args.timeout ?? 900);
    if (!(timeout > 0)) throw new Error('--timeout needs a number of seconds above 0');
    const result = verifyChecks(root, list.checks, { dryRun: args.dryRun, timeout, progress: args.json ? () => {} : io.out });
    const done = doneReport(map, list);
    const report = { format: 'readfirst/verify@1', commit, base: changed.ref, files: changed.files, ok: result.every((c) => c.status === 'pass' || c.status === 'listed') && !done.missing.length, checks: result, ...done };
    // --record: the rules whose checks all passed in this run, written to .readfirst/held.json at this commit.
    if (args.record && !args.dryRun && commit && changed.files.length) {
      const ids = heldInRun(map, changed.files, result);
      if (ids.length) {
        const dirty = git(root, 'status', '--porcelain', '--untracked-files=no').split('\n').some((l) => l.trim() && !l.endsWith(HELD_PATH));
        const next = recordHeld(parseHeld(readText(root)(HELD_PATH)), ids, { commit, date: new Date().toISOString().slice(0, 10), dirty, map });
        mustBeInside(root, HELD_PATH);
        writeFileSync(join(root, HELD_PATH), `${JSON.stringify(next, null, 2)}\n`);
      }
      report.recorded = ids;
    }
    if (args.json) io.out(`${JSON.stringify(report, null, 2)}\n`);
    else {
      io.out(verifyText(report, args.dryRun));
      if (report.recorded) io.out(report.recorded.length ? `recorded in ${HELD_PATH}: ${report.recorded.join(', ')} held at ${commit.slice(0, 7)}. Commit it so the team sees it.\n` : `nothing recorded: no rule had all of its checks pass in this run.\n`);
    }
    return report.ok ? 0 : 1;
  }
  throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}
