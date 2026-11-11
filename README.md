# readfirst

**What to read and check before you — or your AI agent — change a file.**

It found bugs now fixed upstream in [Saleor](https://github.com/saleor/saleor/pull/19984),
[Wagtail](https://github.com/wagtail/wagtail/pull/14790), [n8n](https://github.com/n8n-io/n8n/pull/43033),
[django-allauth](https://codeberg.org/allauth/django-allauth/commit/f1e06cc050eb) and
[WYGIWYH](https://github.com/eitchtee/WYGIWYH/pull/649): 136 real findings across 68 open-source repositories.

## Start in 30 seconds

Any language; needs Node 20+.

```sh
npx readfirst init --agent --ci   # a first map, your agents wired to it (Claude Code, Cursor, Codex, Gemini, ...), the PR Action
npx readfirst read <file>         # before changing a file: its rules, risks, checks, tests and callers
npx readfirst verify              # before you finish: the checks pass and nothing the map ties to the change was left out
```

![npx readfirst read src/imports.mjs prints the rules, risks, checks, tests and callers for that file](docs/readfirst-read.gif)

Commit `.readfirst/map.json`. Filled maps for real repositories: [examples/](examples/).

## What it does

Coding agents can follow imports. What they don't know is what your team knows: "amounts here are in cents", "this
table is read by the mobile app, keep old columns", "run the payment e2e after touching this". readfirst keeps that in
one file next to the code and hands it out, file by file, when someone is about to change something.

- **Your rules and risks, per file**, from `.readfirst/map.json`, with the checks to run and the files that change
  together.
- **Where the code broke before**, from git history: `npx readfirst audit`, no map needed.
- **Bug shapes taken from real bugs**: `npx readfirst scan`, no map needed (results computed and thrown away,
  `expect(...).resolves` nobody awaits, and four more).

No server, no account, no model calls. It reads your git checkout and the map.

## Free and hosted

|  | Free (MIT) | Pro, $39 a month ([readfirst-app](https://readfirst-cloud.vercel.app/)) |
|---|---|---|
| Where it runs | your machine and your CI; your code goes nowhere | the readfirst-app GitHub App reads your repositories on our server |
| The map | `init` writes a first one; you keep it | written for you from the code and its history (the free hosted fill is paused until three paying subscribers), and kept in step after each merge |
| Pull requests | the Action posts what to read and check | PR watch comments on every pull request, whoever opened it: rules a change may break, files left out, the same table written elsewhere |
| Bug shapes | the 6 published shapes (`scan`) | the full hosted set, a repository audit and fix PRs |
| Where outside input goes | — | flows: from each route to the writes it reaches and the checks on the way |
| Agents | Claude Code plugin and hook, MCP server, Cursor rules | the same, plus reproduced-bug reviews in a sandbox (one a month) |

Details: [the guide](https://github.com/jeonghun917/readfirst/blob/main/docs/guide.md#hosted-readfirst-app).

## What it caught

- **Saleor**: an "only recalculate what changed" option recalculated every discounted price
  ([#19984](https://github.com/saleor/saleor/pull/19984)).
- **Wagtail**: a superuser who submits a page got the moderation email about their own submission
  ([#14790](https://github.com/wagtail/wagtail/pull/14790)).
- **n8n**: the RabbitMQ node handed back its channel before the queue bindings were made
  ([#43033](https://github.com/n8n-io/n8n/pull/43033), fixed by the n8n team after our issue).
- **django-allauth**: a provider callback returned a 500 on a non-ASCII value
  ([f1e06cc](https://codeberg.org/allauth/django-allauth/commit/f1e06cc050eb), fixed the day it was reported).
- **WYGIWYH**: client registration answered a 500 instead of a refusal on a non-ASCII token
  ([#649](https://github.com/eitchtee/WYGIWYH/pull/649), merged with its regression test).

Across 68 open-source repositories the hosted shapes recorded 897 hits, 849 judged: 100 bugs in app code, 36 tests that
pass even when their check fails, and 312 false positives kept on record. The counts come after tuning on the same
repositories, so read them as "what is there", not as precision. Reports still with their maintainers:
[the guide](https://github.com/jeonghun917/readfirst/blob/main/docs/guide.md#what-it-caught).

## More

The Claude Code plugin and hook, MCP for any agent, Cursor rules, the GitHub Action, the map format, `audit`, `find`,
monorepos and pinning a version: **[the guide](https://github.com/jeonghun917/readfirst/blob/main/docs/guide.md)**.

## License

MIT
