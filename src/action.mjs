// The GitHub Action: on a pull request, one comment with the read list for the files the PR changes (kept up to date
// on each push), and a failed check when the map no longer covers the code. Off a pull request it only checks the map.
// The changed files come from the GitHub API, so any checkout depth works; only the "broke before" section reads the
// checkout's git log, and says so when the checkout is too shallow to have it.
import { appendFileSync, readFileSync } from 'node:fs';
import { edgesWith, readMapFile, readText, repoFiles } from './cli.mjs';
import { HELD_PATH, parseHeld } from './held.mjs';
import { baseRevision, brokeBefore } from './history.mjs';
import { MAP_PATH, settleMap, unBom } from './map.mjs';
import { brokeSection, readList, toMarkdown } from './readlist.mjs';

export const MARKER = '<!-- readfirst:pr-comment -->';
// A read list longer than one comment goes on in more comments, each found again by its own marker and edited in place
// (GitHub takes 65,536 characters a comment). Before 0.27.1 it was cut at 60,000 characters, sometimes inside <details>.
export const partMarker = (n) => `<!-- readfirst:pr-comment:${n} -->`;
const MAX_COMMENT = 60000;

async function api(fetchImpl, env, method, path, body) {
  const res = await fetchImpl(`${env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.INPUT_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

async function pages(fetchImpl, env, path) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await api(fetchImpl, env, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export const FETCH_DEPTH_HINT = ' (set fetch-depth: 200 on actions/checkout)';

export function commentBody({ list, problems, removed, commit, fixes = [], settled = [], committed = null, broke = [] }) {
  const parts = [MARKER, '## readfirst', ''];
  if (problems.length) {
    parts.push(`> [!WARNING]\n> \`${MAP_PATH}\` no longer matches the code (${problems.length} problem${problems.length > 1 ? 's' : ''}). Run \`npx readfirst check\` and fix the map in this PR.`, '');
    parts.push(...problems.map((p) => `- ${p}`), '');
    if (fixes.length) parts.push('`npx readfirst fix` would make these changes:', ...fixes.map((f) => `- ${f}`), '');
  } else if (committed) {
    parts.push(`<details><summary>readfirst placed ${settled.length} new file(s) in the map and committed it to this branch (${committed.slice(0, 7)})</summary>`, '', ...settled.map((f) => `- ${f}`), '', 'Pull before your next push.', '</details>', '');
  } else if (settled.length) {
    parts.push(`<details><summary>New files placed by their neighbours (${settled.length})</summary>`, '', ...settled.map((f) => `- ${f}`), '', '`npx readfirst fix` writes this into the map; nothing to do for this PR.', '</details>', '');
  }
  if (list) parts.push(toMarkdown(list, { checklist: true, heading: null, broke: false, fold: true }));
  else if (!problems.length && !broke.length) parts.push('No changed files to look up.', '');
  parts.push(...brokeSection(broke, { title: 'Files in this PR that broke before', hint: FETCH_DEPTH_HINT }));
  if (removed.length) parts.push(`Removed in this PR: ${removed.map((f) => `\`${f}\``).join(', ')}`, '');
  parts.push(`<sub>From \`${MAP_PATH}\`${commit ? ` at ${commit.slice(0, 7)}` : ''}. Tick each check once it has run.</sub>`);
  return parts.join('\n');
}

// The comment body in pieces of at most `max` characters, cut only between top-level blocks; a <details> block too long
// for one piece is closed and opened again in the next with "(continued)", and a single line longer than a piece (none
// is in practice) is split where it must be. Nothing is left out: the pieces joined hold every line of the body.
export function splitComment(body, max = MAX_COMMENT) {
  if (body.length <= max) return [body];
  const room = max - 400; // the part heading and the "continued" lines
  const pieces = [];
  let cur = [];
  let size = 0;
  let open = null; // the <details> line of a block still open in `cur`
  const flush = () => {
    if (open) cur.push('', '</details>');
    pieces.push(cur.join('\n'));
    cur = open ? [open.replace(/<\/summary>$/u, ' (continued)</summary>'), ''] : [];
    size = cur.reduce((n, l) => n + l.length + 1, 0);
  };
  for (const line of body.split('\n')) {
    const lines = line.length > room ? line.match(new RegExp(`[\\s\\S]{1,${room}}`, 'gu')) : [line];
    for (const l of lines) {
      if (size + l.length + 1 > room && cur.length) flush();
      cur.push(l);
      size += l.length + 1;
      if (/^<details>/u.test(l)) open = l;
      if (l === '</details>') open = null;
    }
  }
  if (cur.length) pieces.push(cur.join('\n'));
  return pieces.map((p, i) => (i === 0
    ? `${p}\n\n<sub>Continued in the next comment (part 2 of ${pieces.length}).</sub>`
    : `${partMarker(i + 1)}\n## readfirst, part ${i + 1} of ${pieces.length}\n\n${p}${i + 1 < pieces.length ? `\n\n<sub>Continued in the next comment (part ${i + 2} of ${pieces.length}).</sub>` : ''}`));
}

export async function runAction({ env = process.env, fetchImpl = fetch, root = env.GITHUB_WORKSPACE ?? process.cwd(), log = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const files = repoFiles(root);
  // New files beside placed ones and patterns for deleted files are settled as `fix` would; only the rest fails.
  const strict = (env.INPUT_STRICT ?? 'false') === 'true';
  const raw = readMapFile(root);
  const s = settleMap(raw, files);
  // Strict: what fix would settle still counts as a problem, and the map is used as written.
  const strictOff = !strict || !s.settled.length;
  const map = strictOff ? s.map : raw;
  const problems = strictOff ? s.problems : [...s.problems, ...s.settled.map((c) => `not yet written in the map: ${c}`)];
  // With problems left, what fix would change is the help; without, it is a note.
  const settled = problems.length ? [] : s.settled;
  const fixes = problems.length ? s.settled : [];
  const failOnProblems = (env['INPUT_FAIL-ON-MAP-PROBLEMS'] ?? env.INPUT_FAIL_ON_MAP_PROBLEMS ?? 'true') !== 'false';
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request;
  const summary = (s) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${s}\n`); };

  if (!pr) {
    log(problems.length ? `${MAP_PATH} has ${problems.length} problem(s):\n- ${problems.join('\n- ')}` : `${MAP_PATH} is good: ${files.length} files.`);
    return { ok: !(problems.length && failOnProblems), problems };
  }
  const repo = env.GITHUB_REPOSITORY;
  // `limit`: how many tests and users per section; empty (the default) lists all. A value that is not a whole number
  // above 0 lists all too, with a warning, rather than none.
  let limit = Infinity;
  if ((env.INPUT_LIMIT ?? '') !== '') {
    limit = Number(env.INPUT_LIMIT);
    if (!Number.isInteger(limit) || limit < 1) { log(`::warning::readfirst: limit "${env.INPUT_LIMIT}" is not a whole number above 0; listing every test and user.`); limit = Infinity; }
  }
  const changed = await pages(fetchImpl, env, `/repos/${repo}/pulls/${pr.number}/files`);
  const committed = (env['INPUT_AUTO-FIX'] ?? env.INPUT_AUTO_FIX ?? 'false') === 'true' && settled.length
    ? await commitFix({ fetchImpl, env, repo, pr, raw, fixed: map, settled, log })
    : null;
  const removed = changed.filter((f) => f.status === 'removed').map((f) => f.filename);
  const targets = changed.filter((f) => f.status !== 'removed').map((f) => f.filename);
  // A broken map still gets a comment (the problems), but no read list from it.
  // Removed files are looked up too: their group's checks, rules and requires entries still apply to the change.
  // A renamed file's old path is looked up as well: its old group's checks, and files that still import the old path.
  const paths = [...new Set(changed.flatMap((f) => (f.status === 'renamed' && f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])))];
  const list = changed.length && !problems.length
    ? readList({ map, files, imports: edgesWith(files, paths, readText(root)), targets: paths, before: raw, commit: pr.head?.sha ?? null, limit, read: readText(root), held: parseHeld(readText(root)(HELD_PATH)) })
    : null;
  // From the checkout's git log at the PR's base (not the PR's own commits), whatever the map says. A checkout fetched at depth 1 has none: that is said, not hidden.
  const found = brokeBefore(root, targets, new Set(files), baseRevision(root, pr.base?.sha));
  const broke = targets.filter((t) => found[t]).map((t) => ({ path: t, brokeBefore: found[t] }));
  const body = commentBody({ list, problems, removed, commit: pr.head?.sha ?? null, fixes, settled, committed, broke });
  summary(body);

  if ((env.INPUT_COMMENT ?? 'true') !== 'false') {
    const comments = await pages(fetchImpl, env, `/repos/${repo}/issues/${pr.number}/comments`);
    // Anyone can post a comment that starts with the marker. A bot's comment (the Action's token writes as one) comes
    // first; a comment we may not edit is left alone and a new one posted, or another person's comment took ours away
    // for good (2026-11-09).
    // Each marked comment is tried in turn, bots' first, then newest first, and a new one is posted only when none can be
    // edited: with a personal token our comment is a user's too, and posting at every push would break one-pr-comment.
    // A long read list is several comments (splitComment), each found by its own marker; parts a longer list left from
    // an earlier push are emptied with a line saying so, never deleted.
    const pieces = splitComment(body);
    const markerOf = (n) => (n === 1 ? MARKER : partMarker(n));
    const markedWith = (m) => comments.filter((c) => typeof c.body === 'string' && c.body.startsWith(m));
    const stale = [];
    for (let n = pieces.length + 1; markedWith(markerOf(n)).length; n++) stale.push(n);
    const write = async (n, text) => {
      const marked = markedWith(markerOf(n));
      const order = [...marked.filter((c) => c.user?.type === 'Bot'), ...marked.filter((c) => c.user?.type !== 'Bot').reverse()];
      for (const c of order) {
        try { await api(fetchImpl, env, 'PATCH', `/repos/${repo}/issues/comments/${c.id}`, { body: text }); return true; } catch (e) { if (!/: 40[34] /u.test(e.message)) throw e; }
      }
      return false;
    };
    try {
      let posted = 0;
      for (const [i, text] of pieces.entries()) {
        if (!(await write(i + 1, text)) && text) { await api(fetchImpl, env, 'POST', `/repos/${repo}/issues/${pr.number}/comments`, { body: text }); posted++; }
      }
      for (const n of stale) await write(n, `${partMarker(n)}\n## readfirst, part ${n}\n\nNothing here since ${pr.head?.sha?.slice(0, 7) ?? 'the latest push'}: the read list fits in the first comment${pieces.length > 1 ? `s (${pieces.length})` : ''} now.`);
      const updated = posted === 0;
      log(`${updated ? 'updated' : 'posted'} the readfirst comment${pieces.length > 1 ? `s (${pieces.length})` : ''} on #${pr.number}`);
    } catch (e) {
      // A PR from a fork gets a read-only token: the read list stays in the job summary.
      if (!/: 403 /u.test(e.message)) throw e;
      log(`::warning::readfirst could not comment (read-only token, e.g. a PR from a fork); the read list is in the job summary.`);
    }
  }
  if (problems.length) log(`${MAP_PATH} has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  return { ok: !(problems.length && failOnProblems), problems, list, body, committed };
}

// auto-fix: write what `readfirst fix` settles (new files placed by their neighbours, patterns for deleted files) into
// the map on the PR's branch, as one commit through the contents API. Only the mechanical part, never anything a person
// has to decide; only on a branch of this repository; only when the branch's map is the one this run read, so a push in
// between is never overwritten. Returns the new commit's sha, or null with a warning.
async function commitFix({ fetchImpl, env, repo, pr, raw, fixed, settled, log }) {
  if (pr.head?.repo?.full_name !== repo || !pr.head?.ref) {
    log('::warning::readfirst auto-fix: this PR comes from a fork, so the map update stays a suggestion in the comment.');
    return null;
  }
  const path = MAP_PATH.split('/').map(encodeURIComponent).join('/');
  try {
    const now = await api(fetchImpl, env, 'GET', `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(pr.head.ref)}`);
    let onBranch = null;
    try { onBranch = JSON.parse(unBom(Buffer.from(now.content ?? '', 'base64').toString('utf8'))); } catch { onBranch = null; }
    if (JSON.stringify(onBranch) !== JSON.stringify(raw)) {
      log('::warning::readfirst auto-fix: the map on the branch differs from the one this run read (a newer push, or the base changed it); nothing committed.');
      return null;
    }
    const res = await api(fetchImpl, env, 'PUT', `/repos/${repo}/contents/${path}`, {
      message: `readfirst fix: place ${settled.length} new file(s) in the map`,
      content: Buffer.from(`${JSON.stringify(fixed, null, 2)}\n`, 'utf8').toString('base64'),
      sha: now.sha,
      branch: pr.head.ref,
    });
    log(`readfirst auto-fix: committed the map update to ${pr.head.ref}`);
    return res?.commit?.sha ?? 'committed';
  } catch (e) {
    log(`::warning::readfirst auto-fix could not commit (${/: 403 /u.test(e.message) ? 'the token needs contents: write' : e.message.slice(0, 200)}); the comment says what \`npx readfirst fix\` would change.`);
    return null;
  }
}

if (process.argv[1]?.endsWith('/src/action.mjs')) {
  runAction().then((r) => { process.exitCode = r.ok ? 0 : 1; }, (e) => { process.stderr.write(`::error::readfirst: ${e.message}\n`); process.exitCode = 1; });
}
