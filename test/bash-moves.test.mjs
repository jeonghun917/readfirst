// What mv takes away, names after `--` that start with a -, and the backups sed -i, perl -i, cp, mv and install keep
// (src/bash-writes.mjs: copies, operand, inPlaceSuffix, backupSuffix). Until 2026-11-15 `mv a.txt b.txt` named only
// b.txt, so a file the map holds could be moved off through the gate without its notes, while rm named it; `rm --
// -a.txt` and the like named nothing; and `sed -i.bak` or `cp -b` did not name the copy they keep. Each command runs
// through bash in a fresh folder; the files it makes, changes or takes away are what shellWrites must name. The
// helpers follow test/bash-more-writes.test.mjs, since importing a test file runs its tests.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';
import { itemId, runHook } from '../src/cli.mjs';

const hasTools = spawnSync('bash', ['-c', 'cp --version && sed --version && perl -v'], { env: { PATH: process.env.PATH }, stdio: 'ignore' }).status === 0;
const setUp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-moves-'));
  mkdirSync(join(dir, 'd'));
  // Each file holds its own name, so a file another lands on changes.
  for (const f of ['a.txt', 'b.txt', '-a.txt', 'd/a.txt']) writeFileSync(join(dir, f), `one ${f}\n`);
  return dir;
};
const snap = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};
// The files bash makes, changes or takes away.
const bashChanged = (script, dir) => {
  const before = snap(dir);
  spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, stdio: 'ignore', timeout: 10000 });
  const after = snap(dir);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();
};
const named = (script, dir) => { const r = shellWrites(script, dir); return [...r.files.map((f) => relative(dir, f) || '.'), ...r.unknown.map((u) => `?${u.part}`)].sort(); };
const agrees = (scripts) => {
  for (const script of scripts) {
    const dir = setUp();
    const want = named(script, dir);
    // A folder named is where things land (`mv -t d b.txt` names d, as before: what lands in it is not looked up), so a
    // file bash changes in it counts as that folder, unless the file is named itself (a backup in it).
    const changed = [...new Set(bashChanged(script, dir).map((f) => (want.includes(f) ? f : want.find((w) => f.startsWith(`${w}/`)) ?? f)))].sort();
    assert.ok(changed.length > 0, `bash changes a file: ${script}`);
    assert.deepEqual(want, changed, script);
  }
};

test('mv names the files it takes away as well as where they go, and bash agrees', { skip: !hasTools && 'bash, GNU cp, sed or perl is not installed' }, () => {
  agrees(['mv a.txt n.txt', 'mv a.txt b.txt', 'mv -f a.txt b.txt', 'mv -t d b.txt', 'mv --target-directory=d b.txt', 'mv --target-directory d b.txt', 'mv b.txt -- -a.txt']);
  // Into a folder: the folder is named, as before, not what lands in it.
  const dir = setUp();
  assert.deepEqual(named('mv a.txt b.txt d', dir), ['a.txt', 'b.txt', 'd']);
  assert.deepEqual(named('cp a.txt n.txt', dir), ['n.txt'], 'cp takes nothing away');
});

test('a name after -- that starts with a - is written, and bash agrees', { skip: !hasTools && 'bash, GNU cp, sed or perl is not installed' }, () => {
  agrees(['rm -- -a.txt', 'rm -f -- -a.txt b.txt', 'touch -- -n.txt', 'cp a.txt -- -c.txt', 'mv -- -a.txt n.txt', 'sed -i s/one/two/ -- -a.txt', 'truncate -s 0 -- -a.txt', 'echo x | tee -- -t.txt', 'sort -o -s.txt a.txt']);
  const s = (c) => shellWrites(c, '/r').files;
  assert.deepEqual(s('git rm -q -- -a.txt'), ['/r/-a.txt']);
  assert.deepEqual(s('git -C x rm -- -a.txt'), ['/r/x/-a.txt']);
  assert.deepEqual(s('git checkout -- -a.txt'), ['/r/-a.txt']);
  assert.deepEqual(s('cp -t -d a.txt'), ['/r/-d'], 'an option value');
  // The look-alikes: an option before `--`, and a lone - (stdin or stdout).
  assert.deepEqual(s('rm -f a.txt'), ['/r/a.txt']);
  assert.deepEqual(s('echo x | tee -'), []);
  assert.deepEqual(s('sort -o - a.txt'), []);
});

test('the backup sed -i, perl -i, cp, mv and install keep is named, and bash agrees', { skip: !hasTools && 'bash, GNU cp, sed or perl is not installed' }, () => {
  agrees([
    'sed -i.bak s/one/two/ a.txt', 'sed --in-place=.orig s/one/two/ a.txt', 'sed -Ei.bak s/one/two/ a.txt', 'perl -i.orig -pe s/one/two/ a.txt', 'perl -pi.bak -e s/one/two/ a.txt',
    'cp -b a.txt b.txt', 'cp --backup a.txt b.txt', 'cp --backup=simple a.txt b.txt', 'cp -S .old a.txt b.txt', 'cp --suffix=.old -b a.txt b.txt', 'mv -b a.txt b.txt', 'mv -b a.txt d', 'cp -b -t d a.txt', 'install -b a.txt b.txt',
  ]);
  // The look-alikes: no suffix, no backup asked for or none kept, and nothing there to keep.
  agrees(['sed -i s/one/two/ a.txt', 'perl -pi -e s/one/two/ a.txt', 'cp a.txt b.txt', 'cp --backup=none a.txt b.txt', 'cp --backup=off a.txt b.txt', 'cp -b a.txt n.txt', 'mv -b a.txt n.txt']);
});

// The gate end to end: a file the map holds, moved off by mv, is refused until its items are answered.
test('hook --gate refuses mv of a file the map holds until its items are answered', () => {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-moves-gate-'));
  const files = {
    'src/a.js': 'export const a = 1;\n',
    '.readfirst/map.json': JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**'], risks: [{ text: 'callers import a from here', files: ['src/a.js'] }], checks: [{ run: 'true', why: 'nothing' }] }] }),
  };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-moves-gate-state-'));
  const call = (command) => { const out = runHook(JSON.stringify({ session_id: `moves-${process.pid}`, cwd: root, tool_name: 'Bash', tool_input: { command } }), { stateDir, gate: true }); return out ? JSON.parse(out).hookSpecificOutput : null; };
  const first = call('mv src/a.js a.js');
  assert.equal(first?.permissionDecision, 'deny', 'the source is a file the map holds');
  assert.match(first.permissionDecisionReason, /callers import a from here/u);
  const id = itemId('risk', 'src', 'callers import a from here');
  assert.equal(call(`npx readfirst answer '${JSON.stringify([{ item: id, answer: 'done', because: 'the callers are moved with it' }])}'`), null);
  assert.notEqual(call('mv src/a.js a.js')?.permissionDecision, 'deny', 'answered: the same call goes through');
});
