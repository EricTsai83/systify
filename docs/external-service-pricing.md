# External Service Pricing

## Purpose

This document is the single entry point for how Systify's external services are
priced by their providers and which product flows trigger those real costs.

It does not replace provider pricing pages. External prices change, so this
document records the pricing model, Systify-specific cost drivers, internal
controls, and the canonical source to check before making budget or billing
decisions. LLM-specific token math stays in
[`architecture/cost-tracking.md`](./architecture/cost-tracking.md) and
`convex/lib/llmPricing.ts`.

Last verified against provider documentation: 2026-06-06.

## Cost Semantics

This document tracks **real external provider cost** only: the money Systify
would owe WorkOS, GitHub, Convex, Daytona, OpenAI, Anthropic, Vercel, or another
upstream service because the product used that service.

It is not a Systify pricing document. It must not encode:

- Systify customer-facing plans;
- markup, margin, reseller pricing, or credit-pack pricing;
- "estimated value" pricing invented by Systify;
- per-seat or per-repository SaaS packaging unless that is the upstream
  provider's own billable unit.

When a number appears here or in linked implementation files, it should be
traceable to one of these sources:

- the provider's official pricing / billing page;
- the provider's billing export, invoice, usage dashboard, or API;
- an internal code table that mirrors provider list pricing, such as
  `convex/lib/llmPricing.ts`.

If Systify later needs customer billing, create a separate product-pricing or
monetization document. Link back to this file as the cost-basis reference
instead of mixing provider cost with customer price.

## Summary

| Service | Used For | Provider Cost Model | Systify Cost Trigger | Internal Controls |
| --- | --- | --- | --- | --- |
| WorkOS | AuthKit browser sign-in | Active users for User Management; optional connection / add-on pricing for enterprise features | User sign-up, sign-in, profile updates, and any future SSO / Directory Sync / Audit Logs usage | Keep WorkOS usage limited to AuthKit unless enterprise features are explicitly added |
| GitHub | GitHub App install, repository metadata, repository snapshot fetching, webhooks | GitHub App API access is quota-limited rather than directly metered by request in this app; customer GitHub plan costs are outside Systify | Install verification, repo list, permission probe, tree / content fetches during import and sync, freshness checks | GitHub App installation tokens, bounded import fan-out, on-attention freshness checks instead of background polling |
| Convex | Database, functions, actions, HTTP endpoints, crons, scheduler | Plan fee plus metered resource usage: function calls, action compute, storage, I/O, search, egress | Every app request, subscription, mutation, import batch, chat stream persistence, cron, and background action | Bounded queries, indexed access, sharded usage rollups, batching, no separate always-on API server |
| Daytona | Repository sandboxes for Sandbox-grounded Discuss and System Design | Pay-as-you-go resource consumption for sandboxes; per-sandbox usage is broken down by CPU, RAM, and disk | Sandbox creation, running sandboxes, stopped sandboxes retaining disk, file reads, shell execution, sandbox lifecycle operations | Lazy provisioning only, auto-stop / auto-archive / auto-delete, webhook + cron reconciliation, per-user / per-repo daily cost caps |
| OpenAI | LLM generation and embeddings | Per-token pricing by model, with separate input, cached-input, output, and sometimes tool / modality rates | Chat replies, System Design generation, artifact indexing embeddings, Library Ask query embeddings, evals | LLM gateway, model catalog, pricing table coverage tests, daily caps, per-message cost ticker, usage rollups |
| Anthropic | LLM generation | Per-token pricing by model, with input, output, prompt-cache write, and prompt-cache read rates | Chat replies, System Design generation, evals when Anthropic model is selected | Same LLM gateway, catalog, pricing table, daily caps, and usage rollups as OpenAI |
| Vercel | Frontend hosting and deployment | Plan fee plus managed infrastructure usage and fixed monthly DX add-ons | Static frontend delivery, preview / production deployments, edge requests, data transfer, build / deployment activity | Static Vite frontend, SPA rewrites only, Convex-hosted backend, no Vercel serverless API layer in front of Convex |

## WorkOS

Systify currently uses WorkOS for browser-side AuthKit sign-in. The frontend
uses `VITE_WORKOS_CLIENT_ID`; Convex validates the resulting WorkOS token as a
custom JWT. See [`auth-and-access.md`](./auth-and-access.md) for the trust
boundary.

Provider cost model:

- User Management / AuthKit is priced by monthly active users, with a free
  allowance and a per-additional-user tier on the WorkOS pricing page.
- Enterprise SSO and Directory Sync are priced by connection.
- Audit Logs, Radar, custom domains, support, and annual credits are separate
  add-ons / plans.

Systify cost drivers:

- sign-up, sign-in, profile update, and any other WorkOS action that makes a
  user active in the month;
- future enterprise auth features such as SSO, Directory Sync, or Audit Logs.

Current posture:

- Systify only depends on AuthKit-style user management today.
- Do not add WorkOS enterprise features without updating this document and
  [`auth-and-access.md`](./auth-and-access.md).

Official source: <https://workos.com/pricing>

## GitHub

Systify uses a GitHub App for repository authorization, repository discovery,
repository import / sync, installation lifecycle webhooks, and freshness checks.
The app does not use personal access tokens. See
[`github-app-integration-system-design.md`](./github-app-integration-system-design.md)
and [`repository-lifecycle.md`](./repository-lifecycle.md).

Provider cost model:

- GitHub App API access is primarily constrained by API rate limits rather than
  directly metered per request by Systify.
- Customer GitHub subscription costs, private repository access, and Enterprise
  Cloud entitlements belong to the customer's GitHub account, not to Systify's
  provider bill.
- Installation access tokens have a minimum primary REST API limit of 5,000
  requests per hour, can scale with repository / user count up to a cap, and
  have a higher limit for Enterprise Cloud organizations. Secondary limits also
  apply.

Systify cost drivers:

- GitHub App installation callback and OAuth verification;
- installation token creation;
- repository list and repository permission probe;
- tree / content API calls during import and sync;
- freshness checks when a user opens or focuses a repository;
- GitHub webhooks for installation lifecycle.

Current posture:

- Import is GitHub-API-only and does not create a Daytona sandbox.
- Freshness checks are attention-driven instead of cron polling every repo.
- Import and sync should stay bounded and retry-aware because rate limits are
  the operational cost even when requests are not directly billed by Systify.

Official sources:

- <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- <https://github.com/pricing>

## Convex

Convex is Systify's backend runtime, database, scheduler, HTTP endpoint host,
and cron runner. There is no separate Express or Nest server in this repo.

Provider cost model:

- Plans include different built-in allowances and platform features.
- Resource pricing is metered across function calls, action compute, database
  storage, file storage, search storage, database I/O, search query usage, and
  data egress.
- Region and plan selection can affect included usage and per-unit rates.

Systify cost drivers:

- reactive subscriptions and query invalidations;
- mutations that persist imports, messages, artifacts, jobs, and usage rollups;
- Node actions for imports, LLM calls, sandbox orchestration, and background
  jobs;
- crons for reconciliation and recovery;
- database / search / file storage growth from repository snapshots and
  artifacts;
- egress from frontend subscriptions and backend responses.

Current posture:

- Convex is the only backend runtime.
- Query paths should stay indexed and bounded.
- Hot counters use sharded rollups where needed to avoid write contention.
- Long-running external integration work belongs in actions, with mutations
  used for durable state transitions.

Official source: <https://www.convex.dev/pricing>

## Daytona

Daytona provides the repository sandbox used by Sandbox-grounded Discuss and
System Design generation. Repository import never provisions a sandbox. See
[`sandbox-mode-system-design.md`](./sandbox-mode-system-design.md),
[`sandbox-provisioning-cleanup-system-design.md`](./sandbox-provisioning-cleanup-system-design.md),
and [`orphan-resource-handling.md`](./orphan-resource-handling.md).

Provider cost model:

- Daytona uses pay-as-you-go billing based on the resources sandboxes consume.
- Per-sandbox billing exposes total price plus CPU seconds, RAM GB-seconds, and
  disk GB-seconds.
- Running sandboxes count against compute, memory, and storage limits; stopped
  sandboxes free CPU and memory but retain storage; archived and deleted
  sandboxes do not count against active resource quota.
- Billing data can lag actual consumption, so operators should expect a
  settlement window after deletion or cancellation.

Systify cost drivers:

- first Sandbox grounding activation for a repository;
- System Design generation when selected kinds need sandbox-backed inspection;
- sandbox running time;
- stopped sandbox disk retention;
- sandbox file reads and shell commands through Daytona control plane;
- orphaned, stuck, or unreconciled sandboxes.

Current posture:

- Sandboxes are provisioned lazily.
- Auto-stop, auto-archive, and auto-delete intervals bound idle cost.
- Webhook ingestion plus cron reconciliation reduces orphan duration.
- Per-user and per-repository daily sandbox cost caps close the Sandbox
  grounding toggle when exhausted.

Official sources:

- <https://www.daytona.io/docs/billing>
- <https://www.daytona.io/docs/limits>

## LLM Providers

LLM pricing is intentionally delegated to the LLM cost-tracking design because
it has code-level invariants and provider-specific token math.

Read these first:

- [`architecture/cost-tracking.md`](./architecture/cost-tracking.md)
- [`architecture/llm-gateway.md`](./architecture/llm-gateway.md)
- `convex/lib/llmPricing.ts`
- `convex/lib/llmCatalog.ts`

Provider cost model:

- OpenAI and Anthropic bill model usage by token category. Systify tracks
  input, cached input / prompt-cache read, cache write where supported, output,
  and reasoning tokens where exposed.
- OpenAI embeddings are input-only in Systify's pricing table.
- Batch, regional / data-residency multipliers, hosted tools, web search, image,
  audio, and provider-side code execution can have separate pricing. Do not add
  those surfaces without extending the pricing table and this section.

Systify cost drivers:

- chat replies;
- System Design generation;
- Library Ask query embeddings;
- artifact indexing embeddings;
- eval runs.

Current posture:

- The LLM gateway is the single chokepoint for dispatch, usage normalization,
  retry, and cost estimation.
- `MODEL_CATALOG` entries must have matching `llmPricing.ts` rows.
- Pricing misses surface as cost unknown instead of silently becoming zero.
- Daily caps and per-message cost tickers use the same normalized cost path.

Official sources:

- <https://openai.com/api/pricing/>
- <https://www.anthropic.com/pricing>

## Vercel

Vercel hosts and deploys the static frontend. Convex remains the backend and
the HTTP API endpoint host. See
[`vercel-convex-deployment-system-design.md`](./vercel-convex-deployment-system-design.md).

Provider cost model:

- Account plans include base monthly pricing and usage allowances.
- Managed infrastructure resources are usage-based after included allowances.
- DX Platform resources and add-ons can be fixed monthly charges.
- Systify should treat the Vercel pricing docs as the source of truth for
  billable resources because the resource list changes over time.

Systify cost drivers:

- production and preview deployments;
- frontend traffic and data transfer;
- edge requests / routing;
- build activity;
- optional team seats or platform add-ons.

Current posture:

- The frontend is a static Vite build.
- Convex owns backend functions and HTTP endpoints.
- Systify should avoid adding Vercel serverless functions unless there is a
  clear need, because that would create a second backend cost surface.

Official sources:

- <https://vercel.com/docs/pricing>
- <https://vercel.com/pricing>

## Update Procedure

Update this document when any of these change:

- a new external service is added;
- a provider pricing model changes in a way that affects Systify;
- a new product feature creates a new cost trigger;
- a service moves from free-tier / experimental usage to production usage;
- customer-facing SaaS pricing work starts, so this document needs an explicit
  cross-link to a separate product-pricing document;
- an LLM model is added to `convex/lib/llmCatalog.ts` or
  `convex/lib/llmPricing.ts`;
- a deployment architecture change adds a new billable runtime.

For price-sensitive changes:

1. Check the provider's official pricing / billing page on the same day.
2. Update this document's "Last verified" date.
3. Update any affected focused design doc.
4. For LLM changes, update `convex/lib/llmPricing.ts` and keep catalog coverage
   tests passing.
5. Keep provider cost separate from Systify customer pricing.
6. Add or adjust operational controls before enabling unbounded production use.
