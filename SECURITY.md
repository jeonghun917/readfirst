# Security policy

## Supported versions

Only the latest release gets fixes. Today that is 0.8.x, on npm as `readfirst` and as the GitHub Action
`jeonghun917/readfirst@v0`.

## Reporting a vulnerability

Please do not open a public issue. Report it privately:

- on GitHub: the repository's **Security** tab → **Report a vulnerability**, or
- by email: ashite1010@gmail.com, subject starting with `[readfirst security]`.

Say what is affected (command, hook, MCP server or Action), how to reproduce it, and the version. You will get an
answer within 3 days, and a fix or a plan within 14 days for a confirmed issue. Reporters are credited in the release
notes unless they ask not to be.

## What readfirst runs

- The command, the MCP server and the PreToolUse hook read the git checkout and `.readfirst/map.json`. They make no
  network calls and run no commands.
- `readfirst verify` runs the check commands the map lists, with the shell, as you would by hand. The opt-in Stop hook
  (`hook --install --verify`) runs only the commands that the base branch's map already lists.
- The GitHub Action calls the GitHub API with the token it is given. With `auto-fix: true` it commits only the map
  update that `readfirst fix` would write, and never to a fork's branch.
