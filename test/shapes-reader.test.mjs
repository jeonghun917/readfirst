// The shape patterns read code through the one reader (src/code.mjs). While each helper skipped strings by itself,
// a regular expression holding a quote or a parenthesis, a template inside a template and a comment after a call
// each hid a statement or miscounted its arguments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanText } from '../src/scan.mjs';
import { candidates, closeOf, discardedResults, PATTERNS } from '../src/shapes.mjs';

const L = (...a) => a.join('\n');
const ids = (path, text) => scanText(path, text).map((f) => `${f.pattern}:${f.line}`);
const added = (filename, text) => ({ filename, patch: `@@ -0,0 +1,${text.split('\n').length} @@\n${text.split('\n').map((l) => `+${l}`).join('\n')}`, status: 'added' });

test('a call is read to its end whatever its arguments hold: a quote or a parenthesis in a regular expression, a template in a template', () => {
  const js = L(
    'function clean(name, label, a) {',
    "  name.replace(/'/gu, '');",
    "  name.replace(/\\(/gu, '');",
    "  label.replace(`${a ? `(${a}` : ''}`, '');",
    '  name.trim(); /* the result is dropped */',
    '  return name;',
    '}',
  );
  assert.deepEqual(ids('src/clean.ts', js), ['js-replace:2', 'js-replace:3', 'js-replace:4', 'js-string:5']);
});

test('a pattern that reads the statement itself closes its call on the code, not on the text: a parenthesis in a string', () => {
  const t = L("test('a', async () => {", "  expect(load(')')).resolves.toBe(1);", "  expect(load('(')).rejects.toThrow();", "  expect(load(`${a ? ')' : '('}`)).resolves.toBe(1);", '  await expect(load(")")).resolves.toBe(1);', '});');
  assert.deepEqual(ids('src/user.test.ts', t), ['js-expect-promise:2', 'js-expect-promise:3', 'js-expect-promise:4']);
  // A list given from outside gets the code too, and the helper to close a call on it.
  const own = [{ id: 'own-wait', lang: /\.ts$/u, find: (stmt, code) => { const end = closeOf(code, 4); return end > 0 && stmt.startsWith('wait(') ? Object.assign(['', 'wait', 'then'], { open: 4 }) : null; }, why: () => '' }];
  assert.deepEqual(candidates(added('src/a.ts', L('function f() {', "  wait(')');", '}')), own).map((c) => c.line), [2]);
});

test('arguments are counted in code: a comma in a template or in a regular expression is not one', () => {
  // js-replace needs two arguments: with one, the call is not String.prototype.replace.
  const js = L('function f(s, a, b) {', '  s.replace(`${a ? `x,y` : b}`);', '  s.replace(/a,b/u);', "  s.replace(/a,b/u, '');", '}');
  assert.deepEqual(ids('src/a.ts', js), ['js-replace:4']);
  // The comma after the last argument starts no argument (a call written over lines ends each with one).
  const lines = L('function g(s, router) {', '  s.replace(', "    'a',", "    '',", '  );', '  s.replace(', "    '/login',", '  );', '}');
  assert.deepEqual(ids('src/b.ts', lines), ['js-replace:2']);
});

test('what is not code is not a statement: template text, and the lines of a string in Python', () => {
  const js = L('const HELP = `', 'name.trim();', '${', '  name.trim()', '}`;', 'function f(name) {', '  name.trim();', '}');
  assert.deepEqual(ids('src/help.ts', js), ['js-string:7']);
  // Text that reads like a call and holds a placeholder with a call of its own: the words are still text.
  assert.deepEqual(ids('src/gen.ts', L('const SOURCE = `', 'name.trim(${pad(width)});', '`;')), []);
  const py = L('def f(name):', '    """Example:', '    name.strip()', '    """', "    SEP = \"'''\"", '    name.strip()', '    return name');
  assert.deepEqual(ids('app/a.py', py), ['str-method:6']);
});

test('the patterns to look for are an argument: the published ones by default, another list when given', async () => {
  const own = [{ id: 'own-flush', lang: /\.ts$/u, head: /^([\w.]+)\.(flush)\(/u, why: () => 'flush returns a promise' }];
  const file = added('src/a.ts', L('function f(out, s) {', '  out.flush();', '  s.trim();', '}'));
  assert.deepEqual(candidates(file).map((c) => `${c.pattern.id}:${c.line}`), ['js-string:3']);
  assert.deepEqual(candidates(file, own).map((c) => `${c.pattern.id}:${c.line}`), ['own-flush:2']);
  assert.deepEqual((await discardedResults([file], async () => null, { patterns: own })).map((f) => `${f.ref}:${f.line}`), ['pattern:own-flush:2']);
  assert.equal(PATTERNS.some((p) => p.id === 'own-flush'), false);
});

// A pattern marked afterFile asks the whole file whether the call sits in a function and a statement follows it.
const LOOP = [{ id: 'loop-not-awaited', lang: /\.ts$/u, head: /^([\w.]+)\.(forEach)\(\s*async\b/u, long: true, afterFile: true, why: () => 'nothing waits for the callbacks' }];
const followed = async (text) => (await discardedResults([added('src/a.ts', text)], async () => text, { patterns: LOOP })).map((f) => f.line);

test('the function around a call is read from the file: a callback with no name, a method whose header runs over lines', async () => {
  assert.deepEqual(await followed(L("it('saves all', async () => {", '  items.forEach(async (x) => {', '    await save(x);', '  });', '  expect(saved).toBe(3);', '});')), [2]);
  assert.deepEqual(await followed(L('class Store {', '  async saveAll(', '    items: Item[],', '  ): Promise<void>', '  {', '    items.forEach(async (x) => { await this.save(x); });', '    this.done = true;', '  }', '}')), [6]);
  // Not in a function: the loop is a statement of the module.
  assert.deepEqual(await followed(L('items.forEach(async (x) => {', '  await save(x);', '});', 'done();')), []);
  // An if is not a function: the statement after it, in the function that holds both, follows the loop.
  assert.deepEqual(await followed(L('function run(items) {', '  if (items.length) {', '    items.forEach(async (x) => { await save(x); });', '  }', '  report();', '}')), [3]);
});

test('what follows a call is code: a comment, or the text of a template that happens to sit below, is not a statement', async () => {
  assert.deepEqual(await followed(L('function run(items) {', '  items.forEach(async (x) => { await save(x); });', '  /* nothing', '  waits for them */', '}')), []);
  assert.deepEqual(await followed(L('function run(items) {', '  const help = `', '  usage', '  `;', '  items.forEach(async (x) => { await save(x); });', '  /*', '  `', '  */', '}')), []);
  assert.deepEqual(await followed(L('function run(items) {', '  try {', '    items.forEach(async (x) => { await save(x); });', '  } catch (e) {', '    report(e);', '  }', '}')), [], 'the catch runs instead of what follows, not after it');
});

test('a bracket in a string or a comment opens nothing: the statement after it is still a statement', () => {
  const js = L('function f(name, s) {', "  name.replace('(', '');", '  const n = 1; // see (', '  s.trim();', "  const open = 'x'", '  {', '    s.trimEnd();', '  }', '}');
  assert.deepEqual(ids('src/a.ts', js), ['js-replace:2', 'js-string:4', 'js-string:7'], 'a string is a value: the brace on the line after it opens a block');
  const py = L('def f(name):', '    opener = "("', '    name.strip()', '    return name');
  assert.deepEqual(ids('app/a.py', py), ['str-method:3']);
});

test('the brace after case x: and default: opens a block: its lines are statements', () => {
  const js = L('function f(kind, name) {', '  switch (kind) {', "    case 'a': {", '      name.trim();', '      break;', '    }', '    default: {', '      name.trimEnd();', '    }', '  }', "  const o = { a: { b: name.trim() } };", '}');
  assert.deepEqual(ids('src/a.ts', js), ['js-string:4', 'js-string:8']);
});

test('what stays out: a call that takes a triple-quoted string (Python), a call an expression goes on from below a comment', () => {
  assert.deepEqual(ids('app/a.py', L('def f(label):', '    label.strip("""x""")', '    return label')), []);
  assert.deepEqual(ids('src/a.ts', L('function f(name) {', '  const n = name', '    .trim()', '  name.trim()', '    // the length is what is used', '    .length;', '}')), []);
});

test('the function around a call: a function with no name passed to a call, and not a function that closed above the call', async () => {
  assert.deepEqual(await followed(L("app.get('/x', function (req, res) {", '  items.forEach(async (x) => { await save(x); });', '  res.end();', '});')), [2]);
  assert.deepEqual(await followed(L('function run(items) {', '  const helper = () => {', '    go();', '  };', '  items.forEach(async (x) => { await save(x); });', '  report();', '}')), [5]);
  // The function ends where its brace closes, whatever is indented how below it.
  assert.deepEqual(await followed(L('const store = {', '  run(items) {', '    items.forEach(async (x) => { await save(x); });', '  },', '  other: 1,', '};')), []);
});
