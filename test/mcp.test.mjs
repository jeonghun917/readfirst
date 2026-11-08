import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { mcpHandler, serveMcp } from '../src/mcp.mjs';

// Paid review of ca6947a: a request line that is JSON null killed the server (fail() read msg.id).
test('mcp: null and other falsy JSON lines get an invalid-request error, and later lines are still answered', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let got = '';
  output.on('data', (c) => { got += c; });
  serveMcp({ handle: mcpHandler({ run: () => ({ code: 0, out: '', err: '' }), version: '0' }), input, output });
  input.write('null\nfalse\n0\n""\n{"jsonrpc":"2.0","id":5,"method":"ping"}\n');
  await new Promise((r) => setImmediate(r));
  const lines = got.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.slice(0, 4), Array(4).fill({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }));
  assert.deepEqual(lines[4], { jsonrpc: '2.0', id: 5, result: {} });
});
