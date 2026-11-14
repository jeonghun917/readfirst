// A string run by eval, `bash -c` or a script file is commands too, and a write in one was missed in silence: no file
// named and nothing given as not known (review of #211, 2026-11-14). eval's arguments were never read (follow only
// made the variables and the folder not known), a `bash -c` string with a part known only when it runs read as no
// commands at all, and `source x.sh`, `. ./x.sh` and `bash x.sh` were not looked at. A string readfirst can read is
// read where it runs (eval: in this shell, with its variables); one it cannot is given as not known, with why.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';

const hasBash = spawnSync('bash', ['-c', 'true'], { env: {} }).status === 0;
// The files bash makes running the script in a new folder that holds an empty folder a, relative to it (as in
// test/here-docs.test.mjs: copied, since importing a test file runs its tests).
const bashMade = (script) => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-eval-'));
  mkdirSync(join(dir, 'a'));
  spawnSync('bash', ['-c', script], { cwd: dir, env: {}, stdio: 'ignore', timeout: 5000 });
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name)); else out.push(relative(dir, join(d, e.name))); } };
  walk(dir);
  return out.sort();
};
const files = (script) => shellWrites(script, '/r').files.map((f) => relative('/r', f)).sort();
const notKnown = (script) => shellWrites(script, '/r').unknown;

test('a string eval runs is read as commands where eval stands, and bash agrees', { skip: !hasBash && 'bash is not installed' }, () => {
  for (const script of ['eval "echo > e2"', "eval 'echo > e3'", 'cd a; eval "echo > e4"', 'eval "cd a; echo > e5"', "eval echo '>' e6", 'x=a; eval "echo > $x/e7"']) {
    assert.deepEqual(files(script), bashMade(script), script);
    assert.deepEqual(notKnown(script), [], script);
  }
});

test('a string known only when it runs, given to eval or bash -c, is given as not known', () => {
  for (const script of ['eval "$(cat <<E\necho > e1\nE\n)"', 'x=$(cat <<E\necho > e5\nE\n); eval "$x"', 'bash -c "$(cat <<E\necho > e6\nE\n)"', 'bash -c "$X"', 'sh -c "$(cat f)"']) {
    const u = notKnown(script);
    assert.ok(u.length > 0, `nothing given as not known: ${script}`);
    assert.match(u[0].why, /runs it as commands/u, script);
  }
  // The part shown is what the command said: since #211 a here-document's mark (a private-use character and a number)
  // stood where its `<<E` was.
  const [u] = notKnown('eval "$(cat <<E\necho > e1\nE\n)"');
  assert.doesNotMatch(`${u.part} ${u.word}`, /[-]/u);
  assert.match(u.part, /<<E/u);
});

test('a script file run by source, . or a shell is given as not known: its text is not read', () => {
  for (const script of ['source x.sh', '. ./test/setup.mjs', 'bash x.sh', 'sh -e x.sh arg', 'bash -o pipefail x.sh']) {
    const u = shellWrites(script, process.cwd()).unknown;
    assert.ok(u.length > 0, `nothing given as not known: ${script}`);
    assert.match(u[0].why, /does not read the file's text/u, script);
  }
});

// A path with a / that is not there runs nothing (bash fails), and a shell that reads stdin or runs nothing has no file.
test('the look-alikes stay quiet: no write, nothing not known', () => {
  for (const script of ['eval true', 'eval "echo hi"', "bash -c 'echo hi'", 'bash --version', 'sh -c "ls -la"', 'bash -n x.sh', 'bash -s a b', 'source ./no-such-file.sh', 'bash /no/such/x.sh']) {
    assert.deepEqual(files(script), [], script);
    assert.deepEqual(notKnown(script), [], script);
  }
});
