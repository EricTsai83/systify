# Architecture Overview

## System Shape

acme-billing is a TypeScript monorepo with three runnable apps and a shared package layer. The apps are an HTTP API (`apps/api`), a background worker (`apps/worker`), and an admin SPA (`apps/admin`). Shared code — DB schema, Stripe client wrappers, domain types — lives in `packages/core`, `packages/db`, and `packages/stripe`.

## Components & Responsibilities

- `apps/api/` — Express server. Owns inbound Stripe webhooks, the GraphQL surface the admin SPA consumes, and a small REST surface for billing-bot integrations.
- `apps/worker/` — BullMQ-backed job runner. Owns dunning email scheduling, Stripe retry coordination, and the nightly revenue export.
- `apps/admin/` — Vite + React 19 admin UI. Read/write against the API's GraphQL endpoint; auth via WorkOS.
- `packages/core/` — Domain types (`Invoice`, `Subscription`, `DunningPlan`) plus pure business rules (proration, tax category mapping).
- `packages/db/` — Drizzle schema and connection pool.
- `packages/stripe/` — Stripe SDK wrapper with idempotency-key handling.

## Data & Control Flow

An inbound webhook arrives at `apps/api/src/stripe/webhook.ts`, is verified via the signing secret, and is upserted into `stripe_events` (idempotent). The handler dispatches by event type — for `invoice.payment_failed` it enqueues a `dunning.attempt` job in BullMQ. The worker dequeues, emits a SendGrid email through `packages/notifications`, and writes a `dunning_attempts` row. The admin SPA polls GraphQL queries that join `invoices`, `subscriptions`, and `dunning_attempts` to render the customer health view.

## Boundaries & Integrations

- Stripe (HTTPS, signed webhooks in, REST out) via `packages/stripe/`.
- SendGrid (REST out) via `packages/notifications/`.
- AWS S3 (PUT-only) via the worker's report job, signed with IAM role credentials.
- WorkOS (OIDC) for admin login, integrated in `apps/admin/src/auth/`.
- Postgres 16 (TCP) via Drizzle in `packages/db/`.

## Where to Look First

- `apps/api/src/stripe/webhook.ts` — inbound webhook handler, signature verification, dispatch table.
- `apps/worker/src/jobs/dunning.ts` — dunning state machine and BullMQ wiring.
- `packages/core/src/billing/invoice.ts` — invoice domain model and the proration rules under test.
- `packages/db/src/schema.ts` — Drizzle schema, source of truth for every table.
