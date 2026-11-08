// Map edits waiting on a branch nobody has merged: the hosted upkeep keeps one pull request on readfirst/upkeep and adds
// each merge's map edits to it. Left open, it grows unseen (one stayed open three weeks, through 55 merges). Read from
// the refs the clone already has (no network: as of the last fetch), so the hook and an agent can say so.
import { execFileSync } from 'node:child_process';

export const UPKEEP_REFS = 'refs/remotes/*/readfirst/upkeep';
export const MIN_DAYS = 7;
export const MIN_MERGES = 10;

const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// The branch the edits should land on: the remote's HEAD, else <remote>/main or master. Null when none is known.
function baseOf(root, remote) {
  for (const ref of [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`]) {
    try { git(root, 'rev-parse', '--verify', '--quiet', ref); return ref; } catch { /* next */ }
  }
  return null;
}

// { branch, merges, commits, since, days } for the upkeep branch with commits its base lacks, or null.
// merges counts the "#N" numbers in its commit subjects; since is the oldest of those commits.
export function pendingUpkeep(root, { now = Date.now() } = {}) {
  let refs;
  try { refs = git(root, 'for-each-ref', '--format=%(refname)', UPKEEP_REFS).trim().split('\n').filter(Boolean); } catch { return null; }
  for (const ref of refs) {
    const remote = ref.split('/')[2];
    const base = baseOf(root, remote);
    if (!base) continue;
    let log;
    try { log = git(root, 'log', '--no-merges', '--format=%cI%x09%s', `${base}..${ref}`).trim(); } catch { continue; }
    if (!log) continue;
    const rows = log.split('\n').map((l) => l.split('\t'));
    const numbers = new Set(rows.flatMap(([, s]) => [...(s ?? '').matchAll(/#(\d+)/gu)].map((m) => m[1])));
    const since = rows.at(-1)[0];
    return { branch: ref.replace(/^refs\/remotes\//u, ''), merges: numbers.size, commits: rows.length, since: since.slice(0, 10), days: Math.floor((now - Date.parse(since)) / 86_400_000) };
  }
  return null;
}

// Worth a word: waiting a week, or ten merges.
export const pendingDue = (p) => Boolean(p && (p.days >= MIN_DAYS || p.merges >= MIN_MERGES));

export function pendingLine(p) {
  const n = p.merges || p.commits;
  return `map edits from ${n} merge${n === 1 ? '' : 's'} have waited ${p.days} day${p.days === 1 ? '' : 's'} on ${p.branch} (since ${p.since}, as of the last fetch): review and merge that pull request, or close it, so the map stays in step`;
}
