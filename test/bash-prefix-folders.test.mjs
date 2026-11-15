// The prefix of a write not known (the folder it is known to be under) is a folder written once, with `..` and `.`
// taken out and one / at its end, for a write and for a cd alike (knownFolder and climb in src/bash-writes.mjs). The
// hook keeps a repository for such a write when its path starts with the prefix (couldLandIn in src/cli.mjs). Until
// 2026-11-15:
// - `../$X/f` from a folder one below the root, and patch -d, git -C or npm --prefix to /, gave `//`, which no
//   repository's path starts with;
// - `/a/b/../$X/f` gave `/a/b/../`, so a checkout the command makes under /a was left out (with no other repository
//   known, the write went through unasked);
// - `cd /a/$X/..` was under /a/, though it is / when $X is empty, and so were `patch -d`, `git -C` and `npm --prefix`
//   given `sub/$X/..`;
// - `cd $(mktemp -d)/../..` was a new name in the temporary folder, so the hook let its write through unasked.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';
import { runHook } from '../src/cli.mjs';

const vars = new Map([['TMPDIR', { value: '/t', exported: true }]]);
const read = (command) => shellWrites(command, '/r', { vars }).unknown;

test('a prefix is the folder written once, for a write and for a cd', () => {
  for (const [command, prefix, fresh = false] of [
    ['echo > ../$X/f', '/'],
    ['echo > ../../$X/f', '/'],
    ['echo > /a/b/../$X/f', '/a/'],
    ['echo > /a/./$X/f', '/a/'],
    ['echo > /a/b/..$X/f', '/a/b/'],
    ['patch -d .. -p1 < $P', '/'],
    ['patch -d / < p.diff', '/'],
    ['git -C / pull', '/'],
    ['git -C .. pull', '/'],
    ['npm --prefix / install', '/'],
    // A folder option climbs past a part not known as a path does (review of #244: `sub/$X/..` was under sub/, though
    // with $X empty it is the folder itself).
    ['patch -d sub/$X/.. -p0 < f', '/r/'],
    ['git -C sub/$X/.. pull', '/r/'],
    ['npm --prefix sub/$X/.. i', '/r/'],
    ['npm --prefix sub/$X i', '/r/sub/'],
    ['cd /a/b/../$X && echo > f', '/a/'],
    ['cd /a/./$X && echo > f', '/a/'],
    ['cd /a/$X/.. && echo > f', '/'],
    ['cd sub/$X && echo > f', '/r/sub/'],
    ['cd sub/$X/.. && echo > f', '/r/'],
    ['cd /a && cd ../$X && echo > f', '/'],
    ['cd $(mktemp -d) && echo > f', '/t/', true],
    ['cd $(mktemp -d)/.. && echo > f', '/t/'],
    ['cd $(mktemp -d)/../.. && echo > f', '/'],
  ]) {
    const unknown = read(command);
    assert.deepEqual(unknown.map((u) => [u.prefix, Boolean(u.fresh)]), [[prefix, fresh]], command);
  }
  assert.deepEqual(read('echo > ../a$X/f')[0].within, { dir: '/', pre: 'a', post: '' });
});

test('no prefix holds `//`, a `.` or a `..` folder, or ends without a /', () => {
  const shapes = ['../', '../../', '/', '/../', '/a/b/../', '/a/./', '/a/b/./../', './', 'sub/../', 'sub/./'];
  const commands = shapes.flatMap((s) => [`echo > ${s}$X/f`, `echo > ${s}a$X/f`, `cd ${s}$X && echo > f`, `patch -d ${s} -p1 < $P`, `git -C ${s} pull`, `npm --prefix ${s} install`]);
  for (const command of commands) {
    for (const u of read(command)) {
      for (const dir of [u.prefix, u.within?.dir].filter(Boolean)) {
        assert.ok(dir.endsWith('/') && !dir.includes('//') && !/\/\.\.?\//u.test(dir), `${command}: ${dir}`);
      }
    }
  }
});

test('hook --gate: a write through `/a/../` could land in the checkout the command makes there', () => {
  const top = mkdtempSync(join(tmpdir(), 'readfirst-prefix-folders-'));
  mkdirSync(join(top, 'a'));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-prefix-folders-state-'));
  const hook = (command, session) => {
    const out = runHook(JSON.stringify({ session_id: session, cwd: top, tool_name: 'Bash', tool_input: { command } }), { stateDir, gate: true });
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };
  const written = hook(`git init -q new && echo x > ${top}/$X/f`, `prefix-folders-${process.pid}-1`);
  const through = hook(`git init -q new && echo x > ${top}/a/../$X/f`, `prefix-folders-${process.pid}-2`);
  // Until 2026-11-15 this one went through unasked: no checkout's path starts with `<top>/a/../`.
  assert.equal(through?.permissionDecision, 'deny', 'the write through /a/../ is asked about');
  assert.ok(written.permissionDecisionReason.includes(join(top, 'new')), 'the plain path names the new checkout');
  assert.ok(through.permissionDecisionReason.includes(join(top, 'new')), through.permissionDecisionReason);
});
