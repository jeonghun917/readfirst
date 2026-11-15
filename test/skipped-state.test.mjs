// A command skipped as never run still changes what readfirst knows (review of #229, 2026-11-15). Whether it never
// runs is a guess; if the guess is wrong, its cd, pushd or assignment did run, and a read after it is in another
// folder. Skipped, it left the folder as it was, and `true || cd a; readfirst read y.md` credited y.md in the first
// folder: a wrong guess credited the wrong file, not less. Now what it may change is not known after it (as after an
// && list), so a read that depends on it is not credited. A skipped command that changes nothing leaves all known.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashReads, shellWrites } from '../src/bash-writes.mjs';
import { findQueries } from '../src/cli.mjs';

const CWD = '/r';
const reads = (command) => bashReads(command, CWD).flatMap((r) => r.files);

test('a cd, pushd or assignment in a command skipped as never run leaves the folder or the value not known', () => {
  for (const command of [
    'true || cd a; readfirst read y.md', 'false && cd a; readfirst read y.md', 'false && pushd a; readfirst read y.md',
    'true || { cd a; }; readfirst read y.md', 'false && X=a; readfirst read $X/y.md', 'false && export X=a; readfirst read $X/y.md',
    'exit; cd a; readfirst read y.md',
  ]) assert.deepEqual(reads(command), [], command);
  assert.deepEqual(findQueries('false && cd a; readfirst find charge', CWD), [], 'a find there counts in no folder');
});

test('a skipped command that changes nothing leaves the folder known, and a cd that runs is followed', () => {
  assert.deepEqual(reads('false && echo hi; readfirst read y.md'), ['/r/y.md']);
  assert.deepEqual(reads('cd a; readfirst read y.md'), ['/r/a/y.md']);
  assert.deepEqual(reads('false && cd a; cd /b; readfirst read y.md'), ['/b/y.md'], 'a later cd to a whole path is known again');
});

// The one write #229 named differently from main (0afdb27 against 2c4450b, every string of the tests): a JS object
// that names a member `buildOrder:` read as shell. #229 lets a function name be any word bash takes, so
// `buildOrder: () => 1,` is a definition, its `> 1,` no redirect. bash stops at the syntax error and writes nothing;
// main named a write to `1,`. A name with a colon is a function in bash when it is one.
const bash = spawnSync('bash', ['-c', 'true']).status === 0;
test('the write #229 changed: a JS object read as shell writes nothing, as in bash', { skip: !bash && 'bash is not found here' }, () => {
  const run = (script) => {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-skipped-'));
    spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH } });
    return { dir, wrote: (f) => existsSync(join(dir, f)), named: shellWrites(script, dir).files };
  };
  const js = run('module.exports = {\n  makeUser() {},\n  buildOrder: () => 1,\n};\n');
  assert.equal(js.wrote('1,'), false, 'bash writes nothing');
  assert.deepEqual(js.named, [], 'and readfirst names nothing');
  // The other two the review of #229 counted (its strings ran between two literals of test/code.test.mjs): JS that
  // starts `, () =>` and a class with decorators, `@d() @d m(...)`. bash stops at the syntax error in both and writes
  // nothing; readfirst names no file (the second gives `@d` as a write it cannot place, which costs one refusal).
  for (const script of [", () => assert.equal(bounds(path, lines.join('\\n')), want));\n\n// Known and not read right\n", 'import d from "d";\n@d @d.e class E {\n  @d x = 1;\n  @d() @d m(@d p: number) { return p; }\n  @d\n  n() {}\n}\n']) {
    const r = run(script);
    assert.deepEqual(readdirSync(r.dir), [], `bash writes nothing: ${JSON.stringify(script.slice(0, 30))}`);
    assert.deepEqual(r.named, [], `readfirst names no file: ${JSON.stringify(script.slice(0, 30))}`);
  }
  const colon = run('buildOrder:() { echo x > made; }; buildOrder:');
  assert.equal(colon.wrote('made'), true, 'bash runs a function named with a colon');
  assert.deepEqual(colon.named, [join(colon.dir, 'made')], 'and readfirst reads its body where it is called');
});
