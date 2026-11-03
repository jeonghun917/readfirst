# Working in this repository

In this repository the CLI is the checkout itself (`npx readfirst` does not resolve inside its own package), so use `node bin/readfirst.mjs`; the hooks in .claude/settings.json do the same.

Before changing a file, run `node bin/readfirst.mjs read <file>` and follow what it says: keep the rules, read the risks, run the checks it lists. Before writing a new function or module, run `node bin/readfirst.mjs find <what it does>` and reuse what already exists. Before you finish, run `node bin/readfirst.mjs verify`: it runs the checks the map lists for everything you changed; fix what fails. When you learn something a newcomer would get wrong, add it as a risk in .readfirst/map.json.
