# readfirst

**What to read and check before you — or your AI agent — change a file.**

Bugs it found that are now fixed upstream: [Saleor](https://github.com/saleor/saleor/pull/19984),
[Wagtail](https://github.com/wagtail/wagtail/pull/14790), [n8n](https://github.com/n8n-io/n8n/pull/43033),
[django-allauth](https://codeberg.org/allauth/django-allauth/commit/f1e06cc050eb). 136 real findings across 68
open-source repositories, reported to 21 projects.

Coding agents can follow imports. What they don't know is what your team knows: "amounts here are in cents",
"this table is read by the mobile app, keep old columns", "run the payment e2e after touching this". readfirst keeps that
knowledge in one file next to the code and hands it out, file by file, at the moment someone is about to change something.

![npx readfirst read src/imports.mjs prints the rules, risks, checks, tests and callers for that file](docs/readfirst-read.gif)

No server, no account, no model calls. MIT. It reads your git checkout and `.readfirst/map.json`.

## What it caught

```sh
npx readfirst scan   # no map needed: QuerySet/string results thrown away, expect(...).resolves nobody awaits
npx readfirst audit  # no map needed: the files that broke most in the last 12 months, from git history
```

On the free side, readfirst shows where your code broke before, from git history, on the first run, no map needed.

The hosted version scans for fixed bug shapes taken from real bugs: a result computed and thrown away, a range check
with no type check, a secret compared with `!==`, and more. Run over 68 open-source repositories, 897 hits, 849 of
them judged and recorded (real, caveat, false positive, dead code):

- **100 bugs in app code**, 21 of them low-severity secret comparisons
- **36 tests that pass even when their check fails**, every one the same shape: `expect(promise).resolves...` with
  no `await` or `return`, so under Jest the test ends before the assertion runs (Vitest and bun test catch it, so
  their files are left out)
- the 312 false positives are kept on record too, each one settled by a condition every repository gets; the counts
  come after tuning on the same repositories, so read them as "what is there", not as precision

Fixed upstream:

- **saleor**: an "only recalculate what changed" option recalculated every discounted price
  ([saleor/saleor#19984](https://github.com/saleor/saleor/pull/19984)).
- **wagtail**: a superuser who submits a page for moderation got the moderation email about their own submission
  ([wagtail/wagtail#14790](https://github.com/wagtail/wagtail/pull/14790)).
- **n8n**: the RabbitMQ node handed back its channel before the queue bindings were made, and a failed bind escaped
  as an unhandled rejection; the n8n team fixed it after our issue
  ([n8n-io/n8n#43033](https://github.com/n8n-io/n8n/pull/43033)).
- **django-allauth**: a provider callback returned a 500 instead of a clean failure on a non-ASCII value; fixed the
  day it was reported ([f1e06cc](https://codeberg.org/allauth/django-allauth/commit/f1e06cc050eb)).
- **mealie**: a household safety filter that never applied ([mealie#8964](https://github.com/mealie-recipes/mealie/issues/8964))
  is gone on main since a maintainer's scope fix ([mealie#8965](https://github.com/mealie-recipes/mealie/pull/8965)).

Still with their maintainers: a Tandoor filter that never applied
([TandoorRecipes/recipes#4917](https://github.com/TandoorRecipes/recipes/pull/4917)); a failed PayPal capture that went
on to mark the booking paid, and webhooks nobody awaited, in Cal.diy
([#30526](https://github.com/calcom/cal.diy/pull/30526), [#30527](https://github.com/calcom/cal.diy/pull/30527));
Sentry tasks queued before the rows they read were committed
([getsentry/sentry#130383](https://github.com/getsentry/sentry/pull/130383)); a 500 instead of a refusal on a non-ASCII
secret in vas3k.club and WYGIWYH ([vas3k/vas3k.club#1533](https://github.com/vas3k/vas3k.club/pull/1533),
[eitchtee/WYGIWYH#649](https://github.com/eitchtee/WYGIWYH/pull/649)); and findings sent privately to other projects,
which stay unnamed until they are fixed.

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
