import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixMap, MAP_FORMAT, mapProblems, migrateMap } from '../src/map.mjs';
import { readList, toMarkdown } from '../src/readlist.mjs';

const files = ['src/routes/orders.js', 'src/billing/charge.js', 'src/web/page.js'];
const flow = () => ({ entry: 'POST /orders/:id/refund', file: 'src/routes/orders.js', line: 12, checks: [], reaches: [{ file: 'src/billing/charge.js', symbol: 'refund', line: 40, labels: ['db-write', 'money'] }] });
const base = () => ({
  format: MAP_FORMAT,
  groups: [{ id: 'app', title: 'the app', files: ['src/**'] }],
  flows: [flow(), { ...flow(), entry: 'POST /admin/orders/:id/refund', line: 30, checks: ['requireRole'] }],
});

test('a map with valid flows passes check; one without is unchanged', () => {
  assert.deepEqual(mapProblems(base(), files), []);
  const m = base();
  delete m.flows;
  assert.deepEqual(mapProblems(m, files), []);
});

test('flow problems: untracked file, no reaches, bad line, missing checks list, bad label, extra key', () => {
  const p = (f) => mapProblems({ ...base(), flows: [f] }, files).join('\n');
  assert.match(p({ ...flow(), file: 'src/gone.js' }), /not a tracked file/u);
  assert.match(p({ ...flow(), reaches: [] }), /at least one/u);
  assert.match(p({ ...flow(), line: 0 }), /line number/u);
  assert.match(p({ ...flow(), checks: undefined }), /checks: a list/u);
  assert.match(p({ ...flow(), reaches: [{ ...flow().reaches[0], labels: ['DB Write'] }] }), /lowercase/u);
  assert.match(p({ ...flow(), reaches: [{ ...flow().reaches[0], file: 'x.js' }] }), /x\.js is not a tracked file/u);
  assert.match(p({ ...flow(), owner: 'x' }), /owner/u);
});

test('fix drops flows whose entry file or every reached file is gone, and reached files that are gone', () => {
  const gone = fixMap(base(), ['src/billing/charge.js', 'src/web/page.js']);
  assert.equal(gone.map.flows, undefined);
  assert.ok(gone.changes.some((c) => /flows: dropped POST \/orders\/:id\/refund/u.test(c)));
  const m = base();
  m.flows[0].reaches.push({ file: 'src/old.js', symbol: 'x', line: 1, labels: ['exec'] });
  const kept = fixMap(m, files);
  assert.deepEqual(kept.map.flows[0].reaches.map((r) => r.file), ['src/billing/charge.js']);
});

test('read shows the flows through a file, from either end, with their checks or the lack of one', () => {
  for (const target of ['src/routes/orders.js', 'src/billing/charge.js']) {
    const list = readList({ map: base(), files, imports: [], targets: [target] });
    assert.deepEqual(list.flows.map((f) => [f.entry, f.checks]), [['POST /orders/:id/refund', []], ['POST /admin/orders/:id/refund', ['requireRole']]]);
  }
  const md = toMarkdown(readList({ map: base(), files, imports: [], targets: ['src/billing/charge.js'] }));
  assert.match(md, /## Outside input reaches this code/u);
  assert.match(md, /\*\*POST \/orders\/:id\/refund\*\* \(`src\/routes\/orders\.js:12`\) reaches `refund` \(`src\/billing\/charge\.js:40`: db-write, money\); no check of who may do it found on the way/u);
  assert.match(md, /checked by `requireRole`/u);
  assert.deepEqual(readList({ map: base(), files, imports: [], targets: ['src/web/page.js'] }).flows, []);
});

test('a reach may name the tables it writes or reads; read shows them', () => {
  const withTables = { ...flow(), reaches: [{ ...flow().reaches[0], tables: ['orders', 'public.refunds'] }] };
  assert.deepEqual(mapProblems({ ...base(), flows: [withTables] }, files), []);
  const p = (t) => mapProblems({ ...base(), flows: [{ ...flow(), reaches: [{ ...flow().reaches[0], tables: t }] }] }, files).join('\n');
  assert.match(p('orders'), /tables: a list/u);
  assert.match(p(['orders; drop']), /a table name/u);
  const md = toMarkdown(readList({ map: { ...base(), flows: [withTables] }, files, imports: [], targets: ['src/billing/charge.js'] }));
  assert.match(md, /db-write, money on `orders`, `public\.refunds`\)/u);
});

test('vocabulary: the repository\'s own checks, sinks, non-checks and public entries, with evidence; fix drops gone files; read shows them', () => {
  const vocabulary = {
    checks: [{ name: 'requireRole', evidence: 'src/routes/orders.js:7', why: 'answers 403 unless the role matches' }],
    sinks: [{ call: '*WithCtx', label: 'db-write', evidence: 'src/billing/charge.js:40' }],
    notChecks: [{ name: 'get_db', why: 'opens a database session; refuses no one' }],
    public: [{ entry: 'GET /explore/*', why: 'the public explore page' }],
  };
  assert.deepEqual(mapProblems({ ...base(), vocabulary }, files), []);
  const p = (v) => mapProblems({ ...base(), vocabulary: v }, files).join('\n');
  assert.match(p({ checks: [{ name: 'requireRole' }] }), /evidence: "file:line"/u);
  assert.match(p({ checks: [{ name: 'x y', evidence: 'src/web/page.js:1' }] }), /a function or call name/u);
  assert.match(p({ checks: [{ name: '*', evidence: 'src/web/page.js:1' }] }), /a function or call name/u);
  assert.match(p({ sinks: [{ call: 'save', label: 'DB', evidence: 'src/web/page.js:1' }] }), /lowercase/u);
  assert.match(p({ notChecks: [{ name: 'get_db' }] }), /why: text/u);
  assert.match(p({ checks: [{ name: 'a', evidence: 'gone.js:3' }] }), /not a tracked file/u);
  assert.match(p({ other: [] }), /other/u);
  const { map, changes } = fixMap({ ...base(), vocabulary }, files.filter((f) => f !== 'src/billing/charge.js'));
  assert.equal(map.vocabulary.sinks, undefined);
  assert.ok(changes.some((c) => /vocabulary\.sinks: dropped \*WithCtx/u.test(c)));
  const md = toMarkdown(readList({ map: { ...base(), vocabulary }, files, imports: [], targets: ['src/routes/orders.js'] }));
  assert.match(md, /## This repository's words\n\n- `requireRole` \(`src\/routes\/orders\.js:7`\) decides who may do something: answers 403/u);
});

test('vocabulary since 0.21.0: entries, checksIf, notSinks, once and sources; read shows them, fix drops gone files', () => {
  const vocabulary = {
    entries: [{ decorator: 'Post', within: 'RestController', check: 'signed in', unless: 'skipAuth:\\s*true', evidence: 'src/routes/orders.js:3' }, { call: 'api.register', evidence: 'src/web/page.js:2', why: 'the app registers its pages here' }],
    checksIf: [{ name: 'PermissionDenied', when: 'permissions\\s*=\\s*\\(\\S', evidence: 'src/routes/orders.js:9', why: 'raised only when the mutation lists a permission' }],
    notSinks: [{ call: 'cache.set', why: 'an in-memory cache' }],
    once: [{ name: 'claimJob', evidence: 'src/billing/charge.js:12' }],
    sources: [{ call: 'getBody', evidence: 'src/routes/orders.js:20' }],
  };
  assert.deepEqual(mapProblems({ ...base(), vocabulary }, files), []);
  const p = (v) => mapProblems({ ...base(), vocabulary: v }, files).join('\n');
  assert.match(p({ entries: [{ decorator: 'Post', call: 'x', evidence: 'src/web/page.js:1' }] }), /one of "decorator"/u);
  assert.match(p({ entries: [{ call: 'x', within: 'Ctl', evidence: 'src/web/page.js:1' }] }), /within: the class decorator/u);
  assert.match(p({ entries: [{ decorator: 'Post' }] }), /evidence: "file:line"/u);
  assert.match(p({ entries: [{ decorator: 'Post', unless: 'x', evidence: 'src/web/page.js:1' }] }), /unless: .*only with "check"/u);
  assert.match(p({ entries: [{ decorator: 'Post', check: 'signed in', unless: '(', evidence: 'src/web/page.js:1' }] }), /unless: a regular expression/u);
  assert.match(p({ checksIf: [{ name: 'X', when: '(', evidence: 'src/web/page.js:1', why: 'w' }] }), /when: a regular expression/u);
  assert.match(p({ checksIf: [{ name: 'X', when: 'a', evidence: 'src/web/page.js:1' }] }), /why: text/u);
  assert.match(p({ notSinks: [{ call: 'cache.set' }] }), /why: text/u);
  assert.match(p({ notSinks: [{ call: 'cache.set', label: 'DB', why: 'w' }] }), /lowercase/u);
  assert.match(p({ once: [{ name: 'claimJob' }] }), /evidence/u);
  assert.match(p({ sources: [{ name: 'getBody', evidence: 'src/web/page.js:1' }] }), /call: a function or call name/u);
  const { map, changes } = fixMap({ ...base(), vocabulary }, files.filter((f) => f !== 'src/billing/charge.js'));
  assert.equal(map.vocabulary.once, undefined);
  assert.ok(changes.some((c) => /vocabulary\.once: dropped claimJob/u.test(c)));
  const md = toMarkdown(readList({ map: { ...base(), vocabulary }, files, imports: [], targets: ['src/routes/orders.js'] }));
  assert.match(md, /- `Post` \(`src\/routes\/orders\.js:3`\) declares a route inside `@RestController`, checked by `signed in` unless `skipAuth/u);
  assert.match(md, /- `PermissionDenied` \(`src\/routes\/orders\.js:9`\) decides who may do something only where the code matches `permissions/u);
  assert.match(md, /- `getBody` \(`src\/routes\/orders\.js:20`\) returns outside input/u);
});

test('models (0.22.0): match, is, kind; read shows them; fix drops gone files; the vocabulary is rewritten as models and rules', () => {
  const models = [
    { match: { decorator: 'Post', within: 'RestController' }, is: 'entry', kind: 'route', check: 'signed in', unless: 'skipAuth:\\s*true', evidence: 'src/routes/orders.js:3' },
    { match: { call: 'requireRole' }, is: 'check', kind: 'auth', evidence: 'src/routes/orders.js:7', why: 'answers 403 unless the role matches' },
    { match: { call: '*WithCtx' }, is: 'sink', kind: 'db-write', evidence: 'src/billing/charge.js:40' },
    { match: { extends: 'BaseUserController' }, is: 'check', kind: 'auth', evidence: 'src/routes/orders.js:2' },
    { match: { call: 'get_db' }, is: 'neutral', why: 'opens a session; refuses no one' },
  ];
  assert.deepEqual(mapProblems({ ...base(), models }, files), []);
  const p = (m) => mapProblems({ ...base(), models: m }, files).join('\n');
  assert.match(p([{ match: { call: 'a', decorator: 'b' }, is: 'check', evidence: 'src/web/page.js:1' }]), /exactly one of call, decorator, extends, file/u);
  assert.match(p([{ match: { call: 'a' }, is: 'guard', evidence: 'src/web/page.js:1' }]), /is: one of entry, check, sink, neutral/u);
  assert.match(p([{ match: { call: 'a' }, is: 'sink', evidence: 'src/web/page.js:1' }]), /required for a sink/u);
  assert.match(p([{ match: { call: 'a' }, is: 'check', check: 'x', evidence: 'src/web/page.js:1' }]), /only with is "entry"/u);
  assert.match(p([{ match: { call: 'a' }, is: 'neutral' }]), /why: text/u);
  assert.match(p([{ match: { call: 'a' }, is: 'check' }]), /evidence: "file:line"/u);
  assert.match(p([{ match: { file: 'nowhere/**' }, is: 'entry', evidence: 'src/web/page.js:1' }]), /a pattern that matches a tracked file/u);
  assert.match(p([{ match: { call: 'a', within: 'B' }, is: 'check', evidence: 'src/web/page.js:1' }]), /within: the class decorator/u);
  const { map, changes } = fixMap({ ...base(), models }, files.filter((f) => f !== 'src/billing/charge.js'));
  assert.equal(map.models.length, 4);
  assert.ok(changes.some((c) => /models: dropped \*WithCtx \(src\/billing\/charge\.js gone\)/u.test(c)));
  const md = toMarkdown(readList({ map: { ...base(), models }, files, imports: [], targets: ['src/routes/orders.js'] }));
  assert.match(md, /- `requireRole` \(`src\/routes\/orders\.js:7`\) decides who may do something \(auth\): answers 403/u);
  assert.match(md, /- `Post` \(`src\/routes\/orders\.js:3`\) is where outside input enters inside `@RestController`, checked by `signed in` unless `skipAuth/u);
  const flowPublic = { ...base(), rules: [{ id: 'public-health', rule: 'GET /health is open', files: ['src/**'], flow: { entry: 'GET /health', must: ['public'] } }] };
  assert.deepEqual(mapProblems(flowPublic, files), []);

  const vocabulary = {
    checks: [{ name: 'requireRole', evidence: 'src/routes/orders.js:7', why: 'w' }],
    sinks: [{ call: '*WithCtx', label: 'db-write', evidence: 'src/billing/charge.js:40' }],
    notChecks: [{ name: 'get_db', why: 'session' }],
    public: [{ entry: 'GET /explore/*', why: 'the public explore page' }],
    entries: [{ decorator: 'Post', within: 'RestController', evidence: 'src/routes/orders.js:3' }],
    once: [{ name: 'claimJob', evidence: 'src/billing/charge.js:12' }],
  };
  const m = migrateMap({ ...base(), vocabulary });
  assert.equal(m.map.vocabulary, undefined);
  assert.deepEqual(m.map.models.map((x) => [x.is, x.kind ?? null, Object.values(x.match)[0]]), [['entry', 'route', 'Post'], ['check', 'auth', 'requireRole'], ['sink', 'db-write', '*WithCtx'], ['neutral', null, 'get_db']]);
  assert.deepEqual(m.map.rules.at(-1), { id: 'public-get-explore', rule: 'GET /explore/* is open to anyone on purpose', why: 'the public explore page', files: ['**'], flow: { entry: 'GET /explore/*', must: ['public'] } });
  assert.ok(m.changes.some((c) => /dropped once/u.test(c)));
  assert.deepEqual(mapProblems(m.map, files), [], 'the rewritten map passes check');
  assert.deepEqual(migrateMap(base()).changes, [], 'a map with no vocabulary is left alone');
});

test('a reach may name the inputs that reach it; read shows them', () => {
  const f = { ...flow(), reaches: [{ ...flow().reaches[0], inputs: ['req.body', 'amount'] }] };
  assert.deepEqual(mapProblems({ ...base(), flows: [f] }, files), []);
  assert.match(mapProblems({ ...base(), flows: [{ ...flow(), reaches: [{ ...flow().reaches[0], inputs: 'x' }] }] }, files).join('\n'), /inputs: a list/u);
  const md = toMarkdown(readList({ map: { ...base(), flows: [f] }, files, imports: [], targets: ['src/billing/charge.js'] }));
  assert.match(md, /db-write, money, with input `req\.body`, `amount`\)/u);
});

test('a rule may carry flow: which flows it is about and what they must have on the way', () => {
  const rule = (flow) => ({ ...base(), rules: [{ id: 'refund-admin', rule: 'only admins refund', why: 'money', files: ['src/**'], flow }] });
  assert.deepEqual(mapProblems(rule({ reaches: 'payments-api', must: ['check:requireRole', 'once'] }), files), []);
  assert.deepEqual(mapProblems(rule({ entry: 'POST /orders/*', must: ['check', 'no-input'] }), files), []);
  assert.match(mapProblems(rule({ must: ['check'] }), files).join('\n'), /entry or reaches/u);
  assert.match(mapProblems(rule({ reaches: 'x', must: ['always'] }), files).join('\n'), /one of check/u);
  assert.match(mapProblems(rule({ reaches: 'x', must: [] }), files).join('\n'), /at least one/u);
  assert.match(mapProblems(rule({ reaches: 'x', must: ['check'], other: 1 }), files).join('\n'), /other/u);
});

// 0.25.0: the map stores every path (owner: store everything, cap only the work of one run). An older pinned CLI is
// told about, not silently broken.
test('flows have no count limit; a pinned readfirst before 0.25.0 is warned about more than 500', async () => {
  const { pinProblems } = await import('../src/pins.mjs');
  const many = { ...base(), flows: Array.from({ length: 900 }, (_, i) => ({ ...flow(), line: i + 1 })) };
  assert.deepEqual(mapProblems(many, files), [], '900 flows pass');
  assert.match(pinProblems(many, { version: '0.24.0', at: 'ci.yml' }).join('\n'), /more than 500 flows needs readfirst 0\.25\.0/u);
  assert.deepEqual(pinProblems(many, { version: '0.25.0', at: 'ci.yml' }), []);
  assert.deepEqual(pinProblems({ ...base(), flows: [flow()] }, { version: '0.24.0', at: 'ci.yml' }), [], '500 or fewer: nothing to say');
});
