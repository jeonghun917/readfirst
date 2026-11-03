import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { cursorPlan, cursorRules } from '../src/export.mjs';
import { mapProblems } from '../src/map.mjs';

const MAP = {
  format: 'readfirst/map@1',
  groups: [
    { id: 'billing', title: 'billing: charges and refunds', files: ['billing/**'], checks: [{ run: 'npm test -- billing', why: 'billing tests' }], risks: [{ text: 'amounts are in cents', files: ['billing/charge.js'] }] },
    { id: 'legacy', title: 'old billing', files: ['legacy/**'], deprecated: { why: 'moving to billing/', use: 'billing' } },
    { id: 'docs', title: 'docs', files: ['docs/**'] },
  ],
  rules: [{ id: 'cents', rule: 'amounts are integers in cents', why: 'floats round', files: ['billing/**'], checks: [{ run: 'npm run money' }] }],
};
const FILES = ['billing/charge.js', 'legacy/old.js', 'docs/a.md'];

test('cursorRules writes one .mdc per group with something to say, scoped by the group\'s globs', () => {
  const out = cursorRules(MAP, FILES);
  assert.deepEqual(Object.keys(out).sort(), ['.cursor/rules/readfirst-billing.mdc', '.cursor/rules/readfirst-legacy.mdc'], 'docs has nothing to say');
  const b = out['.cursor/rules/readfirst-billing.mdc'];
  assert.match(b, /^---\ndescription: billing: charges and refunds\nglobs: billing\/\*\*\nalwaysApply: false\n---\n/u);
  assert.match(b, /Edit the map, not this file/u);
  assert.match(b, /- \*\*cents\*\*: amounts are integers in cents \(why: floats round\)/u);
  assert.match(b, /- amounts are in cents \(billing\/charge.js\)/u);
  assert.match(b, /- `npm test -- billing`: billing tests\n- `npm run money`/u, 'group checks and the rule\'s checks, once each');
  assert.match(out['.cursor/rules/readfirst-legacy.mdc'], /\*\*Being replaced\*\*: use `billing` instead\. moving to billing\/ Do not add to it\./u);
});

test('cursorPlan writes what changed and removes only our own files for groups that are gone', () => {
  const want = cursorRules(MAP, FILES);
  const read = (p) => (p === '.cursor/rules/readfirst-billing.mdc' ? want[p] : null);
  const plan = cursorPlan(MAP, FILES, read, ['.cursor/rules/readfirst-billing.mdc', '.cursor/rules/readfirst-old.mdc', '.cursor/rules/team.mdc']);
  assert.deepEqual(plan.write, ['.cursor/rules/readfirst-legacy.mdc']);
  assert.deepEqual(plan.remove, ['.cursor/rules/readfirst-old.mdc'], 'the team\'s own team.mdc stays');
});

test('the exported files belong to no group, like the map', () => {
  assert.deepEqual(mapProblems(MAP, [...FILES, '.cursor/rules/readfirst-billing.mdc']), []);
  assert.match(mapProblems(MAP, [...FILES, '.cursor/rules/team.mdc']).join('\n'), /in no group/u, 'only readfirst-*.mdc is ours');
});

test('readfirst export --cursor writes, --check notices a map change, and the team\'s own rules are left alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-export-'));
  const put = (p, body) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); };
  for (const f of FILES) put(f, '');
  put('.readfirst/map.json', JSON.stringify(MAP, null, 2));
  put('.cursor/rules/team.mdc', 'ours');
  const map2 = structuredClone(MAP); map2.groups.push({ id: 'cursor', title: 'editor rules', files: ['.cursor/rules/team.mdc'] });
  put('.readfirst/map.json', JSON.stringify(map2, null, 2));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x']);
  const run = (...a) => { let out = ''; const code = main(['--root', root, ...a], { out: (s) => { out += s; }, err: () => {} }); return { code, out }; };
  assert.equal(run('export', '--cursor', '--check').code, 1, 'nothing exported yet');
  const w = run('export', '--cursor');
  assert.match(w.out, /wrote \.cursor\/rules\/readfirst-billing\.mdc, \.cursor\/rules\/readfirst-legacy\.mdc/u);
  assert.equal(run('export', '--cursor', '--check').code, 0);
  assert.equal(run('check', '--strict').code, 0, 'the written files need no group');
  map2.rules[0].rule = 'amounts are integers in cents, always';
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify(map2, null, 2));
  const stale = run('export', '--cursor', '--check');
  assert.equal(stale.code, 1);
  assert.match(stale.out, /readfirst-billing\.mdc/u);
  run('export', '--cursor');
  assert.match(readFileSync(join(root, '.cursor/rules/readfirst-billing.mdc'), 'utf8'), /in cents, always/u);
  assert.equal(readFileSync(join(root, '.cursor/rules/team.mdc'), 'utf8'), 'ours');
  assert.ok(!existsSync(join(root, '.cursor/rules/readfirst-docs.mdc')));
  assert.throws(() => run('export'), /readfirst export --cursor/u);
});
