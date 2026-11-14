// Here-documents are found once, as bash finds them (hereDocs in src/bash-writes.mjs), and every walk of the segments
// reads the text without their bodies (eachCommand). Until 2026-11-14 one regex found them, and three shapes it took
// wrong moved a cd into or out of a body: `$((1<<x))` (a shift) and `<<< EOF` (a here-string) were read as here-
// documents, so the cd after them was lost; a line that only starts with the tag (`END of the doc`, or `  END` without
// <<-) ended a body, so a cd inside it was followed and a write named in the wrong folder with certainty. And bashReads
// read a body's lines as commands: a note that quoted `readfirst read f` counted as reading f. Each shape is run
// through bash in an empty folder, and the files it makes are what shellWrites must name.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { bashReads, commandWords, shellWrites } from '../src/bash-writes.mjs';

const hasBash = spawnSync('bash', ['-c', 'true'], { env: {} }).status === 0;
// The files bash makes running the script in a new folder that holds an empty folder a, relative to it.
const bashMade = (script) => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-heredoc-'));
  mkdirSync(join(dir, 'a'));
  spawnSync('bash', ['-c', script], { cwd: dir, env: {}, stdio: 'ignore', timeout: 5000 });
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name)); else out.push(relative(dir, join(d, e.name))); } };
  walk(dir);
  return out.sort();
};
const named = (script) => { const r = shellWrites(script, '/r'); return [...r.files.map((f) => relative('/r', f)), ...r.unknown.map((u) => `?${u.part}`)].sort(); };

test('a shift, a here-string and a line that only starts with the tag are no here-documents, and bash agrees', { skip: !hasBash && 'bash is not installed' }, () => {
  for (const [script, wrong] of [
    // The regex took x for a tag: the lines up to `x --f` were a body, the cd was lost (main named g).
    ['y=$((1<<x))\ncd a\nx --f\necho > g', ['g']],
    ['((x = 1<<2)); cd a; echo > g', null],
    // <<< is a here-string: its word is the input, the next lines are commands (main named g).
    ['cat <<< EOF\ncd a\nEOF\necho > g', ['g']],
    // A body ends only at a line that is exactly the tag: main ended it at `END of the doc` and at `  END`, followed the
    // cd inside the body and named a/g, a file bash does not make.
    ['cat <<END\nbody\nEND of the doc\ncd a\nEND\necho > g', ['a/g']],
    ['cat <<END\nbody\n  END\ncd a\nEND\necho > g', ['a/g']],
    // The look-alikes that stay as they were: <<- takes tabs before the tag, an apostrophe in a body opens no quote, a
    // body's cd is data, two here-documents on one line end in turn.
    ['cat <<-END\n\tbody\n\tEND\ncd a\necho > g', null],
    ["cat > notes.md <<'EOF'\nit's a note\nEOF\ncd a\necho > g", null],
    ['cat > n.md <<EOF\ncd a\nEOF\necho > g', null],
    ['cat <<A <<B\na\nA\nb\nB\necho > g', null],
  ]) {
    const made = bashMade(script);
    assert.deepEqual(named(script), made, script);
    if (wrong) assert.notDeepEqual(wrong, made, `what main named is not what bash makes: ${script}`);
  }
});

test('a `readfirst read` in a here-document body is no read; one run as a command still is', () => {
  const reads = (c) => bashReads(c, '/r').map((r) => r.files);
  assert.deepEqual(reads('cat > notes.md <<EOF\nnpx readfirst read src/x.mjs\nEOF'), []);
  assert.deepEqual(reads("git commit -m \"$(cat <<'EOF'\nread it: npx readfirst read src/x.mjs\nEOF\n)\""), []);
  assert.deepEqual(reads('npx readfirst read src/x.mjs'), [['/r/src/x.mjs']]);
  assert.deepEqual(reads("cat <<'EOF'\nnpx readfirst read a.js\nEOF\nnpx readfirst read b.js"), [['/r/b.js']]);
  assert.deepEqual(reads('cat <<< "npx readfirst read a.js"; npx readfirst read b.js'), [['/r/b.js']]);
});

test('commandWords and the other walks see the same commands around a here-document', () => {
  const cmds = (c) => commandWords(c, '/r').map((x) => x.words.map((w) => w.text).join(' '));
  assert.deepEqual(cmds('y=$((1<<x))\nreadfirst answer k\nx --f'), ['readfirst answer k', 'x --f']);
  assert.deepEqual(cmds('cat <<END\nEND of the doc\nreadfirst answer k\nEND\necho done'), ['cat', 'echo done']);
});
