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
  assert.deepEqual(unknown('for f in $L; do echo x > $f.txt; done'), ['$f']);
  assert.deepEqual(unknown('for f in *.js; do echo x > $f.txt; done'), ['$f'], 'a glob list: what it matches when it runs');
  assert.deepEqual(unknown('echo x > "$(git rev-parse --show-toplevel)/f"'), ['$(git rev-parse --show-toplevel)']);
  assert.deepEqual(shellWrites('cd $D && echo x > f.txt', '/r').unknown[0].why, 'D is not set by the command');
  // A write the command names in full is still named; only the unknown one is listed.
  assert.deepEqual(shellWrites('echo a > k.txt; echo b > $OUT', '/r'), { files: ['/r/k.txt'], unknown: [{ part: '$OUT', word: '$OUT', why: 'OUT is not set by the command', prefix: '' }], repos: [] });
  // prefix: the folder the write is known to be under, '' when nothing is known.
  assert.deepEqual(shellWrites('echo x > /tmp/x/$D/f', '/r').unknown.map((u) => u.prefix), ['/tmp/x/']);
  assert.deepEqual(shellWrites('cd /srv/$D && echo x > f', '/r').unknown.map((u) => u.prefix), ['/srv/']);
  assert.deepEqual(shellWrites('echo x > out/$D.txt', '/r').unknown.map((u) => u.prefix), ['/r/out/']);
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
    assert.deepEqual(shellWrites(c, '/r'), { files: [], unknown: [], repos: [] }, c);
  }
});

// The environment the command starts with (the hook passes its own, which Claude Code gives it), what mktemp makes,
// $OLDPWD, and the checkouts a command makes (2026-11-13: most of what the hook asked about was $TMPDIR and mktemp).
test('variables from the environment, mktemp, $OLDPWD and the checkouts a command makes', () => {
  const env = new Map([['TMPDIR', { value: '/tmp/t', exported: true }], ['HOME', { value: '/home/u', exported: true }]]);
  const s = (c) => shellWrites(c, '/r', { vars: env });
  assert.deepEqual(s('echo x > $TMPDIR/a.txt').files, ['/tmp/t/a.txt']);
  assert.deepEqual(s('echo x > $HOME/.x').files, ['/home/u/.x']);
  assert.deepEqual(s('D=$(mktemp -d) && echo x > $D/f').unknown.map((u) => [u.prefix, u.fresh]), [['/tmp/t/', true]], 'a new name in $TMPDIR');
  assert.deepEqual(s('cd $(mktemp -d) && echo x > f').unknown.map((u) => [u.prefix, u.fresh]), [['/tmp/t/', true]]);
  assert.deepEqual(s('R=$(mktemp -d /s/old-XXXX); T=$R/w; echo > $T/x').unknown.map((u) => [u.prefix, u.fresh]), [['/s/', true]], 'the folder of its template');
  assert.deepEqual(s('F=$(mktemp -p /q); echo > $F').unknown.map((u) => [u.prefix, u.fresh]), [['/q/', true]]);
  assert.deepEqual(s('F=$(mktemp x.XXX); echo > $F').unknown.map((u) => [u.prefix, u.fresh]), [['/r/', true]], 'a template with no folder: where the command is');
  assert.deepEqual(s('cd /a && cd /b && echo > $OLDPWD/f').files, ['/a/f']);
  assert.deepEqual(s('for r in $L; do echo > /s/w-$r/f; done').unknown.map((u) => [u.prefix, u.fresh]), [['/s', undefined]], 'a loop variable: not new');
  // Not known only inside a file's name: the file is in that folder. A whole part may hold a /: it could be below.
  assert.deepEqual(s('echo > /s/out-$k.txt').unknown.map((u) => [u.prefix, u.direct]), [['/s', true]]);
  assert.deepEqual(s('echo > /s/$r').unknown.map((u) => [u.prefix, u.direct]), [['/s/', undefined]]);
  assert.deepEqual(s('S=/s && git worktree add $S/w-x main && git clone u /c/d && git -C /a init sub').repos, ['/s/w-x', '/c/d', '/a/sub']);
  // git -C with an absolute folder runs there (it was joined under the command's folder: /r/s/w/f.js).
  assert.deepEqual(s('S=/s && git -C $S/w checkout -- f.js').files, ['/s/w/f.js']);
  assert.deepEqual(s('git -C sub checkout -- f.js').files, ['/r/sub/f.js']);
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
  assert.match(first.permissionDecisionReason, /writes where readfirst cannot tell before it runs: `\$OUT\/f\.txt` \(\$OUT: OUT is not set by the command; could be in /u);
  assert.equal(hook(root, stateDir, 'echo x > "$OUT/f.txt"'), null, 'made again, it goes through');
  // Without --gate it is said, not refused.
  const told = hook(root, mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-')), 'cd $D && sed -i s/a/b/ a.js', false);
  assert.equal(told.permissionDecision, undefined);
  assert.match(told.additionalContext, /`a\.js` \(\$D: D is not set by the command; could be in /u);
  assert.ok(readFileSync(join(stateDir, `readfirst-hook-bash-vars-${process.pid}-${n}.lines`), 'utf8').includes('"unknown:'), 'the mark is kept');
});

// A session runs from the folder it was started in, often one above its repositories: the repositories a write could
// land in come from the write and from what the session has touched, not from that folder (until this test a session
// in /home/user was never asked about `cd $R/repo && echo x > src/f`).
test('hook --gate from a folder outside every repository: an unknown write is still refused once; one known to be outside is not', () => {
  n++;
  const outside = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-outside-'));
  const fresh = () => mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-'));
  const nowhere = hook(outside, fresh(), 'cd $OUTSIDE/readfirst && echo x > src/zz.mjs');
  assert.equal(nowhere.permissionDecision, 'deny');
  assert.match(nowhere.permissionDecisionReason, /`src\/zz\.mjs` \(\$OUTSIDE: OUTSIDE is not set by the command; could be in any repository: none is known to this session\)/u);
  // Known to be under a folder that holds no repository: outside them all, nothing to ask.
  assert.equal(hook(outside, fresh(), `echo x > ${outside}/$D/f.txt`), null);
  assert.equal(hook(outside, fresh(), `cd ${outside}/$D && echo x > f.txt`), null);
});

test('hook --gate from outside: a repository the session already used is where an unknown write could land', () => {
  n++;
  const root = repo();
  const outside = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-outside-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-'));
  const session = `bash-vars-used-${process.pid}-${n}`;
  // The session edits a.js in the repository (its notes are shown: the repository is now one it used).
  hook(outside, stateDir, `sed -i s/1/2/ ${root}/a.js`, true, session);
  const out = hook(outside, stateDir, 'cd $R && echo x > b.js', true, session);
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, new RegExp(`could be in [^)]*${root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  // A write under the folder above it could land in it too; one under another folder could not.
  const parent = join(root, '..');
  assert.equal(hook(outside, stateDir, `echo x > ${parent}/$X/f.txt`, true, session).permissionDecision, 'deny');
  assert.equal(hook(outside, stateDir, `echo x > ${outside}/$X/f.txt`, true, session), null);
  assert.ok(readFileSync(join(stateDir, `readfirst-hook-${session}.lines`), 'utf8').includes(`"start:${root}"`), 'the Stop hook checks that repository');
});

// A value is believed only where the command surely sets it (review of this change, 2026-11-13: each of these named the
// old value as if sure). Unknown parts are shown as they are.
test('values changed where the reader cannot follow are not known: $( ) split at |, +=, eval, branches, pipes, functions', () => {
  const s = (c) => { const r = shellWrites(c, '/r'); return r.files.length ? r.files : r.unknown.map((u) => u.part); };
  // A: a $( ) or backticks the command is split inside (at its | ; &&) is still an assignment, of a value not known.
  assert.deepEqual(s('S=/a; S=$(echo b | tr b c); echo x > $S/f'), ['$(echo b …)']);
  assert.deepEqual(s('S=/a; S=`echo b | tr b c`; echo x > $S/f'), ['`echo b …`']);
  assert.deepEqual(s('S=/a; S="$(echo b | tr b c)"; echo x > $S/f'), ['$(echo b …)']);
  assert.deepEqual(s('S=/a; S=$(cd /z && pwd); echo x > $S/f'), ['$(cd /z …)']);
  assert.deepEqual(s('cd $(echo b | tr b c) && echo x > f'), ['$(echo b …)']);
  // B: other ways of setting a value.
  assert.deepEqual(s('S=/a; S+=/b; echo x > $S/f'), ['/a/b/f'], '+= appends');
  for (const c of ["S=/a; eval 'S=/b'; echo x > $S/f", 'S=/a; printf -v S %s /b; echo x > $S/f', 'S=/a; . env.sh; echo x > $S/f',
    'S=/a; source env.sh; echo x > $S/f', 'S=/a; mapfile S < l; echo x > $S/f', 'S=/a; let S=3; echo x > $S/f', 'S=/a; ((S=3)); echo x > $S/f',
    'S=/a; f(){ S=/b; }; f; echo x > $S/f', 'if x; then S=/a; else S=/b; fi; echo x > $S/f', 'true || S=/a; echo x > $S/f']) {
    assert.deepEqual(s(c), ['$S'], c);
  }
  // A pipeline's stage runs in a subshell: its assignment does not stay.
  assert.deepEqual(s('S=/z; S=/a | cat; echo x > $S/f'), ['/z/f']);
  assert.deepEqual(s('S=/z; echo | S=/a; echo x > $S/f'), ['/z/f']);
  // && chains run in order: the value is known.
  assert.deepEqual(s('mkdir -p /a && S=/a && echo x > $S/f'), ['/a/f']);
  // An assignment is not the command its value ends in: E=/s/eval is not eval.
  assert.deepEqual(s('E=/s/eval && echo x > $E/out.txt'), ['/s/eval/out.txt']);
  assert.deepEqual(s('S=/a; F=/x/source; echo x > $S/f'), ['/a/f']);
  // A here-document inside a loop: the loop it is read in does not stay open for the rest of the command.
  assert.deepEqual(s("E=/s && for m in a b; do cp x $E/mut/ && python3 - <<'EOF'\nprint(1)\nEOF\ndone"), ['/s/mut/']);
  // C: export keeps its mark when the value is set later or again.
  assert.deepEqual(s("export S; S=/a; bash -c 'echo x > $S/f'"), ['/a/f']);
  assert.deepEqual(s("export S=/a; S=/b; bash -c 'echo x > $S/f'"), ['/b/f']);
  // $'...', $(( )) and $PWD.
  assert.deepEqual(s("echo x > $'a b'"), ["$'a b'"]);
  assert.deepEqual(s('echo x > $((1+1)).txt'), ['$((1+1))']);
  assert.deepEqual(s('cd /a; S=$PWD; echo x > $S/f'), ['/a/f']);
});

// The owner's rule (2026-11-13): no refusal for a write outside every repository. $TMPDIR is the hook's own, a mktemp
// folder is new and outside them, but a loop variable under a scratch folder that holds a worktree is still asked.
test('hook --gate from outside: $TMPDIR and mktemp writes are quiet; a loop write into a scratch folder with a worktree is asked', () => {
  n++;
  const outside = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-outside-'));
  const fresh = () => mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-'));
  assert.equal(hook(outside, fresh(), 'echo x > "$TMPDIR/out.txt"'), null);
  assert.equal(hook(outside, fresh(), 'D=$(mktemp -d) && echo x > $D/f.txt'), null);
  assert.equal(hook(outside, fresh(), 'cd "$(mktemp -d)" && echo x > f.txt'), null);
  // A scratch folder with a checkout in it (a worktree is a folder with a .git file).
  const scratch = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-scratch-'));
  mkdirSync(join(scratch, 'w-main'));
  writeFileSync(join(scratch, 'w-main/.git'), 'gitdir: /elsewhere\n');
  const asked = hook(outside, fresh(), `S=${scratch}; for rev in $REVS; do cp t.js $S/w-$rev/test/; done`);
  assert.equal(asked.permissionDecision, 'deny');
  assert.match(asked.permissionDecisionReason, /\$rev: rev is a loop variable; could be in [^)]*w-main/u);
  // A literal list is followed: w-a and w-b are not checkouts, so the writes are outside every repository.
  assert.equal(hook(outside, fresh(), `S=${scratch}; for rev in a b; do cp t.js $S/w-$rev/test/; done`), null);
  // An empty scratch folder where the command itself makes the worktree: asked too, with the list known or not.
  const empty = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-scratch-'));
  for (const list of ['$REVS', 'a b']) {
    const made = hook(outside, fresh(), `S=${empty}; for rev in ${list}; do git worktree add $S/w-$rev $rev; cp t.js $S/w-$rev/test/; done`);
    assert.equal(made?.permissionDecision, 'deny', list);
  }
  // The same loop into an empty scratch folder that makes no checkout: outside every repository, quiet.
  assert.equal(hook(outside, fresh(), `S=${empty}; for rev in $REVS; do cp t.js $S/out-$rev.txt; done`), null);
  // A file whose name alone is not known lands in the scratch folder itself, not in the worktree below it: quiet.
  assert.equal(hook(outside, fresh(), `for k in 1 2; do npm test > ${scratch}/run$k.txt; done`), null);
});

// Second review (2026-11-13): a value holds inside the block that sets it and is not known after a block or an && / ||
// list that may not have run; a literal loop list is followed; `"a$"` keeps its $.
test('blocks, && lists, loops, cd -, pushd and popd: a value is known exactly where it surely holds', () => {
  const s = (c) => { const r = shellWrites(c, '/r'); return [...r.files, ...r.unknown.map((u) => u.part)]; };
  // A $ before the closing quote is a plain $; $'...' and $"..." only open outside quotes.
  assert.deepEqual(s('echo x > "a$"'), ['/r/a$']);
  assert.deepEqual(s('echo x > "$"'), ['/r/$']);
  assert.deepEqual(s('echo x > "$\'b\'"'), ["/r/$'b'"]);
  // Inside an if or a loop, a value or a cd holds for what follows it there; after the block it is not known.
  assert.deepEqual(s('if true; then S=/a; echo x > $S/f; fi'), ['/a/f']);
  assert.deepEqual(s('for i in 1; do cd /a && sed -i s/a/b/ f.js; done'), ['/a/f.js']);
  assert.deepEqual(s('if true; then S=/a; fi; echo x > $S/f'), ['$S']);
  assert.deepEqual(s('S=/z; if x; then S=/a; else echo x > $S/f; fi'), ['/z/f'], 'else starts from before the if');
  assert.deepEqual(s('S=/z; if x; then S=/a; else S=/a; fi; echo x > $S/f'), ['$S'], 'a branch changed it');
  assert.deepEqual(s('S=/z; if x; then echo; fi; echo x > $S/f'), ['/z/f'], 'a block that changes nothing');
  assert.deepEqual(s('case $x in a) S=/a;; b) echo x > $S/f;; esac'), ['$S'], 'case arms are alternatives');
  // A ( after do, then or else opens a subshell: its cd runs, and ends at its ).
  assert.deepEqual(s('for i in 1; do (cd h && node x > ../s.txt) & wait; done; echo > g'), ['/r/s.txt', '/r/g']);
  // In a loop each turn starts where the last ended: a relative cd and a value built from itself are not known.
  assert.deepEqual(s('for i in 1 2; do cd sub; echo x > f; done'), ['cd sub']);
  assert.deepEqual(s('for i in 1 2; do S=$S/x; echo > $S/f; done'), ['$S']);
  // A command after && or || may not run: what it changed is not known once the list ends; inside it, it is.
  assert.deepEqual(s('[ -n "$X" ] && S=/a; echo x > $S/f'), ['$S']);
  assert.deepEqual(s('test -d /a && cd /a; echo x > f'), ['cd /a']);
  assert.deepEqual(s('test -d /a && cd /a && echo x > f'), ['/a/f']);
  assert.deepEqual(s('cd /a && echo x > f; echo y > g'), ['/a/f', '/a/g'], 'the first command of a list always runs');
  // The ; of a block's own syntax does not end the list around it, and a here-document's walk does not end it either.
  assert.deepEqual(s('S=/s && for r in a b; do echo > $S/w-$r/f; done'), ['/s/w-a/f', '/s/w-b/f']);
  assert.deepEqual(s("S=/s && cd $S && python3 - <<'EOF'\nopen('o.txt', 'w')\nEOF"), ['/s/o.txt']);
  // A checkout made at a folder not known in full is somewhere below the known part; a file beside it is not in it.
  assert.deepEqual(s('S=/s; git worktree add $S/w-$R x; echo > $S/out.txt'), ['/s/out.txt']);
  // export -n takes the mark off: bash -c does not see it.
  assert.deepEqual(s('S=/a; export S; export -n S; bash -c "echo x > \\$S/f"'), ['$S']);
  // cd - goes back to $OLDPWD; popd to the folder pushd left.
  assert.deepEqual(s('cd /a; cd /b; cd -; echo x > f'), ['/a/f']);
  assert.deepEqual(s('pushd /a; pushd /b; popd; echo x > f'), ['/a/f']);
  // A loop over a literal list writes once per value; a list the shell expands is not known.
  assert.deepEqual(s('for r in a b; do echo x > /t/zz-$r/f.txt; done'), ['/t/zz-a/f.txt', '/t/zz-b/f.txt']);
  assert.deepEqual(s('for r in a "b c"; do for k in 1 2; do echo > /t/$r-$k; done; done'), ['/t/a-1', '/t/a-2', '/t/b c-1', '/t/b c-2']);
  assert.deepEqual(s('for r in a b; do echo; done; echo > /t/$r'), ['$r'], 'after the loop');
  // A file in a checkout the command makes is not there yet: listed in that checkout.
  assert.deepEqual(shellWrites('git worktree add /s/w main && cp t.js /s/w/test/', '/r').unknown.map((u) => [u.word, u.prefix]), [['/s/w/test/', '/s/w/']]);
  // within: a part not known inside one folder name.
  assert.deepEqual(shellWrites('echo x > /t/zz-$R/f.txt', '/r').unknown.map((u) => u.within), [{ dir: '/t/', pre: 'zz-', post: '' }]);
  assert.deepEqual(shellWrites('echo x > /t/$A/$B/f.txt', '/r').unknown.map((u) => u.within), [undefined], 'more than one folder name');
});

// The hook from a folder outside every repository, with many repositories next to where a write goes (2026-11-13:
// `/tmp/zz-$r/f.txt` walked all of /tmp, 12 s, and the refusal named hundreds of repositories).
test('hook --gate: a part not known inside one folder name looks only at folders of that shape, fast, and names few', () => {
  n++;
  const outside = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-outside-'));
  const many = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-many-'));
  for (let k = 0; k < 300; k++) mkdirSync(join(many, `r${k}`, '.git'), { recursive: true });
  const fresh = () => mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-'));
  const timed = (command) => { const t = Date.now(); const out = hook(outside, fresh(), command); return { out, ms: Date.now() - t }; };
  for (const c of [`echo x > ${many}/zz-$R/f.txt`, `for r in a b; do echo x > ${many}/zz-$r/f.txt; done`]) {
    const { out, ms } = timed(c);
    assert.equal(out, null, c);
    assert.ok(ms < 1000, `${c}: ${ms} ms`);
  }
  // A folder of that shape that is a repository: asked, and only it is named.
  mkdirSync(join(many, 'zz-a', '.git'), { recursive: true });
  const one = timed(`echo x > ${many}/zz-$R/f.txt`).out;
  assert.equal(one?.permissionDecision, 'deny');
  assert.match(one.permissionDecisionReason, new RegExp(`could be in ${join(many, 'zz-a').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\)`, 'u'));
  // A whole folder name not known: every repository below could be it; five are named and the rest counted.
  const all = timed(`echo x > ${many}/$X/f.txt`);
  assert.equal(all.out?.permissionDecision, 'deny');
  assert.match(all.out.permissionDecisionReason, new RegExp(`and 296 more below ${many.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/`, 'u'));
  assert.ok(all.out.permissionDecisionReason.length < 1500, `${all.out.permissionDecisionReason.length} characters`);
});

// Review of 2026-11-13: a write known only to be under `/` was dropped (the walk read '' for /), and $OLDPWD took the
// hook's own value, not the folder the shell was in.
test('hook --gate: a write under / with the rest not known is asked; $OLDPWD before any cd is not the hook\'s', () => {
  n++;
  const outside = mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-outside-'));
  const fresh = () => mkdtempSync(join(tmpdir(), 'readfirst-bash-vars-state-'));
  for (const c of ['cd /$D && echo x > f', 'echo x > /$A/$B/f']) assert.equal(hook(outside, fresh(), c)?.permissionDecision, 'deny', c);
  const old = process.env.OLDPWD;
  process.env.OLDPWD = outside;
  try {
    const out = hook(outside, fresh(), 'echo x > $OLDPWD/f.txt');
    assert.equal(out?.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /\$OLDPWD/u);
  } finally {
    if (old === undefined) delete process.env.OLDPWD; else process.env.OLDPWD = old;
  }
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
