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
// The shapes of a cut to a fixed size: slice(0, N) with N a number, an UPPER_CASE constant or a size parameter (max...,
// limit, count); a push while a count is under such a bound; a loop that stops when a count reaches one. The first
// version looked only at a slice followed by map/join/forEach/filter/flatMap or at an UPPER_CASE bound, and let
// `return unique(out).slice(0, 5)`, `for (const d of defs.slice(0, 2))`, `.slice(0, max)` and `out.length === 10) break`
// through (in readfirst-cloud, eleven list cuts; here the audit's files still using deprecated code, cut to five).
const SIZE = String.raw`(?:[0-9]+|[A-Z][A-Z0-9_]*|max\w*|limit|count)`;
const BOUND = String.raw`(?:[3-9]|[1-9][0-9]+|[A-Z][A-Z0-9_]*|max\w*|limit|count)`;
// A slice from the end, `.slice(-30)`, keeps the last N and drops the rest the same way: a failing check's output in
// verify was cut to its last 30 lines with no word of how many came before (readfirst watch on readfirst#139); this
// test, which looked only at slice(0, N), passed it.
export const CUT = new RegExp(String.raw`\.slice\(0, *${SIZE}\)|\.slice\(-${BOUND}\)|length *< *${BOUND}\)[^;]*\.push\(|(?:\.length|\bn) *(?:===|>=) *${BOUND}\) *(?:return|break|continue)`, 'u');
// A cut of text, not of a list, is left out before the shapes are looked for: a short sha, a hash, a date string, a
// title, subject, message or body, the result of a string method or of String(), inert() or codeSpan().
export const TEXT = new RegExp(String.raw`(?:\b\w*(?:[sS]ha|[cC]ommit\w*|[hH]ash)\w*(?:\([^()]*\))?\)?\??|digest\('hex'\)|toISOString\(\)|\b(?:title|subject|message|body|route|text|value|why|since|slug)(?: \?\? '')?\)?|\.(?:trim|text)\(\)\)?|\.(?:join|replace)\([^()]*(?:\([^()]*\)[^()]*)*\)|\.split\([^()]*\)\[0\]|\b(?:String|inert|codeSpan)\([^;]*\)|\x60)\.slice\(0, *\d+\)|\.slice\(0, *\d+\)\}?…`, 'gu');

const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []));

export function silentCuts(dirs) {
  const out = [];
  for (const dir of dirs) {
    for (const path of walk(dir)) {
      const lines = readFileSync(join(root, path), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/^\s*\/\//u.test(l)) return;
        if (CUT.test(l.replace(TEXT, '')) && !/\bcut:/u.test(l) && !/\bcut:/u.test(lines[i - 1] ?? '')) out.push(`${path}:${i + 1}: ${l.trim().slice(0, 120)}`);
      });
    }
  }
  return out;
}

test('the cut shapes catch what the first version missed, and leave text cuts alone', () => {
  for (const l of ['  return unique(out).slice(0, 5);', '  for (const d of defs.slice(0, 2)) {', '  .slice(0, max)', '    if (out.length === 10) break;', '    if (n >= PER_FILE) continue;', "      if (lead.commits.length < 3) lead.commits.push(c);", '  for (const path of pinFiles(tracked).slice(0, 20)) {', "  const tail = all.split('\\n').slice(-30).join('\\n');", '  rows.slice(-MAX_ROWS)'])
    assert.ok(CUT.test(l.replace(TEXT, '')), l);
  for (const l of ['`${sha.slice(0, 7)}`', "createHash('sha256').update(x).digest('hex').slice(0, 16)", "new Date().toISOString().slice(0, 7)", 'inert(f.title.slice(0, 200))', "String(c.commit?.message ?? '').split('\\n')[0].slice(0, 120)", '(pr.body ?? \'\').slice(0, 2000)', 'pr.head?.sha?.slice(0, 7)', "if (parts.length === 1) return x;", 'parts.slice(-1)[0]', "name.split('.').slice(-2)"])
    assert.ok(!CUT.test(l.replace(TEXT, '')), l);
});

test('every list cut to a fixed size says where the rest is', () => {
  assert.deepEqual(silentCuts(['src', 'bin']), []);
});
