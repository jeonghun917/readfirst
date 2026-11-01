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
