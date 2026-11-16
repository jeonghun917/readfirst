import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countSteps } from '../src/code.mjs';
import { flowSteps } from '../src/flow.mjs';
import { linearIn, timeShapes } from './linear-time.mjs';

// The steps of the function named `name` (the module's for null).
const stepsOf = (text, name = null, path = 'a.py') => {
  const out = flowSteps(path, text);
  const body = out.bodies.find((b) => b.name === name);
  assert.ok(body, `no body named ${name}: ${out.bodies.map((b) => b.name).join(', ')}`);
  return body.steps;
};
// A value or cond without its reference numbers, to compare by shape.
const shape = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'ref' || k === 'binding' || k === 'line' ? undefined : x)));
const condOf = (src) => shape(stepsOf(`def f(x, y, C):\n    if ${src}:\n        pass\n`, 'f')[0].cond);
const valueOf = (src) => shape(stepsOf(`def f(x, y, C):\n    v = ${src}\n`, 'f')[0].value);
const X = { k: 'ref', name: 'x' };

// ------------------------------------------------------------------------------------------------------- predicates

test('flow, Python: `is None` and `is not None`, `== None` and `!= None`, either side', () => {
  assert.deepEqual(condOf('x is None'), { k: 'none', of: X, neg: false });
  assert.deepEqual(condOf('x is not None'), { k: 'none', of: X, neg: true });
  assert.deepEqual(condOf('x == None'), { k: 'none', of: X, neg: false });
  assert.deepEqual(condOf('x != None'), { k: 'none', of: X, neg: true });
  assert.deepEqual(condOf('None is not x'), { k: 'none', of: X, neg: true });
  assert.deepEqual(condOf('x.y is None'), { k: 'none', of: { k: 'attr', of: X, name: 'y' }, neg: false });
});

test('flow, Python: truthiness of a value, and not', () => {
  assert.deepEqual(condOf('x'), { k: 'truthy', of: X });
  assert.deepEqual(condOf('not x'), { k: 'not', of: { k: 'truthy', of: X } });
  assert.deepEqual(condOf('x.ok()'), { k: 'truthy', of: { k: 'call', callee: { k: 'attr', of: X, name: 'ok' }, args: [] } });
  assert.deepEqual(condOf('(x)'), { k: 'truthy', of: X });
});

test('flow, Python: isinstance with one class or a tuple; a shadowed isinstance is just a call', () => {
  assert.deepEqual(condOf('isinstance(x, C)'), { k: 'isinstance', of: X, types: [{ k: 'ref', name: 'C' }] });
  assert.deepEqual(condOf('isinstance(x, (C, dict))'), { k: 'isinstance', of: X, types: [{ k: 'ref', name: 'C' }, { k: 'ref', name: 'dict' }] });
  const steps = stepsOf('def isinstance(a, b):\n    return 1\nif isinstance(x, int):\n    pass\n');
  assert.equal(steps[1].cond.k, 'truthy');
});

test('flow, Python: and, or and not nest by precedence', () => {
  assert.deepEqual(condOf('x is not None and isinstance(x, C)'), { k: 'and', of: [{ k: 'none', of: X, neg: true }, { k: 'isinstance', of: X, types: [{ k: 'ref', name: 'C' }] }] });
  assert.deepEqual(condOf('x or y and not x'), {
    k: 'or',
    of: [{ k: 'truthy', of: X }, { k: 'and', of: [{ k: 'truthy', of: { k: 'ref', name: 'y' } }, { k: 'not', of: { k: 'truthy', of: X } }] }],
  });
  assert.deepEqual(condOf('(x or y) and x'), { k: 'and', of: [{ k: 'or', of: [{ k: 'truthy', of: X }, { k: 'truthy', of: { k: 'ref', name: 'y' } }] }, { k: 'truthy', of: X }] });
});

test('flow, Python: every other condition is opaque with its text', () => {
  assert.deepEqual(condOf('x > 1'), { k: 'opaque', text: 'x>1' });
  assert.deepEqual(condOf('x == y'), { k: 'opaque', text: 'x== y' });
  assert.deepEqual(condOf('x is None is y'), { k: 'opaque', text: 'x is None is y' });
  assert.deepEqual(condOf('x in y'), { k: 'opaque', text: 'x in y' });
  assert.equal(condOf('(n := len(x)) > 1').k, 'opaque');
});

// ----------------------------------------------------------------------------------------------------------- values

test('flow, Python: references, attributes, indexes and calls, with keyword and spread arguments', () => {
  assert.deepEqual(valueOf('x.a[y].b(1, k=y, *x, **y)'), {
    k: 'call',
    callee: { k: 'attr', of: { k: 'index', of: { k: 'attr', of: X, name: 'a' }, key: { k: 'ref', name: 'y' } }, name: 'b' },
    args: [{ value: { k: 'lit', v: 'num', text: '1' } }, { name: 'k', value: { k: 'ref', name: 'y' } }, { spread: '*', value: X }, { spread: '**', value: { k: 'ref', name: 'y' } }],
  });
});

test('flow, Python: literals, and the uses an f-string holds', () => {
  assert.deepEqual(valueOf('None'), { k: 'lit', v: 'None' });
  assert.deepEqual(valueOf('1.5'), { k: 'lit', v: 'num', text: '1.5' });
  assert.deepEqual(valueOf('-2'), { k: 'lit', v: 'num', text: '-2' });
  assert.deepEqual(valueOf('"a" "b"'), { k: 'lit', v: 'str' });
  assert.deepEqual(valueOf('f"{x.a} and {y!r} {x:>10}"'), { k: 'lit', v: 'str', uses: [{ k: 'attr', of: X, name: 'a' }, { k: 'ref', name: 'y' }, X] });
  assert.deepEqual(valueOf('(x, y)'), { k: 'lit', v: 'tuple', items: [X, { k: 'ref', name: 'y' }] });
  assert.deepEqual(valueOf('x, *y'), { k: 'lit', v: 'tuple', items: [X, { k: 'ref', name: 'y', spread: '*' }] });
  assert.deepEqual(valueOf('x if y else C, x'), { k: 'lit', v: 'tuple', items: [{ k: 'choice', cond: { k: 'truthy', of: { k: 'ref', name: 'y' } }, then: X, else: { k: 'ref', name: 'C' } }, X] });
  assert.deepEqual(valueOf('()'), { k: 'lit', v: 'tuple', items: [] });
  assert.deepEqual(valueOf('[x]'), { k: 'lit', v: 'list', items: [X] });
  assert.deepEqual(valueOf('{x: y}'), { k: 'lit', v: 'dict' });
  assert.deepEqual(valueOf('{x}'), { k: 'lit', v: 'set' });
  assert.deepEqual(valueOf('(x)'), X);
});

test('flow, Python: a conditional expression is a choice; a call of a class the file binds constructs it', () => {
  assert.deepEqual(valueOf('x if y is None else C'), { k: 'choice', cond: { k: 'none', of: { k: 'ref', name: 'y' }, neg: false }, then: X, else: { k: 'ref', name: 'C' } });
  const steps = stepsOf('class Store:\n    pass\ns = Store(1)\nt = await make()\n');
  assert.equal(steps[1].value.k, 'new');
  assert.deepEqual(shape(steps[2].value), { k: 'call', callee: { k: 'ref', name: 'make' }, args: [], await: true });
});

test('flow, Python: arithmetic, comprehensions, `or` defaults and comparisons as values are opaque', () => {
  assert.deepEqual(valueOf('x + 1'), { k: 'opaque', text: 'x+1' });
  assert.deepEqual(valueOf('x or y'), { k: 'opaque', text: 'x or y' });
  assert.deepEqual(valueOf('x is None'), { k: 'opaque', text: 'x is None' });
  assert.equal(valueOf('(a for a in x)').k, 'opaque');
  assert.deepEqual(valueOf('[a for a in x]'), { k: 'lit', v: 'list', text: '[a for a in x]' });
  assert.deepEqual(valueOf('f(x + 1)'), { k: 'call', callee: { k: 'ref', name: 'f' }, args: [{ value: { k: 'opaque', text: 'x+1' } }] });
});

test('flow, Python: a value nested deeper than CPython parses (200) is opaque with nesting, its text whole', () => {
  const v = valueOf(`${'f('.repeat(250)}x${')'.repeat(250)}`);
  let depth = 0;
  let w = v;
  while (w.k === 'call') { depth++; w = w.args[0].value; }
  assert.equal(depth, 200);
  assert.equal(w.k, 'opaque');
  assert.equal(w.nesting, true);
  assert.equal(w.text, `${'f('.repeat(50)}x${')'.repeat(50)}`);
});

test('flow, Python: a lambda is a function value, its body a scope of the table', () => {
  const out = flowSteps('a.py', 'g = lambda z: z + 1\n');
  const v = out.bodies[0].steps[0].value;
  assert.equal(v.k, 'fn');
  assert.equal(out.table.scopes[v.scope].kind, 'function');
});

// ------------------------------------------------------------------------------------------------------------ steps

test('flow, Python: assignments bind what the scope table binds; tuples, stars, attributes, chains and +=', () => {
  const out = flowSteps('a.py', 'a = b = 1\nx, *rest = y\nself.z = 2\nn += 1\nm: int = 3\n');
  const [one, two, three, four, five] = out.bodies[0].steps;
  assert.deepEqual(one.targets.map((t) => out.table.bindings[t.binding].name), ['a', 'b']);
  assert.deepEqual(shape(two.targets), [{ k: 'tuple', items: [{ k: 'name', name: 'x' }, { k: 'name', name: 'rest', star: true }] }]);
  assert.deepEqual(shape(three.targets), [{ k: 'attr', of: { k: 'ref', name: 'self' }, name: 'z' }]);
  assert.equal(four.aug, '+=');
  assert.equal(out.table.bindings[five.targets[0].binding].how, 'assign');
  assert.ok(out.table.bindings[five.targets[0].binding].annotation);
});

test('flow, Python: if, elif and else nest as branches; a body on the header\'s line is its body', () => {
  const steps = stepsOf('if x: y = 1\nelif y:\n    z = 2\n    w = 3\nelse:\n    return\nq = 4\n');
  assert.equal(steps.length, 2);
  const [b] = steps;
  assert.equal(b.op, 'branch');
  assert.equal(b.then[0].op, 'assign');
  assert.equal(b.else[0].op, 'branch');
  assert.equal(b.else[0].then.length, 2);
  assert.equal(b.else[0].else[0].op, 'return');
  assert.equal(steps[1].line, 7);
});

test('flow, Python: a walrus in a header is no end of it: the body is the loop\'s (scopes read `:=` as the header\'s `:`)', () => {
  const steps = stepsOf('def f(fp):\n    while line := fp.readline():\n        print(line)\n    if m := fp.x(): return m\n', 'f');
  assert.deepEqual(steps.map((s) => s.op), ['loop', 'branch']);
  assert.equal(steps[0].body[0].op, 'call');
  assert.equal(steps[0].cond.k, 'opaque');
  assert.equal(steps[1].then[0].op, 'return');
});

test('flow, Python: for and while are loops with their else; try with handlers, else and finally; with items', () => {
  const steps = stepsOf([
    'for k, v in x.items():', '    break', 'else:', '    pass',
    'while not x:', '    continue',
    'try:', '    a = 1', 'except (KeyError, ValueError) as e:', '    raise', 'except Exception:', '    pass', 'except:', '    pass', 'else:', '    b = 1', 'finally:', '    c = 1',
    'with open(p) as fh, lock:', '    d = fh.read()', '',
  ].join('\n'));
  const [loop, loop2, t, w] = steps;
  assert.equal(loop.kind, 'for');
  assert.deepEqual(shape(loop.target), { k: 'tuple', items: [{ k: 'name', name: 'k' }, { k: 'name', name: 'v' }] });
  assert.equal(loop.body[0].op, 'break');
  assert.deepEqual(loop.else, []);
  assert.deepEqual(shape(loop2.cond), { k: 'not', of: { k: 'truthy', of: X } });
  assert.equal(t.handlers.length, 3);
  assert.equal(t.handlers[0].types.length, 2);
  assert.ok(t.handlers[0].binding !== null);
  assert.equal(t.handlers[2].types, null);
  assert.equal(t.else.length, 1);
  assert.equal(t.finally.length, 1);
  assert.equal(w.items.length, 2);
  assert.equal(w.items[0].target.k, 'name');
  assert.equal(w.items[1].target, null);
});

test('flow, Python: a match is a branch per case, conds opaque; `case _` is the last else', () => {
  const steps = stepsOf('def f(c):\n    match c:\n        case [a, b]:\n            return a\n        case {"k": v}:\n            return v\n        case _:\n            return None\n', 'f');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].cond.text, 'match c case [a, b]');
  assert.equal(steps[0].else[0].cond.k, 'opaque');
  assert.equal(steps[0].else[0].else[0].op, 'return');
});

test('flow, Python: defs and classes are steps of their body and entries of their own, with decorators', () => {
  const out = flowSteps('a.py', '@app.route("/x")\ndef view(r):\n    return r\nclass C(Base):\n    n = 1\n    def m(self):\n        return self.n\n');
  const [view, cls] = out.bodies[0].steps;
  assert.equal(view.op, 'def');
  assert.equal(view.decorators[0].k, 'call');
  assert.equal(cls.op, 'class');
  assert.deepEqual(out.bodies.map((b) => [b.kind, b.name]), [['module', null], ['function', 'view'], ['class', 'C'], ['function', 'm']]);
  assert.equal(out.bodies[3].steps[0].op, 'return');
});

test('flow, Python: imports name their bindings; assert, raise, del and global; an expression is expr or call', () => {
  const out = flowSteps('a.py', 'import os, sys as s\nfrom a import b\nassert x is not None, "x"\nraise E()\ndel x\nprint(1)\nx[0]\n');
  const steps = out.bodies[0].steps;
  assert.deepEqual(steps[0].bindings.map((b) => out.table.bindings[b].name), ['os', 's']);
  assert.deepEqual(steps[1].bindings.map((b) => out.table.bindings[b].name), ['b']);
  assert.deepEqual(shape(steps[2].cond), { k: 'none', of: X, neg: true });
  assert.equal(steps[3].op, 'raise');
  assert.equal(steps[4].op, 'opaque');
  assert.equal(steps[5].op, 'call');
  assert.equal(steps[6].op, 'expr');
});

test('flow, Python: the netbox shape: a value set to None under a condition, used under `is not None`', () => {
  const steps = stepsOf([
    'def post(self, request, pk=None):',
    '    obj = None',
    '    if pk:',
    '        obj = get_object_or_404(IPAddress, pk=pk)',
    '    if obj is not None:',
    '        obj.assign(request.user)',
    '',
  ].join('\n'), 'post');
  assert.deepEqual(steps.map((s) => s.op), ['assign', 'branch', 'branch']);
  assert.equal(steps[1].then[0].targets[0].name, 'obj');
  assert.notEqual(steps[0].targets[0].binding, steps[1].then[0].targets[0].binding);
  assert.deepEqual(shape(steps[2].cond), { k: 'none', of: { k: 'ref', name: 'obj' }, neg: true });
});

test('flow: a JavaScript file is not lowered yet; a file the reader does not read is null', () => {
  assert.equal(flowSteps('a.js', 'const x = 1;').bodies, null);
  assert.equal(flowSteps('a.txt', 'x'), null);
});

// ------------------------------------------------------------------------------------------------------------ linear

const FLOW_SHAPES = {
  'py: a long elif chain': (n) => `def f(x):\n    if x is None:\n        y = 0\n${Array.from({ length: n / 40 }, (_, i) => `    elif x == ${i}:\n        y = x.a()\n`).join('')}`,
  'py: a long and chain': (n) => `if ${'x is not None and '.repeat(n / 20)}x:\n    pass\n`,
  'py: a long or chain of nots': (n) => `if ${'not x or '.repeat(n / 10)}x:\n    pass\n`,
  'py: a ternary chain': (n) => `v = ${'a if c else '.repeat(n / 12)}z\n`,
  'py: a ternary chain in a condition': (n) => `if ${'a if c else '.repeat(n / 12)}z:\n    pass\n`,
  'py: a run of not': (n) => `if ${'not '.repeat(n / 4)}x:\n    pass\n`,
  'py: deep parentheses in a condition': (n) => `if ${'('.repeat(n / 2)}x${')'.repeat(n / 2)}:\n    pass\n`,
  'py: deep subscripts': (n) => `v = a${'[b[c]]'.repeat(n / 6)}\n`,
  'py: calls nested in arithmetic': (n) => `v = ${'f(1 + '.repeat(n / 7)}x${')'.repeat(n / 7)}\n`,
  'py: deep calls': (n) => `v = ${'f('.repeat(n / 2)}x${')'.repeat(n / 2)}\n`,
  'py: a long member chain with calls': (n) => `a = 1\na${'.b(a)[a].c'.repeat(n / 11)}\n`,
  'py: many statements': (n) => `def f(x):\n${'    x = g(x.a, k=x) if x else None\n'.repeat(n / 36)}`,
  'py: deep ifs': (n) => Array.from({ length: Math.floor(Math.sqrt(n)) }, (_, i) => `${' '.repeat(i)}if x:\n`).join('') + `${' '.repeat(Math.floor(Math.sqrt(n)))}pass\n`,
  'py: a long try': (n) => `try:\n    pass\n${'except E as e:\n    raise\n'.repeat(n / 27)}`,
  'py: many f-string placeholders': (n) => `s = f"${'{x.a} '.repeat(n / 6)}"\n`,
};

test('flow: linear steps in the length of a file, its nesting and its chains', () => {
  for (const [name, make] of Object.entries(FLOW_SHAPES)) {
    const count = (n) => { const text = make(n); countSteps(true); flowSteps('a.py', text); return countSteps(false); };
    const [small, big] = [count(2_000), count(32_000)];
    assert.ok(small > 0 && big < small * 20, `${name}: ${small} steps at 2,000 characters, ${big} at 32,000 (${(big / small).toFixed(1)} times)`);
  }
});

test('flow: linear time in the length of a file, its nesting and its chains', async () => {
  const { done, said } = await timeShapes(FLOW_SHAPES, new URL('../src/flow.mjs', import.meta.url).href, 'flowSteps', new Function('fn', 'text', 'return fn(\'a.py\', text);'));
  assert.ok(linearIn(done, FLOW_SHAPES), said);
});
