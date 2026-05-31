# Data Model Overview

## Stores & Schemas

Single Postgres 16 instance, managed via Drizzle in `packages/db/src/schema.ts`. Migrations are file-per-step in `packages/db/migrations/`. Redis (managed via BullMQ) holds queue state only — no business data outlives the queue.

## Entities & Relationships

- `customers` — one row per Stripe customer. Mirrors `cus_…` ids; carries email and the billing address snapshot.
- `subscriptions` — one row per active or past Stripe subscription, linked to `customers.id`.
- `invoices` — one row per Stripe invoice, linked to `subscriptions.id`. Carries the canonical `status` enum (`open | paid | uncollectible | void`).
- `dunning_attempts` — many per invoice, linked to `invoices.id`. Each row is an email send attempt.
- `stripe_events` — append-only log of every webhook payload, keyed by Stripe event id for idempotency.
- `revenue_snapshots` — daily rollup written by the worker's report job. Read-only after write.

## Read & Write Paths

- Webhook ingestion writes `stripe_events` first (idempotent insert), then upserts `invoices` / `subscriptions` in the same transaction.
- The admin GraphQL resolvers read by joining `customers`, `subscriptions`, and the latest `invoices` per subscription.
- The worker's nightly job reads invoices in the last 24h, aggregates by plan, and writes one row to `revenue_snapshots`.
- Dunning state writes happen in a transaction across `invoices.last_dunning_at` and a new `dunning_attempts` row.

## Notable Invariants

- `stripe_events.event_id` is `UNIQUE` — webhook idempotency is enforced at the DB layer, not the application.
- `invoices.status` advances monotonically per row except for `void`, which is terminal. Enforced by trigger `invoices_status_transition`.
- `revenue_snapshots` is INSERT-only; the report job aborts if a row already exists for the target date (idempotency).

## Where to Look First (file references)

- `packages/db/src/schema.ts` — every table definition.
- `packages/db/migrations/` — historical schema evolution.
- `apps/api/src/stripe/webhook.ts` — the upsert path for `invoices` / `subscriptions`.
- `apps/worker/src/jobs/dunning.ts` — write path for `dunning_attempts`.
- `apps/worker/src/reports/revenue.ts` — write path for `revenue_snapshots`.
