// find and the constants that hold a list or table of names. Until this test, find listed functions, classes and types
// only: a constant set to a list (`const HTTP_CLIENTS = ['axios', 'got']`) was a plain value and left out, so
// `readfirst find` found none of three lists of the same HTTP libraries, nor two lists of rate-limited services or two
// lists of secret words, where grep found them all; each was written again beside the ones already there.
// A constant whose value holds brackets and at least two strings or object keys is now found by its name and by the
// names written in it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitions, find, findText } from '../src/find.mjs';

const FILES = {
  'src/net/clients.js': "// the HTTP libraries a request can go through\nexport const HTTP_CLIENTS = [\n  'axios', // most of the code\n  'got',\n  'node-fetch',\n];\nexport function request() {}\n",
  'src/scan/outbound.ts': "const NETWORK_MODULES = new Set(['axios', 'undici', 'node-fetch']);\nexport function outbound(): string[] { return [...NETWORK_MODULES]; }\n",
  'tools/libs.py': 'HTTP_LIBS: list[str] = [\n    "requests",  # sync\n    "httpx",\n    "aiohttp",\n]\n',
  'src/limits.js': "export const RATE_LIMITS = { github: 5000, 'api.stripe.com': 100, slack: 1 };\n",
  'src/throttle.py': 'THROTTLED = {"github": 60, "slack": 1}\n',
  'src/redact.js': "const SECRET_WORDS = ['password', 'token', 'apiKey'];\nmodule.exports.SENSITIVE = ['password', 'private_key'];\n",
  'src/scrub.js': "const WORD = /\\b(?:password|secret|api_?key)\\b/iu;\nconst SEP = /\\s*\\|\\s*/u;\n",
  'src/scrub.py': 'import re\nSECRET_RE = re.compile(r"password|private_key")\n',
  'src/plain.js': "const N = 3;\nconst ONE = ['only'];\nfunction inner() { const local = ['axios', 'got']; return local; }\nrun({ list: ['axios', 'got'] });\nconst MESSAGES = ['axios failed to connect', 'got no answer'];\n",
};
const files = Object.keys(FILES);
const read = (f) => FILES[f] ?? null;
const hits = (query) => find({ query, files, read }).code.map((h) => `${h.kind} ${h.name ?? ''} ${h.file}`.replace('  ', ' '));

test('a constant list is found by the names it holds', () => {
  assert.deepEqual(hits('axios').filter((h) => h.startsWith('list')), ['list HTTP_CLIENTS src/net/clients.js', 'list NETWORK_MODULES src/scan/outbound.ts']);
  assert.ok(hits('httpx').includes('list HTTP_LIBS tools/libs.py'), 'a Python list, with comments between its strings');
  const r = find({ query: 'node-fetch', files, read });
  const h = r.code.find((x) => x.name === 'HTTP_CLIENTS');
  assert.deepEqual([h.kind, h.line, h.inValues], ['list', 2, ['node', 'fetch']]);
  assert.match(findText(r), /`HTTP_CLIENTS` \(list\) in `src\/net\/clients\.js:2` — matches node, fetch \(node, fetch among the names it holds\)/u);
});

test('a constant list is found by its name and its comment, and so are tables and what a module exports', () => {
  assert.ok(hits('http client').includes('list HTTP_CLIENTS src/net/clients.js'));
  assert.ok(hits('http libraries').includes('list HTTP_LIBS tools/libs.py'));
  assert.deepEqual(hits('github slack').filter((h) => h.startsWith('list')).sort(), ['list RATE_LIMITS src/limits.js', 'list THROTTLED src/throttle.py'], 'object keys and dict keys');
  assert.deepEqual(hits('password').filter((h) => h.startsWith('list')).sort(), ['list SECRET_RE src/scrub.py', 'list SECRET_WORDS src/redact.js', 'list SENSITIVE src/redact.js', 'list WORD src/scrub.js']);
});

test('a pattern of alternatives is a list of the names it holds; an escaped | is not an alternative', () => {
  assert.ok(hits('secret').includes('list WORD src/scrub.js'));
  assert.equal(find({ query: 'sep', files: ['src/scrub.js'], read }).searched.lists, 1, 'WORD only, not SEP');
});

test('a single value, a list of one, a list inside a function, a call argument and a list of sentences are not lists to find', () => {
  const r = find({ query: 'only local axios got', files: ['src/plain.js'], read });
  assert.deepEqual(r.code.filter((h) => h.kind === 'list'), []);
  assert.equal(r.searched.lists, 0);
});

test('definitions, which the find gate and the trigger engine read, still leave lists out', () => {
  assert.deepEqual(definitions('src/net/clients.js', FILES['src/net/clients.js']).map((d) => d.name), ['request']);
});
