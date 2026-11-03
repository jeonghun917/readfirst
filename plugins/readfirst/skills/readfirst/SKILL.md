---
name: readfirst
description: Read what the repository's own map says before changing code, reuse what already exists, and run the checks that cover your change before you finish. Use whenever you are about to edit, add or delete files in a repository that has a .readfirst/map.json, before writing a new function, module or helper in any repository, and before telling the user a change is done.
argument-hint: the file you are about to change, or what the new code should do
allowed-tools: Bash(npx --yes readfirst:*), Bash(npx readfirst:*)
---

# Read first, then change

readfirst keeps a map of the repository in `.readfirst/map.json`: groups of files, the checks
that cover them, the risks a newcomer would get wrong, and the rules the code keeps. People wrote
it, or it was drafted from the code and reviewed. It runs locally: no network, no model, no
account.

## Before you change a file

```bash
npx --yes readfirst read <file> [<file> ...]
```

Follow what it prints:

- **Rules** are promises other code depends on. Keep them. If the change needs to break one, stop
  and tell the user which rule and why, instead of breaking it quietly.
- **Risks** are traps. Read each one and check your change against it.
- **Checks** are the commands that cover these files. Run them after the change.
- **Tests that reach this file** and **used by** show what else your change can break. Read the
  callers you are about to change the behaviour of.
- A group marked **being replaced** says what to use instead. Do not add new code to it.

If the repository has no `.readfirst/map.json`, `read` says so. Do not create one unasked; you
can tell the user that `npx readfirst init --agent` drafts one from the folders and scripts.

## Before you write new code

```bash
npx --yes readfirst find <what the code should do>
```

It lists functions and files that may already do it, best first, with how many places use each.
Reuse or extend what exists instead of writing a second version. If none fits, say so in one line
and write the new code.

## Before you say you are done

```bash
npx --yes readfirst verify
```

It runs the checks the map lists for everything you changed against the base branch. Fix what
fails. If a check cannot run here (a missing service, a missing tool), say which one and why
rather than skipping it silently.

## When you learn something

If you hit something a newcomer would get wrong in this repository, and the map does not say it,
add it as a risk to the right group in `.readfirst/map.json`, with the file and line that shows
it, and run `npx readfirst check` so the map still passes.
