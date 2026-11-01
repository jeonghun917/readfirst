// The GitHub Action: on a pull request, one comment with the read list for the files the PR changes (kept up to date
// on each push), and a failed check when the map no longer covers the code. Off a pull request it only checks the map.
// The changed files come from the GitHub API, so any checkout depth works.
import { appendFileSync, readFileSync } from 'node:fs';
import { readMapFile, readText, repoFiles } from './cli.mjs';
import { importEdges } from './imports.mjs';
import { fixMap, MAP_PATH, mapProblems } from './map.mjs';
import { readList, toMarkdown } from './readlist.mjs';

export const MARKER = '<!-- readfirst:pr-comment -->';
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

export function commentBody({ list, problems, removed, commit, fixes = [] }) {
  const parts = [MARKER, '## readfirst', ''];
  if (problems.length) {
    parts.push(`> [!WARNING]\n> \`${MAP_PATH}\` no longer matches the code (${problems.length} problem${problems.length > 1 ? 's' : ''}). Run \`npx readfirst check\` and fix the map in this PR.`, '');
    parts.push(...problems.slice(0, 20).map((p) => `- ${p}`), ...(problems.length > 20 ? [`- …and ${problems.length - 20} more`] : []), '');
    if (fixes.length) parts.push('`npx readfirst fix` would make these changes:', ...fixes.slice(0, 10).map((f) => `- ${f}`), ...(fixes.length > 10 ? [`- …and ${fixes.length - 10} more`] : []), '');
  }
  if (list) parts.push(toMarkdown(list, { checklist: true, heading: null }));
  else if (!problems.length) parts.push('No changed files to look up.', '');
  if (removed.length) parts.push(`Removed in this PR: ${removed.map((f) => `\`${f}\``).join(', ')}`, '');
  parts.push(`<sub>From \`${MAP_PATH}\`${commit ? ` at ${commit.slice(0, 7)}` : ''}. Tick each check once it has run.</sub>`);
  let body = parts.join('\n');
  if (body.length > MAX_COMMENT) body = `${body.slice(0, MAX_COMMENT)}\n\n…cut here: run \`npx readfirst diff\` for the whole list.`;
  return body;
}

export async function runAction({ env = process.env, fetchImpl = fetch, root = env.GITHUB_WORKSPACE ?? process.cwd(), log = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const files = repoFiles(root);
  const map = readMapFile(root);
  const problems = mapProblems(map, files);
  const failOnProblems = (env['INPUT_FAIL-ON-MAP-PROBLEMS'] ?? env.INPUT_FAIL_ON_MAP_PROBLEMS ?? 'true') !== 'false';
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request;
  const summary = (s) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${s}\n`); };

  if (!pr) {
    log(problems.length ? `${MAP_PATH} has ${problems.length} problem(s):\n- ${problems.join('\n- ')}` : `${MAP_PATH} is good: ${files.length} files.`);
    return { ok: !(problems.length && failOnProblems), problems };
  }
  const repo = env.GITHUB_REPOSITORY;
  const changed = await pages(fetchImpl, env, `/repos/${repo}/pulls/${pr.number}/files`);
  const removed = changed.filter((f) => f.status === 'removed').map((f) => f.filename);
  const targets = changed.filter((f) => f.status !== 'removed').map((f) => f.filename);
  // A broken map still gets a comment (the problems), but no read list from it.
  const list = targets.length && !problems.length
    ? readList({ map, files, imports: importEdges(files, readText(root)), targets, commit: pr.head?.sha ?? null, limit: Number(env.INPUT_LIMIT || 30) })
    : null;
  const fixes = problems.length ? (() => { try { return fixMap(map, files).changes; } catch { return []; } })() : [];
  const body = commentBody({ list, problems, removed, commit: pr.head?.sha ?? null, fixes });
  summary(body);

  if ((env.INPUT_COMMENT ?? 'true') !== 'false') {
    const comments = await pages(fetchImpl, env, `/repos/${repo}/issues/${pr.number}/comments`);
    const mine = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
    try {
      if (mine) await api(fetchImpl, env, 'PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body });
      else await api(fetchImpl, env, 'POST', `/repos/${repo}/issues/${pr.number}/comments`, { body });
      log(`${mine ? 'updated' : 'posted'} the readfirst comment on #${pr.number}`);
    } catch (e) {
      // A PR from a fork gets a read-only token: the read list stays in the job summary.
      if (!/: 403 /u.test(e.message)) throw e;
      log(`::warning::readfirst could not comment (read-only token, e.g. a PR from a fork); the read list is in the job summary.`);
    }
  }
  if (problems.length) log(`${MAP_PATH} has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  return { ok: !(problems.length && failOnProblems), problems, list, body };
}

if (process.argv[1]?.endsWith('/src/action.mjs')) {
  runAction().then((r) => { process.exitCode = r.ok ? 0 : 1; }, (e) => { process.stderr.write(`::error::readfirst: ${e.message}\n`); process.exitCode = 1; });
}
