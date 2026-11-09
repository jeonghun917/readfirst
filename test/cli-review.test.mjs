// The findings of the 2026-11-08 CLI review (readfirst 0.26.3), each reproduced on a scratch repository first, and the
// hook that refused every tool call over an option it did not know.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, parse, runHook, runStopHook } from '../src/cli.mjs';
import { bashWrites } from '../src/bash-writes.mjs';
import { draftChecks, MAP_FORMAT } from '../src/map.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'readfirst.mjs');

function repo(files, { branch = 'main' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-review-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', branch);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}
const run = (root, ...argv) => {
  let out = '';
  let err = '';
  let code;
  try { code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: (s) => { err += s; } }); } catch (e) { code = 2; err += e.message; }
  return { code, out, err };
};
// The command as a user types it, from a folder (no --root).
const cli = (cwd, ...argv) => {
  try { return { code: 0, out: execFileSync('node', [BIN, ...argv], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const stateDir = () => mkdtempSync(join(tmpdir(), 'readfirst-review-state-'));
const MAP = (groups, rules = []) => JSON.stringify({ format: MAP_FORMAT, groups, rules });
const SRC = {
  'src/math.js': 'export const add = (a, b) => a + b;\n',
  'src/sum.js': "import { add } from './math.js';\nexport const sum = (xs) => xs.reduce(add, 0);\n",
};

test('review 1: read takes an absolute path and a path from the current folder', () => {
  const { root } = repo({ ...SRC, '.readfirst/map.json': MAP([{ id: 'src', title: 'src', files: ['src/**', '.readfirst/**'], checks: [{ run: 'echo ok', why: 'the src check' }] }]) });
  for (const [cwd, path] of [[root, join(root, 'src/math.js')], [join(root, 'src'), 'math.js'], [join(root, 'src'), './math.js'], [root, 'src/math.js']]) {
    const r = cli(cwd, 'read', path);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /# Read first: `src\/math\.js`/u, `${cwd} ${path}`);
    assert.match(r.out, /the src check/u);
    assert.doesNotMatch(r.out, /not a tracked file/u);
  }
  // With --root (the MCP server, scripts) a relative path is still from the root, wherever the command runs.
  assert.match(cli(join(root, 'src'), 'read', '--root', root, 'src/math.js').out, /the src check/u);
  // A path outside the repository is passed on as given, and reads as not tracked.
  assert.match(cli(root, 'read', '/etc/hostname').out, /not a tracked file/u);
});

test('review 2: prompt works whenever check passes (a new file beside placed ones)', () => {
  const { root } = repo({ ...SRC, 'README.md': '# x\n' });
  run(root, 'init');
  writeFileSync(join(root, 'TODO.md'), 'y\n');
  assert.equal(run(root, 'check').code, 0);
  const p = run(root, 'prompt');
  assert.equal(p.code, 0, p.err);
  // What check still fails on stops prompt too.
  writeFileSync(join(root, '.readfirst/map.json'), MAP([{ id: 'src', title: 'src', files: ['src/**', '*.md', '.readfirst/**'] }], [{ id: 'r', rule: 'x', files: ['gone.js'] }]));
  assert.equal(run(root, 'check').code, 1);
  assert.match(run(root, 'prompt').err, /has problems/u);
});

test('review 3: a map broken by a rename is said out loud by both hooks, not silence', () => {
  const { root, git } = repo({ ...SRC, 'package.json': '{"scripts":{"test":"node -e 0"}}', '.readfirst/map.json': MAP([{ id: 'src', title: 'src', files: ['src/**', 'package.json', '.readfirst/**'], checks: [{ run: 'node -e 0', why: 'the suite' }] }], [{ id: 'pure', rule: 'add stays pure', files: ['src/math.js'] }]) });
  git('checkout', '-q', '-b', 'work');
  git('mv', 'src/math.js', 'src/arith.js');
  git('commit', '-q', '-m', 'rename');
  const dir = stateDir();
  const pre = JSON.parse(runHook(JSON.stringify({ session_id: 'r3', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/sum.js') } }), { stateDir: dir }));
  const notes = pre.hookSpecificOutput.additionalContext;
  assert.match(notes, /map\.json is broken \(1 problem; first: rules\[0\]\.files: src\/math\.js matches no tracked file\)/u);
  assert.match(notes, /Check to run after the change: node -e 0/u, 'what the map still gives is kept');
  writeFileSync(join(root, 'src/sum.js'), `${readFileSync(join(root, 'src/sum.js'), 'utf8')}// x\n`);
  const stop = (active = false) => runStopHook(JSON.stringify({ session_id: 'r3', cwd: root, stop_hook_active: active }), { stateDir: dir, timeout: 30 });
  const blocked = JSON.parse(stop());
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /map\.json is broken/u);
  assert.equal(stop(true), null, 'the second stop lets go');
  // A map that is not even JSON: the hook still answers, from git history alone.
  writeFileSync(join(root, '.readfirst/map.json'), '{ nope');
  const bad = JSON.parse(runHook(JSON.stringify({ session_id: 'r3b', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/sum.js') } }), { stateDir: dir }));
  assert.match(bad.hookSpecificOutput.additionalContext, /map\.json is broken \(1 problem; first: \.readfirst\/map\.json is not valid JSON/u);
  assert.match(JSON.parse(stop()).reason, /not valid JSON.*The checks for the files you edited were not run/su);
});

test('review 4: a test script that watches is not drafted as a check', () => {
  const checks = (scripts) => draftChecks(['package.json'], () => JSON.stringify({ scripts })).map((c) => c.run);
  assert.deepEqual(checks({ test: 'jest --watch', lint: 'eslint .' }), ['npm run lint']);
  assert.deepEqual(checks({ test: 'jest --watchAll' }), []);
  assert.deepEqual(checks({ test: 'vitest watch' }), []);
  assert.deepEqual(checks({ test: 'nodemon --exec mocha' }), []);
  assert.deepEqual(checks({ test: 'jest', typecheck: 'tsc --noEmit -w' }), ['npm test']);
  // These run once.
  assert.deepEqual(checks({ test: 'react-scripts test --watchAll=false' }), ['npm test']);
  assert.deepEqual(checks({ test: 'jest -w 4' }), ['npm test'], 'jest -w is --maxWorkers');
  assert.deepEqual(checks({ test: 'vitest run', lint: 'eslint . --no-watch' }), ['npm test', 'npm run lint']);
});

test('review 5: init --agent --ci goes on past a .claude/settings.json with comments, and says what to add', () => {
  const { root } = repo({ 'a.js': 'x\n', 'CLAUDE.md': '# notes\n', 'AGENTS.md': '# a\n', '.claude/settings.json': '{\n  // mine\n  "permissions": {}\n}\n' });
  const r = run(root, 'init', '--agent', '--ci');
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(root, '.readfirst/map.json')));
  assert.ok(existsSync(join(root, '.github/workflows/readfirst.yml')));
  assert.match(r.out, /by hand: \.claude\/settings\.json was left alone \(it is not plain JSON[^)]*\); add \{"hooks":\{"PreToolUse"/u);
  assert.match(readFileSync(join(root, '.claude/settings.json'), 'utf8'), /\/\/ mine/u, 'left as it was');
  assert.equal(run(root, 'check').code, 0);
  // hook --install alone still refuses, with the snippet.
  const h = run(root, 'hook', '--install', '--verify');
  assert.equal(h.code, 2);
  assert.match(h.err, /not plain JSON.*"Stop"/su);
});

test('review 6: on main with no remote, committed changes are not "nothing to verify"', () => {
  const { root, git } = repo({ ...SRC, '.readfirst/map.json': MAP([{ id: 'src', title: 'src', files: ['src/**', '.readfirst/**'], checks: [{ run: 'exit 1', why: 'fails' }] }]) });
  writeFileSync(join(root, 'src/math.js'), 'export const add = (a, b) => b + a;\n');
  git('commit', '-qam', 'change');
  const v = run(root, 'verify');
  assert.equal(v.code, 2);
  assert.match(v.err, /on main, the base branch itself.*pass --base <ref>/u);
  assert.equal(run(root, 'diff').code, 2);
  // With --base the commit is seen and the failing check runs.
  assert.equal(run(root, 'verify', '--base', 'HEAD~1').code, 1);
  // Uncommitted changes are still verified, with a note that commits are not counted.
  writeFileSync(join(root, 'src/sum.js'), '// y\n');
  const u = run(root, 'verify');
  assert.equal(u.code, 1);
  assert.match(u.err, /only uncommitted changes are counted/u);
});

test('review 6: the Stop hook on main with no remote checks a file committed during the session', () => {
  const { root } = repo({ ...SRC, '.readfirst/map.json': MAP([{ id: 'src', title: 'src', files: ['src/**', '.readfirst/**'], checks: [{ run: 'exit 1', why: 'fails' }] }]) });
  const dir = stateDir();
  const at = Date.now() + 2000; // the session marks the files two seconds after the first commit
  for (const f of ['src/math.js', 'src/sum.js']) runHook(JSON.stringify({ session_id: 'r6', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, f) } }), { stateDir: dir, now: at });
  const stop = () => runStopHook(JSON.stringify({ session_id: 'r6', cwd: root }), { stateDir: dir, timeout: 30 });
  assert.equal(stop(), null, 'seen, not changed, not committed');
  writeFileSync(join(root, 'src/math.js'), 'export const add = (a, b) => b + a;\n');
  const later = new Date(at + 1000).toISOString();
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'change'], { env: { ...process.env, GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later } });
  const blocked = JSON.parse(stop());
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /1 of 1 check\(s\).*failed/u);
});

test('review 7: setup writes nothing outside the repository through symlinks', () => {
  const outside = mkdtempSync(join(tmpdir(), 'readfirst-review-outside-'));
  writeFileSync(join(outside, 'CLAUDE.md'), '# outside\n');
  mkdirSync(join(outside, 'claude'));
  mkdirSync(join(outside, 'cursor'));
  const { root } = repo({ 'a.js': 'x\n' });
  symlinkSync(join(outside, 'CLAUDE.md'), join(root, 'CLAUDE.md'));
  symlinkSync(join(outside, 'claude'), join(root, '.claude'));
  symlinkSync(join(outside, 'cursor'), join(root, '.cursor'));
  symlinkSync(join(outside, 'missing.md'), join(root, 'GEMINI.md')); // a link to a file that does not exist yet
  const r = run(root, 'setup', '--for', 'claude,cursor,gemini');
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(outside, 'CLAUDE.md'), 'utf8'), '# outside\n');
  assert.equal(existsSync(join(outside, 'claude', 'settings.json')), false);
  assert.equal(existsSync(join(outside, 'cursor', 'mcp.json')), false);
  assert.equal(existsSync(join(outside, 'missing.md')), false);
  for (const f of ['CLAUDE.md', '.claude/settings.json', '.cursor/mcp.json', 'GEMINI.md']) assert.match(r.out, new RegExp(`by hand: ${f.replace(/\./gu, '\\.')} was left alone \\(it is outside the repository`, 'u'), f);
});

test('review 8: a UTF-8 byte order mark in the map and in package.json is read like npm reads it', () => {
  const { root, git } = repo({ ...SRC, 'package.json': '﻿{"scripts":{"test":"node -e 0"}}\n' });
  assert.match(run(root, 'init').out, /checks found: npm test/u);
  const at = join(root, '.readfirst/map.json');
  writeFileSync(at, `﻿${readFileSync(at, 'utf8')}`);
  git('add', '.');
  git('commit', '-q', '-m', 'map with a BOM');
  assert.equal(run(root, 'check').code, 0);
  assert.match(run(root, 'read', 'src/math.js').out, /npm test/u);
  const hook = runHook(JSON.stringify({ session_id: 'r8', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/math.js') } }), { stateDir: stateDir() });
  assert.match(JSON.parse(hook).hookSpecificOutput.additionalContext, /npm test/u);
});

test('review 9: &> and &>> write their target', () => {
  assert.deepEqual(bashWrites('echo x &> src/log.txt', '/r'), ['/r/src/log.txt']);
  assert.deepEqual(bashWrites('echo x &>> src/log.txt', '/r'), ['/r/src/log.txt']);
  assert.deepEqual(bashWrites('npm test &>/dev/null', '/r'), []);
  assert.deepEqual(bashWrites('npm test 2>&1 | tail -5', '/r'), []);
  assert.deepEqual(bashWrites('echo x >&2', '/r'), []);
});

test('review 10: output cut short by a closed pipe is no crash', async () => {
  const r = await new Promise((done) => {
    const child = spawn('node', [BIN, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy(); // the reader (head) is gone before readfirst writes
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => done({ code, err }));
  });
  assert.doesNotMatch(r.err, /EPIPE|Unhandled/u);
  assert.equal(r.code, 0);
});

test('review 11: --name=value, unknown options and flags given a value', () => {
  assert.equal(parse(['verify', '--base=main']).base, 'main');
  assert.deepEqual(parse(['read', '--limit=5', 'a.js']), { _: ['read', 'a.js'], json: false, limit: '5' });
  assert.equal(parse(['diff', '--base=feature=x']).base, 'feature=x', 'split at the first =');
  assert.throws(() => parse(['verify', '--bse', 'main']), /unknown option --bse/u);
  assert.throws(() => parse(['verify', '--base=']), /--base needs a value/u);
  assert.throws(() => parse(['init', '--force=yes']), /--force takes no value/u);
  assert.deepEqual(parse(['read', '--', '--json']), { _: ['read', '--json'], json: false }, 'after -- everything is a name');
  const { root, git } = repo(SRC);
  run(root, 'init');
  git('add', '.');
  git('commit', '-q', '-m', 'map');
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'src/math.js'), '// y\n');
  assert.match(run(root, 'diff', '--base=main').out, /src\/math\.js/u);
  assert.match(run(root, 'read', '--limit=5', 'src/math.js').out, /# Read first: `src\/math\.js`/u);
});

test('review 12: a misspelt --base says there is no such ref, not that the clone is shallow', () => {
  const { root } = repo(SRC);
  run(root, 'init');
  const r = run(root, 'verify', '--base', 'mian');
  assert.equal(r.code, 2);
  assert.match(r.err, /no branch or commit named mian/u);
  assert.doesNotMatch(r.err, /shallow/u);
});

test('hook: an option it does not know warns and lets the call through (exit 0), for both hooks', () => {
  for (const argv of [['hook', '--gate', '--quiet'], ['hook', '--stop', '--timeout'], ['hook', '--gate=yes'], ['--root', '/nowhere', 'hook', '--bogus']]) {
    let out = '';
    const code = main(argv, { out: (s) => { out += s; }, err: () => {} }, () => '{}');
    assert.equal(code, 0, argv.join(' '));
    const msg = JSON.parse(out).systemMessage;
    assert.match(msg, /readfirst \d+\.\d+\.\d+ hook: .*let this call through/u, argv.join(' '));
    assert.equal(JSON.parse(out).hookSpecificOutput, undefined, 'never a deny');
  }
  // Outside a hook the same mistake is still an error.
  assert.throws(() => main(['read', '--quiet', 'a.js'], { out: () => {}, err: () => {} }), /unknown option --quiet/u);
  assert.throws(() => main(['hook', '--install', '--quiet'], { out: () => {}, err: () => {} }), /unknown option --quiet/u);
  // From the command line: exit 0, never 2 (which refuses the tool call).
  const r = cli(tmpdir(), 'hook', '--gate', '--newer-flag');
  assert.equal(r.code, 0);
  assert.match(r.out, /systemMessage/u);
});

test('--version prints the package version', () => {
  const { version } = JSON.parse(readFileSync(join(dirname(BIN), '..', 'package.json'), 'utf8'));
  assert.equal(cli(tmpdir(), '--version').out.trim(), version);
  let out = '';
  assert.equal(main(['--version'], { out: (s) => { out += s; }, err: () => {} }), 0);
  assert.equal(out.trim(), version);
});
