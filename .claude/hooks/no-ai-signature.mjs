#!/usr/bin/env node
// No AI signatures on anything this repository publishes (owner's order, 2026-11-06): no Co-Authored-By naming Claude
// or Anthropic, no Claude-Session line, no "Generated with/by Claude Code" footer, no claude.ai session link.
//
//   node .claude/hooks/no-ai-signature.mjs hook        Claude Code PreToolUse: blocks a git commit or tag, a gh call or a
//                                                      GitHub tool (PR, comment, file push) whose text carries one
//   node .claude/hooks/no-ai-signature.mjs msg <file>  git commit-msg hook (core.hooksPath .githooks)
//   node .claude/hooks/no-ai-signature.mjs ci          CI: the pull request's title, body and commits, or the pushed commits
//   node .claude/hooks/no-ai-signature.mjs setup       SessionStart: points git at .githooks so the commit-msg hook runs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const SIGNATURE = /^\s*co-authored-by:[^\n]*(?:claude|anthropic)|^\s*claude-session:|generated (?:with|by) \[?claude(?: code)?\]?|claude\.ai\/code\/session|noreply@anthropic\.com/imu;
const say = (where) => `Blocked: ${where} carries an AI signature (Co-Authored-By: Claude, Claude-Session, "Generated with Claude Code" or a claude.ai session link). The owner forbids them in commits, PRs and comments (CLAUDE.md). Remove it and try again.`;

const mode = process.argv[2];
const stdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };

if (mode === 'hook') {
  let event = {};
  try { event = JSON.parse(stdin() || '{}'); } catch { process.exit(0); }
  const tool = String(event.tool_name ?? '');
  const input = event.tool_input ?? {};
  // Bash: only commands that publish or record (a grep that names the pattern is not a signature).
  const publishes = tool === 'Bash' ? /\bgit\s+(?:commit|tag|notes|merge|rebase|cherry-pick)\b|\bgh\s+(?:pr|issue|release|api)\b/u.test(String(input.command ?? '')) : /^mcp__github__/u.test(tool);
  if (publishes && SIGNATURE.test(JSON.stringify(input))) { console.error(say(tool === 'Bash' ? 'this command' : `this ${tool} call`)); process.exit(2); }
  process.exit(0);
}

if (mode === 'msg') {
  const text = readFileSync(process.argv[3], 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  if (SIGNATURE.test(text)) { console.error(say('the commit message')); process.exit(1); }
  process.exit(0);
}

if (mode === 'setup') {
  try { execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' }); } catch { /* not a git checkout */ }
  process.exit(0);
}

// The GitHub tools add their footer when they create a pull request, and the author removes it right after; the run
// for "opened" saw the footer from the event and failed on every pull request, a red check everyone learned to ignore
// (2026-11-07). So for "opened" it waits a little and reads the title and description as they are now; the rule is the
// same, and a footer still there still fails.
const SETTLE_MS = 30_000;
async function currentPullRequest(event, pr) {
  const token = process.env.GITHUB_TOKEN;
  const repo = event.repository?.full_name;
  if (!token || !repo) return pr;
  if (event.action === 'opened') await new Promise((r) => setTimeout(r, SETTLE_MS));
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr.number}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    return res.ok ? await res.json() : pr;
  } catch { return pr; }
}

if (mode === 'ci') {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const found = [];
  const pr = event.pull_request;
  if (pr) {
    const now = await currentPullRequest(event, pr);
    if (SIGNATURE.test(`${now.title ?? ''}\n${now.body ?? ''}`)) found.push('the pull request title or description');
    try {
      const log = execFileSync('git', ['log', '--format=%H%x00%B%x01', `${pr.base.sha}..${pr.head.sha}`], { encoding: 'utf8' });
      for (const entry of log.split('\x01')) { const [sha, body] = entry.trim().split('\x00'); if (sha && SIGNATURE.test(body ?? '')) found.push(`commit ${sha.slice(0, 7)}`); }
    } catch (e) { console.error(`commits not read: ${e.message}`); }
  }
  for (const c of event.commits ?? []) if (SIGNATURE.test(c.message ?? '')) found.push(`commit ${String(c.id).slice(0, 7)}`);
  if (found.length) { console.error(`${say(found.join(', '))}`); process.exit(1); }
  console.log('no AI signatures');
  process.exit(0);
}

console.error('usage: no-ai-signature.mjs hook | msg <file> | ci | setup');
process.exit(2);
