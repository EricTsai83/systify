# Security Overview

## Authentication

- Admin users authenticate via WorkOS OIDC. `apps/admin/src/auth/` redirects to WorkOS and exchanges the code for a session cookie set by the API at `apps/api/src/middleware/auth.ts`.
- The billing bot authenticates with a static `X-Bot-Key` header validated by `apps/api/src/rest/_bot.ts`.
- Stripe webhooks authenticate with Stripe's signing secret, verified by `Stripe.webhooks.constructEvent` in `apps/api/src/stripe/webhook.ts`.

## Authorisation

- Role check happens in `apps/api/src/middleware/auth.ts`. Three roles: `viewer`, `operator`, `admin`. The mapping comes from the WorkOS user's `role` attribute.
- GraphQL resolvers gate mutations through `assertRole(ctx, "operator")` — defined in `apps/api/src/graphql/_authz.ts` and called at the top of every mutation resolver.
- REST endpoints have no per-user authorisation today — the billing bot key has implicit `viewer` access.

## Input Validation

- GraphQL inputs validated by the generated types from `apps/api/src/graphql/schema.gql`.
- REST inputs validated by Zod schemas in `apps/api/src/rest/_zod.ts`.
- Webhook payloads validated by Stripe's signature plus type-narrowed handling in the dispatch table.

## Secrets & Sensitive Data

- All secrets in SSM Parameter Store (`SecureString`).
- Application reads validated by `packages/core/src/env.ts`. No `.env` files in production images.
- Customer billing addresses considered PII — `customers.billing_address` is column-encrypted via pgcrypto, key in SSM. Decryption happens only in `packages/db/src/customers.ts`.
- Stripe ids (`cus_…`, `sub_…`, `in_…`) are NOT considered PII and are logged freely.

## Observed Gaps & Risks

- REST endpoints lack rate limiting — the billing bot key is a single shared secret with no per-IP cap. Surfaced in `apps/api/src/rest/_bot.ts` as a TODO comment.
- The admin session cookie is `SameSite=Lax` but not `__Host-` prefixed; documented as a known limitation in `docs/security.md`.
- `dunning_attempts.recipient_email` is logged in plaintext for ops triage; consider redacting before shipping logs to Datadog.
