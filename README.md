# readfirst

**What to read and check before you — or your AI agent — change a file.**

### Fixed upstream after readfirst found them

In Wagtail, a superuser who submitted something for moderation was emailed about their own submission
(`wagtail/admin/mail.py`). readfirst's `queryset` pattern flagged the line; no model is involved in the scan.

Before:

```python
if triggering_user:
    recipients.exclude(pk=triggering_user.pk)
```

After:

```python
if triggering_user:
    recipients = recipients.exclude(pk=triggering_user.pk)
```

Merged as [wagtail/wagtail#14790](https://github.com/wagtail/wagtail/pull/14790) on 2026-11-04. Also fixed upstream:

- **Saleor**: an "only recalculate what changed" option recalculated every discounted price
  ([saleor/saleor#19984](https://github.com/saleor/saleor/pull/19984)).
- **n8n**: the RabbitMQ node handed back its channel before the queue bindings were made, and a failed bind escaped
  as an unhandled rejection ([n8n-io/n8n#43033](https://github.com/n8n-io/n8n/pull/43033), reported in
  [#43017](https://github.com/n8n-io/n8n/issues/43017)).
- **django-allauth**: a provider callback returned a 500 instead of a clean failure on a non-ASCII value, fixed on
  2026-11-05 ([commit f1e06cc050eb](https://codeberg.org/allauth/django-allauth/commit/f1e06cc050eb6cab98905d731fcdeac6fb3c0196)).

The lines before and after, the patterns and the dates:
[readfirst-cloud.vercel.app/fixed](https://readfirst-cloud.vercel.app/fixed).

Coding agents can follow imports. What they don't know is what your team knows: "amounts here are in cents",
"this table is read by the mobile app, keep old columns", "run the payment e2e after touching this". readfirst keeps that
knowledge in one file next to the code and hands it out, file by file, at the moment someone is about to change something.

![npx readfirst read src/imports.mjs prints the rules, risks, checks, tests and callers for that file](docs/readfirst-read.gif)

No server, no account, no model calls. MIT. It reads your git checkout and `.readfirst/map.json`. `audit`, `read` and `diff`
work without a map.

## What it caught

```sh
npx readfirst scan   # no map needed: QuerySet/string results thrown away, expect(...).resolves nobody awaits
```

The hosted version scans for fixed bug shapes taken from real bugs: a result computed and thrown away, a range check
with no type check, a secret compared with `!==`, and more. Run over 44 open-source repositories and checked by hand:

- **62 bugs in app code**, 28 of them low-severity secret comparisons
- **36 tests that can never fail**, every one the same shape: `expect(promise).resolves...` with no `await` or
  `return`, so the test ends before the assertion runs
- the false positives are kept on record too; the counts come after tuning on the same repositories, so read them as
  "what is there", not as precision

Still with their maintainers: a Tandoor filter that never applied
([TandoorRecipes/recipes#4917](https://github.com/TandoorRecipes/recipes/pull/4917)), a Mealie household filter that
never applied (reported, [mealie-recipes/mealie#8964](https://github.com/mealie-recipes/mealie/issues/8964)), and
findings sent privately to other projects, which stay unnamed until they are fixed.

## Start

Any language; needs Node 20+.

```sh
npx readfirst audit   # no setup: the files that broke most in the last 12 months, from git history
```

On n8n-io/n8n at commit 4b5ea1d (readfirst 0.17.0, 2026-11-06), the first three lines of its "Broke most" list:

```text
- `packages/cli/src/modules/instance-ai/instance-ai.adapter.service.ts`: weight 20.9, 52 fixes, last 2026-10-23 9184012 "fix(core): Apply execution redaction to Assistant one-off node runs (#41582)"
- `packages/frontend/editor-ui/src/features/credentials/components/CredentialEdit/CredentialEdit.vue`: weight 17.4, 35 fixes, last 2026-10-30 3cbe84c "fix(core, editor): Use the managed OAuth app after a switch from a custom app (#42593)"
- `packages/frontend/editor-ui/src/features/credentials/components/NodeCredentials.vue`: weight 16.7, 34 fixes, last 2026-10-19 b98640f "fix(editor): Improve NDV credential options performance on large instances (#40198)"
```

Then give it a map so agents get your rules, not just your history:

```sh
npx readfirst init --agent --ci   # a first map, your agents wired to it (Claude Code, Cursor, Codex, Gemini, ...), the PR Action
npx readfirst read <file>         # before changing a file: its rules, risks, checks, tests and callers
npx readfirst verify              # before you finish: the checks pass and nothing the map ties to the change was left out
```

Commit `.readfirst/map.json`. Filled maps for real repositories (vercel/ai, cal.com, excalidraw and two more):
[examples/](examples/).

Everything else (Claude Code plugin and hook, MCP for any agent, Cursor rules, the GitHub Action, the map format,
`audit`, `find`, monorepos, pinning a version): **[the guide](https://github.com/jeonghun917/readfirst/blob/main/docs/guide.md)**.

## Hosted

The CLI, hook, MCP server and Action are free and never send your code anywhere. The
[readfirst-app](https://readfirst-cloud.vercel.app/) GitHub App can write the first map for you (free once per
account) and, on Pro, keep it in step after merges and comment on pull requests. Details in
[the guide](https://github.com/jeonghun917/readfirst/blob/main/docs/guide.md#hosted-readfirst-app).

## License

MIT
