// Triggered or not (0.28.0, src/trigger.mjs): each risk and rule shown for a changed file is judged against the change.
// One about a function the change did not touch is listed as not triggered, with the reason, never dropped; one that
// names nothing readfirst can find is shown by its files, as before.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runAction } from '../src/action.mjs';
import { main } from '../src/cli.mjs';
import { MAP_FORMAT } from '../src/map.mjs';
import { toMarkdown } from '../src/readlist.mjs';
import { judge, parseGitDiff, parsePatch, toNew } from '../src/trigger.mjs';

const PAY = [
  'export function charge(amount) {',
  '  return round(amount);',
  '}',
  '',
  '// Refunds go back to the card they came from.',
  'export function refund(amount) {',
  '  return -amount;',
  '}',
  '',
  'const MAX_RETRIES = 3;',
  '',
].join('\n');

test('a patch gives the changed lines on the new side, the changed text, and where an old line is now', () => {
  const c = parsePatch('@@ -2,1 +2,2 @@\n-  return round(amount);\n+  return round(amount, 2);\n+  // two places\n@@ -7 +8,0 @@\n-  return -amount;');
  assert.deepEqual([...c.lines].sort((a, b) => a - b), [2, 3, 8]);
  assert.deepEqual(c.text, ['  return round(amount);', '  return round(amount, 2);', '  // two places', '  return -amount;']);
  assert.equal(toNew(c, 1), 1, 'above every hunk: unchanged');
  assert.equal(toNew(c, 5), 6, 'below the first hunk, which added a line');
  assert.equal(toNew(c, 10), 10, 'below both: +1 then -1');
  const files = parseGitDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n');
  assert.deepEqual([...files.keys()], ['a.js', 'gone.js']);
  assert.equal(files.get('a.js').whole, false);
  assert.equal(files.get('gone.js').whole, true, 'a deleted file counts as changed all through');
});

test('a risk about a function the change touched is triggered; one about a function it did not touch is not, with the reason', () => {
  const list = {
    rules: [{ id: 'cents', rule: 'amounts stay in cents', for: ['src/pay.js'] }],
    risks: [
      { group: 'pay', text: 'charge rounds before it stores the amount', for: ['src/pay.js'] },
      { group: 'pay', text: 'the retry limit MAX_RETRIES is read by the queue too', for: ['src/pay.js'] },
      { group: 'pay', text: 'the line that matters is src/pay.js:7', for: ['src/pay.js'] },
      { group: 'pay', text: 'a backticked `refund` and an evidence line - src/pay.js:2', for: ['src/pay.js'] },
    ],
  };
  // The change: one line in charge's body.
  const changes = new Map([['src/pay.js', parsePatch('@@ -2 +2 @@\n-  return round(amount);\n+  return round(amount, 2);')]]);
  judge(list, { changes, read: (p) => (p === 'src/pay.js' ? PAY : null), files: ['src/pay.js'] });
  const [rule] = list.rules;
  const [plain, max, line7, mixed] = list.risks;
  assert.deepEqual(rule.trigger, { triggered: true, about: [], by: [], why: 'names no symbol or line readfirst can find: shown for its files' }, 'nothing to judge by: shown by its files, as before');
  assert.equal(plain.trigger.triggered, true, 'a plain unticked word is not taken as a name: `charge` here is prose');
  assert.deepEqual(plain.trigger.about, []);
  assert.equal(max.trigger.triggered, false);
  assert.equal(max.trigger.why, 'the change does not touch `MAX_RETRIES`');
  assert.equal(line7.trigger.triggered, false, 'line 7 is in refund, which did not change');
  assert.deepEqual(mixed.trigger.by, ['src/pay.js:2'], 'line 2 is in charge, which changed; `refund` did not');
  assert.equal(mixed.trigger.triggered, true);
  // A name in an added or removed line counts too: the change replaces a use of MAX_RETRIES somewhere else.
  const other = { risks: [{ group: 'pay', text: 'the retry limit MAX_RETRIES is read by the queue too', for: ['src/pay.js'] }], rules: [] };
  judge(other, { changes: new Map([['src/queue.js', parsePatch('@@ -1 +1 @@\n-retry(MAX_RETRIES)\n+retry(LIMIT)')]]), read: (p) => (p === 'src/pay.js' ? PAY : null), files: ['src/pay.js', 'src/queue.js'] });
  assert.deepEqual(other.risks[0].trigger.by, ['`MAX_RETRIES`']);
});

test('a comment above the next function belongs to it, and an evidence line follows the lines added above it', () => {
  // A new function and its comment added after charge: charge itself is not touched (on readfirst#139 the comment above
  // a new function made the function before it read as changed).
  const after = PAY.replace('// Refunds', '// A fee for each charge.\nexport function fee() {\n  return 1;\n}\n\n// Refunds');
  const added = parsePatch('@@ -4,0 +5,5 @@\n+// A fee for each charge.\n+export function fee() {\n+  return 1;\n+}\n+');
  const list = { rules: [], risks: [{ group: 'pay', text: 'see `charge` and src/pay.js:7', for: ['src/pay.js'] }] };
  judge(list, { changes: new Map([['src/pay.js', added]]), read: () => after, files: ['src/pay.js'] });
  assert.equal(list.risks[0].trigger.triggered, false, 'charge ends before the blank line and the comment of fee; old line 7 (refund) is now line 12, untouched');
  assert.equal(list.risks[0].trigger.why, 'the change does not touch `charge`, src/pay.js:7');
});

test('a plain lowercase name counts only as a function in the item\'s own files, never by showing up in the diff', () => {
  // On readfirst#139 a new test declaring its own `run` helper, and the word `files` in changed lines, made risks about
  // `run` and `files` read as touched.
  const list = { rules: [], risks: [{ group: 'pay', text: 'the `files` field and the `run` field are read by the server', for: ['src/pay.js'] }] };
  const test = 'const run = () => 1;\nexport function files() {}\n';
  const changes = new Map([['test/x.test.js', { lines: new Set(), text: ['const files = list.files;', 'run()'], hunks: [], whole: true }]]);
  judge(list, { changes, read: (p) => (p === 'src/pay.js' ? PAY : p === 'test/x.test.js' ? test : null), files: ['src/pay.js', 'test/x.test.js'] });
  assert.deepEqual(list.risks[0].trigger.about, [], 'not names of this item: shown by its files, as before');
  assert.equal(list.risks[0].trigger.triggered, true);
});

test('on its own PR: names in docs, the map and comments do not count, and a function ends at its own closing brace', () => {
  // readfirst#142 judged itself: its map edit and its comments named runHook and changedFiles, and an inner helper of
  // main() (fromHere) ran to the end of main, so all three read as touched.
  const CLI = [
    'export function runHook(input) {',
    '  const save = () => 1;',
    '  function inner() {',
    '    return 2;',
    '  }',
    '  return save() + inner();',
    '}',
    '',
    'export function main(args) {',
    '  const fromHere = (given) => {',
    '    return given;',
    '  };',
    '  const changes = null;',
    '  return fromHere(args);',
    '}',
    '',
  ].join('\n');
  const risks = [
    { group: 'cli', text: 'runHook swallows every error', for: ['src/cli.mjs'] },
    { group: 'cli', text: 'read takes a path through fromHere', for: ['src/cli.mjs'] },
  ];
  const list = { rules: [], risks };
  const changes = new Map([
    // main's body changed below fromHere; runHook's body changed below its inner functions.
    ['src/cli.mjs', parsePatch('@@ -13 +13 @@\n-  const changes = null;\n+  const changes = judge();\n@@ -6 +6 @@\n-  return save() + inner();\n+  return save() + inner() + 1;')],
    ['.readfirst/map.json', parsePatch('@@ -1 +1 @@\n-x\n+  "text": "fromHere and runHook"')],
    ['docs/guide.md', parsePatch('@@ -1 +1 @@\n-x\n+see fromHere')],
    ['src/trigger.mjs', parsePatch('@@ -0,0 +1 @@\n+// fromHere made fromHere read as changed')],
  ]);
  judge(list, { changes, read: (p) => (p === 'src/cli.mjs' ? CLI : null), files: ['src/cli.mjs', '.readfirst/map.json', 'docs/guide.md', 'src/trigger.mjs'] });
  assert.equal(risks[0].trigger.triggered, true, 'runHook runs past its inner functions to its own closing brace');
  assert.deepEqual(risks[0].trigger.by, ['`runHook`']);
  assert.equal(risks[1].trigger.triggered, false, 'fromHere ends at its own brace; main changed below it, and the map, the guide and a comment only name it');
});

test('the read list shows triggered items in place and the others under "Not triggered by this change", whole', () => {
  const list = { targets: [{ path: 'src/pay.js', group: 'pay', status: 'IN_MAP' }], rules: [{ id: 'cents', rule: 'amounts stay in cents in `charge`', for: ['src/pay.js'], trigger: { triggered: false, about: ['`charge`'], by: [], why: 'the change does not touch `charge`' } }], risks: [{ group: 'pay', text: 'refundAll walks every order', named: true, for: ['src/pay.js'], trigger: { triggered: true, about: ['`refundAll`'], by: ['`refundAll`'] } }], hotspots: [], flows: [], vocabulary: [], checks: [], tests: [], usedBy: [], notCovered: [], unseen: [], deprecated: [], together: [], dependents: [] };
  const md = toMarkdown(list);
  assert.match(md, /## Watch out\n\n- refundAll walks every order _\(the change touches `refundAll`\)_/u);
  assert.match(md, /## Not triggered by this change\n\n- not triggered \(the change does not touch `charge`\): \*\*cents\*\*: amounts stay in cents in `charge`/u);
  assert.doesNotMatch(md, /## Rules that must keep holding/u, 'the rule is not shown as if it applied');
  assert.match(toMarkdown(list, { fold: true }), /<details><summary>Not triggered by this change \(1\)<\/summary>/u, 'folded in the PR comment, with its count');
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-trigger-'));
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}
const MAP = { format: MAP_FORMAT, groups: [{ id: 'pay', title: 'Payments', files: ['src/**'], risks: [{ text: 'refund must use the original card: `refund`', files: ['src/pay.js'] }, { text: 'charge rounding: `charge`', files: ['src/pay.js'] }] }] };

test('diff judges the branch\'s change: only the risk about the function it changed is under Watch out', () => {
  const { root, git } = repo({ 'src/pay.js': PAY, '.readfirst/map.json': JSON.stringify(MAP) });
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'src/pay.js'), PAY.replace('return round(amount);', 'return round(amount, 2);'));
  let out = '';
  assert.equal(main(['--root', root, 'diff', '--base', 'main'], { out: (s) => { out += s; }, err: () => {} }), 0);
  assert.match(out, /## Watch out\n\n- charge rounding: `charge` _\(the change touches `charge`\)_/u);
  assert.match(out, /## Not triggered by this change\n\n- not triggered \(the change does not touch `refund`\): refund must use the original card/u);
  let json = '';
  main(['--root', root, 'diff', '--base', 'main', '--json'], { out: (s) => { json += s; }, err: () => {} });
  const risks = JSON.parse(json).risks;
  assert.deepEqual(risks.map((r) => [r.text.split(':')[0], r.trigger.triggered]), [['refund must use the original card', false], ['charge rounding', true]]);
  let read = '';
  main(['--root', root, 'read', 'src/pay.js'], { out: (s) => { read += s; }, err: () => {} });
  assert.doesNotMatch(read, /Not triggered/u, '`read` is not a change: nothing is judged');
});

test('the Action judges from the API patches; a file without a patch counts as changed all through', async () => {
  const { root } = repo({ 'src/pay.js': PAY, '.readfirst/map.json': JSON.stringify(MAP) });
  const event = join(root, '..', `${root.split('/').pop()}-event.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567' } } }));
  const run = async (files) => {
    const posts = [];
    const fetchImpl = async (url, init) => {
      const u = new URL(url);
      const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
      if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? files : []);
      if (init.method === 'GET') return json([]);
      if (init.method === 'POST') posts.push(JSON.parse(init.body).body);
      return json({ id: 1 }, 201);
    };
    await runAction({ env: { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't', GITHUB_API_URL: 'https://api.example' }, fetchImpl, log: () => {} });
    return posts.join('\n');
  };
  const withPatch = await run([{ filename: 'src/pay.js', status: 'modified', patch: '@@ -2 +2 @@\n-  return round(amount);\n+  return round(amount, 2);' }]);
  assert.match(withPatch, /charge rounding: `charge` _\(the change touches `charge`\)_/u);
  assert.match(withPatch, /<details><summary>Not triggered by this change \(1\)<\/summary>\n\n- not triggered \(the change does not touch `refund`\): refund must use the original card/u);
  const noPatch = await run([{ filename: 'src/pay.js', status: 'modified' }]);
  assert.doesNotMatch(noPatch, /Not triggered/u, 'no patch to read: everything in the file counts as touched');
});
