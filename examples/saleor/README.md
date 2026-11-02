# saleor

Saleor, the Django e-commerce platform, from [saleor/saleor](https://github.com/saleor/saleor) at `0e3fa1b`. 4,727 files in
72 groups, 12 rules, 15 risks and 53 hot spots.

Where it came from:
- `AGENTS.md` (663 lines): the deployment model (many pods, one shared Postgres), concurrency patterns, row locks,
  tasks after commit, the GraphQL boundary, multi-tenant sites, concurrent index migrations, untrusted downloads, PII
- `saleor/graphql/AGENTS.md`: one error class per mutation, ADDED_IN versions, list limits, the query cost map, the
  generated schema
- groups: one per Django app and one per GraphQL sub-package, each with its own `pytest --reuse-db saleor/<app>`
- hot spots: functions where the code meets those rules (writes the database, queries it, queues a task, calls out),
  found by readfirst-app's labeler with no model, from the 150 files a Pro fill reads

Found while making it: `update_discounted_prices_for_promotion(only_dirty_products=True)` is documented to recalculate
only the listings marked dirty, but the `.filter(discounted_price_dirty=True)` on line 71 is never assigned, so every
listing is recalculated (`saleor/product/utils/variant_prices.py:40-41, 70-71`). It is in the map as a risk.

## Before editing a product task

```markdown
# Read first: `saleor/product/tasks.py`

## Rules that must keep holding

- **tasks-after-commit**: a Celery task is queued after the transaction commits (on_commit, or call_event for webhooks), never with a bare .delay() inside an open transaction — why: the task can start on another pod before the row it needs is committed (AGENTS.md:19-21, 436-448)
- **atomic-writes**: counters change with F() expressions and upserts use update_or_create on a unique constraint; no check-then-act and no count += 1; save() — why: every operation runs concurrently with itself on many pods; the read-then-write loses updates (AGENTS.md:13-15, 341-379)
- **short-locks**: select_for_update runs inside traced_atomic_transaction through the app's lock_objects module, is evaluated (list/get/__in) so it really locks, and the transaction stays short — why: a lazy lock queryset takes no lock; long locks stall the shared Postgres (AGENTS.md:382-421, 646-648)
- **no-n-plus-one**: no per-row query or per-row save in a loop: bulk update/delete, .iterator() on unbounded querysets, fetch only the columns used, reuse dataloaders on hot paths — why: the shared Postgres is the scaling bottleneck and writes replicate to every read replica (AGENTS.md:22-24, 632-648)

- …and 6 repository-wide rules (site resolution, call_event, no signals, untrusted files, dev imports, the GraphQL boundary)

## Watch out

- ProductChannelListing.discounted_price_dirty marks listings whose discounted price must be recalculated by a Celery task; a promotion or price change that skips mark_products_in_channels_as_dirty leaves storefront prices stale (saleor/product/utils/product.py:82-135) _(group saleor-product)_
- search_index_dirty drives re-indexing; a change to search vector logic needs a data migration that marks existing rows dirty (AGENTS.md:483-520, saleor/product/models.py:193) _(group saleor-product)_

## Hot spots in this code

- `_update_variants_names` (`saleor/product/tasks.py:79`): db-write, under **atomic-writes**, **no-n-plus-one**, **short-locks**: Writes the database
- `update_variant_relations_for_active_promotion_rules_task` (`saleor/product/tasks.py:182`): db-write, db-read, queue, under **no-n-plus-one**, **short-locks**, **tasks-after-commit**: Writes the database, queries the database, enqueues or retries work
- `recalculate_discounted_price_for_products_task` (`saleor/product/tasks.py:249`): db-write, db-read, queue, under **no-n-plus-one**, **short-locks**, **tasks-after-commit**: Writes the database, queries the database, enqueues or retries work
- `mark_products_search_vector_as_dirty` (`saleor/product/tasks.py:303`): db-write, db-read, under **no-n-plus-one**, **short-locks**, **atomic-writes**: Writes the database, queries the database
- `on_failure_fetch_product_media_image_task` (`saleor/product/tasks.py:351`): db-write, db-read, under **no-n-plus-one**, **short-locks**, **atomic-writes**: Writes the database, queries the database

## Run these checks

- `pytest --reuse-db saleor/product` — the tests for this part
```

## Before editing the discounted-price code

```markdown
# Read first: `saleor/product/utils/variant_prices.py`

## Watch out

- ProductChannelListing.discounted_price_dirty marks listings whose discounted price must be recalculated by a Celery task; a promotion or price change that skips mark_products_in_channels_as_dirty leaves storefront prices stale (saleor/product/utils/product.py:82-135) _(group saleor-product)_
- update_discounted_prices_for_promotion(only_dirty_products=True) is meant to recalculate only dirty listings, but the filter on line 71 is not assigned, so every listing of the products is recalculated (saleor/product/utils/variant_prices.py:40-41, 70-71) _(group saleor-product)_
- search_index_dirty drives re-indexing; a change to search vector logic needs a data migration that marks existing rows dirty (AGENTS.md:483-520, saleor/product/models.py:193) _(group saleor-product)_
```
