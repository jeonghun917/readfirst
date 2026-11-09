// No list is cut to a fixed size without a word of the rest (the owner's rule: nothing hidden, 2026-11-09). The bug
// ledger found fourteen such cuts in readfirst and readfirst-cloud in two days (10 files in the hook, 12 note lines, 30
// tests, 5 users, 60,000 characters, 15 audit rows with "--json lists all" while the JSON held the same 15...). A cut of
// a list for output, `.slice(0, N)` with a constant or a number followed by map/join/forEach/filter/flatMap, a spread of
// such a slice, a slice to an UPPER_CASE constant, or a loop that stops when a count reaches one, needs a `cut:` comment
// on its line or the line above that says where the rest is said. A string cut (a short sha, a subject) is no list: the
// shapes below do not match it unless it is cut to a constant, which then says so in its comment.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const CUT = /\.slice\(0, *(?:[A-Z][A-Z0-9_]*|[0-9]+)\)\.(?:map|join|forEach|filter|flatMap)\(|\.\.\.[\w$.?]+\.slice\(0, *(?:[A-Z][A-Z0-9_]*|[0-9]+)\)|\.slice\(0, *[A-Z][A-Z0-9_]+\)|length *(?:===|>=) *[A-Z][A-Z0-9_]+\) *(?:return|break)/u;

export function silentCuts(dirs) {
  const out = [];
  for (const dir of dirs) {
    for (const name of readdirSync(join(root, dir)).filter((f) => f.endsWith('.mjs'))) {
      const lines = readFileSync(join(root, dir, name), 'utf8').split('\n');
      lines.forEach((l, i) => { if (CUT.test(l) && !/\bcut:/u.test(l) && !/\bcut:/u.test(lines[i - 1] ?? '')) out.push(`${dir}/${name}:${i + 1}: ${l.trim().slice(0, 120)}`); });
    }
  }
  return out;
}

test('every list cut to a fixed size says where the rest is', () => {
  assert.deepEqual(silentCuts(['src', 'bin']), []);
});
