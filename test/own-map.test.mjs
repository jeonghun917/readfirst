// This repository's own map (.readfirst/map.json) keeps the limits `readfirst check` holds every map to: a risk of at
// most 2,000 characters and the rest of the shape mapProblems asks for. Until this test only `readfirst check` saw it,
// and npm test passed with a risk over the limit (one reached exactly 2,000 characters on 2026-11-13 before anyone
// looked). The map is read as it is committed and judged by the same function check calls (mapProblems, through
// settleMap); `placement: false` leaves out where files belong, which a stray file in a working tree would change.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readMapFile, repoFiles } from '../src/cli.mjs';
import { mapProblems } from '../src/map.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');

test('this repository\'s map keeps the limits check holds it to', () => {
  const map = readMapFile(here);
  assert.deepEqual(mapProblems(map, repoFiles(here), { placement: false }), []);
});

test('the same call fails on a risk one character over the limit, so the test above would see one', () => {
  const map = readMapFile(here);
  const at = map.groups.findIndex((g) => g.risks?.length);
  const groups = map.groups.map((g, i) => (i === at ? { ...g, risks: [{ ...g.risks[0], text: 'x'.repeat(2001) }, ...g.risks.slice(1)] } : g));
  const problems = mapProblems({ ...map, groups }, repoFiles(here), { placement: false });
  assert.ok(problems.some((p) => p.startsWith(`groups[${at}].risks[0]`)), problems.join('\n'));
});
