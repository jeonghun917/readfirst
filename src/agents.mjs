// Wires readfirst into the coding agents a project already uses, from the files those agents keep in the repository.
// Only files inside the checkout are written, and only to add readfirst next to what is there: a JSON file that does
// not parse, or a tool whose settings live in the user's home folder (Windsurf), is left alone and the lines to add
// are printed instead. Nothing here runs a command or touches the network.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MCP_ARGS = ['--yes', 'readfirst', 'mcp'];
export const AGENTS = ['claude', 'cursor', 'vscode', 'gemini', 'codex', 'opencode', 'windsurf'];

// Which agents the project shows signs of. AGENTS.md alone is read by many tools, so it names none of them.
export function detectAgents(root) {
  const has = (...p) => p.some((f) => existsSync(join(root, f)));
  return AGENTS.filter((a) => ({
    claude: has('.claude', 'CLAUDE.md', '.mcp.json'),
    cursor: has('.cursor', '.cursorrules'),
    vscode: has('.vscode', '.github/copilot-instructions.md'),
    gemini: has('.gemini', 'GEMINI.md'),
    codex: has('.codex'),
    opencode: has('opencode.json', 'opencode.jsonc', '.opencode'),
    windsurf: has('.windsurf', '.windsurfrules'),
  })[a]);
}

// Adds `value` at `path` in a JSON file unless something is there already. Returns 'wrote', 'present', or a reason it
// was left alone (the file is not plain JSON).
function mergeJson(root, file, path, value) {
  const at = join(root, file);
  let doc = {};
  if (existsSync(at)) {
    try { doc = JSON.parse(readFileSync(at, 'utf8')); } catch { return 'not plain JSON'; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not a JSON object';
  }
  let node = doc;
  for (const k of path.slice(0, -1)) {
    if (node[k] !== undefined && (typeof node[k] !== 'object' || node[k] === null || Array.isArray(node[k]))) return `${k} is not an object`;
    node = (node[k] ??= {});
  }
  const last = path.at(-1);
  if (node[last] !== undefined) return 'present';
  node[last] = value;
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, `${JSON.stringify(doc, null, 2)}\n`);
  return 'wrote';
}

const CODEX_BLOCK = `[mcp_servers.readfirst]\ncommand = "npx"\nargs = ["--yes", "readfirst", "mcp"]\n`;
function codexConfig(root) {
  const at = join(root, '.codex', 'config.toml');
  const now = existsSync(at) ? readFileSync(at, 'utf8') : '';
  if (/^\s*\[mcp_servers\.readfirst\]/mu.test(now)) return 'present';
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, `${now}${now && !now.endsWith('\n') ? '\n' : ''}${now ? '\n' : ''}${CODEX_BLOCK}`);
  return 'wrote';
}

// What each agent gets. `notes` are the instruction files the read-first line goes into for that agent (created when
// missing); `mcp` writes its MCP server entry, or `manual` says what to add by hand.
const PLAN = {
  claude: { notes: ['CLAUDE.md'] }, // the PreToolUse hook (installHook) is wired by the caller
  cursor: { mcp: (root) => ['.cursor/mcp.json', mergeJson(root, '.cursor/mcp.json', ['mcpServers', 'readfirst'], { command: 'npx', args: MCP_ARGS })] },
  vscode: { mcp: (root) => ['.vscode/mcp.json', mergeJson(root, '.vscode/mcp.json', ['servers', 'readfirst'], { type: 'stdio', command: 'npx', args: MCP_ARGS })] },
  gemini: { notes: ['GEMINI.md'], mcp: (root) => ['.gemini/settings.json', mergeJson(root, '.gemini/settings.json', ['mcpServers', 'readfirst'], { command: 'npx', args: MCP_ARGS })] },
  codex: { mcp: (root) => ['.codex/config.toml', codexConfig(root)] },
  opencode: { mcp: (root) => (existsSync(join(root, 'opencode.jsonc')) && !existsSync(join(root, 'opencode.json'))
    ? ['opencode.jsonc', 'has comments']
    : ['opencode.json', mergeJson(root, 'opencode.json', ['mcp', 'readfirst'], { type: 'local', command: ['npx', ...MCP_ARGS], enabled: true })]) },
  windsurf: { manual: 'Windsurf keeps MCP servers in ~/.codeium/windsurf/mcp_config.json: add {"mcpServers": {"readfirst": {"command": "npx", "args": ["--yes", "readfirst", "mcp"]}}}' },
};

export const SNIPPETS = {
  '.cursor/mcp.json': '{"mcpServers": {"readfirst": {"command": "npx", "args": ["--yes", "readfirst", "mcp"]}}}',
  '.vscode/mcp.json': '{"servers": {"readfirst": {"type": "stdio", "command": "npx", "args": ["--yes", "readfirst", "mcp"]}}}',
  '.gemini/settings.json': '{"mcpServers": {"readfirst": {"command": "npx", "args": ["--yes", "readfirst", "mcp"]}}}',
  'opencode.json': '{"mcp": {"readfirst": {"type": "local", "command": ["npx", "--yes", "readfirst", "mcp"], "enabled": true}}}',
  'opencode.jsonc': '{"mcp": {"readfirst": {"type": "local", "command": ["npx", "--yes", "readfirst", "mcp"], "enabled": true}}}',
};

// Wires the given agents. addLine(file) adds the read-first line to one notes file and says whether it wrote.
// Returns { wrote: [files], manual: [lines for the user] }.
export function setupAgents(root, agents, { addLine }) {
  const wrote = [];
  const manual = [];
  for (const a of agents) {
    const p = PLAN[a];
    for (const f of p.notes ?? []) if (addLine(f)) wrote.push(f);
    if (p.mcp) {
      const [file, result] = p.mcp(root);
      if (result === 'wrote') wrote.push(file);
      else if (result !== 'present') manual.push(`${file} was left alone (${result}); add ${SNIPPETS[file] ?? 'the readfirst MCP server'} to it by hand`);
    }
    if (p.manual) manual.push(p.manual);
  }
  return { wrote, manual };
}
