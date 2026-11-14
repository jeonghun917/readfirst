// First-run errors that say what is wrong (owner's plan B, 2026-11-09): a check that fails on a fresh clone or a new
// worktree because the dependencies are not installed read as broken code, a misspelled map field was only "unknown
// field", and a map without `format` was told `format: "readfirst/map@1"` without saying it was missing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { dependencyHint, main } from '../src/cli.mjs';
import { MAP_FORMAT, mapProblems, nearField } from '../src/map.mjs';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-first-run-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}
const run = (root, ...argv) => {
  let out = '';
  const code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: () => {} });
  return { code, out };
};

test('verify says the dependencies look missing when a check fails on a package that is not installed', () => {
  const map = { format: MAP_FORMAT, groups: [{ id: 'src', title: 'Source', files: ['src/**', 'package.json'], checks: [{ run: 'node src/a.mjs', why: 'the app starts' }] }] };
  const { root, git } = repo({ 'package.json': '{"name":"x","type":"module","dependencies":{"left-pad-not-here":"1.0.0"}}\n', 'src/a.mjs': "import 'left-pad-not-here';\n", '.readfirst/map.json': JSON.stringify(map) });
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'src/a.mjs'), "import 'left-pad-not-here';\nconsole.log(1);\n");
  const v = run(root, 'verify', '--base', 'main');
  assert.equal(v.code, 1, 'it still fails: nothing is passed for it');
  assert.match(v.out, /ERR_MODULE_NOT_FOUND|Cannot find package/u, 'the output is still shown');
  assert.match(v.out, /It looks like the package left-pad-not-here is not installed, and there is no node_modules here \(a fresh clone or a new worktree\?\): install the dependencies/u);
  assert.match(v.out, /if this change added the import, add the package to package\.json too/u, 'a new import of a package not in the manifest fails the same way, and is said');
  const json = JSON.parse(run(root, 'verify', '--base', 'main', '--json').out);
  assert.match(json.checks[0].hint, /left-pad-not-here is not installed/u);
});

test('the hint names what the output shows, and nothing for an ordinary failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-hint-'));
  assert.match(dependencyHint(dir, "Traceback (most recent call last):\nModuleNotFoundError: No module named 'requests'"), /the Python module requests is not installed here/u);
  assert.match(dependencyHint(dir, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/r/src/b.mjs' imported from /r/src/a.mjs"), /a file it imports is not there: \/r\/src\/b\.mjs \(a wrong import path, or a build step that has not run\)/u);
  assert.match(dependencyHint(dir, "Error: Cannot find module 'express'\nRequire stack:"), /the package express is not installed/u, 'CommonJS require of a package');
  assert.equal(dependencyHint(dir, 'AssertionError: expected 1 to equal 2'), null);
  assert.equal(dependencyHint(dir, ''), null);
});

test('a map field one letter or a plural away is named; format says it is required and what it must be', () => {
  const files = ['src/a.js'];
  const base = { format: MAP_FORMAT, groups: [{ id: 'src', title: 'Source', files: ['src/**'] }] };
  const p = (map) => mapProblems(map, files);
  assert.ok(p({ ...base, groups: [{ id: 'src', title: 'Source', file: ['src/**'], files: ['src/**'] }] }).includes('groups[0].file: unknown field; did you mean `files`?'));
  assert.ok(p({ ...base, groups: [{ ...base.groups[0], risks: [{ text: 'x', file: ['src/a.js'] }] }] }).includes('groups[0].risks[0].file: unknown field; did you mean `files`?'));
  assert.ok(p({ ...base, rule: [] }).includes('map.rule: unknown field; did you mean `rules`?'));
  assert.ok(p({ ...base, extra: 1 }).includes('map.extra: unknown field'), 'nothing near: no guess');
  assert.equal(nearField('titel', ['id', 'title', 'files']), 'title');
  assert.equal(nearField('xyz', ['id', 'title', 'files']), null);
  const { format, ...noFormat } = base;
  assert.equal(format, MAP_FORMAT);
  assert.ok(p(noFormat).includes(`format: required: add "format": "${MAP_FORMAT}" to the map`));
  assert.ok(p({ ...base, format: 'readfirst/map@2' }).includes(`format: must be "${MAP_FORMAT}", not "readfirst/map@2"`));
  assert.deepEqual(p(base), [], 'a right map has no problems');
});

// readfirst watch on readfirst#139: a failing check's output was cut to its last 30 lines with no word of the rest.
test('a failing check with long output says how many lines came before the last 30', () => {
  const map = { format: MAP_FORMAT, groups: [{ id: 'src', title: 'Source', files: ['src/**'], checks: [{ run: 'node src/long.mjs', why: 'long output' }] }] };
  const { root, git } = repo({ 'src/long.mjs': "for (let i = 1; i <= 45; i++) console.log('line ' + i);\nprocess.exit(1);\n", '.readfirst/map.json': JSON.stringify(map) });
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'src/long.mjs'), "for (let i = 1; i <= 45; i++) console.log('line ' + i);\nprocess.exit(1);\n// changed\n");
  const v = run(root, 'verify', '--base', 'main');
  assert.equal(v.code, 1);
  assert.match(v.out, /\(15 earlier lines not shown; run `node src\/long\.mjs` to see them all\)\nline 16\n/u);
  assert.match(v.out, /line 45/u);
  assert.doesNotMatch(v.out, /line 15\n/u);
});

// 2026-11-14: verify said `npm test` failed, and its last 30 lines were the runner's summary, so which test failed was
// not shown (two runs in a row, then never again: it could not be found). A TAP `not ok` line before the last lines is
// shown with the block under it; a todo or a skip is not.
test('a failing check shows each failing test, wherever it stands in the output', () => {
  const tap = [
    'TAP version 13', 'ok 1 - first', 'not ok 2 - the one that failed', '  ---', '  error: |-', '    expected 1, got 2', '  ...',
    'not ok 3 - a todo # TODO not done yet', '  ---', '  ...',
    ...Array.from({ length: 40 }, (_, k) => `ok ${k + 4} - filler ${k}`), '# tests 43', '# fail 1',
  ];
  const map = { format: MAP_FORMAT, groups: [{ id: 'src', title: 'Source', files: ['src/**'], checks: [{ run: 'node src/tap.mjs', why: 'tap output' }] }] };
  const script = `console.log(${JSON.stringify(tap.join('\n'))});\nprocess.exit(1);\n`;
  const { root, git } = repo({ 'src/tap.mjs': script, '.readfirst/map.json': JSON.stringify(map) });
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'src/tap.mjs'), `${script}// changed\n`);
  const v = run(root, 'verify', '--base', 'main');
  assert.equal(v.code, 1);
  assert.match(v.out, /\(the failing tests, from the earlier lines:\)\nnot ok 2 - the one that failed\n {2}---\n {2}error: \|-\n {4}expected 1, got 2\n {2}\.\.\.\n/u);
  assert.doesNotMatch(v.out, /a todo/u, 'a todo is not a failure');
  // 52 lines: the last 30 are shown, and of the 22 before them the failing test's 5.
  assert.match(v.out, /\(17 of the 22 earlier lines not shown; run `node src\/tap\.mjs` to see them all\)\nok 16 - filler 12\n/u);
  assert.match(v.out, /# fail 1/u);
});

// Review of #201 (2026-11-14), each on node's own TAP: a `...` line in an error's text ended the block (the rest of the
// message and the stack were lost); `\# TODO` in a test's name hid a failing test; a block that runs on into the last
// lines was shown twice and the count of lines left out went below zero; and a thousand failures were all shown whole.
const verifyTap = (tap) => {
  const map = { format: MAP_FORMAT, groups: [{ id: 'src', title: 'Source', files: ['src/**'], checks: [{ run: 'node src/tap.mjs', why: 'tap output' }] }] };
  const script = `console.log(${JSON.stringify(tap.join('\n'))});\nprocess.exit(1);\n`;
  const { root, git } = repo({ 'src/tap.mjs': script, '.readfirst/map.json': JSON.stringify(map) });
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'src/tap.mjs'), `${script}// changed\n`);
  return run(root, 'verify', '--base', 'main').out;
};
const filler = (n, at = 0) => Array.from({ length: n }, (_, k) => `ok ${at + k} - filler ${k}`);

test('a failing test is shown whole and once: dots in its error, a \\# in its name, a block that runs into the last lines', () => {
  const dots = verifyTap(['not ok 1 - throws', '  ---', '  error: |-', '    boom', '    ...', '    more text after dots', '  stack: |-', '    at x', '  ...', ...filler(40, 2)]);
  assert.match(dots, /\n {4}\.\.\.\n {4}more text after dots\n {2}stack: \|-\n {4}at x\n {2}\.\.\.\n/u, 'the block goes on past a deeper ...');
  const named = verifyTap(['not ok 1 - parses \\# TODO comments', '  ---', '  ...', 'not ok 2 - later # TODO not yet', '  ---', '  ...', ...filler(40, 3)]);
  assert.match(named, /not ok 1 - parses \\# TODO comments/u, 'a # in the name is no directive');
  assert.doesNotMatch(named, /later # TODO/u);
  // 10 lines of ok, a block of 43 lines, and 2 lines of summary: 56 lines, the last 30 from line 27.
  const long = verifyTap([...filler(10), 'not ok 11 - long', '  ---', ...Array.from({ length: 41 }, (_, k) => `  line ${k}`), '  ...', '# tests 11', '# fail 1']);
  assert.equal(long.match(/ {2}line 20\n/gu)?.length, 1, 'no line of the block twice');
  assert.match(long, /\(10 of the 26 earlier lines not shown; run/u);
});

test('a thousand failing tests: each is named, the blocks of the first ten are shown, and the rest are counted', () => {
  const tap = Array.from({ length: 1000 }, (_, k) => [`not ok ${k + 1} - broke ${k}`, '  ---', '  error: |-', `    failure ${k}`, '  ...']).flat();
  const out = verifyTap([...tap, ...filler(40, 1001)]);
  assert.match(out, /not ok 1000 - broke 999\n/u, 'the last is named');
  assert.match(out, / {4}failure 9\n/u);
  assert.doesNotMatch(out, / {4}failure 10\n/u, 'its block is not shown');
  assert.match(out, /\(the blocks under 990 of these 1000 failing tests not shown; run `node src\/tap\.mjs` to see them\)/u);
});
