// The shell reader against bash, on scripts made at random from pieces that trip it (2026-11-14). Each script is run by
// bash in an empty folder of its own under a temporary root, with an empty environment and a time limit, and the files
// it makes are compared with the files shellWrites names:
// - missed: bash made a file, readfirst did not name it and gave no unknown (the hook would say nothing);
// - fake: readfirst named a file bash did not make, in a script bash can parse (`bash -n`).
// The commands of both lists are pinned in test/bash-fuzz-baseline.json. A command that is new on either list fails the
// test; one that is no longer on it fails too, with the line to take out of the baseline, so the baseline only shrinks.
// Scripts where the two differ for a reason only running them shows are kept apart, under "runtime", with the reason.
// The pieces, the random numbers (mulberry32) and the way a script is made from them are copied unchanged from the
// reviewer's generator (fz187d.mjs, sha256 b1947397b684e020fc5395e5db02bf2458a56c26b2e847df46bd165c69da64db).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shellWrites } from '../src/bash-writes.mjs';

const SCRIPTS = 3000; // about 13 s on the machine that set it; the scripts are the first 3,000 of seed 187
const BASELINE = new URL('./bash-fuzz-baseline.json', import.meta.url);
const hasBash = spawnSync('bash', ['-c', 'true'], { env: {} }).status === 0;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('fuzz against bash: missed and fake writes are only those in the baseline', { skip: !hasBash && 'bash is not installed here, so the scripts cannot be run' }, () => {
let seed=+process.argv[3]||187; const rnd=()=>{seed=(seed+0x6D2B79F5)>>>0;let t=seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296};
const T=['(( n ))','[[ x ]]','$((echo 1)','$((cd d)','(echo 1)',' > f2','; ','$(( 1 ))','))','echo','echo x','$((','$[','((','))','(',')',']',' ','>','>f1','> f2','>f3',';','1','x','cd d','&&','||','$(','`','"',"'",'| cat','\n','{ ',' }','if ','then ','fi','2>&1','<<<x','$((1>0))','$[1>0]','(echo 1)','((1>0))'];
  seed = 187; // the generator reads a seed from its command line; the test always uses 187
  const root = mkdtempSync(join(tmpdir(), 'readfirst-fuzz-'));
  const seenC = new Set();
  const missed = [];
  const fake = [];
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  // "racy": scripts whose own result in bash changes from run to run, each with why. Not compared. (`>((1>0))` was
  // here, its 0 there in 11 of 40 runs when the folder was read at once: a <( ) or >( )'s files are now waited for.)
  const racy = new Set(base.racy.map((r) => r.command));
  // A >( ) may still be writing when its folder is removed: removing it is tried again, and never fails the test
  // (it once stopped a run with ENOTEMPTY, 2026-11-14).
  const clean = (d) => { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the root is removed at the end */ } };
  try {
    for (let it = 0; it < SCRIPTS; it++) {
 let c=''; const k=2+Math.floor(rnd()*9); for(let i=0;i<k;i++)c+=T[Math.floor(rnd()*T.length)];
      if (seenC.has(c)) continue;
      seenC.add(c);
      if (racy.has(c)) continue;
      const dir = join(root, `w${it}`);
      mkdirSync(join(dir, 'd'), { recursive: true });
      const run = spawnSync('bash', ['-c', c], { cwd: dir, stdio: 'ignore', timeout: 5000, env: {} });
      if (run.error || run.signal) { clean(dir); continue; } // timed out: not compared
      const w = shellWrites(c, dir);
      const named = w.files.map((f) => f.slice(dir.length + 1));
      const list = () => [...readdirSync(dir).filter((x) => x !== 'd'), ...readdirSync(join(dir, 'd')).map((x) => `d/${x}`)];
      let made = list();
      // A <( ) or >( ) runs beside bash and may write after bash returns: a file named that is not there yet is waited
      // for, up to a second (`>((1>0))> f2` made its 0 within 10 ms alone, and once not before the folder was read
      // under npm test's load, so the test failed with no change to the reader, 2026-11-14).
      for (let t = 0; t < 100 && /[<>]\(/u.test(c) && named.some((x) => x !== 'd' && !made.includes(x)); t++) { pause(10); made = list(); }
      if (!w.unknown.length && made.some((x) => !named.includes(x))) missed.push(c);
      if (named.some((x) => x !== 'd' && !made.includes(x)) && spawnSync('bash', ['-n', '-c', c], { stdio: 'ignore', env: {} }).status === 0) fake.push(c);
      clean(dir);
    }
  } finally {
    clean(root);
  }
  const problems = [];
  for (const c of racy) if (!seenC.has(c)) problems.push(`no longer made by the generator: take ${JSON.stringify(c)} out of "racy" in test/bash-fuzz-baseline.json`);
  for (const [name, now] of [['missed', missed], ['fake', fake]]) {
    // "runtime": scripts where bash and readfirst differ for a reason only running them shows (an && or || that goes
    // by the exit status before it, arithmetic that fails when it runs), each with that reason. Not counted as the
    // reader's bugs, and pinned the same way.
    const runtime = new Set(base.runtime.filter((r) => r.list === name).map((r) => r.command));
    const was = new Set(base[name]);
    const is = new Set(now);
    for (const c of now) if (!was.has(c) && !runtime.has(c)) problems.push(`new ${name} write, not in the baseline: ${JSON.stringify(c)}`);
    for (const c of base[name]) if (!is.has(c)) problems.push(`no longer ${name}: take ${JSON.stringify(c)} out of "${name}" in test/bash-fuzz-baseline.json`);
    for (const c of runtime) if (!is.has(c)) problems.push(`no longer ${name}: take ${JSON.stringify(c)} out of "runtime" in test/bash-fuzz-baseline.json`);
  }
  assert.deepEqual(problems, []);
});
