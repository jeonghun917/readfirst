# readfirst

**What to read and check before you — or your AI agent — change a file.**

Coding agents can follow imports. What they don't know is what your team knows: "amounts here are in cents",
"this table is read by the mobile app, keep old columns", "run the payment e2e after touching this". readfirst keeps that
knowledge in one file next to the code and hands it out, file by file, at the moment someone is about to change something.

![npx readfirst read src/imports.mjs prints the rules, risks, checks, tests and callers for that file](docs/readfirst-read.gif)

No server, no account, no model calls. MIT. It reads your git checkout and `.readfirst/map.json`.

## What it caught

Making maps for open source projects, a check for lines whose result is thrown away found real bugs. The ones already
with their maintainers:

- **saleor**: an "only recalculate what changed" option recalculated every discounted price
  ([saleor/saleor#19984](https://github.com/saleor/saleor/pull/19984)).
- **wagtail**: a superuser who submits a page for moderation got the moderation email about their own submission
  ([wagtail/wagtail#14790](https://github.com/wagtail/wagtail/pull/14790)).
- **Tandoor**: a `?category=` filter on an API endpoint never applied
  ([TandoorRecipes/recipes#4917](https://github.com/TandoorRecipes/recipes/pull/4917)).
- **mealie**: a safety filter on households never applied; the maintainers fixed it
  ([mealie-recipes/mealie#8964](https://github.com/mealie-recipes/mealie/issues/8964)).

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
