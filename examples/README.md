# Example maps

Maps written for public repositories, to show what a filled map looks like on a real codebase. Each one was drafted
with `npx readfirst init`, then the rules and risks were taken from the repository's own notes (AGENTS.md, CLAUDE.md,
skills, review guides), each citing the file and line it came from.

These are not maintained by, or affiliated with, the projects they describe.

- [india-compliance](india-compliance/): GST and income tax on ERPNext (Frappe, Python)
- [munin](munin/): MCP-first customer platform (pnpm monorepo, NestJS, Drizzle)
- [vercel-ai](vercel-ai/): the AI SDK (pnpm monorepo, 90+ provider packages)
- [calcom](calcom/): Cal.com scheduling (Yarn monorepo, Next.js, Prisma, NestJS API)
- [excalidraw](excalidraw/): the whiteboard and its npm packages (Yarn workspaces, React)

To try one: copy its `map.json` to `.readfirst/map.json` in a checkout of that repository at the commit named in its
README, then run `npx readfirst read <file>`.
