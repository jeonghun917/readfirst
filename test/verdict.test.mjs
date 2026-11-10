// Two readers, one comment (step 3 of "Nothing hidden, nothing unchecked", 2026-11-09): the PR comment and `diff` open
// with a verdict in the reader's language (templated, no model): what to do, what is blocked, what was not checked,
// which other repositories; then what the change touches, in full; then the rest, folded, whole. The hook's notes for
// an agent come in the same order.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { commentBody, runAction } from '../src/action.mjs';
import { brief, diffLang, main } from '../src/cli.mjs';
import { MAP_FORMAT } from '../src/map.mjs';
import { emptyList, toMarkdown, VERDICT_PLACES } from '../src/readlist.mjs';
import { VERDICT_LANGS, VERDICT_TEXT, verdictLang, verdictLines } from '../src/verdict.mjs';

const on = (by) => ({ triggered: true, about: by, by });
const off = (about) => ({ triggered: false, about, by: [], why: `the change does not touch ${about.join(', ')}` });
const bare = { triggered: true, about: [], by: [], why: 'names no symbol or line readfirst can find: shown for its files' };
// A judged read list with one row of every kind the verdict sorts.
const LIST = () => ({
  ...emptyList(),
  targets: [{ path: 'src/pay.js' }, { path: 'src/cart.js', brokeBefore: { notFetched: true } }],
  rules: [
    { id: 'cents', rule: 'amounts are in cents', why: 'the API sends cents', for: ['src/pay.js'], trigger: on(['`charge`']) },
    { id: 'no-network', rule: 'no network in `render`', for: ['src/pay.js'], trigger: off(['`render`']) },
    { id: 'logged', rule: 'every payment is logged', for: ['src/pay.js'], trigger: bare },
  ],
  risks: [
    { group: 'pay', text: 'charge rounds twice', named: true, for: ['src/pay.js'], trigger: on(['`charge`']) },
    { group: 'pay', text: 'refund must use the original card', named: true, for: ['src/pay.js'], trigger: off(['`refund`']) },
    { group: 'pay', text: 'retries are not idempotent', named: true, for: ['src/pay.js'], trigger: bare },
    { group: 'pay', text: 'the whole group shares one key', named: false, for: ['src/pay.js', 'src/cart.js'], trigger: bare },
  ],
  checks: [{ run: 'npm test', why: 'pay tests', for: ['src/pay.js', 'src/cart.js'] }],
  together: [{ also: ['docs/pay.md'], changed: false, why: 'the docs list the fees', for: ['src/pay.js'] }, { also: ['server.json'], changed: true, why: 'versions match', for: ['src/pay.js'] }],
  dependents: [{ repo: 'acme/shop', paths: ['vendor/pay/**'], why: 'the shop vendors this', for: ['src/pay.js'] }],
  notCovered: [{ path: 'src/new.js', why: 'in no group' }],
  unseen: [{ path: 'src/cart.js', why: 'line 3 loads a module by a computed name' }],
  flows: [{ entry: 'POST /pay', file: 'src/pay.js', line: 4, reaches: [], checks: [], for: ['src/pay.js'] }],
});

test('the verdict says what blocks, what to do, what was not checked and which other repositories, before any item', () => {
  const md = verdictLines(LIST(), { where: 'pr', checklist: true }).join('\n');
  assert.match(md, /^\*\*Blocked\*\*: 1 thing to fix before this is done\.\n/u, 'a file left behind blocks: verify fails on it');
  assert.match(md, /\*\*Blocked\*\*\n\n- `src\/pay\.js` changed but none of `docs\/pay\.md` did: change it too \(verify fails until then\) — the docs list the fees\n/u);
  assert.match(md, /\*\*To do\*\*\n\n- \[x\] `server\.json` changed too, as the map asks — versions match\n- \[ \] `npm test` — pay tests _\(src\/pay\.js, src\/cart\.js\)_\n/u);
  assert.match(md, /- confirm this rule still holds, the change touches what it is about: \*\*cents\*\* \(in full below\)/u);
  assert.match(md, /- read the 1 risk the change touches \(in full below\)/u);
  assert.match(md, /- read the 2 rules and risks readfirst could not match against the change \(in full below\)/u, 'the bare rule and the named bare risk');
  assert.match(md, /\*\*Not checked\*\*\n\n- readfirst ran none of these checks \(the Action runs no repository commands\): tick each once it has run\n/u);
  assert.match(md, /- 2 rules and risks name no symbol or line readfirst can match against the change: shown for their files, unjudged/u);
  assert.match(md, /- 1 more group risk could not be judged either \(folded below, whole\)/u);
  assert.match(md, /- 1 changed file the map does not place: `src\/new\.js`/u);
  assert.match(md, /- 1 file readfirst cannot fully read .*: `src\/cart\.js`/u);
  assert.match(md, /- whether 1 file broke before is unknown: the history was not fetched/u);
  assert.match(md, /\*\*Other repositories\*\*\n\n- \*\*acme\/shop\*\* \(`vendor\/pay\/\*\*`\) depends on this — the shop vendors this\n- readfirst cannot see other repositories from here/u);
  assert.match(verdictLines(LIST(), { where: 'diff' }).join('\n'), /diff runs none of these checks: `npx readfirst verify` runs them/u);
  const clean = { ...emptyList(), targets: [{ path: 'a.js' }] };
  assert.equal(verdictLines(clean)[0], '**Nothing to do** from the map, nothing blocked.');
  assert.doesNotMatch(verdictLines(clean).join('\n'), /Not checked/u, 'nothing unchecked to say');
});

test('map problems block, and the verdict says the read list was not made', () => {
  const md = verdictLines(null, { problems: ['groups[0].files: src/x.js does not exist', 'b'] }).join('\n');
  assert.match(md, /^\*\*Blocked\*\*: 1 thing to fix/u);
  assert.match(md, /the map no longer matches the code \(2 problems, listed below\)/u);
  assert.match(md, /no read list was made, because the map has problems/u);
});

test('Korean has its own words; a language without them is said, in English; the map\'s text is never translated', () => {
  const ko = verdictLines(LIST(), { lang: 'ko', checklist: true }).join('\n');
  assert.match(ko, /^\*\*막힘\*\*: 끝내기 전에 고칠 것 1개\./u);
  assert.match(ko, /\*\*할 일\*\*\n\n- \[x\] 지도대로 `server\.json`도 함께 바뀌었습니다 — versions match/u, 'the why stays as the map wrote it');
  assert.match(ko, /\*\*확인되지 않은 것\*\*/u);
  assert.match(ko, /\*\*다른 저장소\*\*\n\n- \*\*acme\/shop\*\*/u);
  assert.doesNotMatch(ko, /\bBlocked\b|To do|Not checked/u, 'every word of the template is Korean');
  assert.deepEqual(verdictLang('ko-KR'), { lang: 'ko', note: null });
  for (const lang of VERDICT_LANGS) assert.deepEqual(Object.keys(VERDICT_TEXT[lang]).sort(), Object.keys(VERDICT_TEXT.en).sort(), `${lang} has every string en has`);
  const ja = verdictLines(LIST(), { lang: 'ja' })[0];
  assert.match(ja, /^\*\*Blocked\*\*.* \(no "ja" text in readfirst yet: shown in English\)$/u);
});

test('below the verdict each rule and risk is in exactly one place: touched, not matched, or not triggered', () => {
  const list = LIST();
  const md = toMarkdown(list, { heading: null, checklist: true, broke: false, fold: true, verdict: { where: 'pr' } });
  for (const text of ['amounts are in cents', 'no network in `render`', 'every payment is logged', 'charge rounds twice', 'refund must use the original card', 'retries are not idempotent', 'the whole group shares one key'])
    assert.equal(md.split(text).length - 1, 1, `${text}: once`);
  assert.match(md, /## Triggered by this change\n\n- \*\*cents\*\*: amounts are in cents.*\n- charge rounds twice _\(the change touches `charge`\)_/u);
  assert.match(md, /## Not matched against the change: shown for their files\n\n- \*\*logged\*\*: every payment is logged.*\n- retries are not idempotent/u);
  assert.match(md, /<details><summary>More in the groups of these files, not matched against the change \(1\)<\/summary>\n\n- the whole group shares one key/u);
  assert.match(md, /<details><summary>Not triggered by this change \(2\)<\/summary>\n\n- not triggered \(the change does not touch `render`\): \*\*no-network\*\*/u);
  assert.match(md, /<details><summary>Outside input reaches this code \(1\)<\/summary>/u, 'flows are folded like the rest');
  assert.equal(md.split('`npm test`').length - 1, 1, 'the checks are in the verdict, not listed again');
  assert.equal(md.split('acme/shop').length - 1, 1, 'so are the other repositories');
  assert.doesNotMatch(md, /## Run these checks|## Change these too|## Other repositories depend on this/u);
  const plain = toMarkdown(list, { verdict: { where: 'diff' } });
  assert.match(plain, /## Not matched against the change: shown for their files\n\n(?:- .*\n){2}- the whole group shares one key/u, 'unfolded in diff');
  assert.doesNotMatch(plain, /<details>/u);
  assert.match(toMarkdown(list), /## Run these checks/u, '`read` (no verdict) is laid out as before');
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-verdict-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}
const PAY = 'export function charge(amount) {\n  return amount;\n}\n';
const MAP = { format: MAP_FORMAT, groups: [{ id: 'pay', title: 'Payments', files: ['src/**'], risks: [{ text: '`charge` rounds to cents', files: ['src/pay.js'] }], checks: [{ run: 'node -e 1', why: 'it starts' }] }] };

test('the Action writes the verdict in the `language` input, first, and says when it has no words for it', async () => {
  const { root } = repo({ 'src/pay.js': PAY, '.readfirst/map.json': JSON.stringify(MAP) });
  const event = join(root, '..', `${root.split('/').pop()}-event.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abcdef1234567' } } }));
  const run = async (language) => {
    const posts = [];
    const logs = [];
    const fetchImpl = async (url, init) => {
      const u = new URL(url);
      const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
      if (init.method === 'GET' && u.pathname.endsWith('/pulls/7/files')) return json(u.searchParams.get('page') === '1' ? [{ filename: 'src/pay.js', status: 'modified', patch: '@@ -2 +2 @@\n-  return amount;\n+  return Math.round(amount);' }] : []);
      if (init.method === 'GET') return json([]);
      if (init.method === 'POST') posts.push(JSON.parse(init.body).body);
      return json({ id: 1 }, 201);
    };
    await runAction({ env: { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'o/r', INPUT_TOKEN: 't', GITHUB_API_URL: 'https://api.example', ...(language === undefined ? {} : { INPUT_LANGUAGE: language }) }, fetchImpl, log: (s) => logs.push(s) });
    return { body: posts.join('\n'), logs };
  };
  const ko = await run('ko');
  assert.match(ko.body, /^<!-- readfirst:pr-comment -->\n## readfirst\n\n\*\*할 일 2개\*\*, 막힌 것 없음\.\n\n\*\*할 일\*\*\n\n- \[ \] `node -e 1` — it starts\n- 이 변경이 건드린 위험 1개를 읽으세요/u);
  assert.match(ko.body, /## Triggered by this change\n\n- `charge` rounds to cents _\(the change touches `charge`\)_/u);
  const en = await run(undefined);
  assert.match(en.body, /## readfirst\n\n\*\*2 to do\*\*, nothing blocked\./u, 'English by default');
  const ja = await run('ja');
  assert.match(ja.body, /\(no "ja" text in readfirst yet: shown in English\)/u);
  assert.ok(ja.logs.some((l) => /::warning::readfirst: no "ja" text for the verdict yet/u.test(l)), 'and the job log says so');
  const broken = commentBody({ list: null, problems: ['x'], removed: [], commit: null });
  assert.match(broken, /## readfirst\n\n\*\*Blocked\*\*: 1 thing to fix[^\n]*\n[\s\S]*> \[!WARNING\]/u, 'the verdict is above the map\'s problems');
});

test('diff takes --lang, else the one language of this clone\'s labels, else English', () => {
  assert.equal(diffLang('ko', () => []), 'ko');
  assert.equal(diffLang(undefined, () => ['ko']), 'ko');
  assert.equal(diffLang(undefined, () => ['ko', 'en']), 'ko', 'English labels say nothing about the verdict');
  assert.equal(diffLang(undefined, () => ['ko', 'ja']), 'ko', 'a language without verdict words does not count');
  assert.equal(diffLang(undefined, () => []), 'en');
  assert.throws(() => diffLang('korean!', () => []), /--lang needs a language code/u);
  const { root, git } = repo({ 'src/pay.js': PAY, '.readfirst/map.json': JSON.stringify(MAP) });
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(root, 'src/pay.js'), PAY.replace('return amount;', 'return Math.round(amount);'));
  let out = '';
  main(['--root', root, 'diff', '--base', 'main', '--lang', 'ko'], { out: (s) => { out += s; }, err: () => {} });
  assert.match(out, /^# Read first: `src\/pay\.js`\n\n\*\*할 일 2개\*\*/u);
  mkdirSync(join(root, '.readfirst/local/labels'), { recursive: true });
  writeFileSync(join(root, '.readfirst/local/labels/ko.json'), JSON.stringify({ format: 'readfirst/labels@1', lang: 'ko', text: {} }));
  let fromLabels = '';
  main(['--root', root, 'diff', '--base', 'main'], { out: (s) => { fromLabels += s; }, err: () => {} });
  assert.match(fromLabels, /\*\*할 일 2개\*\*/u);
  let json = '';
  main(['--root', root, 'diff', '--base', 'main', '--json', '--lang', 'ko'], { out: (s) => { json += s; }, err: () => {} });
  assert.equal(JSON.parse(json).format, 'readfirst/read-list@1', '--json is the read list, unchanged');
});

test('the hook\'s notes for an agent come in the verdict\'s order', () => {
  const lines = brief(LIST());
  const at = (re) => lines.findIndex((l) => re.test(l));
  const order = [/^Change together/u, /^Check to run/u, /^Broke before: history not fetched/u, /^Not seen by readfirst/u, /^Another repository/u, /^Rule cents/u, /^Risk: charge/u];
  const where = order.map(at);
  assert.ok(where.every((i) => i >= 0), `every kind is there: ${where}`);
  assert.deepEqual([...where].sort((a, b) => a - b), where, 'to do, not checked, other repositories, then what to know');
  assert.equal(lines.length, 2 + 1 + 1 + 1 + 1 + 3 + 4, 'every row once');
});

test('every list of the read list has a place in the verdict layout, and a row of each is shown', () => {
  const lists = Object.entries(emptyList()).filter(([, v]) => Array.isArray(v)).map(([k]) => k);
  assert.deepEqual(lists.filter((k) => !VERDICT_PLACES[k]), [], 'a new list needs a place in verdictMarkdown');
  const list = { ...LIST(),
    deprecated: [{ group: 'legacy', use: 'pay', why: 'moving to pay/', for: ['src/pay.js'] }],
    hotspots: [{ file: 'src/pay.js', symbol: 'charge', line: 1, labels: ['money'], rules: [], note: 'moves money' }],
    vocabulary: [{ name: 'requireUser', evidence: 'src/auth.js:3', kind: 'check', for: ['src/pay.js'] }],
    tests: [{ path: 'test/pay.test.js', via: null, for: ['src/pay.js'] }],
    usedBy: [{ path: 'src/shop.js', line: 9, for: ['src/pay.js'] }] };
  const md = toMarkdown(list, { heading: null, checklist: true, fold: true, verdict: { where: 'pr' } });
  for (const shown of ['src/pay.js', 'amounts are in cents', 'npm test', 'docs/pay.md', 'group **legacy** is being replaced', 'acme/shop', '`charge` (`src/pay.js:1`)', 'POST /pay', '`requireUser`', 'test/pay.test.js', 'src/shop.js:9', '`src/new.js`: in no group', 'line 3 loads a module by a computed name'])
    assert.ok(md.includes(shown), shown);
});

// welsmere, 2026-11-10: `hook --stop --timeout` was accepted and ignored, so its 1,065 s e2e chain was cut at the Stop
// hook's 600 s and reported as failed while it passed. The value now reaches the Stop hook, through main.
test('hook --stop --timeout reaches the Stop hook: a check longer than it is cut, the default lets it finish', async () => {
  const { runHook } = await import('../src/cli.mjs');
  const slowMap = { format: MAP_FORMAT, groups: [{ id: 'pay', title: 'Payments', files: ['src/**'], checks: [{ run: 'node -e "setTimeout(()=>{},3000)"', why: 'slow' }] }] };
  const { root, git } = repo({ 'src/pay.js': PAY, '.readfirst/map.json': JSON.stringify(slowMap) });
  git('checkout', '-q', '-b', 'work');
  const session = `timeout-${process.pid}-${Date.now()}`;
  runHook(JSON.stringify({ session_id: session, cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/pay.js') } }));
  writeFileSync(join(root, 'src/pay.js'), `${PAY}// changed\n`);
  const stop = (...flags) => { let out = ''; main(['hook', '--stop', ...flags], { out: (s) => { out += s; }, err: () => {} }, () => JSON.stringify({ session_id: session, cwd: root, stop_hook_active: false })); return out; };
  assert.match(stop('--timeout', '1'), /"decision":"block".*timeout/su, 'cut at 1 s');
  assert.doesNotMatch(stop(), /"decision":"block"/u, 'the default 600 s lets the 3 s check pass');
  assert.match(stop('--timeout', 'x'), /--timeout needs a number of seconds above 0/u, 'a bad value is said');
});
