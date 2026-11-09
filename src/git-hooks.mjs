// `readfirst setup --git`: a line in the git hooks every commit and push goes through, whoever makes them. Agent notes,
// skills and MCP tools are optional and agents skip them (the owner saw Codex and Claude skip a skill, 2026-11-09); a
// git hook runs for every agent that commits. pre-commit runs `check` (fast), pre-push runs `verify` (the map's checks
// for what changed; it can take minutes). Opt-in and local: nothing here runs a command but git itself, or touches the
// network; the hooks run npx when git calls them.
//
// Where: the folder git calls hooks from (`git rev-parse --git-path hooks`: .git/hooks, core.hooksPath, the main
// repository's .git/hooks for a worktree), and for husky (core.hooksPath .husky/_ or .husky) the user's own .husky/<hook>.
// A hook that is there gets one line added, never replaced. A hooks folder outside the repository and its git folder (a
// global core.hooksPath shared by every repository), a hook file that leads out of them, a hook that is not a shell
// script, and one that hands over with `exec` (a line after it never runs) are left alone; the line is printed for
// adding by hand.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const GIT_HOOK_LINES = {
  'pre-commit': 'npx --yes readfirst check || exit 1 # readfirst: the map places every file (git commit --no-verify skips it once)',
  'pre-push': 'npx --yes readfirst verify || exit 1 # readfirst: the checks the map lists for what changed (git push --no-verify skips it once)',
};

const inside = (dir, path) => dir != null && (path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep));
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
// Where a path really is, a missing one placed by its nearest existing folder (as writing it would create it there).
function whereReally(p) {
  let probe = p;
  const rest = [];
  while (!existsSync(probe) && dirname(probe) !== probe) { rest.unshift(basename(probe)); probe = dirname(probe); }
  return join(real(probe) ?? probe, ...rest);
}

// Adds the readfirst line to pre-commit and pre-push. Returns the folder, what it wrote, what was already there and what
// to add by hand. `git(...args)` runs git in the repository and returns its output.
export function setupGitHooks(root, git) {
  const said = git('rev-parse', '--git-path', 'hooks').trim();
  let dir = isAbsolute(said) ? said : resolve(root, said);
  // husky runs .husky/_/<hook>, which it writes itself and which calls the user's .husky/<hook>: the line goes there.
  if (['.husky/_', '.husky'].includes(relative(root, dir).split(sep).join('/'))) dir = join(root, '.husky');
  const common = git('rev-parse', '--git-common-dir').trim();
  const allowed = [real(root), real(isAbsolute(common) ? common : resolve(root, common))];
  const ok = (p) => allowed.some((a) => inside(a, p));
  const show = (p) => { const r = relative(root, p); return !r || r.startsWith('..') || isAbsolute(r) ? p : r; };
  const out = { folder: show(dir), wrote: [], already: [], manual: [] };
  for (const [hook, line] of Object.entries(GIT_HOOK_LINES)) {
    const file = join(dir, hook);
    const byHand = (why) => out.manual.push(`${show(file)} ${why}; add this line to it by hand: ${line}`);
    const folder = whereReally(dir);
    if (!ok(folder)) { byHand(`is in a hooks folder outside this repository and its git folder (${folder}), shared with other repositories`); continue; }
    const at = whereReally(file);
    if (!ok(at)) { byHand(`leads outside this repository and its git folder (to ${at})`); continue; }
    const now = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (now != null && /\breadfirst (?:check|verify)\b/u.test(now)) { out.already.push(show(file)); continue; }
    if (now != null) {
      const first = now.split('\n')[0];
      if (first.startsWith('#!') && !/\b(?:sh|bash|dash|zsh|ksh)\b/u.test(first)) { byHand(`is not a shell script (${first})`); continue; }
      // A line after `exec` never runs: the hook hands the process over (the pre-commit framework's hook does).
      if (/^\s*exec\s/mu.test(now)) { byHand('hands over with exec, so a line added at the end would never run'); continue; }
      writeFileSync(file, `${now}${!now || now.endsWith('\n') ? '' : '\n'}${line}\n`);
    } else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `#!/bin/sh\n${line}\n`);
    }
    // git runs only an executable hook.
    chmodSync(file, statSync(file).mode | 0o111);
    out.wrote.push(show(file));
  }
  return out;
}

export function gitHooksReport({ folder, wrote, already, manual }) {
  return [
    `git hooks (${folder}):`,
    ...(wrote.length ? [`wrote: ${wrote.join(', ')}. pre-commit runs \`readfirst check\`, pre-push runs \`readfirst verify\` (the map's checks for what changed; it can take minutes). \`--no-verify\` skips them once.`] : []),
    ...(already.length ? [`already there: ${already.join(', ')}.`] : []),
    ...manual.map((m) => `by hand: ${m}`),
  ].join('\n') + '\n';
}
