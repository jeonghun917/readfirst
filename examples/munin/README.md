# munin

[getmunin/munin](https://github.com/getmunin/munin) at `82fe16e`. 1,910 files in 28 groups, 5 rules.

Where it came from:
- `CLAUDE.md`: the MCP tool checklist, connector OAuth and token refresh, migration journal timestamps, RLS, fixture PII
- `packages/backend-core/src/modules/conv/CLAUDE.md`: the poll worker's columns, secrets in channel config
- checks: each workspace package's own scripts through `pnpm --filter`, plus `scripts/check-skill-tool-refs.mjs` and
  `scripts/check-fixture-pii.mjs` from `.husky/pre-commit`

## Before editing the migration journal

```markdown
# Read first: `packages/db/drizzle/meta/_journal.json`

## Rules that must keep holding

- **migration-on-existing-db**: smoke-test a migration and its backfill against a DB already at the previous migration, as munin_app, before the PR — why: a backfill run only against an empty DB is untested, and a superuser hides RLS bugs (CLAUDE.md:117)

## Watch out

- the _journal.json when timestamp must strictly increase with idx; a lower one is silently skipped on every existing DB while fresh CI looks green. This killed the 4.62.0 deploy (CLAUDE.md:118) _(group packages-db)_
- rename drizzle-kit's random NNNN_adjective_noun migration to NNNN_<what_it_does>.sql, with its snapshot and journal tag (CLAUDE.md:116) _(group packages-db)_

## Run these checks

- `pnpm --filter @getmunin/db test -- src/migrations-journal.test.ts` — journal timestamps
- `pnpm --filter @getmunin/db test` — the test suite of @getmunin/db
- `pnpm --filter @getmunin/db run typecheck` — types of @getmunin/db
```

## Before editing a connector

```markdown
# Read first: `packages/backend-core/src/modules/connectors/connector-credential.handler.ts`

## Watch out

- config.oauth is reserved for the trunk; adapters never read or write it, and publicConfig is an allow-list that keeps token ciphertext out of DTOs (CLAUDE.md:56) _(group backend-connectors)_
- a token refresh is a write on a read path: SELECT … FOR UPDATE on the connection row, and marking a connection expired commits in a separate transaction, or the marker rolls back with the error (CLAUDE.md:57) _(group backend-connectors)_
- connector data is live and never persisted in Munin; a domain module is a noun with its own contract, never a vendor (CLAUDE.md:44) _(group backend-connectors)_

## Run these checks

- `pnpm --filter @getmunin/backend-core test -- src/modules/connectors src/modules/commerce src/modules/bookings src/modules/seo` — checks for connectors trunk and the domain modules that read customers' systems (commerce, bookings, seo)
```
