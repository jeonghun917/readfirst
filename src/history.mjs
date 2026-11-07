// Where the code broke before, from `git log` only: no map, no network, no model. A commit whose subject says something
// broke (a revert, a rollback, a hotfix, a regression, a fix) is a scar on the files it touched. The rules below are the
// ones the hosted version uses, kept in one module so both can read them from here.
import { execFileSync } from 'node:child_process';

// How strongly a commit message says "something broke here". The first match wins. A verb (revert, roll back, hotfix,
// fix) counts only where it starts a clause of the subject, as the thing this commit does; a failure word (regression,
// broke, crash...) counts anywhere, but alone it is only weight 1, and 2 when the subject also fixes something.
export const SIGNALS = [
  [3, 'revert', /^revert(?:s|ed|ing)?\b(?!\s+(?:to|back to)\b)/iu],
  [3, 'rollback', /^roll(?:ed|s|ing)?[ -]?back\b/iu],
  [2, 'hotfix', /^hot[ -]?fix(?:es|ed)?\b/iu],
  [2, 'regression', /\bregress(?:ion|ions|ed)\b/iu], // "regression", not a script or test named regress
  [2, 'broke', /\b(?:broke|breaks|broken|outage|incident|crash(?:es|ed)?|data loss)\b/iu],
  [1, 'fix', /^(?:bug[ -]?)?fix(?:es|ed|ing)?\b/iu],
];

// Changes that say nothing about traps in the code: dependency bumps, formatting, typos, docs, tests, new features, and
// release commits (a subject that starts with a version, "0.17.0: ..." or "v1.2.3 ...").
export const NOISE = /\b(?:bump|deps?|dependabot|renovate|typos?|lint|format(?:ting)?|prettier|readme|changelog|release v?\d|merge branch)\b|^(?:docs?|test|tests|chore|style|ci|build|refactor|perf|feat)(?:\(.*?\))?!?:|^\W*fix\((?:docs?|ci|tests?|deps?|build|examples?|readme|i18n|l10n|translations?|locales?|lang|css|styles?|lint|types?|typos?)\)|^v?\d+\.\d+\.\d+\b/iu;
// Files that are never where the trap is: lock files, generated output, media.
export const NOT_CODE = /^\.github\/|^\.readfirst\/|^\.[^/]+$|\.(?:md|mdx|rst|txt)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|CHANGELOG(?:\.md)?)$|\.(?:png|jpe?g|gif|svg|ico|webp|mp4|mp3|wav|woff2?|ttf|glb|gltf|zip|gz|min\.js|map|snap)$|(?:^|\/)(?:dist|build|vendor|node_modules)\//iu;

// Files NOT_CODE lets through that change with almost every fix without being where it broke: tool and CI folders,
// container files, schema or API dumps, package manifests, translation files and data files (a ledger or dataset whose commits mention fixes). They are left out of the "Broke most"
// ranking only; `read` on one of them still shows its history.
export const NOT_TRAP = /(?:^|\/)\.[^/]+\/|(?:^|\/)(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|schema\.(?:graphql|json)|openapi[^/]*\.(?:json|ya?ml)|package\.json|pnpm-workspace\.ya?ml|tsconfig[^/]*\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|Gemfile|Pipfile)$|\.(?:jsonl|ndjson|csv|tsv)$|(?:^|\/)(?:locales?|i18n|translations?|lang)\/[^/]*\.(?:json|po|ya?ml)$/iu;

export const TEST = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$/iu;

// The parts of a subject that each say what the commit does: split at sentence ends, colons, "and"/"then", and " - ".
// "fix(scope)!:" stays one part.
const CLAUSES = /[.;!?](?:\s+|$)|:\s+|\s+(?:and|then|also|&)\s+|\s+-\s+/iu;
// A fix of tests, translations or formatting alone is not a trap in the code.
const ONLY_TESTS = /^(?:bug[ -]?)?fix(?:es|ed|ing)?\s+(?:the\s+|a\s+|some\s+|failing\s+|failed\s+|flaky\s+|broken\s+)?(?:[\w-]+\s+){0,3}(?:(?:unit|e2e|integration)\s+)?(?:tests?|specs?|test failures?|translations?|typos?|lint(?:ing)? errors?|lint|formatting|css|styles?|type errors?)\s*$/iu;
// Failure words that name something else: tests and suites for regressions, line breaks, reporting tools.
const NOT_A_FAILURE = /\bregress\w*\s+(?:tests?|suites?|checks?|coverage)\b|\b(?:line|page|word|column)[ -]breaks?\b|\bbreaking changes?\b|\bcrash(?:[ -]reporting|[ -]reports?|lytics)\b|\bincident(?:[ -]response|s? page|s? management)\b/iu;
const FIX_ELSEWHERE = /\bbug[ -]?fix(?:es)?\b|(?<!\b(?:the|a|an|our|this|that|its|their)\s+)\b(?:fix|resolve|solve|squash|patch|address|repair)(?:es|s|d|ed)?\s+(?:\S+\s+){0,3}(?:bugs?|errors?|crash(?:es)?|issues?|problems?)\b|\b(?:try|tries|trying|attempt(?:s|ing)?) to fix\b/iu;
// Terse subjects put the fix last: "toggle fix", "sharePage hotfix", "switch fixed", "Small fix to realtime count".
const FIX_LAST = /\b(hot[ -]?)?fix(?:es)?(?:\s+(?:for|to|in|on|of)\s+.+)?$|(?<!\b(?:until|once|when|if|not|be|been|being|is|are|was|were|gets?|got)\s+)\bfixed$/iu;
// ...but not when what was fixed is styling, types, syntax, wording or translations.
const COSMETIC = /\b(?:css|styles?|styling|syntax|language|translations?|locales?|i18n|l10n|types?|typescript|typings|typos?|lint|format(?:ting)?|code style|docs?|wording|copy)\s+(?:and\s+\w+\s+)?(?:fix(?:es|ed)?)\b|^fix(?:es|ed)?\s+(?:the\s+)?(?:css|styles?|syntax|types?|typos?)\b/iu;

// "Fixing Broken Link For Custom Links": every word capitalised, so a capital says nothing about a name.
const titleCase = (c) => { const w = c.match(/\p{L}[\p{L}'-]*/gu) ?? []; return w.length > 2 && w.filter((x) => /^\p{Lu}/u.test(x)).length / w.length >= 0.6; };

export function clauses(subject) {
  return String(subject ?? '').split(CLAUSES).map((c) => c.trim()).filter(Boolean);
}

// Only the subject line counts (bodies mention fixes in passing), except git's own "This reverts commit" line.
export function scar(message) {
  const text = String(message ?? '');
  const first = text.split('\n')[0];
  if (/^revert\b/iu.test(first) || /^This reverts commit [0-9a-f]{7,}/mu.test(text)) return { weight: 3, kind: 'revert' };
  if (NOISE.test(first)) return null;
  // Issue and pull request numbers around the subject ("17306 fix ...", "[ABC-12] ...", "... (#13854)") are not words.
  const bare = first
    .replace(/^(?:\s*(?:#?\d+|[A-Z][A-Z0-9]+-\d+|\[[^\]]*\]|\([^)]*\))[:\s-]*)+/u, '')
    .replace(/(?:\s*\(#\d+(?:,\s*#\d+)*\)|\s+#\d+)+\s*$/u, '');
  const parts = clauses(bare);
  // In a list ("rename X, fix tooltips, update Y") a fix counts when it has an object, not "fix as one flow".
  const listed = parts.flatMap((c) => c.split(/,\s+/u).slice(1)).some((c) => /^(?:fix(?:es|ed)?)\s+(?!(?:as|or|and|to|in|on|for|of|with|is|are|the product)\b)\S/iu.test(c) && !ONLY_TESTS.test(c) && !COSMETIC.test(c));
  // A label before a colon that ends in "fixes" ("Small fixes: ...", "Self-scan fix: ...") says the commit fixes.
  const labelled = /^[^:]{0,40}\b(?:bug[ -]?|hot[ -]?)?fix(?:es)?:\s/iu.test(bare);
  let fix = labelled || listed || FIX_ELSEWHERE.test(bare) || /\bfix(?:es|ed)?\s+#\d+/iu.test(first);
  for (const c of parts) {
    if (ONLY_TESTS.test(c) || COSMETIC.test(c)) continue;
    for (const [weight, kind, re] of SIGNALS.slice(0, 3)) if (re.test(c)) return { weight, kind };
    const last = c.match(FIX_LAST);
    if (last?.[1]) return { weight: 2, kind: 'hotfix' };
    if (SIGNALS[5][2].test(c) || last) fix = true;
  }
  // A failure word: dropped when it names something else, or when it is written as a name in the middle of a clause
  // ("... history, Broke before items ticked").
  const failure = parts.map((c) => {
    if (NOT_A_FAILURE.test(c)) return null;
    for (const [, kind, re] of SIGNALS.slice(3, 5)) {
      const m = c.match(re);
      if (m && !(m.index > 0 && /^[A-Z]/u.test(m[0]) && !titleCase(c))) return kind;
    }
    return null;
  }).find(Boolean);
  if (failure) return { weight: fix ? 2 : 1, kind: failure };
  return fix ? { weight: 1, kind: 'fix' } : null;
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
  // A commit that touched more than MAX_FILES_PER_COMMIT files (a sweeping rollback, a rename) says little about this one.
  const scars = commits.filter((c) => !(c.touched > MAX_FILES_PER_COMMIT)).map((c) => ({ ...c, ...scar(c.subject) })).filter((c) => c.weight);
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
    // --full-diff --shortstat: how many files each commit touched in all, so a sweeping one can be left out.
    const text = git(root, ['log', '--no-merges', '--full-diff', '--shortstat', '--format=%x01%H%x00%ct%x00%s', '-n', String(LOG_LIMIT), rev, '--', `:(literal)${path}`]);
    if (text === null) continue;
    const commits = parseStatLog(text);
    const found = summarizeScars(path, commits);
    if (found) out[path] = found;
    else { notFetched ??= historyNotFetched(root, rev); if (notFetched) out[path] = { notFetched: true }; }
  }
  return out;
}

// git log --format=%x01%H%x00%ct%x00%s --shortstat: [{ sha, time, subject, touched }], newest first.
export function parseStatLog(text) {
  return String(text ?? '').split('\x01').filter((c) => c.trim()).map((c) => {
    const [head, ...rest] = c.split('\n');
    const [sha, time, subject] = head.split('\0');
    const n = Number(rest.join(' ').match(/(\d+) files? changed/u)?.[1]);
    return { sha, time: Number(time), subject: subject ?? '', touched: Number.isFinite(n) ? n : null };
  });
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
