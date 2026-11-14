import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { countSteps } from '../src/code.mjs';
import { REASONS, resolveImport, scopes } from '../src/scopes.mjs';
import { linearIn, timeShapes } from './linear-time.mjs';

// The reference to `name` on `line` (the first one, or the one with that member), and the binding it means.
const referenceAt = (t, name, line, member) => {
  const r = t.references.find((x) => x.name === name && x.line === line && (member === undefined || x.member === member));
  assert.ok(r, `no reference to ${name} on line ${line}: ${JSON.stringify(t.references.filter((x) => x.line === line))}`);
  return r;
};
const bindingOf = (t, r) => (r.to.binding === undefined ? null : t.bindings[r.to.binding]);
const repoWith = (files, texts = {}) => ({ files, read: (f) => texts[f] ?? null });

// --------------------------------------------------------------------------------------------- an outer parameter

// A route handler nested in the function that builds the routes calls a method of that function's parameter; the
// parameter's annotation names a class another file defines.
const BLUEPRINT = (inner, annotation = 'Store') => `"""Routes. datastore.save() in this docstring is text."""
from flask import Blueprint
from typing import Optional
from app.store import Store


def construct_blueprint(datastore: ${annotation}):
    bp = Blueprint("api", __name__)
${inner}
    return bp
`;
const OUTER = {
  'a handler nested in it': ['    def handler():\n        """Calls datastore.missing()."""\n        datastore.add_watch(1)\n', 'add_watch', 11],
  'a handler two functions deep': ['    def outer():\n        def handler():\n            return datastore.get(1)\n        return handler\n', 'get', 11],
  'a decorated handler': ['    @bp.route("/a")\n    def handler():\n        return datastore.load()\n', 'load', 11],
  'an Optional annotation': ['    def handler():\n        datastore.sync()\n', 'sync', 10, 'Optional[Store]'],
  'a union with None': ['    def handler():\n        datastore.sync()\n', 'sync', 10, 'Store | None'],
  'a lambda in the handler': ['    def handler(xs):\n        return sorted(xs, key=lambda w: datastore.rank(w))\n', 'rank', 10],
};
for (const [shape, [inner, member, line, annotation]] of Object.entries(OUTER)) {
  test(`scopes: a nested function's use of an outer parameter, ${shape}, reaches the parameter and its annotated class`, () => {
    const t = scopes('app/api.py', BLUEPRINT(inner, annotation));
    const use = referenceAt(t, 'datastore', line, member);
    const param = bindingOf(t, use);
    assert.equal(param.how, 'parameter');
    assert.equal(t.scopes[param.scope].name, 'construct_blueprint');
    assert.deepEqual(param.annotation.names.map((x) => x.name), ['Store']);
    const imp = bindingOf(t, t.references[param.annotation.names[0].ref]);
    assert.deepEqual(imp.import, { module: 'app.store', name: 'Store', alias: null, form: 'py-from' });
    const repo = repoWith(['app/__init__.py', 'app/api.py', 'app/store/__init__.py']);
    assert.deepEqual(resolveImport('app/api.py', imp.import, repo), { file: 'app/store/__init__.py' });
    // A docstring is a string: its `datastore.save()` and `datastore.missing()` are not uses.
    assert.ok(!t.references.some((r) => r.line === 1 || r.member === 'missing'));
  });
}

// --------------------------------------------------------------------------------------- an import in a function

const INNER_IMPORTS = {
  'a package': ['from app.sub import mod', 'mod', 'app/sub/mod/__init__.py'],
  'a module of a package': ['from app.llm import summary_jobs', 'summary_jobs', 'app/llm/summary_jobs.py'],
  'a module beside the package': ['from app import worker_pool', 'worker_pool', 'app/worker_pool.py'],
};
for (const [shape, [line, name, file]] of Object.entries(INNER_IMPORTS)) {
  test(`scopes: an import inside a function, of ${shape}, binds in that function only and names the repository's file`, () => {
    const t = scopes('app/tasks.py', `def run(job):\n    ${line}\n    ${name}.start(job)\n\n\ndef other():\n    return ${name}.x\n`);
    const use = bindingOf(t, referenceAt(t, name, 3));
    assert.equal(use.how, 'import');
    assert.equal(t.scopes[use.scope].name, 'run');
    assert.deepEqual(referenceAt(t, name, 7).to, { unknown: 'undefined-name' });
    const repo = repoWith(['app/__init__.py', 'app/tasks.py', 'app/sub/__init__.py', 'app/sub/mod/__init__.py', 'app/llm/__init__.py', 'app/llm/summary_jobs.py', 'app/worker_pool.py']);
    assert.deepEqual(resolveImport('app/tasks.py', use.import, repo), { file });
  });
}

// ------------------------------------------------------------------------------------------------------ Python rules

test('scopes: a parameter shadows the module name of the same name, inside its function only', () => {
  const t = scopes('a.py', 'x = 1\ndef f(x):\n    return x\nprint(x)\n');
  assert.equal(bindingOf(t, referenceAt(t, 'x', 3)).how, 'parameter');
  assert.equal(bindingOf(t, referenceAt(t, 'x', 4)).how, 'assign');
  assert.equal(bindingOf(t, referenceAt(t, 'x', 4)).scope, 0);
});

test('scopes: a class body is not seen from its methods, nor from a comprehension in it', () => {
  const t = scopes('a.py', 'def f(c=10):\n    class K:\n        c = 1\n        y = c\n        v = [q + c for q in [0]]\n        def m(self):\n            return c\n');
  assert.equal(t.scopes[bindingOf(t, referenceAt(t, 'c', 4)).scope].kind, 'class');
  // As Python runs it: the comprehension and the method see f's c (10), not the class's.
  assert.equal(bindingOf(t, referenceAt(t, 'c', 5)).how, 'parameter');
  assert.equal(bindingOf(t, referenceAt(t, 'c', 7)).how, 'parameter');
});

test('scopes: global moves a name to the module, nonlocal to the function around, also for a binding made above it', () => {
  const t = scopes('a.py', 'count = 0\ndef inc():\n    count = count + 1\n    global count\ndef outer():\n    n = 0\n    def inner():\n        nonlocal n\n        n += 1\n    return n\n');
  const moved = t.bindings.filter((b) => b.name === 'count' && b.how === 'assign');
  assert.deepEqual(moved.map((b) => b.scope), [0, 0]);
  assert.equal(t.scopes[bindingOf(t, referenceAt(t, 'n', 9)).scope].name, 'outer');
  assert.ok(t.bindings.some((b) => b.how === 'nonlocal' && b.hidden));
});

test('scopes: a name assigned anywhere in a function is local throughout it (early), and an assignment is a new binding', () => {
  const t = scopes('a.py', 'x = 1\ndef f():\n    print(x)\n    x = 2\na = 1\na = a + 1\nprint(a)\n');
  const early = referenceAt(t, 'x', 3);
  assert.equal(t.scopes[bindingOf(t, early).scope].name, 'f');
  assert.equal(early.early, true);
  assert.equal(bindingOf(t, referenceAt(t, 'a', 6)).line, 5);
  assert.equal(bindingOf(t, referenceAt(t, 'a', 7)).line, 6);
});

test('scopes: a later module binding a function body uses is found (early), as it is there when the function runs', () => {
  const t = scopes('a.py', 'def f():\n    return g()\ndef g():\n    return 1\n');
  const r = referenceAt(t, 'g', 2);
  assert.equal(bindingOf(t, r).how, 'def');
  assert.equal(r.early, true);
});

test('scopes: renamed imports bind their alias; import * makes the module\'s unbound names unknown, with its reason', () => {
  const t = scopes('a.py', 'import numpy as np\nfrom os import path as p\nfrom m import *\nnp.array(p)\nfoo()\nlen(p)\n');
  assert.deepEqual(bindingOf(t, referenceAt(t, 'np', 4)).import, { module: 'numpy', name: null, alias: 'np', form: 'py-import' });
  assert.deepEqual(bindingOf(t, referenceAt(t, 'p', 4)).import, { module: 'os', name: 'path', alias: 'p', form: 'py-from' });
  assert.deepEqual(referenceAt(t, 'foo', 5).to, { unknown: 'import-star' });
  assert.deepEqual(referenceAt(t, 'len', 6).to, { builtin: true });
  assert.deepEqual(t.unknown, [{ line: 3, reason: 'import-star', text: 'm' }]);
});

test('scopes: annotations give the names they are about: wrappers are left out, a quoted one is unknown', () => {
  const t = scopes('a.py', 'from typing import Optional, Union\nimport typing\ndef f(a: Optional[S], b: S | None, c: list[S], d: Union[S, T], e: typing.Optional[S], g: "S", h: mod.S):\n    pass\n');
  const names = Object.fromEntries(t.bindings.filter((b) => b.how === 'parameter').map((b) => [b.name, b.annotation.names?.map((x) => x.name + (x.member ? `.${x.member}` : '')) ?? b.annotation]));
  assert.deepEqual(names, { a: ['S'], b: ['S'], c: ['S'], d: ['S', 'T'], e: ['S'], g: { unknown: 'string-annotation' }, h: ['mod.S'] });
});

test('scopes: imports under if TYPE_CHECKING are types; try and except ImportError make two bindings', () => {
  const t = scopes('a.py', 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from app.store import Store\ntry:\n    import ujson as json\nexcept ImportError:\n    import json\nx = json.dumps(1)\n');
  assert.equal(t.bindings.find((b) => b.name === 'Store').type, true);
  assert.deepEqual(t.bindings.filter((b) => b.name === 'json').map((b) => b.line), [5, 7]);
  assert.equal(bindingOf(t, referenceAt(t, 'json', 8)).line, 7);
});

test('scopes: a lambda and a comprehension are scopes, a lambda with no name', () => {
  const t = scopes('a.py', 'xs = [y * 2 for y in range(3)]\nf = lambda q: q + 1\nprint(y)\n');
  assert.equal(t.scopes[bindingOf(t, referenceAt(t, 'y', 1)).scope].kind, 'comprehension');
  const lambda = t.scopes[bindingOf(t, referenceAt(t, 'q', 2)).scope];
  assert.deepEqual([lambda.kind, lambda.name], ['function', null]);
  assert.deepEqual(referenceAt(t, 'y', 3).to, { unknown: 'undefined-name' });
});

test('scopes: eval and exec make a scope\'s unbound names unknown; keyword arguments are not names', () => {
  const t = scopes('a.py', 'def f():\n    eval("x")\n    return y\nprint(z, sep=w)\n');
  assert.deepEqual(referenceAt(t, 'y', 3).to, { unknown: 'eval' });
  assert.deepEqual(referenceAt(t, 'z', 4).to, { unknown: 'undefined-name' });
  assert.ok(!t.references.some((r) => r.name === 'sep'));
});

// --------------------------------------------------------------------------------------------- JavaScript, TypeScript

test('scopes: let and const are block-scoped, var and function declarations hoisted to the function', () => {
  const t = scopes('a.js', 'const x = 1;\nfunction f(x) { return x; }\n{ let x = 2; x; }\nx;\ng();\nfunction g() { return h; }\nvar h = 1;\nfunction k() { { var v = 1; } return v; }\n');
  assert.equal(bindingOf(t, referenceAt(t, 'x', 2)).how, 'parameter');
  assert.equal(bindingOf(t, referenceAt(t, 'x', 3)).how, 'let');
  assert.equal(bindingOf(t, referenceAt(t, 'x', 4)).how, 'const');
  assert.equal(referenceAt(t, 'g', 5).early, true);
  assert.equal(bindingOf(t, referenceAt(t, 'h', 6)).how, 'var');
  assert.equal(t.scopes[bindingOf(t, referenceAt(t, 'v', 8)).scope].name, 'k');
});

test('scopes: a reassignment is a new binding, and its value still sees the one before', () => {
  const t = scopes('a.js', 'let z = 1;\nz = z + 1;\nz++;\nconsole.log(z);\n');
  assert.equal(bindingOf(t, referenceAt(t, 'z', 2)).how, 'let');
  assert.equal(bindingOf(t, referenceAt(t, 'z', 4)).line, 3);
  assert.deepEqual(t.bindings.filter((b) => b.name === 'z').map((b) => `${b.how}@${b.line}`), ['let@1', 'assign@2', 'assign@3']);
});

test('scopes: ESM imports, renamed ones and CommonJS require bind names with what they import', () => {
  const t = scopes('a.ts', "import Def, { a as b, type T } from './m';\nimport type { U } from './u';\nimport * as ns from 'pkg';\nconst { c, d: e } = require('n');\nconst f = require('o').g;\nb(Def, ns.x, c, e, f);\n");
  const imp = (name) => bindingOf(t, referenceAt(t, name, 6)).import;
  assert.deepEqual(imp('b'), { module: './m', name: 'a', alias: 'b', form: 'esm' });
  assert.deepEqual(imp('Def'), { module: './m', name: 'default', alias: 'Def', form: 'esm' });
  assert.deepEqual(imp('ns'), { module: 'pkg', name: '*', alias: 'ns', form: 'esm' });
  assert.deepEqual(imp('c'), { module: 'n', name: 'c', alias: null, form: 'require' });
  assert.deepEqual(imp('e'), { module: 'n', name: 'd', alias: 'e', form: 'require' });
  assert.deepEqual(imp('f'), { module: 'o', name: 'g', alias: 'f', form: 'require' });
  assert.deepEqual(t.bindings.filter((b) => b.type).map((b) => b.name), ['T', 'U']);
});

test('scopes: export from is recorded, not looked up; export type and declare are types', () => {
  const t = scopes('a.ts', "export * from './re';\nexport { q as r } from './q';\nexport type { V } from './v';\ndeclare const D: number;\nexport type W = string;\nr; D;\n");
  assert.deepEqual(t.bindings.filter((b) => b.hidden).map((b) => [b.name, b.import.form, b.type ?? false]), [['*', 'export-from', false], ['r', 'export-from', false], ['V', 'export-from', true]]);
  assert.deepEqual(referenceAt(t, 'r', 6).to, { unknown: 'undefined-name' });
  assert.equal(bindingOf(t, referenceAt(t, 'D', 6)).type, true);
  assert.equal(t.bindings.find((b) => b.name === 'W').type, true);
});

test('scopes: arrow functions are scopes with no name; typed parameters and return types are read as types', () => {
  const t = scopes('a.ts', "import { Store, Opts } from './s';\nconst f = (a: Store, { k }: Opts): R => a.k + k;\nconst g = x => x;\nclass K { m(p) { return p + this.v; } v = 1; }\n");
  const a = bindingOf(t, referenceAt(t, 'a', 2));
  assert.deepEqual([a.how, t.scopes[a.scope].kind, t.scopes[a.scope].name], ['parameter', 'function', null]);
  assert.deepEqual(a.annotation.names.map((x) => x.name), ['Store']);
  assert.ok(t.references.filter((r) => r.name === 'Store' || r.name === 'Opts').every((r) => r.type));
  assert.ok(t.references.filter((r) => r.name === 'R').every((r) => r.type) && t.references.some((r) => r.name === 'R'));
  assert.equal(bindingOf(t, referenceAt(t, 'x', 3)).how, 'parameter');
  assert.equal(bindingOf(t, referenceAt(t, 'p', 4)).how, 'parameter');
  assert.ok(!t.references.some((r) => r.name === 'm' || r.name === 'v'));
});

test('scopes: with and eval make unbound names unknown; object keys and properties are not names', () => {
  const t = scopes('a.js', 'const o = { a: 1, b, c() { return 2; } };\nwith (o) { foo; }\no.p;\nconst v = cond ? { why: 1 } : { why: 2 };\n');
  assert.deepEqual(referenceAt(t, 'foo', 2).to, { unknown: 'with-statement' });
  assert.ok(!t.references.some((r) => ['a', 'c', 'p', 'why'].includes(r.name)));
  assert.equal(referenceAt(t, 'b', 1).to.unknown, 'undefined-name');
});

test('scopes: an object or array in a destructuring default is a value: its keys are not names, its uses are', () => {
  const t = scopes('a.js', 'const R = 1;\nfunction f({ a = [{ id: 1, rule: R }] } = {}) {}\nfunction g([b = { rule: R }]) {}\nconst { c = { rule: R }, d: [e = [R]] } = {};\n');
  assert.ok(!t.references.some((r) => r.name === 'id' || r.name === 'rule'), JSON.stringify(t.references.map((r) => r.name)));
  for (const line of [2, 3, 4]) assert.equal(bindingOf(t, referenceAt(t, 'R', line)).line, 1);
  assert.deepEqual(t.bindings.map((b) => b.name).sort(), ['R', 'a', 'b', 'c', 'e', 'f', 'g']);
  const u = scopes('a.js', 'for (const { a = { k: 1 } } of xs) a;\ntry {} catch ({ b = { k: 1 } }) { b; }\nclass C { m({ c = { k: 1 } }) { return c; } }\nfunction h({ d: { e = { k: 1 } } = {} }) { return e; }\n');
  assert.ok(!u.references.some((r) => r.name === 'k' || r.name === 'd'), JSON.stringify(u.references.map((r) => r.name)));
  // A default with a body of its own, and a ternary whose `:` is no key.
  const v = scopes('a.js', 'const R = 1, c = 0;\nfunction f({ a = () => { return R; } }) {}\nconst { b = class { m() { return R; } } } = {};\nconst { d = ({ e }) => e } = {};\nfunction g({ h = c ? { k: 1 } : { k: 2 }, i }) { return h + i; }\n');
  assert.equal(bindingOf(v, referenceAt(v, 'R', 2)).line, 1);
  assert.equal(bindingOf(v, referenceAt(v, 'R', 3)).line, 1);
  assert.equal(bindingOf(v, referenceAt(v, 'e', 4)).how, 'parameter');
  assert.equal(bindingOf(v, referenceAt(v, 'h', 5)).how, 'parameter');
  assert.deepEqual(v.bindings.map((b) => b.name).sort(), ['R', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.ok(!v.references.some((r) => r.name === 'k'), JSON.stringify(v.references.map((r) => r.name)));
});

test('scopes: in a TS object type, member names, index and function-type parameter names are not names used', () => {
  const t = scopes('a.ts', 'type V = number;\nfunction f(a: { k: V; m?: V; n(): V; [key: string]: V }) { return a; }\nfunction g({ b }: { b: V }, cb: (err: V, val?: V) => V) { return b + cb; }\n');
  const types = t.references.filter((r) => r.type && !r.to.builtin);
  assert.deepEqual(types.map((r) => r.name), ['V', 'V', 'V', 'V', 'V', 'V', 'V', 'V']);
  assert.ok(types.every((r) => t.bindings[r.to.binding].name === 'V'));
});

test('scopes: a comma inside type arguments splits no parameter, declarator or pattern; type parameters are bound', () => {
  const t = scopes('a.ts', [
    'type V = number;',
    'function f(m: Map<string, V>, b) { return m + b; }',
    'const a: Map<string, V> = new Map<string, V>(), c = 1;',
    'const { d = new Map<string, V>(), e } = {};',
    'const x = f<string, V>(a, c);',
    'function g<T extends Map<string, V>, U = Record<string, V>, F extends (z: V) => V = (y: V) => V>(p: T, q: U): T { return p; }',
    'class C<K> { m(k: K): K { return k; } }',
    'const h = <W,>(w: W): W => w;',
  ].join('\n') + '\n');
  const names = (how) => t.bindings.filter((b) => b.how === how).map((b) => b.name).sort();
  // A return type is a type used: `: T` and `: K` as well as the parameters'.
  assert.equal(t.references.filter((r) => r.name === 'T' && r.line === 6).length, 2);
  assert.equal(t.references.filter((r) => r.name === 'K' && r.line === 7).length, 2);
  // A `<` whose `>` lies past a closing bracket is a comparison: `[a < b], c > (d)`.
  const u = scopes('a.ts', 'const a = 1, b = 2, c = 3, d = 4, k = (x, y) => x + y;\nconst w = k([a < b], c > (d));\n');
  assert.ok(u.references.every((r) => !r.type), JSON.stringify(u.references.filter((r) => r.type)));
  // A function type's parameters are no parameters: in a declaration's, an arrow's or a method's types.
  const v = scopes('a.ts', 'type V = 1;\nfunction g(cb: (e: V) => V, d) { return cb(d); }\nconst h = (cb2: (e2: V) => V): ((r: V) => V) => cb2;\nclass C { m(cb3: (e3: V) => V): (r3: V) => V { return cb3; } }\nlet x: (e4: V) => V;\n');
  assert.deepEqual(v.bindings.map((b) => b.name).sort(), ['C', 'V', 'cb', 'cb2', 'cb3', 'd', 'g', 'h', 'x']);
  assert.deepEqual(names('parameter'), ['b', 'k', 'm', 'p', 'q', 'w']);
  assert.deepEqual(names('const'), ['a', 'c', 'h', 'x']);
  assert.deepEqual(names('destructure'), ['d', 'e']);
  assert.deepEqual(names('type-parameter'), ['F', 'K', 'T', 'U', 'W']);
  assert.ok(t.bindings.filter((b) => b.how === 'type-parameter').every((b) => b.type));
  for (const r of t.references.filter((x) => x.name === 'V')) assert.equal(t.bindings[r.to.binding]?.how, 'type', `V at ${r.line}`);
  for (const [name, line] of [['T', 6], ['U', 6], ['K', 7], ['W', 8]]) assert.equal(bindingOf(t, referenceAt(t, name, line)).how, 'type-parameter', name);
  assert.ok(!t.references.some((r) => r.to.unknown), JSON.stringify(t.references.filter((r) => r.to.unknown)));
});

// ------------------------------------------------------------------------------------ strings, statements, markup

// Each name of t's references, as name@line->how@line of its binding, or name@line->? when it has none.
const resolved = (t) => t.references.map((r) => `${r.name}@${r.line}->${r.to.binding !== undefined ? `${t.bindings[r.to.binding].how}@${t.bindings[r.to.binding].line}` : r.to.builtin ? 'builtin' : '?'}`);

test('scopes, Python: a string prefix is no name; an f-string placeholder holds uses, a format spec and !r none', () => {
  const t = scopes('a.py', 'x = 1\nd = {}\ns = f"{x} {x!r:>{x}} {d[\'k\']} {x=} {x:%H}" + rb"{nope}" + Rf"""{x\n + 1}""" + f\'{x, \', \'.join(d)}\' + r\'\\\'\' + f"{x}"\n');
  assert.deepEqual(resolved(t).filter((r) => !r.startsWith('x@') && !r.startsWith('d@')), []);
  assert.equal(t.references.filter((r) => r.name === 'x').length, 8);
  assert.ok(t.references.every((r) => r.to.binding !== undefined), JSON.stringify(resolved(t)));
});

test('scopes, Python: a walrus binds in the function around (past a comprehension); its `:` ends no header', () => {
  const t = scopes('a.py', 'import sys\ndef f(xs):\n    while line := sys.stdin.readline():\n        print(line)\n    ys = [y := q for q in xs]\n    return y\n');
  assert.equal(bindingOf(t, referenceAt(t, 'line', 4)).how, 'assign');
  const y = bindingOf(t, referenceAt(t, 'y', 6));
  assert.deepEqual([y.how, t.scopes[y.scope].kind], ['assign', 'function']);
});

test('scopes, Python: match and case head statements only before a subject; a capture binds, a dotted name is a use', () => {
  const t = scopes('a.py', [
    'import re', 'class Point: pass', 'RED = 1', 'match = re.match("a", "b")', 'case: int = 2', 'print(match, case)',
    'def f(cmd):', '    match cmd:', '        case ["go", direction] if direction:', '            return direction',
    '        case Point(x=0, y=yy) as p:', '            return yy, p', '        case {"k": v, **rest}:', '            return v, rest',
    '        case RED.real | _:', '            return 0',
  ].join('\n') + '\n');
  assert.equal(bindingOf(t, referenceAt(t, 'match', 6)).line, 4);
  assert.equal(bindingOf(t, referenceAt(t, 'case', 6)).line, 5);
  for (const [name, line] of [['direction', 10], ['yy', 12], ['p', 12], ['v', 14], ['rest', 14]]) assert.equal(bindingOf(t, referenceAt(t, name, line)).how, 'case', name);
  assert.equal(bindingOf(t, referenceAt(t, 'Point', 11)).how, 'class');
  assert.equal(bindingOf(t, referenceAt(t, 'RED', 15)).line, 3);
  assert.ok(!t.references.some((r) => ['x', '_', 'real'].includes(r.name) || r.to.unknown), JSON.stringify(resolved(t)));
});

test('scopes, Python: a line joined by `\\`, a float ending in `.`, and the line after a string over lines', () => {
  const t = scopes('a.py', [
    'from os import path, \\', '    sep', 'T = 20.', 'n = T', 'class C:', '  def f(a, \\', '        b=None):', '    s = """x', '  """ % (a, b)',
    '    return s. \\', '        strip().replace("a", "b"), path, sep, n',
  ].join('\n') + '\n');
  assert.equal(bindingOf(t, referenceAt(t, 'T', 4)).line, 3);
  assert.equal(bindingOf(t, referenceAt(t, 'n', 11)).line, 4);
  assert.equal(bindingOf(t, referenceAt(t, 'sep', 11)).how, 'import');
  // The method's string ends on a line at the method's own indent: that line does not end the method.
  for (const name of ['a', 'b']) assert.equal(bindingOf(t, referenceAt(t, name, 9)).how, 'parameter', name);
  assert.ok(!t.references.some((r) => r.to.unknown || ['strip', 'replace'].includes(r.name)), JSON.stringify(resolved(t)));
});

test('scopes: a template placeholder holds uses; its parentheses are no parameter list', () => {
  const t = scopes('a.js', 'const x = 1, tty = 0;\nconst s = `a ${x + 1} b ${`${x}`}`;\nconst red = tty ? (msg) => `\\x1B[31m${msg}` : m => m;\nclass K { #p = 1; f() { return `${this.#p}`; } }\n');
  assert.equal(t.references.filter((r) => r.name === 'x').length, 2);
  assert.equal(bindingOf(t, referenceAt(t, 'msg', 3)).how, 'parameter');
  const ms = t.references.filter((r) => r.name === 'm');
  assert.ok(ms.length === 1 && t.bindings[ms[0].to.binding].name === 'm', JSON.stringify(resolved(t)));
  assert.ok(!t.references.some((r) => r.to.unknown), JSON.stringify(resolved(t)));
});

test('scopes: methods with a computed or string name, generator methods, labels, and a class field\'s object', () => {
  const t = scopes('a.js', [
    'const K = 1;',
    'class A { [K](a) { return a; } *g(b) { yield b; } static *[K](c) { return c; } get [K]() { return K; } \'s\'(d) { return d; } conf = { help: K, arch: K }; }',
    'const o = { *g(e) { return e; }, [K](f) { return f; }, \'=\'({ attr, value }) { return attr === value; } };',
    'outer: for (const x of [K]) { for (const y of [x]) { if (y) continue outer; break outer; } }',
  ].join('\n') + '\n');
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'attr', 'value']) assert.equal(bindingOf(t, t.references.find((r) => r.name === name)).how, 'parameter', name);
  assert.ok(!t.references.some((r) => r.to.unknown || ['outer', 'help', 'arch'].includes(r.name)), JSON.stringify(resolved(t)));
});

test('scopes: a function or class first in a block is declared there, not a value', () => {
  const t = scopes('a.js', 'function wrap(P) {\n  function adopt(v) { return v; }\n  return (function () { function step() { return adopt(1) + inner(); } function inner() { return 2; } return step; })();\n}\nconst make = () => { class Safe {} return new Safe(); };\n');
  assert.equal(bindingOf(t, referenceAt(t, 'adopt', 3)).line, 2);
  assert.equal(bindingOf(t, referenceAt(t, 'inner', 3)).how, 'def');
  assert.equal(bindingOf(t, referenceAt(t, 'Safe', 5)).how, 'class');
  assert.ok(!t.references.some((r) => r.to.unknown), JSON.stringify(resolved(t)));
});

test('scopes: JSX tag names, attributes and text are no names; a component and the code in braces are uses', () => {
  const t = scopes('a.jsx', [
    'import Button from "./b";', 'const ui = {}, h = () => 1, v = 2, p = {};',
    'const e = <div className="a" onClick={h} data-x={v} style={{ color: v }} {...p}>text here {v} <Button on={h}/> <ui.Card/> <>frag</></div>;',
  ].join('\n') + '\n');
  assert.deepEqual(t.references.map((r) => r.name).sort(), ['Button', 'h', 'h', 'p', 'ui', 'v', 'v', 'v']);
  assert.ok(!t.references.some((r) => r.to.unknown), JSON.stringify(resolved(t)));
  // In a .ts file `<T>x` is a type assertion, not JSX.
  assert.equal(scopes('a.ts', 'type T = 1;\nconst y = 1;\nconst z = <T>y;\n').references.find((r) => r.name === 'y').to.binding !== undefined, true);
});

test('scopes: every reason given is one of REASONS', () => {
  const t = scopes('a.js', "with (o) { a; }\neval('x');\nimport(name);\nrequire(name);\n");
  for (const r of [...t.references.filter((x) => x.to.unknown).map((x) => x.to.unknown), ...t.unknown.map((x) => x.reason)]) assert.ok(REASONS.includes(r), r);
  assert.deepEqual(t.unknown.map((x) => x.reason), ['with-statement', 'eval', 'dynamic-import', 'computed-require']);
});

// ---------------------------------------------------------------------------------------------------- across files

test('resolveImport: Python relative and absolute imports, a package of the repository, a package from outside', () => {
  const repo = repoWith(['app/__init__.py', 'app/a.py', 'app/b/__init__.py', 'app/b/c.py', 'src/lib/__init__.py']);
  assert.deepEqual(resolveImport('app/a.py', { module: '.b', name: 'c', form: 'py-from' }, repo), { file: 'app/b/c.py' });
  assert.deepEqual(resolveImport('app/a.py', { module: '..', name: 'app', form: 'py-from' }, repo), { file: 'app/__init__.py' });
  assert.deepEqual(resolveImport('app/a.py', { module: 'lib', name: null, form: 'py-import' }, repo), { file: 'src/lib/__init__.py' });
  assert.deepEqual(resolveImport('app/a.py', { module: 'app.nope', name: 'x', form: 'py-from' }, repo), { unknown: 'unresolved-module', text: 'app.nope' });
  assert.deepEqual(resolveImport('app/a.py', { module: 'requests.adapters', name: 'x', form: 'py-from' }, repo), { outside: 'requests' });
});

test('resolveImport: JavaScript relative paths, a tsconfig alias, a package from outside, an alias no file matches', () => {
  const tsconfig = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } });
  const repo = repoWith(['tsconfig.json', 'src/a.ts', 'src/lib/b.ts', 'src/lib/index.ts'], { 'tsconfig.json': tsconfig });
  assert.deepEqual(resolveImport('src/a.ts', { module: './lib/b', form: 'esm' }, repo), { file: 'src/lib/b.ts' });
  assert.deepEqual(resolveImport('src/a.ts', { module: './lib', form: 'esm' }, repo), { file: 'src/lib/index.ts' });
  assert.deepEqual(resolveImport('src/a.ts', { module: '@/lib/b', form: 'esm' }, repo), { file: 'src/lib/b.ts' });
  assert.deepEqual(resolveImport('src/a.ts', { module: '@scope/pkg/sub', form: 'esm' }, repo), { outside: '@scope/pkg' });
  assert.deepEqual(resolveImport('src/a.ts', { module: 'node:fs', form: 'esm' }, repo), { outside: 'node:fs' });
  assert.deepEqual(resolveImport('src/a.ts', { module: '@/nope', form: 'esm' }, repo), { unknown: 'unresolved-module', text: '@/nope' });
  assert.deepEqual(resolveImport('src/a.ts', { module: './nope', form: 'esm' }, repo), { unknown: 'unresolved-module', text: './nope' });
});

// ------------------------------------------------------------------------------------------------ this repository

// This repository has no undefined names, so an undefined-name here is a misread (an object key read as a use).
test('scopes: every code file of this repository is read, each reference joined to a binding, a builtin or a reason', () => {
  const files = execFileSync('git', ['ls-files', 'src', 'bin', 'test', 'examples'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  let read = 0;
  const undefinedNames = [];
  for (const f of files) {
    const t = scopes(f, readFileSync(f, 'utf8'));
    if (!t) continue;
    read++;
    for (const r of t.references) assert.ok(r.to.binding !== undefined ? t.bindings[r.to.binding].name === r.name : r.to.builtin || REASONS.includes(r.to.unknown), `${f}:${r.line} ${r.name}`);
    for (const r of t.references) if (r.to.unknown === 'undefined-name') undefinedNames.push(`${f}:${r.line} ${r.name}`);
  }
  assert.ok(read > 80, `${read} files read`);
  assert.deepEqual(undefinedNames, []);
});

// ---------------------------------------------------------------------------------------------------------- linear

// Texts of n characters that a lookup per use walking the scopes around it, or a scan per statement to the file's end,
// would read in time growing with n's square.
const SCOPE_SHAPES = {
  'py: a long import list': (n) => Array.from({ length: n / 18 }, (_, i) => `import mod${i} as m${i}`).join('\n'),
  'py: a long from-import list': (n) => `from m import (${Array.from({ length: n / 6 }, (_, i) => `n${i}`).join(',\n')})\n`,
  // Nested functions take half the text (their indents grow with the depth), uses of the outermost parameter the other
  // half: a lookup that walked the scopes around each use would take the depth times the uses.
  'py: deep functions': (n) => { const d = Math.floor(Math.sqrt(n / 2)); return `${Array.from({ length: d }, (_, i) => `${' '.repeat(i)}def f${i}(a${i}):`).join('\n')}\n${' '.repeat(d)}return ${'a0 + '.repeat(n / 10)}a0\n`; },
  'py: a long if/elif chain': (n) => `if x == 0:\n    y = 0\n${Array.from({ length: n / 26 }, (_, i) => `elif x == ${i}:\n    y = x\n`).join('')}`,
  'py: many uses of an outer name': (n) => `top = 1\ndef f():\n    def g():\n${Array.from({ length: n / 16 }, () => '        print(top)').join('\n')}\n`,
  'py: nested comprehensions': (n) => `v = ${'['.repeat(n / 20)}q${' for q in r]'.repeat(n / 20)}\n`,
  'js: a long import list': (n) => `import { ${Array.from({ length: n / 6 }, (_, i) => `n${i}`).join(', ')} } from 'm';\n`,
  'js: deep functions': (n) => `${'function f(a) {'.repeat(n / 32)}${'a + '.repeat(n / 8)}a;${'}'.repeat(n / 32)}`,
  'js: deep blocks with var': (n) => `function f() {${'{ var x = 1;'.repeat(n / 14)}x;${'}'.repeat(n / 14)}}`,
  'js: deep arrows': (n) => `const f = ${'a => '.repeat(n / 5)}a;\n`,
  'js: a long else-if chain': (n) => `let y;\nif (x === 0) { y = 0; }${Array.from({ length: n / 30 }, (_, i) => ` else if (x === ${i}) { y = x; }`).join('')}\n`,
  'js: many reassignments': (n) => `let z = 0;\n${'z = z + 1;\n'.repeat(n / 11)}`,
  'ts: a ternary chain with parentheses': (n) => `const v = ${'c ? (a) : '.repeat(n / 10)}z;\n`,
  // Each `<` is read once for type arguments: nested ones, ones that are comparisons, and type parameters with defaults.
  'ts: deep type arguments': (n) => `function f(m: ${'Map<A, '.repeat(n / 16)}A${'>'.repeat(n / 16)}, b) { return b; }\n`,
  'ts: comparisons that look like type arguments': (n) => `const v = ${'a < b && c > (d) || '.repeat(n / 20)}z;\n`,
  'ts: comparisons left open': (n) => `const v = ${'a < b, '.repeat(n / 8)}z;\n`,
  'ts: nested callback types': (n) => `const f = (a: ${'(b: '.repeat(n / 12)}X${') => X'.repeat(n / 12)}): ${'((c: X) => '.repeat(n / 16)}X${')'.repeat(n / 16)} => a;\n`,
  // Placeholders, nested and in a row; markup; case clauses: each token read once.
  'py: many f-string placeholders': (n) => `x = 1\ns = f"${'{x} '.repeat(n / 4)}"\n`,
  'py: nested f-strings': (n) => `x = 1\ns = ${'f"{'.repeat(n / 8)}x${'}"'.repeat(n / 8)}\n`,
  'py: a long match': (n) => `def f(c):\n    match c:\n${Array.from({ length: n / 40 }, (_, i) => `        case [a${i}, *r${i}] if a${i}:\n            return r${i}\n`).join('')}`,
  'js: nested templates': (n) => `const x = 1;\nconst s = ${'`${'.repeat(n / 6)}x${'}`'.repeat(n / 6)};\n`,
  'js: a long JSX element': (n) => `const h = 1;\nconst e = <div>${'<b className="c" on={h}>text {h}</b>'.repeat(n / 40)}</div>;\n`,
  'js: deep JSX': (n) => `const h = 1;\nconst e = ${'<i a={h}>'.repeat(n / 18)}{h}${'</i>'.repeat(n / 18)};\n`,
  'ts: many type parameters with defaults': (n) => `function f<${Array.from({ length: n / 24 }, (_, i) => `T${i} extends Map<A, B> = C`).join(', ')}>(a: T0) { return a; }\n`,
};

test('scopes: linear steps in the length of a file, its nesting and its lists', () => {
  // The steps of src/code.mjs's reader and of this one (countSteps), the same on every machine.
  for (const [name, make] of Object.entries(SCOPE_SHAPES)) {
    const path = name.startsWith('py') ? 'a.py' : name.startsWith('ts') ? 'a.ts' : 'a.js';
    const count = (n) => { const text = make(n); countSteps(true); scopes(path, text); return countSteps(false); };
    const [small, big] = [count(2_000), count(32_000)];
    assert.ok(small > 0 && big < small * 20, `${name}: ${small} steps at 2,000 characters, ${big} at 32,000 (${(big / small).toFixed(1)} times)`);
  }
});

test('scopes: linear time in the length of a file, its nesting and its lists', async () => {
  for (const lang of ['py', 'js', 'ts']) {
    const shapes = Object.fromEntries(Object.entries(SCOPE_SHAPES).filter(([name]) => name.startsWith(lang)));
    const { done, said } = await timeShapes(shapes, new URL('../src/scopes.mjs', import.meta.url).href, 'scopes', new Function('fn', 'text', `return fn('a.${lang}', text);`));
    assert.ok(linearIn(done, shapes), said);
  }
});
