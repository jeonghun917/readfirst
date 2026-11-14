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
import { bashReads, shellWrites } from '../src/bash-writes.mjs';

const writes = (c) => shellWrites(c, '/r').files;
const unknown = (c) => shellWrites(c, '/r').unknown.map((u) => u.part);

test('a ; | or && inside a $( ) does not split the command around it', () => {
  assert.deepEqual(writes('(echo $(cd /a; pwd) > f)'), ['/r/f'], 'the subshell writes f, where it runs');
  assert.deepEqual(writes('cp $(cat list; echo x) dest'), ['/r/dest'], 'cp still has its destination');
  assert.deepEqual(writes('echo "x -> $(ls | tr a b)"'), [], 'the -> is inside quotes: no redirect');
  assert.deepEqual(unknown('echo "x -> $(ls | tr a b)"'), [], 'and nothing not known');
  assert.deepEqual(unknown('S=$(echo b | tr b c); echo x > $S/f'), ['$(echo b | tr b c)'], 'shown whole');
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
];
// Not run against bash: `>((1>0))` runs (1>0), which makes 0, after bash returns, so 0 was there in 11 of 40 runs.
test('a >( ) holding a subshell: its write is named, not `((1`', () => {
  assert.deepEqual(writes('>((1>0))'), ['/r/0']);
});
test('against bash: the files each command makes are the files readfirst names', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 && 'bash is not installed here, so the commands cannot be run' }, () => {
  for (const c of AGAINST_BASH) {
    const dir = mkdtempSync(join(tmpdir(), 'readfirst-brackets-'));
    mkdirSync(join(dir, 'd'));
    spawnSync('bash', ['-c', c], { cwd: dir, stdio: 'ignore', timeout: 5000, env: {} });
    const made = [...readdirSync(dir).filter((x) => x !== 'd'), ...readdirSync(join(dir, 'd')).map((x) => `d/${x}`)].sort();
    assert.deepEqual(shellWrites(c, dir).files.map((f) => f.slice(dir.length + 1)).sort(), made, c);
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
