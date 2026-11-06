import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitions, find, findText, words } from '../src/find.mjs';

test('words splits names and paths, drops intent words, and stems plurals and verb endings', () => {
  assert.deepEqual(words('retryPayment'), ['retry', 'payment']);
  assert.deepEqual(words('payments/retry_handler.py'), ['payment', 'retry', 'handler', 'py']);
  assert.deepEqual(words('add a new helper for retries'), ['retry']);
  assert.deepEqual(words('HTTPClient parseJSONBody'), ['http', 'client', 'parse', 'json', 'body']);
  assert.deepEqual(words('결제를 재시도하기'), ['결제를', '재시도하기'], 'Hangul is kept whole and met by prefix');
});

test('definitions reads function, class and type names across languages', () => {
  const names = (path, body) => definitions(path, body).map((d) => [d.name, d.kind, d.line]);
  assert.deepEqual(names('a.ts', 'export async function chargeCard() {}\nexport const refund = async (id) => {};\nclass Ledger {}\nexport type Money = number;\nif (x) {}\n'),
    [['chargeCard', 'function', 1], ['refund', 'function', 2], ['Ledger', 'type', 3], ['Money', 'type', 4]]);
  assert.deepEqual(names('a.py', 'class Order:\n    async def refund_payment(self):\n        pass\n'), [['Order', 'type', 1], ['refund_payment', 'function', 2]]);
  assert.deepEqual(names('a.go', 'func (s *Svc) RetryCharge() {}\ntype Gateway struct{}\n'), [['RetryCharge', 'function', 1], ['Gateway', 'type', 2]]);
  assert.deepEqual(names('a.rb', 'class Refunds\n  def self.retry_all!\n'), [['Refunds', 'type', 1], ['retry_all!', 'function', 2]]);
  assert.deepEqual(names('notes.txt', 'def x'), []);
});

const FILES = {
  'src/payments/retry.js': 'export function retryPayment(id) {}\nexport const backoff = (n) => n * 2;\n',
  'src/payments/charge.js': "import { retryPayment } from './retry.js';\nexport function chargeCard() {}\n",
  'src/orders/refund.js': "import { retryPayment } from '../payments/retry.js';\nexport function refundOrder() {}\n",
  'src/email/send.js': 'export function sendRetryEmail() {}\n',
  'test/retry.test.js': "import { retryPayment } from '../src/payments/retry.js';\nfunction testRetryPaymentTwice() {}\n",
  'ios/Pay.swift': 'func pay() {}\n',
};
const imports = [
  { from: 'src/payments/charge.js', to: 'src/payments/retry.js', line: 1 },
  { from: 'src/orders/refund.js', to: 'src/payments/retry.js', line: 1 },
  { from: 'test/retry.test.js', to: 'src/payments/retry.js', line: 1 },
];
const map = {
  format: 'readfirst/map@1',
  groups: [{ id: 'payments', title: 'payments: charging cards and retrying failed payments', files: ['src/payments/**'], risks: [{ text: 'a payment retry must reuse the idempotency key' }] }, { id: 'rest', title: 'the rest', files: ['**'] }],
  rules: [{ id: 'idempotent-retry', rule: 'every payment retry reuses the idempotency key', files: ['src/payments/**'] }],
};

test('find puts the function whose name is the words asked first, code before tests, and what the map says', () => {
  const r = find({ query: 'add a payment retry helper', files: Object.keys(FILES), imports, read: (p) => FILES[p] ?? null, map });
  assert.deepEqual(r.words, ['payment', 'retry']);
  assert.equal(r.code[0].name, 'retryPayment');
  assert.equal(r.code[0].exact, true);
  assert.equal(r.code[0].usedBy, 2, 'tests do not count as users');
  assert.equal(r.code[0].group, 'payments');
  const names = r.code.map((h) => h.name ?? h.file);
  assert.ok(names.indexOf('testRetryPaymentTwice') > names.indexOf('src/payments/retry.js'), 'a test comes after code that matches as many words');
  assert.ok(!names.includes('sendRetryEmail'), 'one word of two is dropped while others match both');
  assert.deepEqual(r.map.map((h) => h.id ?? h.group).sort(), ['idempotent-retry', 'payments', 'payments']);
  assert.deepEqual(r.notSearched, ['swift']);
  const text = findText(r);
  assert.match(text, /- `retryPayment` \(function\) in `src\/payments\/retry.js:1` — name matches · used by 2 file\(s\) · group payments/u);
  assert.match(text, /rule \*\*idempotent-retry\*\*/u);
  assert.match(text, /Not searched: \.swift files/u);
});

test('find matches a definition through the folder it sits in, and says so when nothing matches', () => {
  const r = find({ query: 'payment backoff', files: Object.keys(FILES), imports, read: (p) => FILES[p] ?? null });
  assert.equal(r.code[0].name, 'backoff');
  assert.deepEqual(r.code[0].matched, ['backoff', 'payment']);
  const none = find({ query: '결제 재시도', files: Object.keys(FILES), read: (p) => FILES[p] ?? null });
  assert.match(findText(none), /Nothing matched[^\n]*English words the code would use/u);
  assert.match(findText(find({ query: 'add a new helper', files: [] })), /Only words like "add"/u);
});

test('find reads the comment that says what a definition does, above it or as a Python docstring', () => {
  const texts = {
    'lib/refs.js': '// Table references in a piece of SQL: which tables a line writes or reads.\nexport function lineRefs(text) {\n  return [];\n}\n',
    'app/money.py': '@cached\ndef settle(x):\n    """Pay out the balance owed to a seller."""\n    return x\n',
    'lib/other.js': 'export function unrelated() {}\n',
  };
  const r = find({ query: 'sql table references', files: Object.keys(texts), read: (p) => texts[p] ?? null });
  assert.equal(r.code[0].name, 'lineRefs');
  assert.deepEqual(r.code[0].inComment, ['sql', 'table'], 'reference meets the name (ref)');
  assert.match(findText(r), /in its comment/u);
  const py = find({ query: 'seller payout balance', files: Object.keys(texts), read: (p) => texts[p] ?? null });
  assert.equal(py.code[0].name, 'settle');
});
