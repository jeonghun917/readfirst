// A risk about one configuration file (a workflow, a Dockerfile, a JSON or YAML file) whose `files` list that file alone
// could never be judged: nothing is declared in such a file, so the text names no symbol there, and unless the path
// happened to be the first clause of the text a change to that very file read as "names no symbol or line: shown for
// its files" every time, and audit counted the risk as one to narrow. Its `files` are what it is about: when they are
// exact paths with no declaration in them, a change to one of them triggers the risk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readList } from '../src/readlist.mjs';
import { judge, unmatchedItems } from '../src/trigger.mjs';

const CODE = 'export function buildImage() {\n  return 1;\n}\n';
const read = (p) => (p === 'src/build.js' ? CODE : p === '.github/workflows/release.yml' ? 'on: push\njobs: {}\n' : p === 'Dockerfile' ? 'FROM node:22\n' : null);
const files = ['.github/workflows/release.yml', 'Dockerfile', 'src/build.js', 'src/other.js'];
const TEXT = 'the release job publishes with the token of whoever pushed the tag; a second trigger would publish twice';
const map = (riskFiles, text = TEXT) => ({
  format: 'readfirst/map@1',
  groups: [{ id: 'ci', title: 'ci', files: ['.github/**', 'Dockerfile'], risks: [{ text, files: riskFiles }] }, { id: 'src', title: 'src', files: ['src/**'] }],
});
const change = (path) => new Map([[path, { lines: new Set([1]), text: ['x'], hunks: [], whole: false }]]);
const judged = (m, changed) => {
  const list = readList({ map: m, files, targets: [changed], imports: [], read });
  judge(list, { changes: change(changed), read, files, imports: [] });
  return list.risks.map((r) => r.trigger);
};

test('a change to the configuration file a risk is about triggers it, with the file as what it is about', () => {
  const [t] = judged(map(['.github/workflows/release.yml']), '.github/workflows/release.yml');
  assert.equal(t.triggered, true);
  assert.deepEqual(t.about, ['.github/workflows/release.yml']);
  assert.deepEqual(t.by, ['.github/workflows/release.yml']);
  assert.equal(t.why, undefined, 'judged, not "names no symbol or line"');
});

test('with two such files, a change to one triggers it and names both', () => {
  const [t] = judged(map(['.github/workflows/release.yml', 'Dockerfile']), 'Dockerfile');
  assert.deepEqual(t.about, ['.github/workflows/release.yml', 'Dockerfile']);
  assert.deepEqual(t.by, ['Dockerfile']);
});

test('a pattern among the files, or a file with declarations, is judged as before', () => {
  const [glob] = judged(map(['.github/workflows/*.yml']), '.github/workflows/release.yml');
  assert.deepEqual(glob.about, [], 'a pattern is not a file the risk is about');
  assert.match(glob.why, /names no symbol or line/u);
  const [mixed] = judged(map(['Dockerfile', '.github/workflows/*.yml']), 'Dockerfile');
  assert.deepEqual(mixed.about, [], 'one pattern among the files: the risk is about more than the files it names exactly');
  const [code] = judged(map(['src/build.js'], 'the image is built once; a second build doubles the upload'), 'src/build.js');
  assert.deepEqual(code.about, [], 'src/build.js declares buildImage: the risk should name it');
  const [named] = judged(map(['src/build.js'], '`buildImage` runs once'), 'src/build.js');
  assert.deepEqual(named.about, ['`buildImage`']);
});

test('audit counts such a risk as judgeable, and still lists the ones with a pattern or a code file', () => {
  const m = map(['.github/workflows/release.yml']);
  m.groups[0].risks.push({ text: TEXT, files: ['.github/workflows/*.yml'] }, { text: 'the image is built once', files: ['src/build.js'] });
  assert.deepEqual(unmatchedItems(m, { files, read }).map((u) => u.where).sort(), ['groups.ci.risks[1]', 'groups.ci.risks[2]']);
});
