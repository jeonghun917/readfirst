# calcom

[calcom/cal.com](https://github.com/calcom/cal.com) at `793293c`. 7,711 files in 42 groups, 6 rules.

![cal.com's app store up close: 1,570 files, with the generated-files warning in the panel](city.jpg)

Where it came from:
- `AGENTS.md`: Prisma `select`, `credential.key`, barrel imports, repositories vs services, API v2 imports through platform-libraries, generated app-store files, permission checks in `page.tsx`
- checks: each workspace's own scripts through `yarn workspace`, plus `yarn type-check:ci --force`

## Before editing API v2

```markdown
# Read first: `apps/api/v2/src/main.ts`

## Rules that must keep holding

- **prisma-select**: Prisma queries use select, not include — why: include fetches every field, sensitive ones included (AGENTS.md:7, 157-179)
- **no-credential-key**: credential.key is never selected into a query result or exposed in an API response — why: AGENTS.md:26, 108
- **no-barrel-imports**: import from the source file (@calcom/ui/components/button), never from a package's index.ts barrel; types through import type — why: AGENTS.md:8, 14, 30, 181-191
- **no-as-any**: no as any casts — why: AGENTS.md:25, 109
- **type-check-before-push**: type-check before pushing, and before calling a CI failure unrelated — why: AGENTS.md:13, 31, 83

## Watch out

- apps/api/v2 does not import @calcom/features or @calcom/trpc directly: its tsconfig has no path mapping for them, so re-export from packages/platform/libraries/index.ts and import @calcom/platform-libraries (AGENTS.md:193-208) _(group apps-api)_

## Run these checks

- `yarn test` — the test suite
- `yarn run type-check` — types
- `yarn run lint` — lint rules
- `yarn type-check:ci --force` — keeps rule type-check-before-push
```

## Before editing a generated file

```markdown
# Read first: `packages/app-store/apps.metadata.generated.ts`

## Rules that must keep holding

- **prisma-select**: Prisma queries use select, not include — why: include fetches every field, sensitive ones included (AGENTS.md:7, 157-179)
- **no-credential-key**: credential.key is never selected into a query result or exposed in an API response — why: AGENTS.md:26, 108
- **no-barrel-imports**: import from the source file (@calcom/ui/components/button), never from a package's index.ts barrel; types through import type — why: AGENTS.md:8, 14, 30, 181-191
- **no-as-any**: no as any casts — why: AGENTS.md:25, 109
- **type-check-before-push**: type-check before pushing, and before calling a CI failure unrelated — why: AGENTS.md:13, 31, 83

## Watch out

- *.generated.ts files are written by app-store-cli; never edit them by hand (AGENTS.md:28) _(group packages-app-store)_

## Run these checks

- `yarn workspace @calcom/app-store run type-check` — types of @calcom/app-store
- `yarn workspace @calcom/app-store run lint` — lint rules of @calcom/app-store
- `yarn type-check:ci --force` — keeps rule type-check-before-push
```
