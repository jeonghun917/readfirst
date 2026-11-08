import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { scanText } from '../src/scan.mjs';

const ids = (path, text) => scanText(path, text).map((f) => `${f.pattern}:${f.line}`);

test('scan: an expect(...).resolves nothing waits for, and not one that is awaited or returned', () => {
  const t = [
    "test('a', async () => {",
    '  expect(save(user)).resolves.toBe(true);',
    '  await expect(save(user)).resolves.toBe(true);',
    '  return expect(save(user)).rejects.toThrow();',
    '  expect(',
    '    save(user),',
    '  ).resolves.toBe(true);',
    '});',
  ].join('\n');
  assert.deepEqual(ids('src/user.test.ts', t), ['js-expect-promise:2', 'js-expect-promise:5']);
});

test('scan: a QuerySet or string result thrown away, and the look-alikes it leaves alone', () => {
  const py = ['def f(qs, name):', '    qs = Book.objects.all()', '    qs.filter(active=True)', '    name.strip()', "    os.replace('a', 'b')", '    return qs'].join('\n');
  assert.deepEqual(ids('app/views.py', py), ['queryset:3', 'str-method:4']);
  const js = ["function f(s) {", "  s.replace('a', 'b');", "  router.replace('/login');", '  s.trim();', '  return s;', '}'].join('\n');
  assert.deepEqual(ids('src/a.ts', js), ['js-replace:2', 'js-string:4']);
  assert.deepEqual(ids('node_modules/x/a.js', js), [], 'vendored code is never read');
});

test('scan: runs without a map and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'rf-scan-'));
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  const put = (p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); };
  put('src/a.test.js', "test('x', async () => {\n  expect(p).resolves.toBe(1);\n});\n");
  git('add', '.'); git('commit', '-q', '-m', 'x');
  let out = '';
  assert.equal(main(['scan', '--root', root], { out: (s) => { out += s; }, err: () => {} }), 0);
  assert.match(out, /1 line to look at/u);
  assert.match(out, /src\/a\.test\.js:2/u);
  out = '';
  main(['scan', '--json', '--root', root], { out: (s) => { out += s; }, err: () => {} });
  const r = JSON.parse(out);
  assert.equal(r.format, 'readfirst/scan@1');
  assert.equal(r.findings[0].pattern, 'js-expect-promise');
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'nothing written');
});

// 2026-11-08: vitest (1.6, 2.1, 3.2) and bun test fail an un-awaited resolves/rejects as they should; jest marks it passed.
test('scan: no expect(...).rejects finding in files that run on vitest or bun test', () => {
  const body = "test('x', () => {\n  expect(save(user)).rejects.toThrow();\n});\n";
  assert.equal(scanText('src/a.vitest.test.ts', body).length, 0);
  assert.equal(scanText('src/b.test.ts', `import { test, expect } from 'vitest';\n${body}`).length, 0);
  assert.equal(scanText('src/c.test.ts', `import { test, expect } from 'bun:test';\n${body}`).length, 0);
  assert.equal(scanText('src/d.test.ts', body).length, 1, 'jest (globals) still counts');
});
