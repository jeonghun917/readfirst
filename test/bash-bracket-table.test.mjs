// One table of brackets for the shell reader (2026-11-14). Each reader of src/bash-writes.mjs found the brackets its own
// way: the command was split at a ; | or && inside a $( ), so its writes were lost or read as the outer command's; a
// regex went one ( deep; closeOf called itself once per level and ran out of stack; blank and arithEnd scanned again
// from each opener, so unclosed chains took time by their square; and <( ) / >( ) were read as redirects to files named
// `(cat`. Now one pass makes the table, every reader asks it, and the commands inside each substitution are read as a
// subshell of their own (lift), one after another, never by a call per level.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { bashReads, commandWords, shellWrites } from '../src/bash-writes.mjs';

const writes = (c) => shellWrites(c, '/r').files;
// A wait in place, as in test/bash-fuzz.test.mjs (one line, not imported: importing a test file runs its tests).
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const unknown = (c) => shellWrites(c, '/r').unknown.map((u) => u.part);

test('a ; | or && inside a $( ) does not split the command around it', () => {
  assert.deepEqual(writes('(echo $(cd /a; pwd) > f)'), ['/r/f'], 'the subshell writes f, where it runs');
  assert.deepEqual(writes('cp $(cat list; echo x) dest'), ['/r/dest'], 'cp still has its destination');
  assert.deepEqual(writes('echo "x -> $(ls | tr a b)"'), [], 'the -> is inside quotes: no redirect');
  assert.deepEqual(unknown('echo "x -> $(ls | tr a b)"'), [], 'and nothing not known');
  assert.deepEqual(unknown('S=$(echo b | tr b c); echo x > $S/f'), ['$(echo b | tr b c)'], 'shown whole');
  // A $( ) in "..." that holds a ( ): it closed at the first ) and its write was lost (closeOf-subst-first-paren).
  assert.deepEqual(writes('echo "$((echo 1) > b)"'), ['/r/b']);
  assert.deepEqual(writes('echo "$( (echo 1) > b)"'), ['/r/b']);
});

test('the commands inside a substitution are read, as a subshell where it stands', () => {
  assert.deepEqual(writes('echo $(cd /a; echo x > g)'), ['/a/g'], 'its cd moves its own writes');
  assert.deepEqual(writes('x=$(cd /a); echo > f'), ['/r/f'], 'and not the command around it');
  assert.deepEqual(writes('cd /b; y=$(echo > f)'), ['/b/f'], 'it starts where the command around it is');
  assert.deepEqual(writes('y="$(sort a > b.txt)"'), ['/r/b.txt'], 'inside quotes too');
  assert.deepEqual(writes('echo `cd /a; echo > q`'), ['/a/q'], 'backticks too');
  assert.deepEqual(writes('x=$(( $(cd /a; echo 1 > h) ))'), ['/a/h'], 'inside arithmetic too');
  assert.deepEqual(writes('echo $(echo $(cd /a; echo > deep))'), ['/a/deep'], 'nested');
  assert.deepEqual(unknown('S=$(mktemp -d); echo > $S/f'), ['$(mktemp -d)'], 'mktemp is still seen in its body');
  assert.deepEqual(bashReads('x=$(npx readfirst read g.js); npx readfirst read f.js', '/r').map((r) => r.files), [['/r/f.js']], 'a read inside $( ) is not seen');
});

test('<( ) and >( ) are process substitutions, not redirects', () => {
  assert.deepEqual(writes('>(echo 1)'), []);
  assert.deepEqual(writes('tee >(cat) > o'), ['/r/o'], 'it was a write to `(cat` and o');
  assert.deepEqual(writes('diff <(sort a) <(sort b) > d'), ['/r/d']);
  assert.deepEqual(writes('cat <(cd /a; echo > f)'), ['/a/f'], 'its commands are read as a subshell');
});

// Review of #199 (2026-11-14): a <( ) or >( ) was put back as `/dev/fd/` and its body, so a word the hook names, and a
// command's words, were not what the command said.
test('a <( ) or >( ) is put back as it was written', () => {
  assert.deepEqual(commandWords('diff <(sort a) <(sort b); tee >(cat > f) < in', '/r').map((c) => c.words.map((w) => w.text)), [['diff', '<(sort a)', '<(sort b)'], ['tee', '>(cat > f)']]);
});

// A (( or $(( that is a ( holding a subshell (bash: its inner ) is not followed at once by another )) is decided where
// it opens: what stands in its first ( ) was read as arithmetic until then, so a <( ), >( ) or (( )) there had no place
// in the table. And a (( at the start of a command, split at the ; inside it, was taken for an arithmetic command
// (`((echo`), so its write and cd were lost; `( (cd d; ...) )` and `{ (cd d; ...); }` lost the cd too.
test('the first ( ) of a (( that holds a subshell is read as commands', () => {
  assert.deepEqual(writes('((<(echo b > g); cd d) )'), ['/r/g'], 'it named nothing');
  assert.deepEqual(writes('((cd d; >(cat > h)) )'), ['/r/d/h'], 'it named a file `(cat`, and h where the cd was not');
  assert.deepEqual(writes('((echo > e; echo hi) )'), ['/r/e']);
  assert.deepEqual(writes('((cd d; echo > h) )'), ['/r/d/h']);
  assert.deepEqual(writes('( (cd d; echo > h) )'), ['/r/d/h']);
  assert.deepEqual(writes('{ (cd d; echo > h); }'), ['/r/d/h']);
  assert.deepEqual(writes('echo $((cat <(cd d; echo b >f)) | cat)'), ['/r/d/f']);
});

// Where the reader reads a substitution's body (review of #199: each place a $( ) can stand), all passed already.
test('a substitution is read wherever it stands in a command', () => {
  for (const c of ['case $(echo x >f) in x) ;; esac', 'case x in $(echo >f)) echo;; esac', 'for i in $(echo > f); do :; done', 'select i in $(echo > f); do break; done',
    '[[ $(echo > f) ]]', 'if $(echo > f); then :; fi', 'while $(echo > f; false); do :; done', 'until $(echo > f); do :; done', 'time $(echo > f)', '! $(echo > f)',
    'g() { echo $(echo > f); }; g', 'cat <<E $(echo > f)\nhi\nE']) {
    assert.deepEqual(writes(c), ['/r/f'], c);
  }
});

test('arithmetic nests, and a $( ) that never closes is not run', () => {
  assert.deepEqual(writes('echo $(( (1+2)*3 )) > n'), ['/r/n']);
  assert.deepEqual(writes('x=$(echo > f'), [], 'bash: unexpected EOF while looking for matching `)`, nothing runs');
  assert.deepEqual(writes('echo "never closed > x.txt'), ['/r/x.txt'], 'a quote that never closes is a plain character, as before');
});

test('thousands deep, closed or not, nothing runs out of stack', () => {
  const n = 8000;
  assert.deepEqual(writes(`x=${'$(echo '.repeat(n)}a${')'.repeat(n)} > f`), ['/r/f']);
  assert.deepEqual(writes(`x=${'"$('.repeat(n)}echo a${')"'.repeat(n)}; echo > g`), ['/r/g']);
  assert.deepEqual(writes(`${'('.repeat(n)}cd a${')'.repeat(n)}; echo > h`), ['/r/h']);
  assert.deepEqual(writes(`x=${'$(echo '.repeat(n)}$(cd /a; echo > deep)${')'.repeat(n)}`), ['/a/deep'], 'the deepest body is read');
  for (const c of [`echo "${'$( '.repeat(n)} > f`, `echo ${'$( $((1 '.repeat(n)}`, `echo ${'$((1 '.repeat(n)}`, `echo ${'$[1 '.repeat(n)}`, `echo ${'`'.repeat(n)}`]) {
    assert.doesNotThrow(() => shellWrites(c, '/r'));
  }
});

// Each command bash can run on its own, in an empty folder holding a folder d: the files it makes are the files
// readfirst names.
const AGAINST_BASH = [
  '(echo $(cd d; pwd) > f)', 'echo $(cd d; echo x > g)', 'x=$(cd d); echo > f3', 'cd d; y=$(echo > f4)', 'echo `cd d; echo > q`',
  'x=$(( $(cd d; echo 1 > h) ))', 'echo $(echo $(cd d; echo > deep))', 'y="$(echo a > b.txt)"', 'echo "x -> $(ls | tr a b)"',
  '>(echo 1)', 'tee >(cat) > o', 'cat <(cd d; echo > f2) > /dev/null', 'echo $(( (1+2)*3 )) > n', 'x=$(echo > f',
  'echo "$((echo 1) > b)"', 'echo "$( (echo 1) > b)"',
  '((<(echo b > g); cd d) )', '((echo > e; echo hi) )', '((cd d; echo > h) )', '( (cd d; echo > i) )', '{ (cd d; echo > j); }', 'echo $((cat <(cd d; echo b >k)) | cat)',
  'case $(echo x >f5) in x) ;; esac', 'case x in $(echo >f6)) echo;; esac', 'for i in $(echo > f7); do :; done', '[[ $(echo > f8) ]]', 'if $(echo > f9); then :; fi',
  'while $(echo > f10; false); do :; done', 'time $(echo > f11)', '! $(echo > f12)', 'g() { echo $(echo > f13); }; g', 'cat <<E $(echo > f14)\nhi\nE',
];
// lift marks where it took a substitution out with a character and the body's number. The mark was \x01, and a command
// can hold any character: \x01 and a number in a redirect, a cd or a value was read as a body, and shellWrites threw
// when there was none (`echo hi > \x010`: "Cannot read properties of undefined", review of #206, 2026-11-14), or read
// the body that had that number. The mark is now one the command does not hold. Each command runs in an empty folder
// holding d and \x011.
test('\\x01 and a number in a command are text, not a body lift took out, and bash agrees', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 && 'bash is not installed here, so the commands cannot be run' }, () => {
  for (const c of ['echo hi > \x010', 'cd \x011; echo > e', 'S=\x011; echo > $S/h', 'echo > \x0199999', 'echo $(echo a) > \x010', 'cat <(echo > f1) > \x012',
    'echo hi > 0', 'echo $(echo > 1) > 0']) {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-place-'));
    mkdirSync(join(dir, 'd'));
    mkdirSync(join(dir, '\x011'));
    spawnSync('bash', ['-c', c], { cwd: dir, stdio: 'ignore', timeout: 5000, env: {} });
    const named = shellWrites(c, dir).files.map((f) => f.slice(dir.length + 1)).sort();
    const list = () => readdirSync(dir).flatMap((x) => (['d', '\x011'].includes(x) ? readdirSync(join(dir, x)).map((y) => `${x}/${y}`) : [x])).sort();
    let made = list();
    for (let t = 0; t < 100 && /[<>]\(/u.test(c) && named.some((x) => !made.includes(x)); t++) { pause(10); made = list(); }
    assert.deepEqual(named, made, JSON.stringify(c));
  }
  assert.deepEqual(commandWords('readfirst answer \x010 $(echo a)', '/r').map((x) => x.words.map((w) => w.text)), [['readfirst', 'answer', '\x010', '\0$(echo a)\0']]);
  assert.deepEqual(bashReads('npx readfirst read \x010', '/r').map((r) => r.files), [['/r/\x010']]);
});

// A command that holds every private-use character leaves no mark free: nothing is read, and shellWrites says why
// rather than naming nothing as if nothing were written. The next command is read as before.
test('a command holding every private-use character is not read, and says so', () => {
  const all = Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, i) => String.fromCharCode(0xe000 + i)).join('');
  const r = shellWrites(`echo ${all}; echo $(cd /a) > f`, '/r');
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.unknown.map((u) => [u.part, u.prefix]), [['the command', '']]);
  assert.match(r.unknown[0].why, /private-use/u);
  assert.deepEqual(bashReads(`echo ${all}; npx readfirst read a.js`, '/r'), []);
  assert.deepEqual(commandWords(`echo ${all}`, '/r'), []);
  assert.deepEqual(writes('echo $(cd /a) > f'), ['/r/f']);
});

// Not run against bash: `>((1>0))` runs (1>0), which makes 0, after bash returns, so 0 was there in 11 of 40 runs.
test('a >( ) holding a subshell: its write is named, not `((1`', () => {
  assert.deepEqual(writes('>((1>0))'), ['/r/0']);
});
test('against bash: the files each command makes are the files readfirst names', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 && 'bash is not installed here, so the commands cannot be run' }, () => {
  for (const c of AGAINST_BASH) {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-brackets-'));
    mkdirSync(join(dir, 'd'));
    spawnSync('bash', ['-c', c], { cwd: dir, stdio: 'ignore', timeout: 5000, env: {} });
    const named = shellWrites(c, dir).files.map((f) => f.slice(dir.length + 1)).sort();
    const list = () => [...readdirSync(dir).filter((x) => x !== 'd'), ...readdirSync(join(dir, 'd')).map((x) => `d/${x}`)].sort();
    // A <( ) or >( ) runs beside bash and may write after it returns (`((cd d; >(cat > h)) )` did in 30 of 300 runs
    // under load, review of #199): a file named that is not there yet is waited for, up to a second, as in the fuzz test.
    let made = list();
    for (let t = 0; t < 100 && /[<>]\(/u.test(c) && named.some((x) => !made.includes(x)); t++) { pause(10); made = list(); }
    assert.deepEqual(named, made, c);
  }
});

// Time that grows with the text, not with its square (bash-quadratic-unclosed-chain, reader-slow-not-throw): the slope
// of the time's logarithm against the size's, at 2,000, 8,000 and 32,000 repeats of each shape, must be under 1.5. On
// main before this change these measured about 1.9 (`$( $((1 ` took 54 s at 32,000; `"$(` nested ran out of stack),
// and here about 1. A read is repeated until 20ms of CPU time pass and the fastest of three runs is taken; the sizes
// are measured up to three times, and one slope under 1.5 passes. It runs in a worker stopped after 60 seconds, as in
// test/code.test.mjs: a test's timeout does not stop synchronous code.
const SHAPES = {
  'unclosed $( $((1': "(n) => 'echo ' + '$( $((1 '.repeat(n)",
  'unclosed $((1': "(n) => 'echo ' + '$((1 '.repeat(n)",
  'unclosed "$(': "(n) => 'echo \"' + '$( '.repeat(n) + ' > f'",
  'nested $(echo': "(n) => 'x=' + '$(echo '.repeat(n) + 'a' + ')'.repeat(n) + ' > f'",
  'nested "$(': "(n) => 'x=' + '\"$('.repeat(n) + 'echo a' + ')\"'.repeat(n) + '; echo > g'",
  // A ' that never closes, then openers (review of #199): the table held none of them, and each reader's ask past it
  // scanned the rest again (13 s at 4,000 before).
  "unclosed ' then $((": "(n) => \"echo 'x \" + '$((1)) '.repeat(n)",
  "unclosed ' then quotes": "(n) => \"echo 'x \" + '\"a\" '.repeat(n)",
  'unclosed (( then ((': "(n) => 'echo ' + '(( '.repeat(n)",
  // Lines: eachCommand took each from the front of its list with shift(), which moves the rest each time (32,000
  // comment lines took 0.5 to 0.9 s a reader, 2026-11-14).
  'comment lines ending in a backslash': "(n) => '# c \\\\\\n'.repeat(n) + 'echo > f'",
  'command lines': "(n) => 'echo a\\n'.repeat(n)",
  // The text before each here-document was walked again for it (13 s at 4,000), and then the words before each one in
  // its command or its line were read again for it (review of #206).
  'here-documents': "(n) => 'cat <<E\\nhello\\nE\\n'.repeat(n)",
  'here-documents in one $( )': "(n) => 'x=$(' + 'cat <<E\\nhello\\nE\\n'.repeat(n) + ')'",
  'here-documents on one line': "(n) => 'cat ' + Array.from({ length: n }, (_, i) => '<<E' + i).join(' ') + '\\n' + Array.from({ length: n }, (_, i) => 'b\\nE' + i + '\\n').join('')",
  // Each one inside the $( ) of the one before: the bodies are read from one stack, 32,000 deep, no call per level.
  'here-documents nested in $( )': "(n) => 'x=' + '$(cat <<E\\n'.repeat(n) + 'a\\n' + 'E\\n)'.repeat(n)",
};
const SIZES = [2000, 8000, 32000];
const TIMED = `const { parentPort } = require('node:worker_threads');
(async () => {
  const { shellWrites } = await import(${JSON.stringify(new URL('../src/bash-writes.mjs', import.meta.url).href)});
  const shapes = { ${Object.entries(SHAPES).map(([name, make]) => `${JSON.stringify(name)}: ${make}`).join(',\n')} };
  const sizes = ${JSON.stringify(SIZES)};
  for (const [name, make] of Object.entries(shapes)) {
    const time = (n) => {
      const text = make(n);
      shellWrites(text, '/r');
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t = process.cpuUsage();
        let calls = 0, us = 0;
        do { shellWrites(text, '/r'); calls++; const u = process.cpuUsage(t); us = u.user + u.system; } while (us < 20_000);
        best = Math.min(best, us / 1e3 / calls);
      }
      parentPort.postMessage({ name, n, ms: best });
      return best;
    };
    const slopeOf = (ms) => {
      const x = sizes.map(Math.log), y = ms.map(Math.log);
      const mx = x.reduce((a, b) => a + b) / x.length, my = y.reduce((a, b) => a + b) / y.length;
      return x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0) / x.reduce((s, xi) => s + (xi - mx) ** 2, 0);
    };
    const tries = [];
    for (let k = 0; k < 3 && !tries.some((t) => t.slope < 1.5); k++) { const ms = sizes.map((n) => time(n)); tries.push({ ms, slope: slopeOf(ms) }); }
    parentPort.postMessage({ name, tries });
  }
  parentPort.postMessage(null);
})();`;

// A count of steps, which no load on the machine changes (2026-11-14): eachCommand took each command off the front of
// its list with shift(), which moves the rest of the list each time, so a command of n lines cost about n*n/2 moves
// (at 32,000 lines 0.5 to 0.9 s a reader; the slope test below sits near its limit there). Each element shift() moves is
// counted while the three readers read 4,000 lines: they now read by an index.
test('the commands of a long text are taken one after another, not moved along the list', () => {
  const n = 4000;
  const text = 'echo a\n'.repeat(n);
  const shift = Array.prototype.shift;
  let moved = 0;
  Array.prototype.shift = function counted() { moved += Math.max(0, this.length - 1); return shift.call(this); };
  try {
    shellWrites(text, '/r');
    commandWords(text, '/r');
    bashReads(text, '/r');
  } finally {
    Array.prototype.shift = shift;
  }
  assert.ok(moved < 10 * n, `shift() moved ${moved} elements for ${n} lines (about ${n * n * 1.5} when each command is taken off the front)`);
});

// The state at each here-document (2026-11-14, readfirst review): shellWrites walked all the text before each one again
// (stateAt), so n here-documents cost about n*n/2 commands walked: 4,000 `cat <<E` took 13 s, near the hook's 15.
// eachCommand lists the commands of a text once per walk (segmentsAndOps, then flatMap): the lengths of those lists are
// counted while shellWrites reads 2,000 here-documents. One walk reads each command a few times, not once per document.
test('the state at each here-document comes from one walk, not one per document', () => {
  const n = 2000;
  const text = 'cat <<E\nhello\nE\n'.repeat(n);
  const flatMap = Array.prototype.flatMap;
  let listed = 0;
  Array.prototype.flatMap = function counted(...a) { listed += this.length; return flatMap.apply(this, a); };
  try {
    shellWrites(text, '/r');
  } finally {
    Array.prototype.flatMap = flatMap;
  }
  assert.ok(listed < 10 * n, `${listed} commands listed for ${n} here-documents (about ${n * n} when the text before each is walked again)`);
});

// Then each here-document read the words before it again from the start of its command, or of its line inside a $( )
// (review of #206): n of them on one line or in one $( ) still took time by the square (2,000 on one line: 642 ms, main
// 95). The characters every slice() gives are counted while shellWrites reads each shape: one read takes a few per
// character of the text. Each here-document reading its command again gives hundreds (main gives 360 to 4,100 at 1,000
// and 2,000, as each document's text before it was cut out and walked).
test('the words before each here-document are read once for its command, on one line or in one $( )', () => {
  const n = 2000;
  const docs = 'cat <<E\nhello\nE\n'.repeat(n);
  const shapes = {
    'one per line': docs,
    'in one $( )': `x=$(${docs})`,
    'on one line': `cat ${Array.from({ length: n }, (_, i) => `<<E${i}`).join(' ')}\n${Array.from({ length: n }, (_, i) => `b\nE${i}\n`).join('')}`,
  };
  const slice = String.prototype.slice;
  for (const [name, text] of Object.entries(shapes)) {
    let chars = 0;
    String.prototype.slice = function counted(...a) { const r = slice.apply(this, a); chars += r.length; return r; };
    try {
      shellWrites(text, '/r');
    } finally {
      String.prototype.slice = slice;
    }
    assert.ok(chars < 20 * text.length, `${name}: slice() gave ${chars} characters for a text of ${text.length}`);
  }
});

// The mark where each here-document opens is a character the text does not hold (review of #206): a fixed one read a
// number the user wrote after it as a here-document, and the state of the command it stood in went to the real one.
test('a here-document mark is never a character of the command', () => {
  const named = (c) => shellWrites(c, '/r').files;
  for (let c = 0xe000; c < 0xe004; c++) {
    const ch = String.fromCharCode(c);
    assert.deepEqual(named(`echo "${ch}0"; cd s; cat <<E\n$(echo > u1)\nE`), ['/r/s/u1'], `U+${c.toString(16)} in the command`);
  }
  // Every private-use character in the text but one: lift's mark takes that one, none is left for here-documents, and
  // each is read on a walk of its own, as before. (With every one, nothing is read: the test after the bash one.)
  const allButOne = Array.from({ length: 0xf8ff - 0xe000 }, (_, i) => String.fromCharCode(0xe000 + i)).join('');
  assert.deepEqual(named(`echo "${allButOne}0"; cd s; cat <<E\n$(echo > u1)\nE`), ['/r/s/u1']);
});

test('linear time in the length of unclosed chains and of nesting', async () => {
  const done = [];
  const times = [];
  const said = () => done.map(({ name, tries }) => `${name}: ${tries.map(({ ms, slope }) => `${ms.map((m) => m.toFixed(1)).join(', ')}ms at ${SIZES.join(', ')} (slope ${slope.toFixed(2)})`).join('; ')}`).join('\n');
  const worker = new Worker(TIMED, { eval: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`not done in 60 seconds; measured: ${times.map(({ name, n, ms }) => `${name} ${ms.toFixed(1)}ms at ${n}`).join(', ')}`)), 60_000);
      worker.on('message', (m) => { if (!m) { clearTimeout(timer); resolve(); } else if (m.tries) done.push(m); else times.push(m); });
      worker.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  } finally {
    await worker.terminate();
  }
  assert.equal(done.length, Object.keys(SHAPES).length);
  assert.ok(done.every(({ tries }) => tries.some((t) => t.slope < 1.5)), said());
});
