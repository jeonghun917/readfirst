// readfirst: what to read and check before changing a file.
//   readfirst init                 write a first .readfirst/map.json from the file tree
//   readfirst prompt               the brief for a coding agent to fill in titles, checks, risks and rules
//   readfirst check                the map covers every tracked file and is well formed
//   readfirst read <file>...       the read list for files you are about to change
//   readfirst diff [--base <ref>]  the read list for the files changed since <ref> (default: origin/main, else main)
// Options: --root <dir> (default: the current git repository), --json, --limit <n>.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importEdges } from './imports.mjs';
import { assertMap, draftMap, MAP_PATH, mapProblems } from './map.mjs';
import { agentBrief } from './prompt.mjs';
import { emptyList, readList, toMarkdown } from './readlist.mjs';

const HELP = `readfirst — what to read and check before changing a file

  readfirst init                 write a first ${MAP_PATH} from the file tree
  readfirst prompt               brief for your coding agent to fill in the map
  readfirst check                check the map covers every tracked file
  readfirst read <file>...       read list for files you are about to change
  readfirst diff [--base <ref>]  read list for files changed since <ref>

Options: --root <dir>, --json, --limit <n>, --force (init: replace the map)`;

function parse(argv) {
  const args = { _: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--force') args.force = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--')) { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); args[a.slice(2)] = v; }
    else args._.push(a);
  }
  return args;
}

const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

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

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const args = parse(argv);
  const [cmd, ...rest] = args._;
  if (args.help || !cmd) { io.out(`${HELP}\n`); return cmd || args.help ? 0 : 2; }
  const root = args.root ?? git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const files = repoFiles(root);
  const commit = (() => { try { return git(root, 'rev-parse', 'HEAD').trim(); } catch { return null; } })();

  if (cmd === 'init') {
    const at = join(root, MAP_PATH);
    if (existsSync(at) && args.force !== true) throw new Error(`${MAP_PATH} already exists (pass --force to replace it)`);
    const map = draftMap(files);
    mkdirSync(join(root, '.readfirst'), { recursive: true });
    writeFileSync(at, `${JSON.stringify(map, null, 2)}\n`);
    io.out(`wrote ${MAP_PATH}: ${map.groups.length} groups, ${map.ignore.length} ignored folders.\nNext: run \`readfirst prompt\` and give the brief to your coding agent, or fill in titles, checks, risks and rules by hand.\n`);
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
  if (cmd === 'read' || cmd === 'diff') {
    const map = loadMap(root, files);
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
