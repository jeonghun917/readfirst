// Four readers find a readfirst command in a shell command: the hook install (`readfirstHookOf`), the gate's read
// (`bashReads`), its answer (`answerRuns`) and its find (`findQueries`). Until 2026-11-15 each had a spelling pattern
// of its own: the read, answer and find readers missed a version such as `readfirst@^1.2`, a Windows path, an option
// before the subcommand, npm exec, bun x, npx -p <package> and a shell's -c string, and install knew other forms
// again. Now one reader of the words (`readfirstRun`) serves all four, and every form below is read by each of them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerRuns } from '../src/answers.mjs';
import { bashReads } from '../src/bash-writes.mjs';
import { findQueries, readfirstHookOf } from '../src/cli.mjs';

// Each form runs `readfirst <rest>`; the -c forms put the whole command in a shell's string.
const FORMS = [
  (rest) => `readfirst ${rest}`,
  (rest) => `npx --yes readfirst ${rest}`,
  (rest) => `npx readfirst@^1.2 ${rest}`,
  (rest) => `readfirst@1.2.3-beta+x ${rest}`,
  (rest) => `node C:\\x\\readfirst.mjs ${rest}`,
  (rest) => `node "$CLAUDE_PROJECT_DIR/bin/readfirst.mjs" ${rest}`,
  (rest) => `readfirst --lang ko ${rest}`,
  (rest) => `npx -p readfirst readfirst ${rest}`,
  (rest) => `npm exec -- readfirst ${rest}`,
  (rest) => `npm x readfirst ${rest}`,
  (rest) => `pnpm dlx readfirst ${rest}`,
  (rest) => `yarn dlx readfirst ${rest}`,
  (rest) => `bun x readfirst ${rest}`,
  (rest) => `bunx readfirst ${rest}`,
  (rest) => `node -r ./trace.cjs bin/readfirst.mjs ${rest}`,
  (rest) => `sh -c "readfirst ${rest.replace(/"/gu, '\\"')}"`,
  (rest) => `bash -lc "npx readfirst ${rest.replace(/"/gu, '\\"')}"`,
];
const CWD = '/r';

test('every form runs readfirst for each of the four readers', () => {
  for (const form of FORMS) {
    const hook = form('hook');
    assert.deepEqual(readfirstHookOf(hook), { stop: false }, hook);
    const read = form('read src/a.mjs');
    assert.deepEqual(bashReads(read, CWD), [{ files: ['/r/src/a.mjs'], seen: true, why: null }], read);
    const answer = form(`answer '{"a":1}'`);
    assert.deepEqual(answerRuns(answer, CWD), [{ text: '{"a":1}' }], answer);
    const find = form('find charge money');
    assert.deepEqual(findQueries(find, CWD), [{ query: 'charge money', at: CWD }], find);
  }
});

test('a word that only looks like readfirst, or another subcommand, runs none of them', () => {
  for (const command of ['echo readfirst read src/a.mjs', 'my-readfirst read src/a.mjs', 'readfirst.js read src/a.mjs', 'npx -p readfirst read src/a.mjs', 'readfirst reads src/a.mjs', 'sh -c "echo readfirst read src/a.mjs"']) {
    assert.deepEqual(bashReads(command, CWD), [], command);
  }
  for (const command of ['echo readfirst answer \'{}\'', 'npx -p readfirst answer \'{}\'', 'sh -c "echo readfirst answer x"']) assert.deepEqual(answerRuns(command, CWD), [], command);
  for (const command of ['echo readfirst find x', 'npx -p readfirst find x', 'readfirst read find']) assert.deepEqual(findQueries(command, CWD), [], command);
});

test('an answer through a shell -c is one only when the string is written out, with nothing from a variable', () => {
  const why = (command) => answerRuns(command, CWD).map((r) => (r.text ? 'answer' : r.why.split(' ').slice(0, 3).join(' ')));
  assert.deepEqual(why(`X='{}'; sh -c "readfirst answer \\"$X\\""`), ['its argument is']);
  assert.deepEqual(why(`sh -c "readfirst answer '$X'"`), ['its argument is']);
  assert.deepEqual(why(`sh -c 'readfirst answer "$1"' _ '{}'`), ['its argument is']);
  assert.deepEqual(why(`sh -c "readfirst answer '{}'" | cat`), ['it is in']);
  assert.deepEqual(why(`f() { sh -c "readfirst answer '{}'"; }`), [], 'a function body is not run where it is written');
});

test('a read through a shell -c whose output the outer command sends away is not seen', () => {
  assert.deepEqual(bashReads('sh -c "readfirst read src/a.mjs" > /dev/null', CWD), [{ files: ['/r/src/a.mjs'], seen: false, why: 'its output was sent elsewhere' }]);
  assert.deepEqual(bashReads('sh -c "readfirst read src/a.mjs" | head', CWD), [{ files: ['/r/src/a.mjs'], seen: false, why: 'its output was sent elsewhere' }]);
});
