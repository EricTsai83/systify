# API Surface Overview

## Public Endpoints

- `POST /webhooks/stripe` — Stripe inbound webhook. Implemented in `apps/api/src/stripe/webhook.ts`.
- `POST /graphql` — single GraphQL endpoint for the admin SPA. Schema in `apps/api/src/graphql/schema.ts`; resolvers in `apps/api/src/graphql/resolvers/`.
- `GET /healthz` — liveness probe, returns `200 ok` once the DB pool is reachable. Implemented in `apps/api/src/health.ts`.
- `GET /billing/v1/invoices/:id` — REST read-only endpoint for the billing bot. Implemented in `apps/api/src/rest/invoices.ts`.

## Authentication & Authorisation

- `POST /webhooks/stripe` verifies the Stripe signing secret via `Stripe.webhooks.constructEvent` — no further auth.
- `POST /graphql` requires a WorkOS-signed session cookie; resolved by `apps/api/src/middleware/auth.ts`. Resolvers consult `ctx.user.role` for ops-only mutations.
- `GET /billing/v1/invoices/:id` requires the `X-Bot-Key` header matched against `process.env.BILLING_BOT_KEY`.
- `GET /healthz` is open.

## Request / Response Shapes

- GraphQL types are auto-generated from `apps/api/src/graphql/schema.gql` into `packages/core/src/graphql.ts`. Resolvers consume the generated types directly — no hand-typed shapes.
- REST endpoints validate request payloads with Zod in `apps/api/src/rest/_zod.ts` and serialise responses via the same schemas.
- Webhook payloads are typed against `@stripe/stripe-node`'s `Stripe.Event` discriminated union.

## Error Handling

- GraphQL errors are mapped to `BillingError` in `apps/api/src/graphql/errors.ts` — every error carries an `errorCode` enum and an opaque `errorId` for log correlation.
- REST errors return a JSON envelope `{ error: { code, message, errorId } }` from `apps/api/src/rest/_errors.ts`.
- Webhook handler returns `400` only for signature failures; everything else is acknowledged with `200` and the failure is enqueued for retry in BullMQ.

## Where to Look First

- `apps/api/src/index.ts` — Express route registration.
- `apps/api/src/graphql/schema.gql` — the GraphQL surface, source of truth.
- `apps/api/src/middleware/auth.ts` — session validation.
- `apps/api/src/stripe/webhook.ts` — webhook signature + dispatch.
