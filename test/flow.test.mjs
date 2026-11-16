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
  assert.deepEqual(valueOf('{x: y}'), { k: 'lit', v: 'dict', entries: [{ key: X, value: { k: 'ref', name: 'y' } }] });
  assert.deepEqual(valueOf('{"form": x, **y}'), { k: 'lit', v: 'dict', entries: [{ key: { k: 'lit', v: 'str' }, name: 'form', value: X }, { spread: '**', value: { k: 'ref', name: 'y' } }] });
  assert.deepEqual(valueOf('{}'), { k: 'lit', v: 'dict', entries: [] });
  assert.deepEqual(valueOf('{x}'), { k: 'lit', v: 'set', items: [X] });
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
  assert.equal(steps[1].then[0].op, 'return');
  // The walrus's value is what the condition tests, with the name it binds.
  assert.deepEqual(shape(steps[0].cond), { k: 'truthy', of: { k: 'call', callee: { k: 'attr', of: { k: 'ref', name: 'fp' }, name: 'readline' }, args: [], binds: { k: 'name', name: 'line' } } });
  assert.equal(stepsOf('def f(x):\n    if (m := x.get()) is not None:\n        pass\n', 'f')[0].cond.of.binds.name, 'm');
});

test('flow, Python: raise from keeps its cause apart; params with defaults, stars and keyword-only; lambda bodies', () => {
  const out = flowSteps('a.py', 'def f(self, request, pk=None, *args, k: int = 1, **kw):\n    raise E(pk) from err\ng = lambda a, b=2: a.x\n');
  const f = out.bodies.find((b) => b.name === 'f');
  assert.deepEqual(shape(f.params), [
    { target: { k: 'name', name: 'self' }, default: null },
    { target: { k: 'name', name: 'request' }, default: null },
    { target: { k: 'name', name: 'pk' }, default: { k: 'lit', v: 'None' } },
    { target: { k: 'name', name: 'args' }, default: null, star: '*' },
    { target: { k: 'name', name: 'k' }, default: { k: 'lit', v: 'num', text: '1' } },
    { target: { k: 'name', name: 'kw' }, default: null, star: '**' },
  ]);
  assert.deepEqual(shape(f.steps[0]), { op: 'raise', value: { k: 'call', callee: { k: 'ref', name: 'E' }, args: [{ value: { k: 'ref', name: 'pk' } }] }, cause: { k: 'ref', name: 'err' } });
  const lambda = out.bodies.find((b) => b.scope === out.bodies[0].steps[1].value.scope);
  assert.deepEqual(shape(lambda.params), [{ target: { k: 'name', name: 'a' }, default: null }, { target: { k: 'name', name: 'b' }, default: { k: 'lit', v: 'num', text: '2' } }]);
  assert.deepEqual(shape(lambda.steps), [{ op: 'return', value: { k: 'attr', of: { k: 'ref', name: 'a' }, name: 'x' } }]);
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

test('flow: a file the reader does not read is null', () => {
  assert.equal(flowSteps('a.txt', 'x'), null);
});

// ------------------------------------------------------------------------------------------- JavaScript, TypeScript

const jsCond = (src, path = 'a.ts') => shape(stepsOf(`function f(x, y, C) {\n  if (${src}) {}\n}\n`, 'f', path)[0].cond);
const jsValue = (src, path = 'a.ts') => shape(stepsOf(`function f(x, y, C) {\n  const v = ${src};\n}\n`, 'f', path)[0].value);

test('flow, JS: null and undefined: strict comparisons say which, loose ones either; typeof undefined too', () => {
  assert.deepEqual(jsCond('x === null'), { k: 'none', of: X, neg: false, exact: 'null' });
  assert.deepEqual(jsCond('x !== undefined'), { k: 'none', of: X, neg: true, exact: 'undefined' });
  assert.deepEqual(jsCond('x == null'), { k: 'none', of: X, neg: false });
  assert.deepEqual(jsCond('null != x'), { k: 'none', of: X, neg: true });
  assert.deepEqual(jsCond("typeof x === 'undefined'"), { k: 'none', of: X, neg: false, exact: 'undefined' });
  // A local named undefined is not the value undefined.
  const steps = stepsOf('function f(x, undefined) {\n  if (x === undefined) {}\n}\n', 'f', 'a.js');
  assert.equal(steps[0].cond.k, 'opaque');
});

test('flow, JS: typeof, instanceof, !, && and ||', () => {
  assert.deepEqual(jsCond("typeof x === 'string'"), { k: 'typeof', of: X, is: 'string', neg: false });
  assert.deepEqual(jsCond("'function' !== typeof x"), { k: 'typeof', of: X, is: 'function', neg: true });
  assert.deepEqual(jsCond('x instanceof C'), { k: 'isinstance', of: X, types: [{ k: 'ref', name: 'C' }] });
  assert.deepEqual(jsCond('!x'), { k: 'not', of: { k: 'truthy', of: X } });
  assert.deepEqual(jsCond('x && !y || x'), { k: 'or', of: [{ k: 'and', of: [{ k: 'truthy', of: X }, { k: 'not', of: { k: 'truthy', of: { k: 'ref', name: 'y' } } }] }, { k: 'truthy', of: X }] });
  assert.deepEqual(jsCond('(x != null) && x.ok'), { k: 'and', of: [{ k: 'none', of: X, neg: true }, { k: 'truthy', of: { k: 'attr', of: X, name: 'ok' } }] });
  assert.equal(jsCond('x ?? y').k, 'opaque');
  assert.equal(jsCond("x === 'a'").k, 'opaque');
  assert.equal(jsCond('x < y').k, 'opaque');
});

test('flow, JS: values: optional chains, non-null, generic calls, new, templates, as, choices, functions', () => {
  assert.deepEqual(jsValue('x?.a!.b<string>(y)?.[0]'), {
    k: 'index', optional: true, key: { k: 'lit', v: 'num', text: '0' },
    of: { k: 'call', callee: { k: 'attr', name: 'b', of: { k: 'attr', name: 'a', optional: true, of: X } }, args: [{ value: { k: 'ref', name: 'y' } }] },
  });
  assert.deepEqual(jsValue('new C.D<T>(x)'), { k: 'new', callee: { k: 'attr', of: { k: 'ref', name: 'C' }, name: 'D' }, args: [{ value: X }] });
  assert.deepEqual(jsValue('new C'), { k: 'new', callee: { k: 'ref', name: 'C' }, args: [] });
  assert.deepEqual(jsValue('`a ${x.b} c`'), { k: 'lit', v: 'str', uses: [{ k: 'attr', of: X, name: 'b' }] });
  assert.deepEqual(jsValue('x.y as Store'), { k: 'attr', of: X, name: 'y', as: 'Store' });
  assert.deepEqual(jsValue('x ? y : null'), { k: 'choice', cond: { k: 'truthy', of: X }, then: { k: 'ref', name: 'y' }, else: { k: 'lit', v: 'null' } });
  assert.deepEqual(jsValue('x ? y ? 1 : 2 : 3').else, { k: 'lit', v: 'num', text: '3' });
  assert.deepEqual(jsValue('[x, ...y]'), { k: 'lit', v: 'list', items: [X, { k: 'ref', name: 'y', spread: '...' }] });
  assert.deepEqual(jsValue('(0, x.f)'), { k: 'attr', of: X, name: 'f' });
  assert.deepEqual(jsValue('void 0'), { k: 'lit', v: 'undefined' });
  assert.deepEqual(jsValue('x.sql`select ${y}`'), { k: 'call', callee: { k: 'attr', of: X, name: 'sql' }, args: [{ value: { k: 'lit', v: 'str', uses: [{ k: 'ref', name: 'y' }] } }], tagged: true });
  assert.deepEqual(shape(stepsOf('function f(x) {\n  void x.go();\n}\n', 'f', 'a.js')), [{ op: 'call', value: { k: 'call', callee: { k: 'attr', of: X, name: 'go' }, args: [] } }]);
  assert.deepEqual(jsValue('/a+/g'), { k: 'lit', v: 'regex' });
  assert.equal(jsValue('x ?? y').k, 'opaque');
  assert.equal(jsValue('x + 1').k, 'opaque');
  assert.equal(jsValue('(a) => a').k, 'fn');
  assert.equal(jsValue('async function () {}').k, 'fn');
  assert.equal(jsValue('class extends C {}').k, 'class');
  assert.deepEqual(jsValue('<div a={x}>t</div>', 'a.jsx'), { k: 'lit', v: 'jsx' });
});

test('flow, JS: declarations and assignments: patterns with keys, defaults and rest; chains, += and ++', () => {
  const out = flowSteps('a.ts', 'const { a, b: c = 1, ...r } = x, [d, , ...e] = y;\nlet f: number;\nthis.g = h = 2;\ni += 1;\ni++;\n--i;\nlet h, i;\n');
  const [one, two, three, four, five, six, seven] = out.bodies[0].steps;
  assert.deepEqual(shape(one.targets[0]), { k: 'object', items: [{ key: 'a', target: { k: 'name', name: 'a' } }, { key: 'b', target: { k: 'name', name: 'c' }, default: { k: 'lit', v: 'num', text: '1' } }], rest: { k: 'name', name: 'r' } });
  assert.deepEqual(shape(two.targets[0]), { k: 'tuple', items: [{ k: 'name', name: 'd' }, null, { k: 'name', name: 'e', star: true }] });
  assert.equal(three.value, null);
  assert.deepEqual(shape(four.targets), [{ k: 'attr', of: { k: 'ref', name: 'this' }, name: 'g' }, { k: 'name', name: 'h' }]);
  assert.equal(out.table.bindings[four.targets[1].binding].how, 'assign');
  assert.equal(five.aug, '+=');
  assert.equal(six.aug, '++');
  assert.equal(seven.aug, '--');
});

test('flow, JS: if and else if, for (;;), for of, for in, while, do; break and continue with labels', () => {
  const steps = stepsOf([
    'if (x) a(); else if (y) { b(); } else c();',
    'for (let i = 0; i < 3; i++) { if (i) continue; }',
    'outer: for (const [k, v] of Object.entries(x)) break outer;',
    'for (k in x) {}',
    'while (!x) x = 1;',
    'do { x-- } while (x)',
    '',
  ].join('\n'), null, 'a.js');
  assert.deepEqual(steps.map((s) => s.op), ['branch', 'assign', 'loop', 'loop', 'loop', 'loop', 'loop']);
  assert.equal(steps[0].else[0].op, 'branch');
  assert.equal(steps[0].else[0].else[0].op, 'call');
  assert.equal(steps[2].cond.k, 'opaque');
  assert.deepEqual(steps[2].body.map((s) => s.op), ['branch', 'assign']);
  assert.equal(steps[3].target.k, 'tuple');
  assert.equal(steps[3].body[0].op, 'break');
  assert.equal(steps[4].keys, true);
  assert.equal(steps[5].kind, 'while');
  assert.equal(steps[6].kind, 'do');
  assert.equal(steps[6].cond.k, 'truthy');
});

test('flow, JS: try, catch with its binding, finally; throw is raise; switch is a branch per case', () => {
  const steps = stepsOf([
    'function f(x) {',
    '  try { g(); } catch (e: unknown) { throw e; } finally { h(); }',
    '  try { g(); } catch { }',
    "  switch (x.kind) { case 'a': a(); break; case 'b': case 'c': b(); default: c(); }",
    '  return',
    '  x;',
    '}',
  ].join('\n'), 'f', 'a.ts');
  assert.deepEqual(steps.map((s) => s.op), ['try', 'try', 'branch', 'return', 'expr']);
  assert.ok(steps[0].handlers[0].binding !== null);
  assert.equal(steps[0].handlers[0].body[0].op, 'raise');
  assert.equal(steps[0].finally.length, 1);
  assert.equal(steps[1].handlers[0].binding, null);
  assert.equal(steps[2].cond.text, "switch x.kind case 'a'");
  assert.deepEqual(steps[2].then.map((s) => s.op), ['call']);
  // `case 'b': case 'c':` is one branch: 'b' falls through to c's statements.
  assert.equal(steps[2].else[0].cond.text, "switch x.kind case 'b' | 'c'");
  assert.equal(steps[2].else[0].then[0].op, 'call');
  assert.equal(steps[2].else[0].else[0].op, 'call');
  assert.equal(steps[3].value, null);
  const withDefault = stepsOf("switch (x) { case 1: case 2: default: d(); }\n", null, 'a.js');
  assert.deepEqual(withDefault.map((s) => s.op), ['call']);
});

test('flow, JS: an object literal\'s entries: keys, shorthands, computed keys, spreads, methods and accessors', () => {
  const out = flowSteps('a.ts', 'const k = 1, u = 2;\nconst o = { a: k, u, [k]: 3, "s-x": u, ...u, m(x) { return x }, get p() { return 1 }, n: () => 1, [k](y) {} };\n');
  const v = out.bodies[0].steps[2].value;
  assert.deepEqual(shape(v.entries.slice(0, 5)), [
    { name: 'a', value: { k: 'ref', name: 'k' } },
    { name: 'u', value: { k: 'ref', name: 'u' } },
    { key: { k: 'ref', name: 'k' }, value: { k: 'lit', v: 'num', text: '3' } },
    { name: 's-x', value: { k: 'ref', name: 'u' } },
    { spread: '...', value: { k: 'ref', name: 'u' } },
  ]);
  assert.deepEqual(v.entries.slice(5).map((e) => [e.name ?? e.key.name, e.value.k]), [['m', 'fn'], ['p', 'fn'], ['n', 'fn'], ['k', 'fn']]);
  assert.equal(out.bodies.find((b) => b.scope === v.entries[5].value.scope).steps[0].op, 'return');
});

test('flow, JS: `!` binds tighter than a comparison; a comma statement is its parts; a tuple item\'s default', () => {
  assert.equal(jsCond('!x === y').k, 'opaque');
  assert.equal(jsCond('!x instanceof C').k, 'opaque');
  assert.deepEqual(jsCond('!(x === null)'), { k: 'not', of: { k: 'none', of: X, neg: false, exact: 'null' } });
  assert.deepEqual(jsCond('!!x'), { k: 'not', of: { k: 'not', of: { k: 'truthy', of: X } } });
  const out = flowSteps('a.js', 'let a, b, c;\na = 1, b = f(1, 2), c++;\nconst [d = 1, e] = c;\n');
  const steps = out.bodies[0].steps;
  // `let a, b, c;` is a step per declarator, then the comma statement's three.
  assert.deepEqual(steps.slice(3, 6).map((s) => [s.op, s.targets[0].name, s.aug]), [['assign', 'a', undefined], ['assign', 'b', undefined], ['assign', 'c', '++']]);
  assert.deepEqual(shape(steps[6].targets[0]), { k: 'tuple', items: [{ k: 'name', name: 'd', default: { k: 'lit', v: 'num', text: '1' } }, { k: 'name', name: 'e' }] });
});

test('flow: what a reader of paths needs: labels, global and nonlocal, hoisting, assignments inside expressions', () => {
  const js = flowSteps('a.js', 'let m, x;\nif ((m = re.exec(s))) {}\nwhile ((x = it.next()) !== null) {}\nf((x ||= 2));\nouter: for (const a of b) { for (;;) { break outer; } }\nfunction g() {}\n').bodies[0].steps;
  assert.equal(js[2].cond.of.binds.name, 'm');
  assert.equal(js[3].cond.of.binds.name, 'x');
  assert.equal(js[3].cond.exact, 'null');
  assert.deepEqual(shape(js[4].value.args[0].value), { k: 'opaque', text: 'x||=2', binds: { k: 'name', name: 'x' }, aug: '||=' });
  assert.equal(js[5].label, 'outer');
  assert.deepEqual(shape(js[5].body[0].body[0]), { op: 'break', label: 'outer' });
  assert.equal(js[6].hoisted, true);
  assert.equal(jsValue('c ? x = 1 : y').k, 'choice');
  const out = flowSteps('a.py', 'x = 1\ndef f():\n    def g():\n        nonlocal y\n    global x\n    x = 2\n');
  const f = out.bodies.find((b) => b.name === 'f').steps;
  assert.equal(f[1].op, 'global');
  assert.deepEqual(f[1].names, ['x']);
  assert.equal(out.table.bindings[f[1].bindings[0]].how, 'global');
  assert.equal(out.bodies.find((b) => b.name === 'g').steps[0].op, 'nonlocal');
});

test('flow, JS: params: patterns, defaults, rest, optional, decorators, parameter properties, this, one bare name', () => {
  const out = flowSteps('a.ts', [
    'class C {',
    '  constructor(private readonly db: Db, @Inject(T) public t?: T) {}',
    '  m(this: C, { a, b = 2 }: P = {}, ...rest: string[]) { return a; }',
    '}',
    'const g = async x => x;',
    '',
  ].join('\n'));
  const named = (name) => out.bodies.find((b) => b.name === name);
  assert.deepEqual(shape(named('constructor').params), [{ target: { k: 'name', name: 'db' }, default: null }, { target: { k: 'name', name: 't' }, default: null }]);
  assert.deepEqual(shape(named('m').params), [
    { target: { k: 'object', items: [{ key: 'a', target: { k: 'name', name: 'a' } }, { key: 'b', target: { k: 'name', name: 'b' }, default: { k: 'lit', v: 'num', text: '2' } }] }, default: { k: 'lit', v: 'dict', entries: [] } },
    { target: { k: 'name', name: 'rest' }, default: null, star: '...' },
  ]);
  const arrow = out.bodies.find((b) => b.scope === out.bodies[0].steps[1].value.scope);
  assert.deepEqual(shape(arrow.params), [{ target: { k: 'name', name: 'x' }, default: null }]);
});

test('flow, JS: functions, arrows and classes are bodies of their own; fields, static blocks, decorators', () => {
  const out = flowSteps('a.ts', [
    "import { Inject } from './di';",
    'export default async function main() { return 1; }',
    'export const f = (a: number): number => a + 1, g = async (b) => { await b.c(); };',
    '@Controller()',
    'export class S extends B {',
    '  @Inject() private db!: Db;',
    '  static n = 0;',
    '  [k: string]: unknown;',
    '  static { S.n = 1; }',
    '  constructor(private x: X) { super(); }',
    '  async get<T>(key: string): Promise<T> { return this.db.get(key); }',
    '  abstract m(): void;',
    '}',
    'type T = { a: string };',
    'interface I { b: number }',
    'export { f as h };',
    '',
  ].join('\n'));
  const top = out.bodies[0].steps;
  assert.deepEqual(top.map((s) => s.op), ['import', 'def', 'assign', 'assign', 'class', 'opaque']);
  assert.equal(top[4].decorators[0].k, 'call');
  const named = (name) => out.bodies.find((b) => b.name === name);
  assert.equal(named('main').steps[0].op, 'return');
  assert.equal(top[2].value.k, 'fn');
  assert.deepEqual(shape(out.bodies.find((b) => b.scope === top[2].value.scope).steps), [{ op: 'return', value: { k: 'opaque', text: 'a+1' } }]);
  assert.deepEqual(out.bodies.find((b) => b.scope === top[3].value.scope).steps.map((s) => s.op), ['call']);
  const cls = named('S').steps;
  assert.deepEqual(cls.map((s) => [s.op, s.name]), [['field', 'db'], ['field', 'n'], ['assign', undefined], ['def', 'constructor'], ['def', 'get']]);
  assert.equal(cls[0].decorators[0].k, 'call');
  assert.equal(cls[1].static, true);
  assert.equal(named('get').steps[0].value.k, 'call');
});

test('flow, JS: blocks nested deeper than 200 are one opaque step with nesting, their text whole', () => {
  const steps = stepsOf(`function f() {${'{ x(); '.repeat(250)}${'}'.repeat(250)}}\n`, 'f', 'a.js');
  // Blocks are flattened into their body, so the steps are the calls in order and then the opaque rest.
  const calls = steps.filter((s) => s.op === 'call').length;
  const rest = steps.at(-1);
  assert.equal(rest.op, 'opaque');
  assert.equal(rest.nesting, true);
  assert.equal(calls + (rest.text.match(/x\(\)/gu) ?? []).length, 250);
});

test('flow, JS: the cal.com shape: a local and a module of the same name, and an await under a check', () => {
  const steps = stepsOf([
    "import prisma from '@calcom/prisma';",
    'export async function handler(req) {',
    '  const eventType = await prisma.eventType.findUnique({ where: { id: req.query.id } });',
    '  if (!eventType) throw new HttpError({ statusCode: 404 });',
    '  return eventType.users;',
    '}',
  ].join('\n'), 'handler', 'a.js');
  assert.deepEqual(steps.map((s) => s.op), ['assign', 'branch', 'return']);
  assert.equal(steps[0].value.await, true);
  assert.equal(steps[0].value.callee.of.of.name, 'prisma');
  assert.equal(steps[1].then[0].op, 'raise');
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
  'py: a long dict': (n) => `d = {${'"k": x.a(y), **z, '.repeat(n / 22)}}\n`,
  'js: a long object with methods': (n) => `const o = {${' a: x, b, [c]: d, ...e, m(y) { return y; },'.repeat(n / 46)} };\n`,
  'js: a long else-if chain': (n) => `function f(x) {\n  if (x === null) y = 0;\n${Array.from({ length: n / 36 }, (_, i) => `  else if (x === ${i}) { y = x.a(); }\n`).join('')}}\n`,
  'js: a long && chain': (n) => `if (${'x != null && '.repeat(n / 13)}x) {}\n`,
  'js: a run of !': (n) => `if (${'!'.repeat(n / 2)}x) {}\n`,
  'js: a ternary chain': (n) => `const v = ${'c ? a : '.repeat(n / 8)}z;\n`,
  'js: a ternary chain in the middle': (n) => `const v = ${'c ? '.repeat(n / 8)}z${' : a'.repeat(n / 8)};\n`,
  'js: deep calls': (n) => `const v = ${'f('.repeat(n / 2)}x${')'.repeat(n / 2)};\n`,
  'js: deep arrows': (n) => `const f = ${'a => '.repeat(n / 5)}a;\n`,
  'js: deep blocks': (n) => `function f() {${'{ x = 1;'.repeat(n / 8)}${'}'.repeat(n / 8)}}\n`,
  'js: nested functions': (n) => `${'function f() { '.repeat(n / 16)}return 1;${' }'.repeat(n / 16)}\n`,
  'js: many statements': (n) => `function f(x) {\n${'  const y = x?.a ? g(x.b, ...x.c) : null;\n'.repeat(n / 44)}}\n`,
  'js: a long switch': (n) => `switch (x) {\n${Array.from({ length: n / 24 }, (_, i) => `  case ${i}: y(); break;\n`).join('')}}\n`,
  'js: a long member chain with calls': (n) => `const a = 1;\na${'.b(a)[a]?.c'.repeat(n / 12)};\n`,
  'ts: a class with many members': (n) => `class C {\n${'  @d() private x!: X;\n  async m<T>(a: T): Promise<T> { return a; }\n'.repeat(n / 80)}}\n`,
  'js: many template placeholders': (n) => `const x = 1;\nconst s = \`${'${x.a} '.repeat(n / 7)}\`;\n`,
};

test('flow: linear steps in the length of a file, its nesting and its chains', () => {
  for (const [name, make] of Object.entries(FLOW_SHAPES)) {
    const path = name.startsWith('py') ? 'a.py' : name.startsWith('ts') ? 'a.ts' : 'a.js';
    const count = (n) => { const text = make(n); countSteps(true); flowSteps(path, text); return countSteps(false); };
    const [small, big] = [count(2_000), count(32_000)];
    assert.ok(small > 0 && big < small * 20, `${name}: ${small} steps at 2,000 characters, ${big} at 32,000 (${(big / small).toFixed(1)} times)`);
  }
});

test('flow: linear time in the length of a file, its nesting and its chains', async () => {
  for (const lang of ['py', 'js', 'ts']) {
    const shapes = Object.fromEntries(Object.entries(FLOW_SHAPES).filter(([name]) => name.startsWith(lang)));
    const { done, said } = await timeShapes(shapes, new URL('../src/flow.mjs', import.meta.url).href, 'flowSteps', new Function('fn', 'text', `return fn('a.${lang}', text);`));
    assert.ok(linearIn(done, shapes), said);
  }
});
