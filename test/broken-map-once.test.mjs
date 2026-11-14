// A map broken in itself (a rule naming a file that is gone, a map that is not JSON) refused every stop: its refusal
// had no once key, so a session that could not fix the map, or had a reason not to, could not stop at all (ledger
// broken-map-refuses-every-stop). It refuses once for the map as it is (`unchecked:<root>:<hash of the map file>`,
// the tag of a stop that could not check), says it as a note on every later stop, and refuses again once the map
// changes and is still broken.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runHook, runStopHook } from '../src/cli.mjs';

const MAP = (rules) => JSON.stringify({ format: 'readfirst/map@1', groups: [{ id: 'src', title: 'the code', files: ['src/**', '.readfirst/**'], checks: [{ run: 'node -e 0', why: 'nothing' }] }], rules });

function session() {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-brokenmap-'));
  const files = { 'src/a.js': 'export const a = 1;\n', '.readfirst/map.json': MAP([{ id: 'pure', rule: 'a stays pure', files: ['src/a.js'] }]) };
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  const stateDir = mkdtempSync(join(tmpdir(), 'readfirst-brokenmap-state-'));
  const id = `brokenmap-${process.pid}`;
  runHook(JSON.stringify({ session_id: id, cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), { stateDir });
  writeFileSync(join(root, 'src/a.js'), 'export const a = 2;\n');
  const stop = () => { const out = runStopHook(JSON.stringify({ session_id: id, cwd: root }), { stateDir, timeout: 30 }); return out ? JSON.parse(out) : null; };
  return { root, stop };
}
const said = (out) => String(out?.reason ?? out?.systemMessage ?? '');

test('a map broken in itself refuses the stop once for its content, says it on every later stop, and again when it changes', () => {
  const { root, stop } = session();
  // A rule naming a file that is not tracked: the map is read, its problem said.
  writeFileSync(join(root, '.readfirst/map.json'), MAP([{ id: 'pure', rule: 'a stays pure', files: ['src/gone.js'] }]));
  const first = stop();
  assert.equal(first?.decision, 'block');
  assert.match(first.reason, /map\.json is broken \(1 problem; first: rules\[0\]\.files: src\/gone\.js matches no tracked file\)/u);
  for (const n of [2, 3]) {
    const later = stop();
    assert.notEqual(later?.decision, 'block', `stop ${n}: not refused again for the same map`);
    assert.match(said(later), /map\.json is broken/u, `stop ${n}: still said`);
  }
  // The map changed and is not even JSON: refused once more, then said.
  writeFileSync(join(root, '.readfirst/map.json'), '{ nope');
  const again = stop();
  assert.equal(again?.decision, 'block');
  assert.match(again.reason, /not valid JSON.*The checks for the files you edited were not run/su);
  const after = stop();
  assert.notEqual(after?.decision, 'block');
  assert.match(said(after), /not valid JSON.*The checks for the files you edited were not run/su, 'the checks that did not run are still said');
  assert.ok(readFileSync(join(root, '.readfirst/map.json'), 'utf8').startsWith('{ nope'), 'the stop writes nothing to the map');
});
