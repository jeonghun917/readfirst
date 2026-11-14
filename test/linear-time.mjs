// The time a reader takes, for the work its steps do not count (a builtin's: a slice per token was 600 times slower at
// 16 times the text, with the same steps). Used by test/code.test.mjs and test/scopes.test.mjs; not a test itself.
// The time is the process's CPU time, not the clock's: on a CPU shared with other work a short read can fit in one turn
// on the CPU while a long one always waits out the others' turns, which doubled the ratio (pinned to one CPU beside a
// busy loop, a long chain of types measured 36 times by the clock in the median, 23 by CPU time; 9 of 30 runs failed by
// the clock, none by CPU time). Each size is read once first (the first read compiles the reader), then read again and
// again until 20ms of CPU time have passed, and the time of one read is that time over the reads; the fastest of five
// such runs is taken. One read of the small size can take about 1ms, within the noise of the timer and the compiler,
// and timed once a read of a long chain of types failed on CI though its steps grow linearly. The sizes are 20,000,
// 80,000 and 320,000 characters, and the slope of the time's logarithm against the size's (least squares) is the power
// of the size the time grows with. It must be under 1.5. Quadratic work is 2 (the shapes of test/code.test.mjs
// measured 1.74 to 1.86 before their fixes), and work whose steps grow linearly measured 0.59 to 1.26. At 5,000,
// 20,000 and 80,000 a quadratic shape measured 1.39, its linear part still as large as the rest, so the smallest size
// is 20,000. A single ratio of the largest size to the smallest left little room: some linear shapes measured over 32
// times at 16 times the text, where the bound was 32. The three sizes are measured up to three times, and one slope
// under 1.5 passes (quadratic fails all three). It runs in a worker stopped after 60 seconds: a test's timeout does not
// stop synchronous code (a test busy for 8 seconds passed a 1 second timeout), and a reader that rescans a parameter
// list for each parameter was still reading after 240 seconds. CPU time is the whole process's: nothing else may run in
// this process while it is timed.
import { Worker } from 'node:worker_threads';

// The worker's code: `read(fn, text)` calls the export `name` of the module at `url` on a text; shapes are
// { name: (n) => text } whose functions are written into the worker as their source.
const timedSource = (shapes, url, name, read) => `const { parentPort } = require('node:worker_threads');
(async () => {
  const fn = (await import(${JSON.stringify(url)}))[${JSON.stringify(name)}];
  const read = ${read};
  const shapes = { ${Object.entries(shapes).map(([shape, make]) => `${JSON.stringify(shape)}: ${make}`).join(',\n')} };
  for (const [name, make] of Object.entries(shapes)) {
    const time = (n) => {
      const text = make(n);
      read(fn, text);
      let best = Infinity;
      for (let k = 0; k < 5; k++) {
        const t = process.cpuUsage();
        let calls = 0, us = 0;
        do { read(fn, text); calls++; const u = process.cpuUsage(t); us = u.user + u.system; } while (us < 20_000);
        best = Math.min(best, us / 1e3 / calls);
      }
      parentPort.postMessage({ name, n, ms: best });
      return best;
    };
    const sizes = [20_000, 80_000, 320_000];
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

// Times each shape as above: { done: [{ name, tries: [{ ms, slope }] }], said }, said being a line per shape for a
// failure's message. Rejects when the worker is not done in 60 seconds, naming the sizes measured by then.
export async function timeShapes(shapes, url, name, read) {
  const done = [];
  const times = []; // each size as it is measured, for a worker stopped before a shape is done
  const worker = new Worker(timedSource(shapes, url, name, read), { eval: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`not done in 60 seconds; measured: ${times.map(({ name: shape, n, ms }) => `${shape} ${ms.toFixed(1)}ms at ${n}`).join(', ')}`)), 60_000);
      worker.on('message', (m) => { if (!m) { clearTimeout(timer); resolve(); } else if (m.tries) done.push(m); else times.push(m); });
      worker.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  } finally {
    await worker.terminate();
  }
  const said = done.map(({ name: shape, tries }) => `${shape}: ${tries.map(({ ms, slope }) => `${ms.map((m) => m.toFixed(1)).join(', ')}ms at 20,000, 80,000, 320,000 (slope ${slope.toFixed(2)})`).join('; ')}`).join('\n');
  return { done, said };
}

// Whether each shape was timed and one of its tries grew with a power of the size under 1.5.
export const linearIn = (done, shapes) => done.length === Object.keys(shapes).length && done.every(({ tries }) => tries.some((t) => t.slope < 1.5));
