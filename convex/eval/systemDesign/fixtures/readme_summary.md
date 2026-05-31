# README Summary

## Purpose

acme-billing is a self-hosted subscription billing platform that turns Stripe webhook events into invoices, dunning emails, and revenue reports. It exists so internal teams can offer paid plans without re-implementing prorating, tax, and retry logic per product.

## Services & Capabilities

- Stripe webhook ingestion and event reconciliation (`apps/api/src/stripe/webhook.ts`).
- Background job runner for dunning emails and Stripe retries (`apps/worker/src/jobs/`).
- Admin web app for ops to refund, comp, and reissue invoices (`apps/admin/`).
- Daily revenue and MRR reports exported to S3 (`apps/worker/src/reports/`).

## Audience

Backend engineers at companies running a paid SaaS that already use Stripe but need internal tooling. Not a hosted product — the README is explicit that you run it yourself.

## Key Operations

- `pnpm dev` boots Postgres, Redis, and the three apps via docker-compose.
- `pnpm db:migrate` runs Drizzle migrations against the configured database.
- `pnpm worker` runs the background job loop standalone (used in CI).
- `pnpm test` runs the integration suite against an ephemeral Postgres.

## Notable Constraints

- License: Apache-2.0.
- Maturity: beta — the README flags "do not use for primary billing yet".
- External services required: a Stripe account with webhook signing secret, an AWS account for S3 reports, and a SendGrid API key.

## Source

`README.md`, `docs/quickstart.md`, `docs/architecture.md`.
