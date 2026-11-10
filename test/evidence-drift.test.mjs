// Evidence lines that no longer point at what their risk names (readfirst-cloud#228, 2026-11-10): readfirst's own map
// had src/cli.mjs:108 in VERSION for a risk about loadMapLenient (now at 168), and src/bash-writes.mjs:36 in `opening`
// for a risk about `unwrap` and `gitPaths`, and check passed. Since 0.28.0 the line judges a risk against a change, so a
// drifted line judges by the wrong code. Now check lists them, fix moves the ones git shows moving, and the verdict
// counts them; a line is still used to judge (dropping it could hide a real hit).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { MAP_FORMAT } from '../src/map.mjs';
import { judge, moveEvidence } from '../src/trigger.mjs';
import { verdictLines } from '../src/verdict.mjs';

const PAY = 'export function charge(amount) {\n  return round(amount);\n}\n\n// Refunds go to the card.\nexport function refund(amount) {\n  return -amount;\n}\n';
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-drift-'));
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
const run = (root, ...argv) => {
  let out = '';
  const code = main(['--root', root, ...argv], { out: (s) => { out += s; }, err: () => {} });
  return { code, out };
};
const mapWith = (risks) => JSON.stringify({ format: MAP_FORMAT, groups: [{ id: 'pay', title: 'Payments', files: ['src/**'], risks }] });

test('check lists a line the code moved away from, fix writes where git carried it, and a right line is left alone', () => {
  const risks = [
    { text: '`charge` rounds twice - src/pay.js:2', files: ['src/pay.js'] },
    { text: 'the refund comment explains `refund` - src/pay.js:5', files: ['src/pay.js'] },
  ];
  const { root, git } = repo({ 'src/pay.js': PAY, '.readfirst/map.json': mapWith(risks) });
  assert.doesNotMatch(run(root, 'check').out, /evidence lines/u, 'both lines point into what they name, the comment above refund counting as refund');
  writeFileSync(join(root, 'src/pay.js'), `import { round } from './round.js';\n\n// Payments.\n${PAY}`);
  git('commit', '-qam', 'imports');
  const c = run(root, 'check');
  assert.equal(c.code, 0, 'listed, not failed');
  assert.match(c.out, /groups\.pay\.risks\[0\]: src\/pay\.js:2 is outside `charge` \(line 4\): it moved to src\/pay\.js:5, `readfirst fix` writes that/u);
  assert.match(c.out, /groups\.pay\.risks\[1\]: src\/pay\.js:5 is outside `refund` \(line 9\): it moved to src\/pay\.js:8/u);
  assert.equal(run(root, 'check', '--strict').code, 1, '--strict fails on them');
  const f = run(root, 'fix');
  assert.match(f.out, /groups\.pay\.risks\[0\]: src\/pay\.js:2 -> src\/pay\.js:5 \(`charge` moved\)/u);
  const map = JSON.parse(readFileSync(join(root, '.readfirst/map.json'), 'utf8'));
  assert.equal(map.groups[0].risks[0].text, '`charge` rounds twice - src/pay.js:5');
  assert.equal(map.groups[0].risks[1].text, 'the refund comment explains `refund` - src/pay.js:8');
  assert.doesNotMatch(run(root, 'check').out, /evidence lines/u, 'nothing left to say');
});

test('a line wrong from the start is listed for a person, never moved; one in a file where the item names nothing is said', () => {
  const risks = [
    { text: '`refund` must use the original card - src/pay.js:2', files: ['src/pay.js'] },
    { text: 'rounding happens here - src/pay.js:2', files: ['src/pay.js'] },
  ];
  const { root } = repo({ 'src/pay.js': PAY, '.readfirst/map.json': mapWith(risks) });
  const c = run(root, 'check');
  assert.match(c.out, /groups\.pay\.risks\[0\]: src\/pay\.js:2 is outside `refund` \(line 6\): git does not show it moving there, so check it by hand/u);
  assert.match(c.out, /evidence lines in a code file where their risk or rule names nothing declared, so a move cannot be seen \(name the function in backticks\):\n- groups\.pay\.risks\[1\]: src\/pay\.js:2/u);
  run(root, 'fix');
  assert.equal(JSON.parse(readFileSync(join(root, '.readfirst/map.json'), 'utf8')).groups[0].risks[0].text, risks[0].text, 'left as written');
  const json = JSON.parse(run(root, 'check', '--json').out);
  assert.equal(json.drift.length, 1);
  assert.equal(json.unanchored.length, 1);
});

test('the judge still uses a drifted line, marks it, and the verdict counts it in both languages', () => {
  const list = { rules: [], risks: [{ group: 'pay', text: '`refund` must use the original card - src/pay.js:2', for: ['src/pay.js'] }], targets: [{ path: 'src/pay.js' }], checks: [] };
  judge(list, { changes: new Map([['src/pay.js', { lines: new Set([2]), text: ['  return round(amount, 2);'], hunks: [], whole: false }]]), read: () => PAY, files: ['src/pay.js'] });
  const t = list.risks[0].trigger;
  assert.deepEqual(t.drifted, ['src/pay.js:2']);
  assert.ok(t.by.includes('src/pay.js:2'), 'line 2 changed: the item reads as touched, not hidden');
  assert.match(verdictLines(list).join('\n'), /1 rule or risk points at a line outside what it names: it may have moved with the code/u);
  assert.match(verdictLines(list, { lang: 'ko' }).join('\n'), /규칙·위험 1개는 증거 줄이 자기가 말하는 코드 밖을 가리킵니다/u);
});

test('a moved reference is replaced where it stands alone', () => {
  assert.equal(moveEvidence('see src/a.mjs:16 and src/a.mjs:168, x/src/a.mjs:16', 'src/a.mjs:16', 'src/a.mjs', 20), 'see src/a.mjs:20 and src/a.mjs:168, x/src/a.mjs:16');
});
