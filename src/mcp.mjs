// readfirst as an MCP server over stdio, so any agent that speaks MCP (Cursor, Codex, Windsurf, Claude Code...) can ask
// what to read before it changes a file. JSON-RPC 2.0, one message per line, written by hand: no dependencies.
// Every tool call runs the same code as the command line, on the checkout as it is at that moment, and writes nothing.
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'read_list',
    description: 'What to read and check before changing these files: the project rules and risks that apply, the checks to run, the tests that reach the code and the files that use it, and where the file broke before (from git history). Call it before editing.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'paths relative to the repository root' } }, required: ['files'] },
    args: (a) => {
      if (!Array.isArray(a.files) || !a.files.length || a.files.some((f) => typeof f !== 'string' || !f)) throw new Error('files must be a non-empty list of paths');
      return ['read', '--', ...a.files];
    },
  },
  {
    name: 'changed_read_list',
    description: 'The same read list for every file changed on this branch since the base (default origin/main, else main). Call it before finishing, then run the checks it lists.',
    inputSchema: { type: 'object', properties: { base: { type: 'string', description: 'git ref to compare against' } } },
    args: (a) => {
      if (typeof a.base === 'string' && a.base.startsWith('-')) throw new Error('base must be a git ref, not an option');
      return ['diff', ...(typeof a.base === 'string' && a.base ? ['--base', a.base] : [])];
    },
  },
  {
    name: 'find_existing',
    description: 'Before writing a new function, helper or module: the functions, classes, files and map entries that may already do it, matched by words (not meaning) against names and paths. Give a few words about what it does, e.g. "payment retry" or "csv export". If one fits, use or extend it instead of writing another.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'a few words about what you are about to write' } }, required: ['query'] },
    args: (a) => {
      if (typeof a.query !== 'string' || !a.query.trim()) throw new Error('query must be a few words about what you are about to write');
      return ['find', '--', ...a.query.trim().split(/\s+/u)];
    },
  },
  {
    name: 'check_map',
    description: 'Whether .readfirst/map.json still covers the code: files in no group, patterns that match nothing, broken rules.',
    inputSchema: { type: 'object', properties: {} },
    args: () => ['check'],
  },
  {
    name: 'audit_repo',
    description: 'The whole repository against .readfirst/map.json, as a report: rules and risks whose files changed a lot since they were written, hot spots that moved, groups never filled in, code no test reaches through imports, what readfirst could not see, and the files that broke most in the last 12 months (this part needs no map). Use it before larger work, or to decide what to add to the map.',
    inputSchema: { type: 'object', properties: {} },
    args: () => ['audit'],
  },
];

// One request in, one response out (null for notifications). run(argv) runs the CLI and returns { code, out, err }.
export function mcpHandler({ run, version }) {
  return (msg) => {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
    if (msg.id === undefined) return null; // notifications (initialized, cancelled) need no answer
    if (msg.method === 'initialize') {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'readfirst', version },
        instructions: 'Before writing a new function or module, call find_existing and reuse what already exists. Before changing a file, call read_list with it and follow what it says. Before you finish, call changed_read_list and run the checks it lists (or run `npx readfirst verify`).',
      });
    }
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: TOOLS.map(({ args, ...t }) => t) });
    if (msg.method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${msg.params?.name}`);
      let r;
      try { r = run(tool.args(msg.params?.arguments ?? {})); } catch (e) { r = { code: 2, out: '', err: e.message }; }
      const text = [r.out.trimEnd(), r.err.trimEnd()].filter(Boolean).join('\n\n') || '(nothing)';
      return reply({ content: [{ type: 'text', text }], isError: r.code === 2 });
    }
    return fail(-32601, `unknown method ${msg.method}`);
  };
}

// Reads newline-delimited JSON-RPC from input and writes answers to output until input ends.
export function serveMcp({ handle, input, output }) {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`); continue; }
      const res = handle(msg);
      if (res) output.write(`${JSON.stringify(res)}\n`);
    }
  });
}
