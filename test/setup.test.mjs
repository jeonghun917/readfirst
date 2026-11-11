// test/setup.mjs, which the `test` script loads before every test file: no test commit asks the machine's signing
// service, and nothing a test writes to the temp folder is left behind.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const withSetup = (script, env = {}) => execFileSync(process.execPath, ['--import', './test/setup.mjs', '-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } }).trim();

test('the test script loads test/setup.mjs', () => {
  assert.match(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test, /--import \.\/test\/setup\.mjs /u);
});

test('a commit in a test repository is not signed, though the machine is set to sign every commit with a signer that fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readfirst-setup-'));
  try {
    // Whatever the format the machine signs in (gpg or ssh), the signer is a program that fails.
    const signing = { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'gpg.program', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'gpg.ssh.program', GIT_CONFIG_VALUE_2: 'false' };
    const commit = (m) => ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', m];
    const script = `const { execFileSync: g } = require('node:child_process'); const o = { cwd: ${JSON.stringify(dir)}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
      g('git', ['init', '-q'], o); g('git', ${JSON.stringify(commit('one'))}, o);
      console.log(g('git', ['log', '--format=%s'], o).trim() + ' ' + g('git', ['config', 'gpg.program'], o).trim());`;
    assert.equal(withSetup(script, signing), 'one false', 'the pairs the environment already held are kept, and the one added after them wins');
    assert.throws(() => execFileSync('git', commit('two'), { cwd: dir, stdio: 'ignore', env: { ...process.env, ...signing } }), 'without it the same commit fails: the check above is of the setup, not of this machine');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('each test process has a temp folder of its own, gone when the process ends with what it and its children left there', () => {
  const script = `const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    fs.mkdtempSync(path.join(os.tmpdir(), 'left-'));
    require('node:child_process').execFileSync(process.execPath, ['-e', "require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'child-'))"]);
    console.log(os.tmpdir() + '|' + fs.readdirSync(os.tmpdir()).length);`;
  const [own, entries] = withSetup(script).split('|');
  assert.match(own, /readfirst-test-/u);
  assert.equal(entries, '2', 'what the process and its child made is in it');
  assert.equal(existsSync(own), false);
});
