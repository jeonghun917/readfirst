import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importEdges } from '../src/imports.mjs';
import { draftChecks } from '../src/map.mjs';
import { readList } from '../src/readlist.mjs';

const edges = (tree) => importEdges(Object.keys(tree), (f) => tree[f] ?? null).map((e) => `${e.from} -> ${e.to}`).sort();
const testsOf = (tree, target) => readList({ map: { format: 'readfirst/map@1', groups: [{ id: 'all', title: 'all', files: ['**'] }] }, files: Object.keys(tree), imports: importEdges(Object.keys(tree), (f) => tree[f] ?? null), targets: [target] }).tests.map((t) => t.path).sort();

test('Go: a package import reaches every non-test file of that folder', () => {
  const tree = {
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'billing/charge.go': 'package billing\n',
    'billing/refund.go': 'package billing\n',
    'billing/charge_test.go': 'package billing\n',
    'api/handler.go': 'package api\n\nimport (\n\t"fmt"\n\tb "example.com/shop/billing"\n)\n',
    'main.go': 'package main\n\nimport "example.com/shop/api"\n',
  };
  assert.deepEqual(edges(tree), ['api/handler.go -> billing/charge.go', 'api/handler.go -> billing/refund.go', 'main.go -> api/handler.go']);
});

test('Rust: mod declarations and use crate:: / super:: / the crate name from tests/', () => {
  const tree = {
    'Cargo.toml': '[package]\nname = "shop-core"\n',
    'src/lib.rs': 'pub mod billing;\nmod util;\n',
    'src/billing.rs': 'mod invoice;\nuse crate::util::round;\n',
    'src/billing/invoice.rs': 'use super::super::util;\n// use crate::nothing;\n',
    'src/util.rs': 'pub fn round() {}\n',
    'tests/billing.rs': 'use shop_core::billing::invoice;\n',
    'tests/round.rs': 'use shop_core::{util::round, Thing as T};\n',
  };
  assert.deepEqual(edges(tree), [
    'src/billing.rs -> src/billing/invoice.rs', 'src/billing.rs -> src/util.rs', 'src/billing/invoice.rs -> src/util.rs',
    'src/lib.rs -> src/billing.rs', 'src/lib.rs -> src/util.rs', 'tests/billing.rs -> src/billing/invoice.rs',
    'tests/round.rs -> src/lib.rs', 'tests/round.rs -> src/util.rs',
  ]);
  assert.deepEqual(testsOf(tree, 'src/util.rs'), ['tests/billing.rs', 'tests/round.rs']);
});

test('Elixir: defmodule names, alias with braces, and qualified calls', () => {
  const tree = {
    'lib/shop/billing.ex': 'defmodule Shop.Billing do\n  def charge(x), do: x\nend\n',
    'lib/shop/invoice.ex': 'defmodule Shop.Invoice do\nend\n',
    'lib/shop_web/controller.ex': 'defmodule ShopWeb.Controller do\n  alias Shop.{Billing, Invoice}\n  # Shop.Nothing\nend\n',
    'test/shop/billing_test.exs': 'defmodule Shop.BillingTest do\n  use ExUnit.Case\n  test "x", do: Shop.Billing.charge(1)\nend\n',
  };
  assert.deepEqual(edges(tree), ['lib/shop_web/controller.ex -> lib/shop/billing.ex', 'lib/shop_web/controller.ex -> lib/shop/invoice.ex', 'test/shop/billing_test.exs -> lib/shop/billing.ex']);
  assert.deepEqual(testsOf(tree, 'lib/shop/billing.ex'), ['test/shop/billing_test.exs']);
});

test('C#: types reached through using, the own namespace and enclosing ones; comments and strings do not count', () => {
  const tree = {
    'Shop.sln': '',
    'src/Billing/Invoice.cs': 'namespace Shop.Billing;\npublic class Invoice { }\n',
    'src/Billing/Charger.cs': 'namespace Shop.Billing\n{\n  public class Charger { Invoice Make() => new Invoice(); }\n}\n',
    'src/Shared/Money.cs': 'namespace Shop;\npublic record Money(decimal Amount);\n',
    'src/Api/Controller.cs': 'using Shop.Billing;\nnamespace Shop.Api;\n// Invoice in a comment\nclass Controller { Charger c; string s = "Invoice"; Money m; }\n',
    'Shop.Tests/ChargerTests.cs': 'using Shop.Billing;\nnamespace Shop.Tests;\npublic class ChargerTests { Charger c; }\n',
  };
  assert.deepEqual(edges(tree), [
    'Shop.Tests/ChargerTests.cs -> src/Billing/Charger.cs',
    'src/Api/Controller.cs -> src/Billing/Charger.cs', 'src/Api/Controller.cs -> src/Shared/Money.cs', 'src/Billing/Charger.cs -> src/Billing/Invoice.cs',
  ], 'Invoice only in a comment and a string in Controller.cs is not an edge');
  assert.deepEqual(testsOf(tree, 'src/Billing/Invoice.cs'), ['Shop.Tests/ChargerTests.cs']);
  assert.ok(draftChecks(Object.keys(tree)).some((c) => c.run === 'dotnet test'));
});

test('Java and Kotlin: single-type imports, wildcards and same-package names', () => {
  const tree = {
    'build.gradle.kts': '', 'gradlew': '',
    'src/main/java/shop/billing/Invoice.java': 'package shop.billing;\npublic class Invoice {}\n',
    'src/main/java/shop/billing/Charger.java': 'package shop.billing;\nclass Charger { Invoice i; }\n',
    'src/main/kotlin/shop/api/Api.kt': 'package shop.api\nimport shop.billing.Charger\nclass Api(val c: Charger)\n',
    'src/test/java/shop/billing/ChargerTest.java': 'package shop.billing;\nimport shop.billing.*;\nclass ChargerTest { Charger c; }\n',
  };
  assert.deepEqual(edges(tree), [
    'src/main/java/shop/billing/Charger.java -> src/main/java/shop/billing/Invoice.java',
    'src/main/kotlin/shop/api/Api.kt -> src/main/java/shop/billing/Charger.java',
    'src/test/java/shop/billing/ChargerTest.java -> src/main/java/shop/billing/Charger.java',
  ]);
  assert.deepEqual(testsOf(tree, 'src/main/java/shop/billing/Invoice.java'), ['src/test/java/shop/billing/ChargerTest.java']);
  assert.ok(draftChecks(Object.keys(tree)).some((c) => c.run === './gradlew test'));
});

test('Ruby: require_relative, lib requires and Rails constants', () => {
  const tree = {
    'Gemfile': '',
    'app/models/billing/invoice.rb': 'module Billing\n  class Invoice; end\nend\n',
    'app/services/charge_card.rb': 'class ChargeCard\n  def call = Billing::Invoice.new\nend\n',
    'lib/money_format.rb': '',
    'app/helpers/price_helper.rb': "require 'money_format'\nrequire_relative '../services/charge_card'\n",
    'spec/services/charge_card_spec.rb': 'RSpec.describe ChargeCard do; end\n',
  };
  assert.deepEqual(edges(tree), [
    'app/helpers/price_helper.rb -> app/services/charge_card.rb', 'app/helpers/price_helper.rb -> lib/money_format.rb',
    'app/services/charge_card.rb -> app/models/billing/invoice.rb', 'spec/services/charge_card_spec.rb -> app/services/charge_card.rb',
  ]);
  assert.deepEqual(testsOf(tree, 'app/models/billing/invoice.rb'), ['spec/services/charge_card_spec.rb']);
  assert.ok(draftChecks(Object.keys(tree)).some((c) => c.run === 'bundle exec rspec'));
});

test('PHP: use statements and qualified names through composer PSR-4', () => {
  const tree = {
    'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } }, 'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } }, scripts: { test: 'phpunit' } }),
    'app/Billing/Invoice.php': '<?php namespace App\\Billing; class Invoice {}',
    'app/Http/Controller.php': '<?php\nnamespace App\\Http;\nuse App\\Billing\\Invoice;\n',
    'tests/Unit/InvoiceTest.php': '<?php\n$x = new \\App\\Billing\\Invoice();\n',
  };
  assert.deepEqual(edges(tree), ['app/Http/Controller.php -> app/Billing/Invoice.php', 'tests/Unit/InvoiceTest.php -> app/Billing/Invoice.php']);
  assert.ok(draftChecks(Object.keys(tree), (f) => tree[f] ?? null).some((c) => c.run === 'composer test'));
});

test('Elixir checks and a repository with none of these languages', () => {
  assert.ok(draftChecks(['mix.exs', 'lib/a.ex']).some((c) => c.run === 'mix test'));
  assert.deepEqual(edges({ 'README.md': '# x', 'a.txt': 'Shop.Billing' }), []);
});

test('TypeScript: workspace packages by name and tsconfig "paths" aliases', () => {
  const tree = {
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*', 'apps/*'] }),
    'packages/db/package.json': JSON.stringify({ name: '@acme/db', main: './dist/index.js', types: './dist/index.d.ts' }),
    'packages/db/src/index.ts': "export * from './schema';\n",
    'packages/db/src/schema.ts': 'export const invoices = 1;\n',
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': { types: './src/main.ts', default: './dist/main.js' } } }),
    'packages/ui/src/main.ts': '',
    'apps/web/tsconfig.json': '{\n  // Next.js alias\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], }, },\n}\n',
    'apps/web/src/lib/money.ts': '',
    'apps/web/src/app/page.tsx': "import { invoices } from '@acme/db';\nimport { schema } from '@acme/db/schema';\nimport { Button } from '@acme/ui';\nimport { cents } from '@/lib/money';\nimport React from 'react';\nimport fs from 'node:fs';\n",
    'apps/web/src/app/page.test.tsx': "import Page from './page';\n",
    'apps/other/src/x.ts': "import { cents } from '@/lib/money';\n",
  };
  assert.deepEqual(edges(tree), [
    'apps/web/src/app/page.test.tsx -> apps/web/src/app/page.tsx',
    'apps/web/src/app/page.tsx -> apps/web/src/lib/money.ts',
    'apps/web/src/app/page.tsx -> packages/db/src/index.ts',
    'apps/web/src/app/page.tsx -> packages/db/src/schema.ts',
    'apps/web/src/app/page.tsx -> packages/ui/src/main.ts',
    'packages/db/src/index.ts -> packages/db/src/schema.ts',
  ], 'the alias applies only under the tsconfig that declares it; outside packages and node: are left out');
  assert.deepEqual(testsOf(tree, 'packages/db/src/schema.ts'), ['apps/web/src/app/page.test.tsx']);
});

test('Python: dotted strings that name a module of the repository (Frappe hooks, frappe.call, Django settings)', () => {
  const tree = {
    'shop/__init__.py': '',
    'shop/hooks.py': 'doc_events = {"Sales Invoice": {"validate": "shop.overrides.sales_invoice.validate"}}\nlabel = "not.a.module"\n',
    'shop/overrides/__init__.py': '',
    'shop/overrides/sales_invoice.py': 'def validate(doc, method=None): pass\n',
    'shop/api.py': 'def charge(): pass\n',
    'shop/public/js/invoice.js': 'frappe.call({ method: "shop.api.charge" });\n',
    'shop/settings.json': '{"handler": "shop.missing.thing"}\n',
  };
  assert.deepEqual(edges(tree), [
    'shop/hooks.py -> shop/overrides/sales_invoice.py',
    'shop/public/js/invoice.js -> shop/api.py',
  ]);
});

test('Python: a Django project under a folder resolves from the folder that holds manage.py', () => {
  const tree = {
    'backend/manage.py': 'import os\n',
    'backend/feeds/__init__.py': '',
    'backend/feeds/models.py': 'class Feed: pass\n',
    'backend/feeds/views.py': 'from feeds.models import Feed\nfrom feeds import models\n',
    'backend/settings.py': 'INSTALLED_APPS = ["feeds.apps.FeedsConfig"]\n',
    'backend/feeds/apps.py': 'class FeedsConfig: pass\n',
    'backend/feeds/tests/test_models.py': 'import feeds.models\n',
  };
  assert.deepEqual(edges(tree), [
    'backend/feeds/tests/test_models.py -> backend/feeds/models.py',
    'backend/feeds/views.py -> backend/feeds/__init__.py',
    'backend/feeds/views.py -> backend/feeds/models.py',
    'backend/settings.py -> backend/feeds/apps.py',
  ]);
});

test('Python 2: an implicit relative import names a module next to the importing file', () => {
  const tree = {
    'feedlib/__init__.py': '',
    'feedlib/export.py': 'import utils\nfrom channels import google\nimport os\n\nprint "exported"\n',
    'feedlib/utils.py': 'def clean(): pass\n',
    'feedlib/channels/__init__.py': '',
    'feedlib/channels/google.py': 'def push(): pass\n',
    'settings.py': 'ROOT = 1\n',
    'feedlib/settings.py': 'LOCAL = 1\n',
    'feedlib/run.py': 'import settings\ntry:\n    pass\nexcept ValueError, e:\n    pass\n',
    'feedlib/py3.py': 'import utils\nprint("no Python 2 here")\n',
    'feedlib/future.py': 'from __future__ import absolute_import\nimport utils\nprint "x"\n',
  };
  // Only files with Python 2 syntax read imports from their own folder; a module of the same name at a source root wins.
  assert.deepEqual(edges(tree), [
    'feedlib/export.py -> feedlib/channels/__init__.py',
    'feedlib/export.py -> feedlib/channels/google.py',
    'feedlib/export.py -> feedlib/utils.py',
    'feedlib/run.py -> settings.py',
  ]);
});
