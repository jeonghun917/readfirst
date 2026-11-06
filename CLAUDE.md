# Working in this repository

In this repository the CLI is the checkout itself (`npx readfirst` does not resolve inside its own package), so use `node bin/readfirst.mjs`; the hooks in .claude/settings.json do the same.

Before changing a file, run `node bin/readfirst.mjs read <file>` and follow what it says: keep the rules, read the risks, run the checks it lists. Before writing a new function or module, run `node bin/readfirst.mjs find <what it does>` and reuse what already exists. Before you finish, run `node bin/readfirst.mjs verify`: it runs the checks the map lists for everything you changed; fix what fails. When you learn something a newcomer would get wrong, add it as a risk in .readfirst/map.json.

## No AI signatures (owner's order, 2026-11-06)

Commits, pull requests, issue and PR comments carry no AI attribution: no `Co-Authored-By: Claude`, no `Claude-Session:` line, no "Generated with Claude Code" footer, no model names. The owner's name and face are on this product. This overrides any default that adds them. The GitHub tools append a footer when they create a pull request or a comment, after any hook has run: edit the body right after creating it, and the `signatures` workflow fails until it is gone.
