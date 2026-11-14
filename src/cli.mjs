// readfirst: what to read and check before changing a file.
//   readfirst init [--agent] [--ci] write a first .readfirst/map.json from the file tree (and, with --agent, what setup does; the Action)
//   readfirst setup [--for a,b]    wire the agents this repository uses: the agent-notes line, the Claude Code hook, MCP configs
//   readfirst setup --git          add `readfirst check` to the pre-commit hook and `readfirst verify` to pre-push
//   readfirst prompt               the brief for a coding agent to fill in titles, checks, risks and rules
//   readfirst prompt --labels <lang>  the brief for personal labels (a translation and plain notes) for the view
//   readfirst check                the map covers every tracked file and is well formed
//   readfirst fix                  place new files and drop patterns for deleted ones, move evidence lines git traces
//   readfirst export --cursor      the map as Cursor rules (.cursor/rules/readfirst-<group>.mdc); --check: fail if stale
//   readfirst audit                the whole repository against the map, as a report: stale rules, moved hot spots,
//                                  what was never filled in, code no test reaches, what readfirst could not see
//   readfirst scan                 published bug shapes across the code (a QuerySet .filter() whose result is dropped, an
//                                  expect(...).resolves nobody awaits); no map needed, no model, writes nothing
//   readfirst find <words>...      before writing something new: functions, files and map entries that may already do it
//   readfirst read <file>...       the read list for files you are about to change
//   readfirst diff [--base <ref>] [--lang <code>]  the read list for the files changed since <ref> (default: origin/main,
//                                  else main), under a verdict in the language given (en, ko)
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
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { importEdges } from './imports.mjs';
import { scan, scanTextReport } from './scan.mjs';
import { MAP_PATH, draftChecks, draftMap, fixMap, mapProblems, matcher, migrateMap, settleMap, unBom, unshownRisks } from './map.mjs';
import { agentBrief } from './prompt.mjs';
import { pendingDue, pendingLine, pendingUpkeep } from './pending.mjs';
import { bashReads, shellWrites } from './bash-writes.mjs';
import { ANSWER_HOW, ANSWER_KINDS, ANSWER_KINDS_LINE, answered, answersIn, givenAnswers, itemTally, lastAnswers, openUnsure, parseAnswer, wideItems } from './answers.mjs';
import { pinFiles, pinnedReadfirst, pinProblems } from './pins.mjs';
import { audit, auditText, parseBlame, parseLog } from './audit.mjs';
import { definitions, find, findText, meets, words } from './find.mjs';
import { CURSOR_DIR, cursorPlan } from './export.mjs';
import { AGENTS, detectAgents, outsideRepo, setupAgents } from './agents.mjs';
import { gitHooksReport, setupGitHooks } from './git-hooks.mjs';
import { evidenceDrift, judge, moveEvidence, parseGitDiff, textChange } from './trigger.mjs';
import { VERDICT_LANGS } from './verdict.mjs';
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
  readfirst setup --git          git hooks every agent goes through: pre-commit runs check, pre-push runs verify
                                 (one line added to the hooks there; --no-verify skips them once)
  readfirst prompt               brief for your coding agent to fill in the map
  readfirst check [--strict]     check the map covers every tracked file (new files beside placed ones pass; --strict fails on them)
  readfirst fix                  place new files, drop patterns for deleted ones, move evidence lines git traces
  readfirst audit                the whole repository against the map: stale rules, risks no change can judge, moved hot
                                 spots, code no test reaches
  readfirst export --cursor      write the map as Cursor rules, one .mdc per group (--check: fail if they are out of date)
  readfirst scan                 look for known bug shapes: results thrown away, test assertions nobody awaits (no map needed)
  readfirst find <words>...      before writing something new: what in the code may already do it
  readfirst read <file>...       read list for files you are about to change
  readfirst answer '<json>'      answer the items hook --gate asked: [{"item","answer","because","symbols"}], answer one of
                                 keeps, not-this, done, unsure (the hook keeps them; this command writes nothing)
  readfirst diff [--base <ref>] [--lang <code>]  read list for files changed since <ref>, each risk and rule judged against
                                 the change, under a verdict (to do, blocked, not checked) in en or ko
  readfirst verify [--base <ref>]  run the checks for the files changed since <ref> (--dry-run lists them;
                                 --record notes in .readfirst/held.json which rules held, at which commit)
  readfirst hook [--install]     Claude Code hook: the read list before each edit (--install adds it to .claude/settings.json;
                                 --install --verify also runs the checks for edited files before Claude Code finishes;
                                 --report: what each session was asked and did, from the Stop hook's lines)
  readfirst view [--out <file>]  the map as a city in one HTML page
  readfirst mcp                  MCP server on stdio for Cursor, Codex, Windsurf and other agents
  readfirst pending              map edits waiting on an unmerged upkeep branch (local refs, as of the last fetch)
  readfirst prompt --labels <lang>  brief for your agent to write personal labels for the view (e.g. ko, en)

Options: --root <dir>, --json, --limit <n>, --timeout <s> (verify, per check; default 900; hook --stop: default 600), --force (init: replace the map),
         --version; an option's value can also follow an = (--base=main),
         --agent (init: also run setup), --for (setup: the agents to wire, e.g. cursor,codex),
         --ci (init: add .github/workflows/readfirst.yml, the Action with auto-fix)`;

// The on/off flags (name -> key in args) and the options that take a value. Anything else that starts with `--` is an
// error: an unknown option used to take the next word as its value, so `hook --new-flag --stop` quietly ran the wrong hook.
const FLAGS = { json: 'json', force: 'force', agent: 'agent', install: 'install', 'dry-run': 'dryRun', record: 'record', cursor: 'cursor', check: 'check', strict: 'strict', verify: 'verify', git: 'git', ci: 'ci', stop: 'stop', gate: 'gate', report: 'report', help: 'help', version: 'version' };
const VALUES = new Set(['root', 'limit', 'timeout', 'base', 'out', 'for', 'labels', 'lang']);
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
// GIT_OPTIONAL_LOCKS=0: readfirst runs beside the user's own git (in hooks, at the same time as their commands), so its
// `git status` neither refreshes nor locks their index, as git asks of background tools.
// Read at each call, as git inherited process.env before: a variable set after this module loaded still reaches git.
const gitEnv = (more = {}) => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', ...more });
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() });

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
const OUTPUT_LINES = 30;
// The failing tests found above the last lines whose block (error, expected, actual, stack) is shown; the rest are
// shown by their line alone, and counted. A broken shared helper fails hundreds at once, about 50 lines each.
const FAILING_BLOCKS = 10;
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
    const lines = all.split('\n');
    // The last OUTPUT_LINES lines of a failing check (readfirst watch on readfirst#139: it said only "last lines").
    // cut: a line before them says how many came before and that running the command itself shows them all.
    // A failing test is shown wherever it stands in the output: each TAP `not ok` line before the last lines, with the
    // block under it up to its `...` (the error, expected and actual). Until 2026-11-14 a test runner's summary filled
    // the last lines, and verify said a check failed without saying which test.
    // A block ends at the `...` as deep as its `---` (a `...` line in an error's text is deeper: review of #201, it cut
    // the message and the stack), or at the next test line no deeper than the `not ok`. What stands from the last lines
    // on is shown there, not twice. A todo or a skip is no failure: `# TODO` as TAP's directive, not `\# TODO` in a
    // test's name (node writes a # in a name as \#), which hid a failing test. Each failing test's line is shown; the
    // blocks of the first FAILING_BLOCKS of them.
    const from = Math.max(0, lines.length - OUTPUT_LINES);
    const failing = [];
    let failed = 0;
    for (let i = 0; i < from; i++) {
      const head = lines[i].match(/^(\s*)not ok \d+/u);
      if (!head || /(?<!\\)#\s*(?:TODO|SKIP)\b/u.test(lines[i])) continue;
      const deep = head[1].length;
      const open = (lines[i + 1] ?? '').match(/^(\s*)---\s*$/u);
      // end: the index past the block (past its `...`, or at the next test line).
      let end = i + 1;
      if (open) {
        let j = i + 2;
        while (j < lines.length && lines[j] !== `${open[1]}...` && !((lines[j].match(/^(\s*)(?:not )?ok \d+/u)?.[1].length ?? Infinity) <= deep)) j++;
        end = lines[j] === `${open[1]}...` ? j + 1 : j;
      }
      failed++;
      // cut: past FAILING_BLOCKS only the test's line; the line below says how many blocks are left out and where they are.
      failing.push(...lines.slice(i, failed > FAILING_BLOCKS ? i + 1 : Math.min(end, from)));
      i = Math.min(end, from) - 1;
    }
    const tests = failing.length ? ['(the failing tests, from the earlier lines:)', ...failing, ...(failed > FAILING_BLOCKS ? [`(the blocks under ${failed - FAILING_BLOCKS} of these ${failed} failing tests not shown; run \`${c.run}\` to see them)`] : [])] : [];
    const shown = lines.length > OUTPUT_LINES ? [...tests, `(${failing.length ? `${from - failing.length} of the ${from}` : from} earlier lines not shown; run \`${c.run}\` to see them all)`, ...lines.slice(from)] : lines;
    const tail = status === 'pass' ? undefined : shown.join('\n');
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

// The language of diff's verdict: --lang (a language code; one readfirst has no words for is said in the verdict), else
// the one language of this clone's personal labels (`prompt --labels ko`) that the verdict has words for, else English.
export function diffLang(asked, labelLangs) {
  if (asked !== undefined) {
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/u.test(String(asked))) throw new Error('--lang needs a language code, e.g. ko or en');
    return asked;
  }
  const known = [...new Set(labelLangs().map((l) => String(l).toLowerCase().split(/[-_]/u)[0]))].filter((l) => VERDICT_LANGS.includes(l) && l !== 'en');
  return known.length === 1 ? known[0] : 'en';
}

// The read list as factual lines for an agent's context, in the PR comment's order (src/verdict.mjs): what to do first
// (being replaced, change together, checks; a broken map, which blocks, is put before these by the caller), what
// readfirst could not see or fetch, other repositories, then what to know (rules, risks, where it broke, tests). Every
// line is given (0.27.1: no "N more"); with several files, a line for only some of them names them.
// The fixed id of a rule or risk, which an answer names: `rule:<id>` for a rule (its id is the map's), and
// `risk:<group>:<first 8 hex of the SHA-1 of its text>` for a risk (a risk has no id of its own; the same text in the
// same group is the same risk, and an edited text is a new one to answer).
export const itemId = (kind, key, text) => (kind === 'rule' ? `rule:${key}` : `risk:${key ?? 'none'}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 8)}`);
// ids (the PreToolUse hook): each rule and risk also carries its fixed id (itemId) and what the change does to it, from
// judge's `trigger` on its row: touched (by the names or lines given), not touched, or not judged (it names nothing
// readfirst can find; there is no change to judge it against: a file a Bash command writes; or noteStates gave the
// reason in `unjudged`: judging failed, or the edit was too large to place).
const itemState = (t) => (!t ? 'not judged: no edit to judge it against' : t.unjudged ? `not judged: ${t.unjudged}` : !t.triggered ? `not touched: ${t.why}` : t.about?.length ? `touched by ${t.by.join(', ')}` : 'not judged: it names nothing readfirst can find in the code');
// The rules and risks of a judged read list as the gate asks them: { id, need, by, state, text }. `need`: touched or
// not judged (only those are answered); `by`: the names it is touched by, none when it is not judged.
export function noteItems(list) {
  const out = new Map();
  const rows = [...(list.rules ?? []).map((r) => [itemId('rule', r.id, r.rule), r, `Rule ${r.id}: ${r.rule}`]), ...(list.risks ?? []).map((r) => [itemId('risk', r.group, r.text), r, `Risk: ${r.text}`])];
  for (const [id, row, text] of rows) {
    const t = row.trigger;
    const need = !(t && !t.unjudged && !t.triggered);
    // judge gives a name in backticks (`alpha`), a line as path:line and a file as its path; the answer names them bare.
    const by = t && !t.unjudged && t.triggered && t.about?.length ? t.by.map((s) => String(s).replace(/^`(.*)`$/su, '$1')) : [];
    const was = out.get(id);
    if (was) { was.need ||= need; was.by = [...new Set([...was.by, ...by])].sort(); continue; }
    out.set(id, { id, need, by: [...new Set(by)].sort(), state: itemState(t), text });
  }
  return [...out.values()];
}
export function brief(list, { ids = false } = {}) {
  const lines = [];
  const all = (list.targets ?? []).length;
  const forSome = (row) => (all > 1 && row.for && row.for.length < all ? ` [${row.for.join(', ')}]` : '');
  const tag = (id, row) => (ids ? ` [${id} · ${itemState(row.trigger)}]` : '');
  for (const d of list.deprecated ?? []) lines.push(`Being replaced: group ${d.group}${d.use ? `; use ${d.use} instead` : ''} (${d.why}). Do not add to it.${forSome(d)}`);
  for (const t of list.together ?? []) lines.push(`Change together: when this file changes, also change ${t.also.join(' or ')} (${t.why}). verify fails otherwise.${forSome(t)}`);
  for (const c of list.checks) lines.push(`Check to run after the change: ${c.run}${c.why ? ` (${c.why})` : ''}${forSome(c)}`);
  const known = [];
  for (const r of list.rules) known.push(`Rule ${r.id}${tag(itemId('rule', r.id, r.rule), r)}: ${r.rule}${r.why ? ` (why: ${r.why})` : ''}${forSome(r)}`);
  for (const r of list.risks) known.push(`Risk${tag(itemId('risk', r.group, r.text), r)}: ${r.text}${forSome(r)}`);
  for (const t of list.targets ?? []) {
    const b = t.brokeBefore;
    if (b && !b.notFetched) known.push(`Broke before: ${b.count} fix${b.count === 1 ? '' : 'es'} in ${t.path}, last ${b.last.date} ${b.last.sha} "${b.last.subject}"`);
    else if (b) lines.push(`Broke before: history not fetched for ${t.path} (shallow clone)`);
  }
  if (list.tests.length) known.push(`Tests that reach ${all > 1 ? 'these files' : 'this file'}: ${list.tests.map((t) => `${t.path}${forSome(t)}`).join(', ')}`);
  // What readfirst could not see is said only beside something it did say: alone it would be a note about nothing.
  if (lines.length || known.length || (list.dependents ?? []).length) for (const u of list.unseen ?? []) lines.push(`Not seen by readfirst: ${u.why}`);
  for (const d of list.dependents ?? []) lines.push(`Another repository depends on this: ${d.repo}${d.paths.length ? ` (${d.paths.join(', ')})` : ''} (${d.why}).${forSome(d)}`);
  return [...lines, ...known];
}

// The states the hook's notes give (brief with ids), from `judge`, run by `run`. A judge that throws leaves every item
// "not judged" with that reason, never "no edit" (there was one) and never without notes. `unplaced`: files whose edit
// textChange could not place in its budget; an item it did not find touched elsewhere is not judged, with that reason.
export function noteStates(list, run, unplaced = []) {
  const rows = [...(list.rules ?? []), ...(list.risks ?? [])];
  try { run(); } catch (e) {
    const why = `judging the edit failed (${String(e?.message ?? e).split('\n')[0]})`;
    for (const r of rows) r.trigger = { unjudged: why };
    return list;
  }
  if (unplaced.length) {
    const why = `the edit changes too much of ${unplaced.join(', ')} to place within the hook's budget`;
    for (const r of rows) if (!r.trigger || !r.trigger.triggered) r.trigger = { unjudged: why };
  }
  return list;
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

// Step 4, whether the notes were acted on (2026-11-10): every call the hook sees is kept as call:<sig>, a refusal by the
// gate as denied:<sig>, and the same call made again with no other edit or command in between as resent:<sig>:<time>
// (the notes were likely not read: nothing was done between the refusal and the retry). The Stop hook counts them with
// what the map asked and what was done (actedLine), and keeps one line per session in ACTED_LOG for `hook --report`.
const callSig = (tool, targets) => createHash('sha1').update(`${tool}\0${targets.join('\0')}`).digest('hex').slice(0, 12);
// The key of a Bash command the gate asks about once (`unknown:`, `misread:`): the command with where it runs, the
// folder (through symlinks) and the repository holding it. Until 2026-11-14 it was the command's text alone, so a
// command refused once in one folder went through with no word in any other folder or repository, where the same
// text writes somewhere else. Returns the hash for the tag (`unknown:<here>`), worked out once per call (repoOf runs
// git), and `old`: the hash an older readfirst wrote, which a state file may still hold and which still counts as
// asked. So a session that spans the upgrade keeps the old gap for a command asked about before it: it goes through in
// other folders too.
function commandKey(command, cwd) {
  let folder = cwd;
  try { folder = realpathSync(cwd); } catch { /* a folder that is gone: as given */ }
  const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);
  return { here: hash(`${folder}\0${repoOf(folder) ?? ''}\0${command}`), old: hash(command) };
}
// Where the session started in a repository (plan 2.7, "the session's diff"): `head:<sha>:<root>`, the commit HEAD was
// at on the first call that wrote or could write there, before that call ran (the hook runs first). The Stop hook judges
// not-this answers on the diff from it, so a commit made on the branch before the session never counts against an
// answer. '' when the repository had no commit yet.
const HEAD_KEY = /^head:([0-9a-f]*):(.+)$/su;
// The empty tree, the start of a session in a repository that had no commit yet (SHA-1; git hash-object -t tree).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
function headOf(seen, root) {
  for (const k of Object.keys(seen)) { const m = k.match(HEAD_KEY); if (m && m[2] === root) return m[1]; }
  return null;
}
// With it, what the working tree already held then, so changes made before the session are not counted as its own:
// `base:<JSON [root, snapshot, untracked, count, why]>`. snapshot: `git stash create` (a commit of the tracked files as
// they were; it writes git objects nothing refers to, which gc removes, and no ref or stash entry), run on a copy of the
// index in the temp folder, because stash create rewrites the index it reads even with GIT_OPTIONAL_LOCKS=0; HEAD when
// nothing was changed, '' for a repository with no commit and nothing added, null when it could not be taken, with
// why saying what stopped it. untracked: the files git did not track
// then (not ignored), which the stop does not count as the session's; null when there were more than PRE_MAX, with
// count saying how many: the start is then only partly known and no not-this is compared there.
const PRE_MAX = 2000;
function baseOf(seen, root) {
  for (const k of Object.keys(seen)) {
    if (!k.startsWith('base:')) continue;
    let v = null;
    try { v = JSON.parse(k.slice('base:'.length)); } catch { v = null; }
    if (Array.isArray(v) && v[0] === root) return { snapshot: typeof v[1] === 'string' ? v[1] : null, untracked: Array.isArray(v[2]) ? v[2] : null, count: Number(v[3]) || 0, why: typeof v[4] === 'string' ? v[4] : 'git stash create failed' };
  }
  return null;
}
function markHead(seen, root, now) {
  if (!root || headOf(seen, root) !== null) return;
  let sha = '';
  try { sha = git(root, 'rev-parse', '--verify', '-q', 'HEAD').trim(); } catch { sha = ''; }
  seen[`head:${sha}:${root}`] = now;
  let snapshot = null;
  let why = null;
  if (!sha) {
    try { snapshot = git(root, 'ls-files', '-z') ? null : ''; } catch (e) { why = `git ls-files failed (${errorText(e)})`; }
    if (snapshot === null) why ??= 'the repository had no commit yet and files were already added';
  } else {
    let copy = null;
    try {
      const at = git(root, 'rev-parse', '--git-path', 'index').trim();
      copy = mkdtempSync(join(tmpdir(), 'readfirst-index-'));
      const index = join(copy, 'index');
      // No index to copy: stash create on an empty one would take every file for deleted.
      if (!existsSync(resolve(root, at))) throw new Error(`no index file at ${at}`);
      copyFileSync(resolve(root, at), index);
      snapshot = execFileSync('git', ['-C', root, 'stash', 'create'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv({ GIT_INDEX_FILE: index }) }).trim() || sha;
    } catch (e) { snapshot = null; why = `git stash create failed (${errorText(e)})`; }
    if (copy) try { rmSync(copy, { recursive: true, force: true }); } catch { /* the temp folder is cleaned by the system */ }
  }
  let untracked = null;
  let count = 0;
  try { const all = git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean); count = all.length; untracked = count > PRE_MAX ? null : all; } catch { untracked = null; }
  seen[`base:${JSON.stringify([root, snapshot, untracked, count, why])}`] = now;
}
function lastCall(seen) {
  let best = null;
  for (const [k, at] of Object.entries(seen)) if (k.startsWith('call:') && (!best || at > best[1])) best = [k, at];
  return best;
}
export const ACTED_LOG = 'readfirst-acted.jsonl';

// `readfirst find` before new code (2026-11-10: CLAUDE.md asked for it, a session wrote seven new functions without it;
// read was enforced by the gate, find only written). A Bash call that runs find marks find:<root> and the words it
// asked (findwords:<root>:<words>); an Edit, Write or MultiEdit that declares a function or type its file did not
// have, in a repository with a map, with no find that asked about it, is refused once by the gate
// (nofind:<sig>:<names>) with the names and the command, and goes through when made again; written so, it is kept as
// nofindwrite:<sig> and counted by the Stop hook.
// Which find counts for a new name (until 0.31.0 any find, once, opened the gate for the rest of the session, so one
// search at the start covered every function written afterwards): one whose query shares a word with the name
// (`find "retry a payment"` for retryPayment, by find's own words and meets), so searching first and then writing
// passes without a refusal; or any find run after the gate asked about these very names, so a name the query does
// not happen to share a word with costs one refusal and never more.
const FIND_RUN = /(?:^|[\s;&|(])(?:npx\s+(?:--yes\s+|-y\s+)?)?(?:readfirst(?:@[\w.-]+)?|\S*readfirst\.mjs)\s+find\b/u;
// The words a find command asked: what follows `find` up to the end of that command, options left out.
const findQuery = (command) => { const m = String(command).match(FIND_RUN); return m ? words(String(command).slice(m.index + m[0].length).split(/[;|&\n]/u)[0].replace(/(?:^|\s)--?[\w-]+(?:=\S+)?/gu, ' ')) : []; };
// Whether a find of this session asked about `name` in the repository `root`.
function findAsked(seen, root, name) {
  const mine = words(name);
  const prefix = `findwords:${root}:`;
  return Object.keys(seen).some((k) => k.startsWith(prefix) && k.slice(prefix.length).split(' ').some((q) => mine.some((w) => meets(q, w))));
}
export function newCode(tool, input, abs) {
  const names = (text) => new Set(definitions(abs, String(text ?? '')).map((d) => d.name));
  const texts = editTexts(tool, input, abs);
  if (!texts) return [];
  const was = names(texts.before);
  return [...names(texts.after)].filter((n) => !was.has(n));
}
// The file an Edit, MultiEdit or Write is about to change, before and after it: { before, after }, or null for any
// other tool. An edit's old and new strings are fragments (a method's lines without its class, half a statement, a
// line of a template): read alone, a function only moved looked new and a word in a string looked like a declaration,
// so the edit is applied to the file as it is on disk, as Claude Code applies it (replace_all: every occurrence; an
// old text not in the file: no change). A new file was ''.
export function editTexts(tool, input, abs) {
  if (!/^(?:Edit|MultiEdit|Write)$/u.test(tool)) return null;
  let before = '';
  try { before = readFileSync(abs, 'utf8'); } catch { /* a new file */ }
  const apply = (text, e) => { const [from, to] = [String(e?.old_string ?? ''), String(e?.new_string ?? '')]; return !from ? text : e?.replace_all ? text.split(from).join(to) : text.replace(from, () => to); };
  const after = tool === 'Edit' ? apply(before, input) : tool === 'MultiEdit' ? (input?.edits ?? []).reduce(apply, before) : String(input?.content ?? '');
  return { before, after };
}

// Claude Code PreToolUse hook. Reads the hook's JSON on stdin; for an Edit, Write or MultiEdit of a file, or a Bash
// command that writes files (src/bash-writes.mjs), prints the read list of the files as additionalContext, once per file
// per session: every file the call writes, each repository's lines once, nothing cut (0.27.1; before, the first 10 files
// and 12 lines per file). Never blocks by default; with --gate (`hook --gate`) the first call that touches a file it has
// not shown is refused with the read list as the reason, and the same call goes through when made again, as a
// map gate does. Any problem means no output.
// budget: how long it may spend looking up (the hook has 15 s). Files it had no time for are named, marked for the Stop
// hook's checks, and looked up on the next call that writes them; with --gate the call is refused so it is made again.
// A call that writes nothing readfirst can name (a script, a build) still marks when the session started in that
// repository, so the Stop hook checks the files changed after it.
// readers: the shell readers, which a test may replace with one that throws.
export function runHook(input, { now = Date.now(), stateDir = tmpdir(), gate = false, budget = 10_000, readers = { shellWrites, bashReads } } = {}) {
  let event = null;
  try {
    event = JSON.parse(input);
    const cwd = event.cwd ?? process.cwd();
    const tool = event.tool_name ?? '';
    const file = event.tool_input?.file_path;
    // A variable the command does not set has the value Claude Code's environment gives it, which the hook shares:
    // $TMPDIR and $HOME are known paths, not unknown ones.
    // Not OLDPWD: the hook's own is not the folder the Bash shell was in before (review of 2026-11-13); the command's cd
    // sets it, and before that it is not known.
    const env = new Map(Object.entries(process.env).filter(([k]) => k !== 'OLDPWD').map(([k, v]) => [k, { value: v, exported: true }]));
    // A reader that throws on a command is a write readfirst cannot place: refused once with --gate like any unknown
    // write (until 2026-11-13 the throw reached the catch below and the command went through with no word), and kept as
    // misread:<hash of the command> for the Stop hook and `hook --report`.
    let misread = null;
    const readSafely = (read) => { try { return read(); } catch (e) { misread ??= errorText(e); return null; } };
    const command = String(event.tool_input?.command ?? '');
    let written = tool === 'Bash' ? readSafely(() => readers.shellWrites(event.tool_input?.command, cwd, { vars: env })) : null;
    const targets = [...new Set((/^(?:Edit|Write|MultiEdit)$/u.test(tool) && file ? [isAbsolute(file) ? file : resolve(cwd, file)]
      : written ? written.files : []).map(physical))];
    const seen = readSeen(stateDir, event.session_id) ?? {};
    const before = { ...seen };
    const save = () => { try { addSeen(stateDir, event.session_id, before, seen); return true; } catch { return false; } };
    const sig = callSig(tool, targets);
    const prev = lastCall(seen);
    if (prev && prev[0] === `call:${sig}` && seen[`denied:${sig}`] === prev[1]) seen[`resent:${sig}:${now}`] = now;
    seen[`call:${sig}`] = now;
    if (tool === 'Bash' && FIND_RUN.test(String(event.tool_input?.command ?? ''))) {
      const root = repoOf(cwd);
      const asked = findQuery(event.tool_input.command);
      if (root) { seen[`find:${root}`] = now; if (asked.length) seen[`findwords:${root}:${[...new Set(asked)].join(' ')}`] = now; }
    }
    // `readfirst read` run in Bash shows the same notes the hook would (2026-11-13: the gate did not count it, so a
    // file read that way was refused all the same). It counts for the branch it ran on, and only when its whole
    // output came back: one sent to /dev/null, a file or a pipe, or cut by --limit, is not marked.
    // The marks count from the next call on, and only when this call is let through: the hook runs before the
    // command, so in `readfirst read f; sed -i ... f` nobody has seen the notes when sed writes (2026-11-13: that
    // command went through), and a refused call runs no read at all.
    const reads = {};
    if (tool === 'Bash') {
      const known = new Map();
      const branches = new Map();
      for (const r of readSafely(() => readers.bashReads(event.tool_input?.command, cwd, { vars: env })) ?? []) {
        if (!r.seen) continue;
        for (const abs of r.files.map(physical)) {
          const root = rootOf(abs, known);
          if (root) reads[`read:${branchOf(root, branches)}:${abs}`] = now;
        }
      }
    }
    // With --gate, `readfirst answer '<json>'` answers what the gate asked (src/answers.mjs). Kept as the reads are:
    // only when this call is let through, from the next call on, so `readfirst answer ... && sed -i ... f` is refused for
    // f's items. An answer readfirst cannot read or check is refused with what is wrong, and nothing of it is kept.
    const given = gate && tool === 'Bash' ? readSafely(() => answersIn(command, cwd, seen)) : null;
    if (given?.problems.length) {
      const saved = save();
      const reason = `readfirst: nothing of this answer is kept:\n- ${given.problems.join('\n- ')}\nGive it again as one quoted argument: ${ANSWER_HOW}`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...(saved ? { permissionDecision: 'deny', permissionDecisionReason: reason } : { additionalContext: reason }) } });
    }
    for (const k of Object.keys(given?.keys ?? {})) reads[k] = now;
    // Writes whose place the command cannot tell before it runs (a variable from outside it, a $( ), a loop variable;
    // shellWrites): named, never dropped (until 2026-11-13 they were left out without a word), unless they are known to
    // be outside every repository (couldLandIn). With --gate the call is refused once with them
    // (`unknown:<hash of the command and its folder>`, commandKey) and goes through when made again there. Each
    // repository they could land in gets the session's start mark, so the Stop hook checks the files that change there.
    let keys = null;
    const keysOnce = () => (keys ??= commandKey(command, cwd));
    if (misread) {
      const whole = { part: 'the whole command', word: command, why: `readfirst hit an error reading it (${misread})`, prefix: '' };
      written = { files: written?.files ?? [], unknown: [...(written?.unknown ?? []), whole], repos: written?.repos ?? [] };
      seen[`misread:${keysOnce().here}`] = now;
    }
    const unplaced = written?.unknown.length ? couldLandIn(written.unknown, seen, cwd, written.repos, Date.now() + budget / 5) : [];
    // Asked once per command and folder (commandKey): the same text run in another folder or repository is asked again.
    const unknownKey = unplaced.length ? `unknown:${keysOnce().here}` : null;
    const askUnknown = Boolean(unknownKey) && !before[unknownKey] && !before[`unknown:${keys.old}`];
    if (unknownKey) { seen[unknownKey] = now; for (const r of new Set(unplaced.flatMap((u) => u.roots))) { if (!seen[`start:${r}`]) seen[`start:${r}`] = now; markHead(seen, r, now); } }
    // Said once per command: made again, it goes through without the line.
    // Five repositories are named for a write and the rest counted with where they are (below its folder, or the ones
    // this session used): hundreds made a line no one reads (2026-11-13). All of them get the start mark above.
    const landIn = (u) => {
      const where = u.prefix ? `below ${u.prefix}` : 'that this session used';
      // cut: five named, the rest counted with where they are (`where`)
      const some = u.roots.length > 5 ? `${u.roots.slice(0, 5).join(', ')} and ${u.roots.length - 5} more ${where}` : u.roots.join(', ');
      if (u.looked) return `could be in a repository below ${u.prefix}${u.roots.length ? ` (${some} and more: readfirst stopped looking at ${u.looked})` : ` (readfirst stopped looking at ${u.looked})`}`;
      return u.roots.length ? `could be in ${some}` : 'could be in any repository: none is known to this session';
    };
    const unknownLine = askUnknown ? `readfirst: this command writes where readfirst cannot tell before it runs: ${unplaced.map((u) => `\`${clip(u.word)}\` (${clip(u.part)}: ${u.why}; ${landIn(u)})`).join('; ')}. If one of these is a file in a repository, read its notes first (\`npx readfirst read <file>\`)${gate ? ', then make the same call again' : ''}; the Stop hook checks the files that change.` : null;
    if (!targets.length) {
      const root = repoOf(cwd);
      if (root && !seen[`start:${root}`]) seen[`start:${root}`] = now;
      markHead(seen, root, now);
      if (!(gate && askUnknown)) Object.assign(seen, reads);
      const saved = save();
      if (!unknownLine) return null;
      if (gate && askUnknown && saved) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: unknownLine } });
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: unknownLine } });
    }
    { const roots = new Map(); for (const abs of targets) markHead(seen, rootOf(abs, roots), now); }
    const deadline = Date.now() + budget;
    const edited = new Map(targets.flatMap((abs) => { const e = editTexts(tool, event.tool_input, abs); return e ? [[abs, e]] : []; }));
    const { notes, late, items } = notesFor(targets, seen, now, { deadline, stateDir, edited, gate });
    // The gate asks each item the change touches, or that readfirst cannot judge against it, until it has an answer that
    // holds (answered: the item touched by no other names than when it was answered). Until the answers, the same call
    // made again was let through whether the notes had been read or not. An item not touched is one line, not asked.
    const answers = gate ? givenAnswers(seen) : [];
    const asks = gate ? items.filter((i) => i.need && !answered(answers, i.id, i.by)) : [];
    for (const i of asks) seen[`ask:${JSON.stringify([i.id, i.by])}`] = now;
    const askLine = asks.length ? `readfirst: answer each of these before this change, as one quoted JSON argument, then make the same call again: ${ANSWER_HOW} (answer: ${ANSWER_KINDS_LINE}). An answer holds for this session while the change touches the item by the same names.\n- ${asks.map((i) => `\`${i.id}\` (${i.state})${i.shown ? '' : `: ${i.text}`}`).join('\n- ')}` : null;
    const waiting = pendingNotes(targets, seen, now);
    const known = new Map();
    const added = /^(?:Edit|Write|MultiEdit)$/u.test(tool) ? targets.map((abs) => ({ abs, root: rootOf(abs, known), names: newCode(tool, event.tool_input, abs) }))
      .filter((f) => f.names.length && f.root && existsSync(join(f.root, MAP_PATH))) : [];
    // The names no find asked about; the ask is kept with them, so the same file given other new names later is asked again.
    const open = added.map((f) => ({ ...f, names: f.names.filter((n) => !findAsked(seen, f.root, n)) })).filter((f) => f.names.length);
    const askKey = `nofind:${sig}:${open.flatMap((f) => f.names).sort().join(',')}`;
    const askedAt = before[askKey];
    const fresh = open.filter((f) => !(askedAt && seen[`find:${f.root}`] > askedAt));
    const askFind = fresh.length > 0 && !askedAt;
    const findLine = fresh.length ? `readfirst: this adds ${fresh.map((f) => `${f.names.map((n) => `\`${n}\``).join(', ')} to ${relative(f.root, f.abs)}`).join('; ')}, and no \`readfirst find\` in this session asked about ${fresh.flatMap((f) => f.names).length === 1 ? 'it' : 'them'}. Run \`npx readfirst find "<what it does>"\` first and reuse what already exists${gate && askFind ? ', then make the same call again' : ''}.` : null;
    if (fresh.length) seen[gate && askFind ? askKey : `nofindwrite:${sig}`] = now;
    if (gate && (asks.length || askFind || askUnknown)) seen[`denied:${sig}`] = now;
    if (!(gate && (asks.length || late.length || askFind || askUnknown))) Object.assign(seen, reads);
    const saved = save();
    const lateLine = late.length ? `readfirst: no time left in this call (the hook has ${Math.round(budget / 1000)} s) to look up ${late.join(', ')}. ${gate ? 'Make the same call again and readfirst goes on with them;' : 'The next call that writes them gets their notes, and'} the Stop hook checks them all the same; \`npx readfirst read ${late.join(' ')}\` gives them now.` : null;
    if (!notes.length && !waiting.length && !lateLine && !findLine && !unknownLine && !askLine) return null;
    // Waiting map edits are a word to pass on, never a reason to refuse an edit: --gate denies for items not answered
    // and, once per call, for files it had no time for, new code written before `readfirst find` and writes it cannot
    // place. Notes with nothing to answer (every item not touched) go through as context.
    const text = [...notes, ...(askLine ? [askLine] : []), ...(lateLine ? [lateLine] : []), ...(findLine ? [findLine] : []), ...(unknownLine ? [unknownLine] : []), ...waiting].join('\n\n');
    // A gate whose state cannot be saved would refuse the same call forever (a full or read-only temp folder): it passes
    // the notes as context instead.
    if (gate && (asks.length || lateLine || askFind || askUnknown) && saved) return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `readfirst: read this before changing these files, then make the same call again.\n\n${text}` } });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });
  } catch (e) {
    // Never fails closed (the call goes through), but what failed is kept (failed:<tool>:<error>) for the Stop hook and
    // `hook --report`: until 2026-11-13 a bug here looked the same as nothing to say.
    // Quoted values and numbers are left out of the key (`open '/a/b'`, `reading 'x'`), so one kind of error is one key
    // and the state does not grow by a line for each call it fails on.
    const kind = errorText(e).replace(/(['"`]).*?\1/gu, '$1…$1').replace(/\d+/gu, 'N');
    try { if (event?.session_id) addSeen(stateDir, event.session_id, {}, { [`failed:${event.tool_name ?? ''}:${kind}`]: now }); } catch { /* nothing more to do */ }
    return null;
  }
}
// A command or a word of one in the hook's line: the first CLIP characters and, on the same line, how many were left
// out (a command readfirst could not read was quoted whole: 64,404 characters in one refusal, 2026-11-13).
const CLIP = 200;
const clip = (text) => {
  const s = String(text);
  return s.length <= CLIP ? s : `${s.slice(0, CLIP)}… (${s.length} characters, ${s.length - CLIP} left out)`; // cut: says how many it left out
};
// An error in one line, short enough for a state key and a report line.
const errorText = (e) => `${e?.name ?? 'Error'}: ${String(e?.message ?? e)}`.replace(/\s+/gu, ' ').slice(0, 160); // cut: the error's first 160 characters; the rest is in no state

// The branch a repository is on, or the commit when none is checked out; '' when git cannot say. `known` keeps the
// answers of one call.
function branchOf(root, known = new Map()) {
  if (!known.has(root)) {
    let b = '';
    try { b = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(); if (b === 'HEAD') b = git(root, 'rev-parse', 'HEAD').trim(); } catch { b = ''; }
    known.set(root, b);
  }
  return known.get(root);
}

// The repository of a path: that of its nearest existing folder (a new file's folder may not exist yet). `known` keeps
// the answers of one call, so a command writing many files in one folder asks git once.
function rootOf(abs, known = new Map()) {
  let dir = dirname(abs);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  if (!known.has(dir)) known.set(dir, repoOf(dir));
  return known.get(dir);
}

// The repositories each write a Bash command cannot place could land in (shellWrites' unknown), whatever folder the
// session runs in. With no known start (`prefix` ''), any repository the session knows (the call folder's and those of
// the files it marked), or any at all when it knows none. With a prefix: the repository holding that folder; else the
// repositories below it, which a partly known path (`$S/w-$rev/f`) can reach: those the session knows, those the
// command itself makes (`made`: git worktree add, clone, init) and those found on disk (reposUnder). A new path mktemp
// makes (`fresh`) has nothing below it: only the repository holding its folder counts. A write with none is outside
// every repository and dropped: a temporary folder, a scratch folder with no checkout in it. Until 2026-11-13 the
// repository was the call's folder alone, so a session started above its repositories (`cd $R/repo && echo > src/f`)
// was never asked, and every write to $TMPDIR or a mktemp folder was.
// A part not known inside one folder name (`within`: `/tmp/zz-$r/f`) narrows that to the folders whose name fits its
// known letters (/tmp/zz-*) and what is below them: it walked all of /tmp, 12 s, and named every repository there
// (2026-11-13). The walks share 2000 folders and the time until `until`.
// Returns [{ ...unknown, roots }], roots empty when no repository is known at all (it could be any).
function couldLandIn(unknown, seen, cwd, made = [], until = Infinity) {
  const walk = { left: 2000, until };
  const known = new Map();
  const roots = new Set();
  const here = repoOf(cwd);
  if (here) roots.add(here);
  for (const k of Object.keys(seen)) {
    const m = k.match(/^(?:start:(.+)|touched:(.+)|(?:shown|read):[^:]*:(.+)|(\/.+))$/su);
    if (!m) continue;
    if (m[1]) { roots.add(m[1]); continue; }
    const root = rootOf(m[2] ?? m[3] ?? m[4], known);
    if (root) roots.add(root);
  }
  const out = [];
  for (const u of unknown) {
    if (!u.prefix) { out.push({ ...u, roots: [...roots] }); continue; }
    const dir = u.prefix.endsWith('/') ? u.prefix : `${u.prefix}/`;
    const own = rootOf(join(dir, 'x'), known);
    if (own) { out.push({ ...u, roots: [own] }); continue; }
    // A new mktemp path, or a file whose name alone is not known (`$S/out-$k.txt`), is in that folder: nothing below.
    if (u.fresh || u.direct) continue;
    // The first folder name below dir a repository is in ('' for dir itself: a checkout the command makes whose own name
    // is not known), and whether it fits `within`.
    const w = u.within;
    const fits = (name) => !w || name === '' || (name.length >= w.pre.length + w.post.length && name.startsWith(w.pre) && name.endsWith(w.post));
    const under = (r) => `${r}/`.startsWith(dir) && fits(`${r}/`.slice(dir.length).split('/')[0]);
    let starts = [dir];
    if (w) { try { starts = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fits(e.name)).map((e) => join(dir, e.name)); } catch { starts = []; } }
    const disk = { found: [], cut: null };
    for (const s of starts) { const r = reposUnder(s, walk); disk.found.push(...r.found); if (r.cut) { disk.cut = r.cut; break; } }
    const where = [...new Set([...[...roots].filter(under), ...made.filter(under), ...disk.found])];
    if (where.length || disk.cut) out.push({ ...u, roots: where, ...(disk.cut ? { looked: disk.cut } : {}) });
  }
  return out;
}

// The checkouts (a folder with a .git in it) in a folder and below it, five deep, from a walk of at most `walk.left`
// folders (shared by the walks of one call) and until `walk.until`; node_modules and .git are not entered. cut: the
// folder the walk stopped in when it reached either, so the caller counts a repository as possible there rather than
// none.
function reposUnder(dir, walk = { left: 2000, until: Infinity }) {
  const found = [];
  // The root stays `/`: stripped to '' it could not be read, and a write under `/$D` was dropped without a word (review
  // of 2026-11-13).
  const queue = [[dir === '/' ? '/' : dir.replace(/\/$/u, ''), 0]];
  while (queue.length) {
    const [d, depth] = queue.shift();
    // cut: the walk stops after `walk.left` folders or at `walk.until`; `cut` names where, and couldLandIn then keeps
    // the write as possible
    if (--walk.left < 0 || Date.now() > walk.until) return { found, cut: d };
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    if (entries.some((e) => e.name === '.git')) { found.push(d); continue; }
    if (depth >= 5) continue;
    for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules') queue.push([join(d, e.name), depth + 1]);
  }
  return { found, cut: null };
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
// edited: absolute path -> { before, after } for the files an Edit, MultiEdit or Write is about to change (editTexts):
// their notes are judged against that change (judge in src/trigger.mjs) and each says whether it is touched.
// gate: the files already shown are judged too (their notes are not shown again) and `items` gives each rule and risk
// of every file with the repository it is in and whether its notes were shown in this call (noteItems): the gate asks
// what a change touches every time, not once per file.
function notesFor(targets, seen, now, { deadline = Infinity, stateDir, edited = new Map(), gate = false } = {}) {
  const known = new Map();
  const branches = new Map();
  const byRoot = new Map();
  const again = new Map();
  for (const abs of targets) {
    const root = rootOf(abs, known);
    if (!root) continue;
    const path = relative(root, abs).replace(/\\/gu, '/');
    if (path.startsWith('..') || path === MAP_PATH || path.startsWith('.git/')) continue;
    const key = join(root, path);
    // Notes shown or read on another branch do not count: the map and the file there may say something else
    // (2026-11-13: a mark left from the previous branch let an edit through on the next one without its notes).
    const branch = branchOf(root, branches);
    const fresh = (k) => seen[k] && now - seen[k] < 6 * 3600_000;
    // A file read with `readfirst read` and not shown by the hook is still a file this call edits: `touched:` has the
    // Stop hook check it (without it, the read let the edit through and the stop never checked the file).
    // A bare path with no `shown:` mark at all was written by an older readfirst, which kept no branch: it still counts.
    const legacy = fresh(key) && !Object.keys(seen).some((k) => k.startsWith('shown:') && k.endsWith(`:${key}`));
    if (legacy || fresh(`shown:${branch}:${key}`) || fresh(`read:${branch}:${key}`)) {
      if (!seen[key]) seen[`touched:${key}`] ??= now;
      if (!gate) continue;
      if (!again.has(root)) again.set(root, []);
      if (!again.get(root).includes(path)) again.get(root).push(path);
      if (!byRoot.has(root)) byRoot.set(root, []);
      continue;
    }
    if (!byRoot.has(root)) byRoot.set(root, []);
    if (!byRoot.get(root).includes(path)) byRoot.get(root).push(path);
  }
  const notes = [];
  const late = [];
  const items = [];
  for (const [root, shownNow] of byRoot) {
    const paths = [...shownNow, ...(again.get(root) ?? []).filter((p) => !shownNow.includes(p))];
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
    // The change each edited file is about to get, judged as `readfirst diff` judges a commit: the file is read as it
    // will be. A judge that fails leaves the notes, each item saying judging failed (noteStates): the hook must not
    // drop the notes.
    // An edit too large to place in the time left (textChange's budget) is not judged by guessing: its items say so.
    const changes = new Map(done.flatMap((p) => { const e = edited.get(join(root, p)); return e ? [[p, textChange(e.before, e.after, { deadline })]] : []; }));
    const unplaced = [...changes].filter(([, c]) => c.unplaced).map(([p]) => p);
    for (const p of unplaced) changes.delete(p);
    const after = (p) => { const e = edited.get(join(root, p)); return e ? e.after : readText(root)(p); };
    noteStates(list, () => { if (changes.size) judge(list, { changes, read: after, files: all, imports: map ? ctx.edges() : [] }); }, unplaced);
    const shown = done.some((p) => shownNow.includes(p));
    if (gate) items.push(...noteItems(list).map((i) => ({ ...i, root, shown })));
    if (!shown) continue;
    const lines = brief(list, { ids: true });
    // A map that cannot be read at all gives no rules or risks: said, so notes with nothing asked are not taken for a
    // map with nothing to say (the gate then asks nothing and lets the call through with these notes).
    if (ctx.broken.length && !map) lines.unshift(`${MAP_PATH} could not be read, so these notes hold none of its rules and risks${gate ? ' and the gate asks none of them' : ''}: fix the map to see them.`);
    if (ctx.broken.length) lines.unshift(brokenMapLine(ctx.broken));
    for (const p of done) { seen[join(root, p)] = now; seen[`shown:${branchOf(root, branches)}:${join(root, p)}`] = now; }
    if (!lines.length) continue;
    notes.push(`readfirst notes for ${done.join(', ')}${map ? ` (from ${MAP_PATH})` : ''}:\n- ${lines.join('\n- ')}`);
  }
  return { notes, late, items };
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
    const tag = recorded.match(/^(pending|notrun|start|touched|call|denied|resent|find|findwords|nofind|nofindwrite|shown|read|unknown|misread|failed|ask|answer|unsure|untrue|head|base):(.*)$/su);
    if (tag && /^(?:pending|notrun|call|denied|resent|find|findwords|nofind|nofindwrite|shown|read|unknown|misread|failed|ask|answer|unsure|untrue|head|base)$/u.test(tag[1])) continue;
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
  const tally = { asked: 0, acted: 0, notActed: [] };
  const found = [];
  const notes = [];
  for (const [root, edited] of [...byRoot].sort(([a], [b]) => a.localeCompare(b))) {
    const r = stopFor(root, edited, timeout, byRoot.size > 1, firstSeen.get(root), { said, say, answers: givenAnswers(seen), head: headOf(seen, root), start: baseOf(seen, root) });
    if (r?.note) notes.push(r.note);
    if (r?.found) found.push(...r.found);
    if (r?.pass) passed.push(r.pass);
    if (r?.block) blocks.push(r.block);
    if (r?.tally) { tally.asked += r.tally.asked; tally.acted += r.tally.acted; tally.notActed.push(...r.tally.notActed); }
  }
  // Answers left unsure with no later answer of another kind block the stop once for that set of items (plan 2.6:
  // `unsure:<hash of their ids>`), named with what each said.
  const unsure = openUnsure(seen);
  const unsureKey = unsure.length ? `unsure:${createHash('sha1').update(unsure.map((a) => a.item).join('\0')).digest('hex').slice(0, 12)}` : null;
  if (unsureKey && !said(unsureKey)) {
    say(unsureKey);
    blocks.push(`readfirst: ${unsure.length} answer(s) of this session are still unsure:\n- ${unsure.map((a) => `\`${a.item}\`: ${a.because}`).join('\n- ')}\nAnswer each again with keeps, not-this or done (${ANSWER_HOW}) once you know, or say why it stays unsure.`);
  }
  const record = { session: String(event.session_id ?? 'none'), at: Date.now(), shown: Object.keys(seen).filter((k) => !/^[a-z]+:/u.test(k)).length, ...tally, resent: Object.keys(seen).filter((k) => k.startsWith('resent:')).length, noFind: Object.keys(seen).filter((k) => k.startsWith('nofindwrite:')).length, misread: Object.keys(seen).filter((k) => k.startsWith('misread:')).length, failed: Object.keys(seen).filter((k) => k.startsWith('failed:')).map((k) => k.slice('failed:'.length)), unsure: unsure.length, untrue: found.length, items: itemTally(seen, found) };
  const line = actedLine(record);
  if (line) { try { appendFileSync(join(stateDir, ACTED_LOG), `${JSON.stringify(record)}\n`); } catch { /* the line is still said */ } }
  if (blocks.length) return JSON.stringify({ decision: 'block', reason: [...blocks, ...notes, ...(line ? [line] : [])].join('\n\n') });
  if (passed.length || notes.length || line) return JSON.stringify({ systemMessage: [...passed, ...notes, ...(line ? [line] : [])].join('\n') });
  return null;
}

// The Stop hook's last line (step 4): what the map asked for the files edited, what was done, what was not, and how
// often a refused edit was made again at once. Every item not done is named.
export function actedLine({ shown = 0, asked = 0, acted = 0, notActed = [], resent = 0, noFind = 0, misread = 0, failed = [], unsure = 0, untrue = 0 }) {
  if (!asked && !resent && !noFind && !misread && !failed.length && !unsure && !untrue) return null; // notes shown and nothing asked: the stop stays quiet, as before
  const unsureLine = `${unsure ? `; ${unsure} answer(s) left unsure` : ''}${untrue ? `; ${untrue} answer(s) the change does not bear out` : ''}`;
  const not = notActed.length ? `, not done: ${notActed.join('; ')}` : '';
  const again = resent ? `; ${resent} refused edit(s) made again at once with nothing in between, so their notes were likely not read` : '';
  const nofind = noFind ? `; ${noFind} edit(s) added new functions without \`readfirst find\` first` : '';
  const misreadLine = misread ? `; readfirst hit an error reading ${misread} command(s), each counted once per folder it ran in, refused once as writes it could not place` : '';
  // One failed: key per tool and error, so the same error on many calls is one.
  const failedLine = failed.length ? `; the hook failed and let calls through unchecked, with ${failed.length} different error(s) (${failed.join('; ')})` : '';
  return `readfirst, this session: notes shown for ${shown} file(s); asked ${asked} (checks to run, files that change together), done ${acted}${not}${again}${nofind}${misreadLine}${failedLine}${unsureLine}.`;
}

// The last line of each session in ACTED_LOG, or null when there is none (no session recorded, or no such file).
function actedSessions(stateDir = tmpdir()) {
  let text = '';
  try { text = readFileSync(join(stateDir, ACTED_LOG), 'utf8'); } catch { return null; }
  const last = new Map();
  for (const l of text.split('\n')) { try { const r = JSON.parse(l); if (r && typeof r.session === 'string') last.set(r.session, r); } catch { /* a line cut short */ } }
  return [...last.values()];
}
// `readfirst hook --report`: the Stop hook's lines of every session kept in ACTED_LOG (the last one of each session),
// added up, with every item not done and how often.
export function hookReport({ stateDir = tmpdir() } = {}) {
  const rows = actedSessions(stateDir);
  if (!rows) return 'readfirst hook --report: no session has been recorded yet (the Stop hook writes one line per session).';
  // The gate's items over every session (plan 2.8): how often each was asked, each kind of answer, and how many the
  // Stop hook found the change did not bear out; most asked first, every one named.
  const items = new Map();
  for (const r of rows) {
    for (const [id, n] of Object.entries(r.items && typeof r.items === 'object' ? r.items : {})) {
      const t = items.get(id) ?? { sessions: 0, asked: 0, false: 0, ...Object.fromEntries(ANSWER_KINDS.map((k) => [k, 0])) };
      t.sessions++;
      for (const k of ['asked', 'false', ...ANSWER_KINDS]) t[k] += Number(n?.[k]) || 0;
      items.set(id, t);
    }
  }
  const itemRows = [...items].sort((a, b) => b[1].asked - a[1].asked || a[0].localeCompare(b[0])).map(([id, t]) => `- \`${id}\`: asked ${t.asked} time(s) in ${t.sessions} session(s); ${ANSWER_KINDS.map((k) => `${k} ${t[k]}`).join(', ')}; not borne out ${t.false}`);
  const sum = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const counts = new Map();
  for (const r of rows) for (const x of r.notActed ?? []) counts.set(x, (counts.get(x) ?? 0) + 1);
  const failures = new Map();
  for (const r of rows) for (const x of Array.isArray(r.failed) ? r.failed : []) failures.set(x, (failures.get(x) ?? 0) + 1);
  const asked = sum('asked');
  return [
    `readfirst hook --report: ${rows.length} session(s)`,
    `- notes shown for ${sum('shown')} file(s)`,
    `- asked ${asked}, done ${sum('acted')}, not done ${asked - sum('acted')}`,
    `- refused edits made again at once with nothing in between: ${sum('resent')}, in ${rows.filter((r) => r.resent > 0).length} session(s)`,
    `- edits that added new functions without \`readfirst find\` first: ${sum('noFind')}, in ${rows.filter((r) => r.noFind > 0).length} session(s)`,
    `- commands readfirst hit an error reading, each counted once per folder it ran in (refused once as writes it could not place): ${sum('misread')}, in ${rows.filter((r) => r.misread > 0).length} session(s)`,
    `- errors the hook let calls through unchecked on: ${failures.size} different, in ${rows.filter((r) => Array.isArray(r.failed) && r.failed.length).length} session(s)`,
    `- answers left unsure at the stop: ${sum('unsure')}, in ${rows.filter((r) => r.unsure > 0).length} session(s)`,
    `- answers the change did not bear out at the stop: ${sum('untrue')}, in ${rows.filter((r) => r.untrue > 0).length} session(s)`,
    ...(itemRows.length ? ['Items the gate asked, most asked first:', ...itemRows] : []),
    ...(failures.size ? ['Hook errors, in most sessions first:', ...[...failures].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x, n]) => `- ${x} (${n})`)] : []),
    ...(counts.size ? ['Not done, most often first:', ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x, n]) => `- ${x} (${n})`)] : []),
  ].join('\n');
}

// The Stop hook for one repository: its map's checks for the files edited there that are still changed.
// answers: the session's answers to the gate (givenAnswers), compared with the change at the end; `found` in the result
// names the items whose last answer the change does not bear out.
// head: the commit the session started from there (headOf), null when the state does not say; start: what the working
// tree held then (baseOf), null when the state does not say.
function stopFor(root, edited, timeout, named, since, { said = () => false, say = () => {}, answers = [], head = null, start = null } = {}) {
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
    const imports = edgesWith(files, targets, readText(root));
    if (map) try { list = readList({ map, files, imports, targets }); } catch { list = null; }
    const brokenLine = broken.length ? `readfirst${at}: ${brokenMapLine(broken)}${list ? '' : ' The checks for the files you edited were not run.'} Fix it before you finish.` : null;
    if (!list) return brokenLine ? { block: brokenLine } : null;
    // Answers the change does not bear out (plan 2.7), by each item's last answer: a not-this whose item the final diff
    // (judged again, as `readfirst diff` judges it) touches by a name outside its symbols; below, a done whose item's
    // checks did not all pass here. Said once for the same items, like every refusal of the stop.
    const last = lastAnswers(answers);
    const items = new Map([...list.rules.map((r) => [itemId('rule', r.id, r.rule), r]), ...list.risks.map((r) => [itemId('risk', r.group, r.text), r])]);
    const untrue = [];
    const notThis = [...items.keys()].filter((id) => last.get(id)?.answer === 'not-this');
    // Judged on the session's own diff: from the commit the repository was at before its first call (`head:`), to the
    // working tree, with files git does not track yet counted whole. A state from an older readfirst has no such commit:
    // nothing is compared, and the stop says so.
    // A starting commit no longer under HEAD (a branch switch, a rebase, a commit gone) would put another branch's
    // changes in the diff, and a diff git cannot make would say nothing at all: both say so instead (review of
    // readfirst#204).
    // The diff starts from what the working tree held at the start (`base:`, baseOf): changes already made then, and
    // files git did not track then, are not the session's. A start only partly known (more untracked files than
    // PRE_MAX, or no snapshot) compares nothing and says so.
    const notCompared = (why) => `readfirst${at}: ${notThis.length} not-this answer(s) were not compared with the change: ${why}.`;
    let noStart = notThis.length && (head === null || !start) ? notCompared("this session's starting commit was not recorded (a state from an older readfirst)") : null;
    if (notThis.length && head && !noStart) {
      // cut: head is a commit sha shortened for the message, not a list.
      try { git(root, 'merge-base', '--is-ancestor', head, 'HEAD'); } catch { noStart = notCompared(`this session started at ${head.slice(0, 12)}, which is not under the commit checked out now (a branch switch or a rebase)`); }
    }
    if (notThis.length && !noStart && start.snapshot === null) noStart = notCompared(`the working tree at the session's start could not be recorded (${start.why})`);
    if (notThis.length && !noStart && start.untracked === null) noStart = notCompared(start.count > PRE_MAX ? `the session started with ${start.count} untracked files, more than the ${PRE_MAX} readfirst records, so its starting point is only partly known` : 'the files git did not track at the session\'s start could not be listed');
    if (notThis.length && !noStart) {
      let changes = null;
      try {
        changes = parseGitDiff(git(root, 'diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', start.snapshot || EMPTY_TREE));
        const before = new Set(start.untracked);
        for (const f of git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) if (!changes.has(f) && !before.has(f)) changes.set(f, { lines: new Set(), text: [], whole: true });
        // readfirst keeps no copy of an untracked file from the start, so what the session changed in one is not judged:
        // said, never left out silently. One the session then added to git shows in the diff as new from its first line
        // (review of readfirst#204), so it leaves the diff too.
        const unkept = [...new Set([...targets, ...changes.keys()])].filter((f) => before.has(f)).sort();
        for (const f of unkept) changes.delete(f);
        if (unkept.length) noStart = `readfirst${at}: ${unkept.map((f) => `\`${f}\``).join(', ')} ${unkept.length === 1 ? 'was' : 'were'} not tracked by git when the session began; anything changed there since was not compared with its ${notThis.length} not-this answer(s).`;
      } catch (e) { changes = null; noStart = notCompared(`the session's diff could not be read (${errorText(e)})`); }
      if (changes) try {
        judge(list, { changes, read: readText(root), files, imports });
        for (const it of noteItems(list)) {
          if (!notThis.includes(it.id)) continue;
          const given = new Set(last.get(it.id).symbols);
          const outside = it.by.filter((s) => !given.has(s));
          if (outside.length) untrue.push({ id: it.id, line: `\`${it.id}\` was answered not-this (${[...given].map((s) => `\`${s}\``).join(', ')}), but the change touches it by ${outside.map((s) => `\`${s}\``).join(', ')}` });
        }
      } catch (e) { noStart = [noStart, notCompared(`the session's diff could not be judged (${errorText(e)})`)].filter(Boolean).join('\n'); }
    }
    const answerLine = () => {
      if (!untrue.length) return null;
      const key = `untrue:${root}:${createHash('sha1').update(untrue.map((u) => u.id).sort().join('\0')).digest('hex').slice(0, 12)}`;
      if (said(key)) return null;
      say(key);
      return `readfirst${at}: ${untrue.length} answer(s) of this session the change does not bear out:\n- ${untrue.map((u) => u.line).join('\n- ')}\nAnswer them again (${ANSWER_HOW}), or say why, before you finish.`;
    };
    // Files left behind: what the map says changes together with an edited file, against everything changed so far,
    // the session's own commits included: they make a file count as edited, so its partner in the same commits counts
    // as changed too (a pair committed together was reported as left behind until 0.27.1).
    const all = [...new Set([...dirty, ...changed, ...committedAfter])];
    const missing = list.together.filter((t) => !all.some(matcher(t.also)));
    if (!list.checks.length && !missing.length) {
      const answersSaid = answerLine();
      const found = untrue.map((u) => u.id);
      if (!brokenLine && !answersSaid) return found.length || noStart ? { found, note: noStart } : null;
      return { block: [brokenLine, answersSaid].filter(Boolean).join('\n'), found, note: noStart };
    }
    const trusted = trustedRuns(root, since);
    const skipped = list.checks.filter((c) => !trusted.runs.has(c.run)).map((c) => c.run);
    const result = verifyChecks(root, list.checks.filter((c) => trusted.runs.has(c.run)), { timeout });
    const failed = result.filter((c) => c.status !== 'pass');
    // A done whose item has checks (a rule's own, a risk's group's) that did not all pass in this run.
    const passed = new Set(result.filter((c) => c.status === 'pass').map((c) => c.run));
    for (const [id, row] of items) {
      if (last.get(id)?.answer !== 'done') continue;
      const own = id.startsWith('rule:') ? (map.rules ?? []).find((r) => r.id === row.id)?.checks : (map.groups ?? []).find((g) => g.id === row.group)?.checks;
      const open = (own ?? []).map((c) => c.run).filter((r) => !passed.has(r));
      if (open.length) untrue.push({ id, line: `\`${id}\` was answered done, but ${open.map((r) => `\`${r}\` ${result.find((c) => c.run === r)?.status ?? 'did not run'}`).join(', ')}` });
    }
    const answersSaid = answerLine();
    const found = untrue.map((u) => u.id);
    const notRun = skipped.length ? ` Not run, because ${trusted.why}: ${skipped.map((r) => `\`${r}\``).join(', ')}; run \`npx readfirst verify\` to run them on purpose.` : '';
    const byCommand = unnamed.filter((f) => targets.includes(f));
    const fromCommands = byCommand.length ? ` Changed in this session by commands readfirst could not read, so checked too: ${byCommand.join(', ')}.` : '';
    // Checks that did not run block the stop once for this state of the files (0.27.1: they used to pass it with a note).
    const state = skipped.length ? `notrun:${root}:${treeState(root, dirty)}` : null;
    const blockNotRun = state && !said(state);
    if (blockNotRun) say(state);
    const tally = {
      asked: list.checks.length + list.together.length,
      acted: result.length - failed.length + list.together.length - missing.length,
      notActed: [...failed.map((c) => `\`${c.run}\` ${c.status}`), ...skipped.map((r) => `\`${r}\` not run`), ...missing.map((t) => `${t.also.join(', ')} not changed with ${t.for.join(', ')}`)],
    };
    if (!failed.length && !missing.length && !brokenLine && !blockNotRun && !answersSaid) return { tally, found, note: noStart, pass: `readfirst verify${at}: ${result.length} check(s) passed for ${targets.length} edited file(s).${notRun}${fromCommands}` };
    return { tally, found, note: noStart, block: [
      ...(brokenLine ? [brokenLine] : []),
      ...(answersSaid ? [answersSaid] : []),
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
  // A readfirst hook installed before it read Bash commands (matcher Edit|Write|MultiEdit) never sees a file a command
  // writes, nor a `readfirst read` or `find` run in Bash, and installing again left it so (2026-11-13). Bash is added
  // to the matcher of each such entry; its command is left as it is (--gate stays the user's choice), and so is every
  // other entry. A matcher is a pattern of tool names: none, '' or '*' already covers Bash.
  const seesBash = (m) => {
    if (typeof m !== 'string' || m === '' || m === '*') return true;
    try { return new RegExp(`^(?:${m})$`, 'u').test('Bash'); } catch { return m.split('|').map((s) => s.trim()).includes('Bash'); }
  };
  const narrow = pre.filter((m) => !seesBash(m.matcher) && (m.hooks ?? []).some((h) => /readfirst hook/u.test(h.command ?? '') && !/--stop\b/u.test(h.command ?? '')));
  const widened = narrow.map((m) => [m.matcher, `${m.matcher}|Bash`]);
  for (const m of narrow) m.matcher = `${m.matcher}|Bash`;
  if (!added && !widened.length) return false;
  if (!added) {
    // Only the matcher changes: the file keeps its own layout (and a byte order mark) when each old matcher is
    // written once in it; otherwise it is written out as JSON, as for a new hook.
    let text = readFileSync(at, 'utf8');
    const once = widened.every(([from]) => text.split(JSON.stringify(from)).length === 2);
    if (once) {
      for (const [from, to] of widened) text = text.replace(JSON.stringify(from), () => JSON.stringify(to));
      writeFileSync(at, text);
      return 'matcher';
    }
  }
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(at, `${JSON.stringify(settings, null, 2)}\n`);
  return added || 'matcher';
}

// The changes to `path` since the commit that last wrote `ref` into the map (git log -S), to the working tree, for
// evidenceDrift; null when git cannot tell (no history, a shallow clone, the reference never committed).
function evidenceHistory(root) {
  return (path, ref) => {
    try {
      const c = git(root, 'log', '-1', '--format=%H', `-S${ref}`, '--', MAP_PATH).trim();
      if (!c) return null;
      return parseGitDiff(git(root, 'diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', c, '--', path)).get(path) ?? { lines: new Set(), text: [], hunks: [], whole: false };
    } catch { return null; }
  };
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
      // --timeout (seconds per check) reaches the Stop hook too: it was accepted and ignored until 0.29.0, so a check
      // longer than 600 s (a browser test chain of 1,065 s) was cut off and reported as failed. A bad value is said, not
      // taken as the default.
      const timeout = args.timeout === undefined ? undefined : Number(args.timeout);
      if (timeout !== undefined && !(timeout > 0)) return letThrough(new Error('--timeout needs a number of seconds above 0'));
      if (args.report) { io.out(`${hookReport()}\n`); return 0; }
      const out = args.stop ? runStopHook(stdin(), timeout ? { timeout } : {}) : runHook(stdin(), { gate: args.gate });
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
  // `readfirst answer '<json>'`: what the gate asked, answered. The PreToolUse hook reads the answer from the command
  // line before it runs and keeps it (src/answers.mjs); the command itself only says what it was given and what is
  // wrong with it, and writes nothing. It needs no repository.
  if (cmd === 'answer') {
    if (rest.length !== 1) throw new Error(`give the answers as one quoted JSON argument: ${ANSWER_HOW}`);
    const { answers, problems } = parseAnswer(rest[0]);
    if (problems.length) { io.out(`readfirst answer: not kept, nothing of it:\n- ${problems.join('\n- ')}\n`); return 1; }
    io.out(`readfirst answer: ${answers.length} answer(s):\n${answers.map((a) => `- ${a.item}: ${a.answer}${a.symbols.length ? ` (${a.symbols.join(', ')})` : ''}, because ${a.because}`).join('\n')}\nUnder \`readfirst hook --gate\` the hook checks them against what it asked and keeps them when this command is let through; this command writes nothing.\n`);
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
    // Evidence lines outside what their item names (2026-11-10): the line judges the item against a change, so
    // one the code moved away from judges by the wrong code. Listed, failed with --strict; `fix` moves those git traces.
    const { drift, unanchored } = evidenceDrift(map, { files, read, history: evidenceHistory(root) });
    const driftLine = (d) => `${d.where}: ${d.ref} is outside ${d.names.map((n, i) => `\`${n}\` (line ${d.lines[i]})`).join(', ')}${d.now ? `: it moved to ${d.path}:${d.now}, \`readfirst fix\` writes that` : ': git does not show it moving there, so check it by hand (wrong from the start, or pointing elsewhere on purpose)'}`;
    const problems = [...settledMap.problems, ...pinProblems(map, pinnedReadfirst(new Map(pinFiles(files).map((f) => [f, read(f)])))), ...(args.strict ? [...about, ...drift.map(driftLine)] : [])];
    if (args.json) io.out(`${JSON.stringify({ ok: !problems.length, problems, settled, unshown, drift, unanchored }, null, 2)}\n`);
    else {
      if (problems.length) io.out(`${MAP_PATH} has ${problems.length} problem(s):\n- ${problems.join('\n- ')}\n`);
      else io.out(`${MAP_PATH} is good: ${files.length} files.\n`);
      if (settled.length) io.out(`settled without writing (\`readfirst fix\` writes it down):\n- ${settled.join('\n- ')}\n`);
      if (about.length && !args.strict) io.out(`risks about a file that does not show them (it gets nothing when it is read; --strict fails on them):\n- ${about.join('\n- ')}\n`);
      if (mentions.length) io.out(`risks that mention a file which does not show them (often a consequence; add the file to their files if whoever changes it should read them):\n- ${mentions.join('\n- ')}\n`);
      if (drift.length && !args.strict) io.out(`evidence lines outside what their risk or rule names (a change is judged by that line; --strict fails on them):\n- ${drift.map(driftLine).join('\n- ')}\n`);
      if (unanchored.length) io.out(`evidence lines in a code file where their risk or rule names nothing declared, so a move cannot be seen (name the function in backticks):\n- ${unanchored.map((u) => `${u.where}: ${u.ref}`).join('\n- ')}\n`);
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
    // --git: only the git hooks (opt-in); the agents are wired by setup without it. Without a map the hooks would fail
    // every commit, so it stops before writing them.
    if (args.git) {
      if (!existsSync(join(root, MAP_PATH))) throw new Error(`no ${MAP_PATH} here: the hooks would fail every commit; \`readfirst init\` writes a first map, then run setup --git again`);
      io.out(gitHooksReport(setupGitHooks(root, (...a) => git(root, ...a))));
      return 0;
    }
    io.out(setupReport(setup(root, args.for)) + placeHint());
    return 0;
  }
  if (cmd === 'hook') {
    let added;
    try { added = installHook(root, { verify: args.verify }); } catch (e) { throw new Error(`${e.message}; ${hookSnippet(args.verify)}`); }
    io.out((added === 'matcher'
      ? `added Bash to the readfirst hook's matcher in .claude/settings.json: it now also sees files a Bash command writes, and the \`readfirst read\` and \`find\` runs; its command was left as it was.\n`
      : added
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
    // Evidence lines git shows moving with the code are written where they are now.
    for (const d of evidenceDrift(map, { files, read: readText(root), history: evidenceHistory(root) }).drift.filter((x) => x.now)) {
      const [, gid, i] = d.where.match(/^groups\.(.+)\.risks\[(\d+)\]$/u) ?? [];
      const item = gid !== undefined ? map.groups.find((g) => g.id === gid)?.risks?.[Number(i)] : map.rules?.find((r) => `rules.${r.id}` === d.where);
      const key = gid !== undefined ? 'text' : 'rule';
      if (!item || typeof item[key] !== 'string') continue;
      item[key] = moveEvidence(item[key], d.ref, d.path, d.now);
      changes.push(`${d.where}: ${d.ref} -> ${d.path}:${d.now} (\`${d.names[0]}\` moved)`);
    }
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
    // The rules and risks of this map that most sessions answered not-this at the gate (plan 2.8), from the Stop hook's
    // lines on this machine (ACTED_LOG in the temp folder; read, never written): each is wider than what it is about.
    const ofMap = new Map([...(settled.rules ?? []).map((r) => [itemId('rule', r.id, r.rule), `rule ${r.id}: ${r.rule}`]), ...(settled.groups ?? []).flatMap((g) => (g.risks ?? []).map((r) => [itemId('risk', g.id, r.text), `risk in group ${g.id}: ${r.text}`]))]);
    report.wide = wideItems((actedSessions() ?? []).map((r) => r.items)).filter((w) => ofMap.has(w.id)).map((w) => ({ ...w, text: ofMap.get(w.id) }));
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
    let changes = null;
    if (cmd === 'diff') {
      const changed = changedFiles(root, args.base);
      onBaseItself(changed, io);
      rev = changed.since;
      targets = changed.files;
      // What each file's change is, for judging risks and rules against it (src/trigger.mjs): the commits since the base
      // and what is not committed yet; a new file not added yet counts as changed all through.
      changes = parseGitDiff(git(root, 'diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', changed.since));
      for (const f of changed.files) if (!changes.has(f)) changes.set(f, { lines: new Set(), text: [], whole: true });
      if (!targets.length) {
        io.out(args.json ? `${JSON.stringify(emptyList(commit), null, 2)}\n` : `no files changed since ${changed.ref}.\n`);
        return 0;
      }
    }
    // No limit unless asked for: a cut list says how many it left out.
    const limit = args.limit === undefined ? Infinity : Number(args.limit);
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit needs a whole number of 1 or more');
    const broke = brokeBefore(root, targets, new Set(files), rev);
    const imports = edgesWith(files, targets, readText(root));
    const list = readList({ map, files, imports, targets, commit, limit, read: readText(root), held: parseHeld(readText(root)(HELD_PATH)), broke, before: map && asWritten.get(map) });
    if (changes) judge(list, { changes, read: readText(root), files, imports });
    // diff opens with the verdict (src/verdict.mjs) in --lang, else the one language of this clone's labels, else English.
    const verdict = changes ? { lang: diffLang(args.lang, () => Object.keys(readLabels(root, io.err))), where: 'diff' } : null;
    io.out(args.json ? `${JSON.stringify(list, null, 2)}\n` : `${toMarkdown(list, { verdict })}\n`);
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
