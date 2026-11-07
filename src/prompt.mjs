// The brief for a coding agent (Claude Code, Cursor, Codex...) to turn the drafted map into a useful one. The map is
// filled by the agent the team already uses, so readfirst itself calls no model and needs no key.
import { MAP_FORMAT, MAP_PATH } from './map.mjs';

export function agentBrief(map) {
  return `You are filling in ${MAP_PATH} for this repository. readfirst uses it to tell people and coding agents what to
read and check before they change a file. A first draft is already there (groups by folder, format ${MAP_FORMAT}).

Do this:
1. For each group, read its files enough to write:
   - "title": one line on what this part of the code does.
   - "checks": the commands that prove this part still works, e.g. {"run": "npm test -- auth", "why": "login and sessions"}.
     Use commands that exist in this repo (package.json scripts, Makefile, pytest...). Leave the list empty if there is none.
   - "risks": things a newcomer would get wrong here, each {"text": "...", "files": ["optional/path/or/pattern/**"]}.
     Good risks are specific: hidden coupling, data that must stay compatible, money or auth paths, slow or paid calls,
     generated files that must not be edited by hand. Do not write generic advice ("be careful", "write tests").
2. Split or merge groups when the folder split is wrong. Every tracked file must stay in exactly one group or in "ignore".
   Patterns: a path, "folder/**", or a "*" glob within one segment.
3. Add "rules": promises the code must keep, each {"id": "kebab-id", "rule": "...", "why": "...", "files": [...],
   "checks": [{"run": "..."}]}. Take them from comments, docs, tests and commit messages. Only write rules you can point to
   in the code or docs. Ask the user for the ones only they know. When a rule is about a route or a call (who may refund,
   a charge runs once), also write it as structure: "flow": {"reaches": "payments-api" or "table:orders" or a function
   name, or "entry": "POST /api/orders/*", "must": ["check", "check:<name>", "once", "no-input"]}.
4. If a group is being replaced (old code new work must not extend), add "deprecated": {"why": "...", "use": "new-group-id or path"}.
   Read lists and \`readfirst find\` then send people and agents to the replacement.
5. Add "vocabulary": this repository's own words, so tools that read code with no model know them. Only what you saw
   in the code, each with "evidence": "file:line":
   - "checks": functions that decide who may do something, {"name": "requireTester", "evidence": "...", "why": "..."}.
   - "sinks": calls that write data, move money or call out, {"call": "*WithCtx", "label": "db-write", "evidence": "..."}.
   - "notChecks": names that look like checks but refuse no one (a database session dependency), {"name", "why"}.
   - "public": entries open to anyone on purpose, {"entry": "GET /api/explore/*", "why": "..."}.
   - "entries": how this repository declares routes when it is not a framework's usual way, {"decorator": "Post",
     "within": "RestController", "evidence": "..."} or {"call": "api.register", "evidence": "..."}. When every route
     declared that way needs a signed-in user unless it opts out, add "check": "signed in" and "unless": "skipAuth:\\\\s*true".
   - "checksIf": a check that counts only under a condition, {"name": "PermissionDenied", "when": "permissions\\\\s*=\\\\s*\\\\(\\\\s*[^)\\\\s]",
     "evidence": "...", "why": "..."} (\`when\` is a regular expression the route's own code must match).
   - "notSinks": calls that look like writes but are not, {"call": "cache.set", "why": "..."}.
   - "once": what keeps a job or webhook from running twice here, {"name": "claimJob", "evidence": "..."}.
   - "sources": functions whose return value is outside input, {"call": "getBody", "evidence": "..."}.
6. Run \`npx readfirst check\` until it says the map is good (\`npx readfirst fix\` places new files and drops dead
   patterns for you), then show the user the diff of ${MAP_PATH}.

Current groups: ${map.groups.map((g) => `${g.id} (${g.files.join(', ')})`).join('; ')}.
`;
}
