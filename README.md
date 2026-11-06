# readfirst

**What to read and check before you — or your AI agent — change a file.**

Coding agents can follow imports. What they don't know is what your team knows: "amounts here are in cents",
"this table is read by the mobile app, keep old columns", "run the payment e2e after touching this". readfirst keeps that
knowledge in one file next to the code and hands it out, file by file, at the moment someone is about to change something.

![npx readfirst read src/imports.mjs prints the rules, risks, checks, tests and callers for that file](docs/readfirst-read.gif)

No server, no account, no model calls. MIT. It reads your git checkout and `.readfirst/map.json`.

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

Fixed by the maintainers:

- **saleor**: an "only recalculate what changed" option recalculated every discounted price
  ([saleor/saleor#19984](https://github.com/saleor/saleor/pull/19984)).
- **wagtail**: a superuser who submits a page for moderation got the moderation email about their own submission
  ([wagtail/wagtail#14790](https://github.com/wagtail/wagtail/pull/14790)).
- **mealie**: a safety filter on households never applied
  ([mealie-recipes/mealie#8964](https://github.com/mealie-recipes/mealie/issues/8964)).
- **n8n**: the RabbitMQ node handed back its channel before the queue bindings were made, and a failed bind escaped
  as an unhandled rejection ([n8n-io/n8n#43017](https://github.com/n8n-io/n8n/issues/43017)).
- **django-allauth**: a provider callback returned a 500 instead of a clean failure on a non-ASCII value; fixed the
  day it was reported.

Still with their maintainers: a Tandoor filter that never applied
([TandoorRecipes/recipes#4917](https://github.com/TandoorRecipes/recipes/pull/4917)), and findings sent privately to
other projects, which stay unnamed until they are fixed.

## Start

Any language; needs Node 20+.

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
