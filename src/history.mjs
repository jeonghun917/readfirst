// Where the code broke before, from `git log` only: no map, no network, no model. A commit whose subject says something
// broke (a revert, a rollback, a hotfix, a regression, a fix) is a scar on the files it touched. The rules below are the
// ones the hosted version uses, kept in one module so both can read them from here.
import { execFileSync } from 'node:child_process';

// How strongly a commit message says "something broke here". The first match wins.
export const SIGNALS = [
  [3, 'revert', /^revert\b|\brevert(?:s|ed|ing)?\s+["'`#(]|\bthis reverts commit\b/iu],
  [3, 'rollback', /\broll(?:ed|s|ing)?[ -]?back\b/iu],
  [2, 'hotfix', /\bhot[ -]?fix(?:es|ed)?\b/iu],
  [2, 'regression', /\bregress(?:ion|ions|ed)?\b/iu],
  [2, 'broke', /\b(?:broke|breaks|broken|outage|incident|crash(?:es|ed)?|data loss)\b/iu],
  [1, 'fix', /^(?:fix|bugfix)(?:\(.*?\))?!?:|\bfix(?:es|ed)?\b|\bbug\b/iu],
];

// Changes that say nothing about traps in the code: dependency bumps, formatting, typos, docs, tests, new features, and
// release commits (a subject that starts with a version, "0.17.0: ..." or "v1.2.3 ...").
export const NOISE = /\b(?:bump|deps?|dependabot|renovate|typos?|lint|format(?:ting)?|prettier|readme|changelog|release v?\d|merge branch)\b|^(?:docs?|test|tests|chore|style|ci|build|refactor|perf|feat)(?:\(.*?\))?!?:|^fix\((?:docs?|ci|tests?|deps?|build|examples?|readme)\)|^v?\d+\.\d+\.\d+\b/iu;
// Files that are never where the trap is: lock files, generated output, media.
export const NOT_CODE = /^\.github\/|^\.readfirst\/|^\.[^/]+$|\.(?:md|mdx|rst|txt)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|CHANGELOG(?:\.md)?)$|\.(?:png|jpe?g|gif|svg|ico|webp|mp4|mp3|wav|woff2?|ttf|glb|gltf|zip|gz|min\.js|map|snap)$|(?:^|\/)(?:dist|build|vendor|node_modules)\//iu;

// Files NOT_CODE lets through that change with almost every fix without being where it broke: tool and CI folders,
// container files, schema or API dumps, package manifests, translation files and data files (a ledger or dataset whose commits mention fixes). They are left out of the "Broke most"
// ranking only; `read` on one of them still shows its history.
export const NOT_TRAP = /(?:^|\/)\.[^/]+\/|(?:^|\/)(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|schema\.(?:graphql|json)|openapi[^/]*\.(?:json|ya?ml)|package\.json|pnpm-workspace\.ya?ml|tsconfig[^/]*\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|Gemfile|Pipfile)$|\.(?:jsonl|ndjson|csv|tsv)$|(?:^|\/)(?:locales?|i18n|translations?|lang)\/[^/]*\.(?:json|po|ya?ml)$/iu;

export const TEST = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$/iu;

// Only the subject line counts (bodies mention fixes in passing), except git's own "This reverts commit" line.
export function scar(message) {
  const text = String(message ?? '');
  const first = text.split('\n')[0];
  if (/^revert\b/iu.test(first) || /^This reverts commit [0-9a-f]{7,}/mu.test(text)) return { weight: 3, kind: 'revert' };
  if (NOISE.test(first)) return null;
  for (const [weight, kind, re] of SIGNALS) if (re.test(first)) return { weight, kind };
  return null;
}

// A commit touching many files says little about any one of them, so its weight is spread over them. scars: [{ weight,
// files }]; exists: the set of files that are still there. Returns Map(path -> score).
export const MAX_FILES_PER_COMMIT = 25;
export function spreadScars(scars, exists) {
  const score = new Map();
  for (const c of scars) {
    const files = (c.files ?? []).filter((f) => exists.has(f) && !NOT_CODE.test(f));
    if (!files.length || files.length > MAX_FILES_PER_COMMIT) continue;
    for (const f of files) {
      // Tests show where it broke but the trap is in the code they test, so they count half.
      score.set(f, (score.get(f) ?? 0) + (c.weight / Math.sqrt(files.length)) * (TEST.test(f) ? 0.5 : 1));
    }
  }
  return score;
}

// `read` and `diff` look at the last LOG_LIMIT commits of a file, and show it when its scars weigh MIN_WEIGHT or more
// (one fix is weight 1: it is not yet a pattern; one revert, rollback or hotfix is).
export const LOG_LIMIT = 200;
export const MIN_WEIGHT = 2;
const TOP_SHOWN = 3;

const day = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

// commits: [{ sha, time, subject }] for one file, newest first. Returns { count, weight, top } or undefined when the file
// has too little to show (or is not code).
export function summarizeScars(path, commits) {
  if (NOT_CODE.test(path)) return undefined;
  const half = TEST.test(path) ? 0.5 : 1;
  const scars = commits.map((c) => ({ ...c, ...scar(c.subject) })).filter((c) => c.weight);
  const weight = scars.reduce((n, c) => n + c.weight, 0) * half;
  if (weight < MIN_WEIGHT) return undefined;
  // Strongest first, newest first within equal weight.
  const top = [...scars].sort((a, b) => b.weight - a.weight || b.time - a.time).slice(0, TOP_SHOWN)
    .map((c) => ({ sha: c.sha.slice(0, 7), date: day(c.time), kind: c.kind, subject: c.subject }));
  const last = scars.reduce((a, b) => (b.time > a.time ? b : a));
  return { count: scars.length, weight, top, last: { sha: last.sha.slice(0, 7), date: day(last.time), kind: last.kind, subject: last.subject } };
}

// Never throws: not a git repository, git missing or any other failure gives null.
function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

// Whether the clone has cut-off history short enough that "no scars found" says little: shallow, and fewer commits than
// the log looks at. A clone fetched to depth 200 or more is shallow too, but has what `read` looks at.
export function historyNotFetched(root, rev = 'HEAD') {
  if (git(root, ['rev-parse', '--is-shallow-repository'])?.trim() !== 'true') return false;
  const n = Number(git(root, ['rev-list', '--count', rev])?.trim());
  return !Number.isFinite(n) || n < LOG_LIMIT;
}

// The revision whose history a PR's "broke before" reads: the base the PR was opened against, so the PR's own commits
// (a "fix: ..." that is the change being reviewed) do not make its files look like they broke before. baseSha, when that
// commit is in the checkout; else HEAD^1 when HEAD is a merge commit (the refs/pull/N/merge checkout); else HEAD.
export function baseRevision(root, baseSha = null) {
  if (/^[0-9a-f]{7,40}$/iu.test(baseSha ?? '') && git(root, ['cat-file', '-e', `${baseSha}^{commit}`]) !== null) return baseSha;
  const parents = git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])?.trim().split(' ') ?? [];
  return parents.length > 2 ? 'HEAD^1' : 'HEAD';
}

// For each tracked code file among `targets`: { count, weight, top, last }, or { notFetched: true } when a shallow
// clone has too little history to say. Files with nothing to show are left out; with no git at all the result is {}.
// rev: the revision whose history is read (default HEAD; `diff` and the Action pass the base of the change).
export function brokeBefore(root, targets, tracked = null, rev = 'HEAD') {
  const out = {};
  if (rev.startsWith('-')) return out;
  if (git(root, ['rev-parse', '--git-dir']) === null) return out;
  let notFetched = null;
  for (const raw of targets) {
    const path = raw.replace(/^\.\//u, '').replace(/\\/gu, '/');
    if (NOT_CODE.test(path) || (tracked && !tracked.has(path))) continue;
    const text = git(root, ['log', '--no-merges', '--format=%H%x00%ct%x00%s', '-n', String(LOG_LIMIT), rev, '--', `:(literal)${path}`]);
    if (text === null) continue;
    const commits = text.split('\n').filter(Boolean).map((l) => { const [sha, time, subject] = l.split('\0'); return { sha, time: Number(time), subject: subject ?? '' }; });
    const found = summarizeScars(path, commits);
    if (found) out[path] = found;
    else { notFetched ??= historyNotFetched(root, rev); if (notFetched) out[path] = { notFetched: true }; }
  }
  return out;
}

// git log --format=%x01%H%x00%ct%x00%s --name-only: [{ sha, time, subject, files }], newest first.
export function parseScarLog(text) {
  return String(text ?? '').split('\x01').filter((c) => c.trim()).map((c) => {
    const [head, ...rest] = c.split('\n');
    const [sha, time, subject] = head.split('\0');
    return { sha, time: Number(time), subject: subject ?? '', files: rest.map((f) => f.trim()).filter(Boolean) };
  });
}

// "Broke most" needs this much to be worth listing: a file's spread weight of at least BROKE_MOST_MIN_SCORE, from at
// least BROKE_MOST_MIN_COMMITS scar commits. On a small or young repository every file sits at one or two fixes and a
// list of them would be noise, so the list is then empty.
export const BROKE_MOST_MIN_SCORE = 2;
export const BROKE_MOST_MIN_COMMITS = 2;
export const BROKE_MOST_TOP = 10;

// The files with the highest scar weight over the last 12 months, from one pass over the log. log: parseScarLog;
// exists: the files still in the checkout. Returns [{ path, score, commits, last }] best first.
export function brokeMost(log, exists, { top = BROKE_MOST_TOP } = {}) {
  const scars = log.map((c) => ({ ...c, ...scar(c.subject) })).filter((c) => c.weight);
  const kept = new Set([...exists].filter((f) => !NOT_TRAP.test(f)));
  const score = spreadScars(scars, kept);
  const touched = new Map();
  for (const c of scars) {
    const files = c.files.filter((f) => kept.has(f) && !NOT_CODE.test(f));
    if (!files.length || files.length > MAX_FILES_PER_COMMIT) continue;
    for (const f of files) touched.set(f, [...(touched.get(f) ?? []), c]);
  }
  return [...score]
    .map(([path, s]) => {
      const cs = touched.get(path);
      const last = cs.reduce((a, b) => (b.time > a.time ? b : a));
      return { path, score: Math.round(s * 10) / 10, commits: cs.length, last: { sha: last.sha.slice(0, 7), date: day(last.time), kind: last.kind, subject: last.subject } };
    })
    .filter((r) => r.score >= BROKE_MOST_MIN_SCORE && r.commits >= BROKE_MOST_MIN_COMMITS)
    .sort((a, b) => b.score - a.score || b.commits - a.commits || a.path.localeCompare(b.path))
    .slice(0, top);
}

// One pass over the last 12 months of the log for `audit`; [] when there is no git or no history.
export function readScarLog(root, since = '12.months') {
  const text = git(root, ['-c', 'core.quotepath=off', 'log', '--no-merges', '--no-renames', `--since=${since}`, '--name-only', '--format=%x01%H%x00%ct%x00%s']);
  return text === null ? [] : parseScarLog(text);
}
