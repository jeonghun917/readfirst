// Loaded before every test file (`node --import ./test/setup.mjs --test ...`, the `test` script of package.json).
// Two things the tests' throwaway repositories must not take from the machine they run on:
// - commit signing: where git is set to sign every commit (commit.gpgsign in the global configuration, as in a
//   hosted agent session), each test commit asked the machine's signing service; a suite of about ninety commits
//   run many times a day used the service up, and then every commit on the machine failed, the real ones too;
// - the temp folder: 29 test files make folders with mkdtempSync and one removed its own, so each run left
//   several hundred behind. Each test process now gets a temp folder of its own (os.tmpdir() and every child
//   process read TMPDIR), removed when the process ends.
// A test file run by hand without --import (`node --test test/x.test.mjs`) gets neither.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// git reads GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> for n below GIT_CONFIG_COUNT, after its files: one more
// pair is added to whatever the environment already holds.
const n = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
process.env[`GIT_CONFIG_KEY_${n}`] = 'commit.gpgsign';
process.env[`GIT_CONFIG_VALUE_${n}`] = 'false';
process.env.GIT_CONFIG_COUNT = String(n + 1);

// A temp folder variable that is not an absolute path is read against the working directory: a hosted session had
// TMPDIR=" /tmp" (a leading space, 2026-11-25), the tests made a folder named " " inside the checkout and four of them
// failed (readfirst-cloud's ledger, tmpdir-with-leading-space-read-as-relative). Such a value is dropped, so
// os.tmpdir() takes the next variable or the system's own.
for (const name of ['TMPDIR', 'TMP', 'TEMP']) if (process.env[name] !== undefined && !isAbsolute(process.env[name])) delete process.env[name];

// realpath: on macOS the temp folder is behind a symlink, and tests compare paths with what git prints.
const own = mkdtempSync(join(realpathSync(tmpdir()), 'readfirst-test-'));
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = own;
process.on('exit', () => { try { rmSync(own, { recursive: true, force: true }); } catch { /* a folder still in use stays */ } });
