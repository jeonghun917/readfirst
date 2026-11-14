// A string run by eval, `bash -c` or a script file is commands too, and a write in one was missed in silence: no file
// named and nothing given as not known (review of #211, 2026-11-14). eval's arguments were never read (follow only
// made the variables and the folder not known), a `bash -c` string with a part known only when it runs read as no
// commands at all, and `source x.sh`, `. ./x.sh` and `bash x.sh` were not looked at. A string readfirst can read is
// read where it runs (eval: in this shell, with its variables); one it cannot is given as not known, with why.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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

// Review of #213: a script run as the command itself (`./build.sh`, also after exec or nohup), fed to a shell on stdin
// (`bash < build.sh`, `bash -s < build.sh`) or through a pipe (`cat build.sh | sh`) was still silent. Each runs in a
// folder holding build.sh, which writes `made`: bash makes it, and readfirst gives the command as not known, with why.
// A program run by its path (/bin/true) and a path that is not there stay quiet, and so does a shell given -n.
test('a script run as the command, or fed to a shell on stdin or by a pipe, is given as not known, and bash runs it', { skip: !hasBash && 'bash is not installed' }, () => {
  // A new folder holding build.sh, a script that writes `made`.
  const fixture = () => { const d = mkdtempSync(join(tmpdir(), 'readfirst-eval-run-')); writeFileSync(join(d, 'build.sh'), '#!/bin/sh\necho > made\n'); chmodSync(join(d, 'build.sh'), 0o755); return d; };
  const dir = fixture();
  for (const script of ['./build.sh', 'exec ./build.sh', 'nohup ./build.sh', 'bash < build.sh', 'bash -s < build.sh', 'sh <build.sh', 'cat build.sh | sh']) {
    const d = fixture();
    spawnSync('bash', ['-c', script], { cwd: d, env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 5000 });
    assert.ok(readdirSync(d).includes('made'), `bash runs the script: ${script}`);
    const u = shellWrites(script, dir).unknown;
    assert.ok(u.length > 0, `nothing given as not known: ${script}`);
    assert.match(u[0].why, /runs it, and readfirst does not read the file's text|runs the commands the command before it prints/u, script);
  }
  for (const script of ['./no-such.sh', '/bin/true', 'cat build.sh', 'bash -n < build.sh', 'sh -n build.sh']) {
    assert.deepEqual(shellWrites(script, dir), { files: [], unknown: [], repos: [] }, script);
  }
});

// Review of #213 (acbad2f): a file with an execute bit and no #! runs too: the kernel refuses it (ENOEXEC) and bash
// reads it as a shell script; readfirst looked for #! only, and was silent. One with #! but no execute bit runs nothing
// (permission denied) and stays quiet, as does a program (its magic bytes).
test('an executable file without #! runs as a script, one without an execute bit does not, and bash agrees', { skip: !hasBash && 'bash is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-eval-plain-'));
  writeFileSync(join(dir, 'plain.sh'), 'echo > made1\n');
  chmodSync(join(dir, 'plain.sh'), 0o755);
  writeFileSync(join(dir, 'noexec.sh'), '#!/bin/sh\necho > made2\n');
  writeFileSync(join(dir, 'prog'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
  chmodSync(join(dir, 'prog'), 0o755);
  spawnSync('bash', ['-c', './plain.sh; ./noexec.sh'], { cwd: dir, env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 5000 });
  const made = readdirSync(dir);
  assert.ok(made.includes('made1') && !made.includes('made2'), `bash runs plain.sh and not noexec.sh: ${made}`);
  assert.match(shellWrites('./plain.sh', dir).unknown[0]?.why ?? '', /does not read the file's text/u);
  assert.deepEqual(shellWrites('./noexec.sh', dir).unknown, []);
  assert.deepEqual(shellWrites('./prog', dir).unknown, []);
});

// A path with a / that is not there runs nothing (bash fails), and a shell that reads stdin or runs nothing has no file.
test('the look-alikes stay quiet: no write, nothing not known', () => {
  for (const script of ['eval true', 'eval "echo hi"', "bash -c 'echo hi'", 'bash --version', 'sh -c "ls -la"', 'bash -n x.sh', 'bash -s a b', 'source ./no-such-file.sh', 'bash /no/such/x.sh']) {
    assert.deepEqual(files(script), [], script);
    assert.deepEqual(notKnown(script), [], script);
  }
});
