// Variables a shell command sets for itself are known before it runs: `S=/a; cd $S/w && echo x > f` writes /a/w/f.
// Until this test the reader took no value from them: a write after `cd $S` was not named at all, and a write to `$F`
// was dropped, both silently (in readfirst's own sessions every write into a worktree went through such a variable).
// What the command cannot know (a variable from outside it, a $( ) value, a loop variable) is not guessed: the write
// is listed as unknown, with the part that is not known, never dropped.
// Words are read as the shell reads them: `a\&b.js` is the file a&b.js (the backslash was kept until this test).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashReads, bashWrites, shellWrites } from '../src/bash-writes.mjs';
import { runHook } from '../src/cli.mjs';

const w = (c) => bashWrites(c, '/r');
const unknown = (c) => shellWrites(c, '/r').unknown.map((u) => u.part);

test('a variable the command sets: cd to it, write to it, ${ } and export', () => {
  assert.deepEqual(w('S=/a; cd $S/w && echo x > f'), ['/a/w/f']);
  assert.deepEqual(w('S=/a && cd ${S}/w && echo x > f'), ['/a/w/f']);
  assert.deepEqual(w('export S=/a; cd "$S" && sed -i s/a/b/ g.js'), ['/a/g.js']);
  assert.deepEqual(w('F=x.py; echo a > $F'), ['/r/x.py']);
  assert.deepEqual(w('F=x.py; cp a.py "$F"'), ['/r/x.py']);
});

test('quoted values, a variable made from another, and A=1 B=$A in one line', () => {
  assert.deepEqual(w('S="/a b"; echo x > "$S/f.txt"'), ['/a b/f.txt']);
  assert.deepEqual(w("S='/a'; echo x > $S/f.txt"), ['/a/f.txt']);
  assert.deepEqual(w('S=/a; T=$S/w; cd $T && echo x > f'), ['/a/w/f']);
  assert.deepEqual(w('A=/a B=$A/b; echo x > $B/f'), ['/a/b/f']);
});

test('a subshell keeps its cd and its variables inside', () => {
  assert.deepEqual(w('S=/a; (cd $S && echo x > f) && echo y > g'), ['/a/f', '/r/g']);
  assert.deepEqual(w('(S=/a; echo x > $S/f); echo y > $S/g'), ['/a/f']);
  assert.deepEqual(unknown('(S=/a; echo x > $S/f); echo y > $S/g'), ['$S'], 'outside the ( ) S is not the command\'s');
});

test('what the command cannot know is listed as unknown, never dropped', () => {
  assert.deepEqual(w('ls > $OUT'), []);
  assert.deepEqual(unknown('ls > $OUT'), ['$OUT']);
  assert.deepEqual(unknown('cd $D && echo x > f.txt'), ['$D']);
  assert.deepEqual(unknown('S=$(mktemp -d); echo x > $S/f'), ['$(mktemp -d)']);
  assert.deepEqual(unknown('for f in a b; do echo x > $f.txt; done'), ['$f']);
  assert.deepEqual(unknown('echo x > "$(git rev-parse --show-toplevel)/f"'), ['$(git rev-parse --show-toplevel)']);
  assert.deepEqual(shellWrites('cd $D && echo x > f.txt', '/r').unknown[0].why, 'D is not set by the command');
  // A write the command names in full is still named; only the unknown one is listed.
  assert.deepEqual(shellWrites('echo a > k.txt; echo b > $OUT', '/r'), { files: ['/r/k.txt'], unknown: [{ part: '$OUT', word: '$OUT', why: 'OUT is not set by the command' }] });
});

test('a loop body is read: sed -i after do, a write after then', () => {
  assert.deepEqual(unknown('for f in src/*.js; do sed -i s/a/b/ $f; done'), ['$f']);
  assert.deepEqual(w('if true; then echo x > f.txt; fi'), ['/r/f.txt']);
  assert.deepEqual(w('while true; do sed -i s/a/b/ g.js; done'), ['/r/g.js']);
});

test('words as the shell reads them: a backslash escapes the next character', () => {
  assert.deepEqual(w('echo x > a\\&b.js'), ['/r/a&b.js']);
  assert.deepEqual(w('sed -i s/a/b/ my\\ file.txt'), ['/r/my file.txt']);
  assert.deepEqual(w('echo x > "a\\"b.txt"'), ['/r/a"b.txt']);
  assert.deepEqual(w("echo x > 'a\\b.txt'"), ['/r/a\\b.txt'], 'inside single quotes a backslash is a character');
});

test('commands that only read stay without writes and without unknowns', () => {
  for (const c of ['S=/a; ls $S', 'F=x; cat $F', 'echo $HOME', 'for f in a b; do echo $f; done', 'grep -n x "$F" 2>/dev/null']) {
    assert.deepEqual(shellWrites(c, '/r'), { files: [], unknown: [] }, c);
  }
});

test('readfirst read through a variable the command set counts as a read of that file', () => {
  assert.deepEqual(bashReads('S=/a; cd $S && npx readfirst read src/x.mjs', '/r').map((r) => r.files), [['/a/src/x.mjs']]);
  assert.deepEqual(bashReads('F=src/x.mjs; node bin/readfirst.mjs read "$F"', '/r').map((r) => r.files), [['/r/src/x.mjs']]);
});

// The hook: a write it cannot place is named. With --gate the call is refused once, and the same call goes through when
// made again; a write it can place gets its notes as before.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-'));
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  mkdirSync(join(root, '.readfirst'));
  writeFileSync(join(root, '.readfirst/map.json'), JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'code', title: 'the code', files: ['*.js'], risks: [{ text: '`a` is read by the build' }] }], rules: [] }));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  return root;
}
let n = 0;
const hook = (root, stateDir, command, gate = true, session = `bash-vars-${process.pid}-${n}`) => {
  const out = runHook(JSON.stringify({ session_id: session, cwd: root, tool_name: 'Bash', tool_input: { command } }), { stateDir, gate });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};

test('hook --gate: a write to a variable from outside the command is refused once, named, and the same call then goes through', () => {
  n++;
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-'));
  const first = hook(root, stateDir, 'echo x > "$OUT/f.txt"');
  assert.equal(first.permissionDecision, 'deny');
  assert.match(first.permissionDecisionReason, /writes where readfirst cannot tell before it runs: `\$OUT\/f\.txt` \(\$OUT: OUT is not set by the command\)/u);
  assert.equal(hook(root, stateDir, 'echo x > "$OUT/f.txt"'), null, 'made again, it goes through');
  // Without --gate it is said, not refused.
  const told = hook(root, mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-')), 'cd $D && sed -i s/a/b/ a.js', false);
  assert.equal(told.permissionDecision, undefined);
  assert.match(told.additionalContext, /`a\.js` \(\$D: D is not set by the command\)/u);
  assert.ok(readFileSync(join(stateDir, `readfirst-hook-bash-vars-${process.pid}-${n}.lines`), 'utf8').includes('"unknown:'), 'the mark is kept');
});

test('hook --gate: a write through a variable the command set is placed, and gets that file\'s notes', () => {
  n++;
  const root = repo();
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-'));
  const out = hook(root, stateDir, `R=${root}; cd $R && sed -i s/1/2/ a.js`);
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /readfirst notes for a\.js/u);
  assert.doesNotMatch(out.permissionDecisionReason, /cannot tell/u);
});
