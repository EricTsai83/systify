# Cost Tracking

## Why this exists

Per-user LLM cost visibility is mandatory in this product. Without it, abusive
usage cannot be detected, billing is impossible, and the daily-cap rate limiter
cannot be enforced. Cost capture happens at the gateway boundary (the single
chokepoint, see `llm-gateway.md`) so coverage is uniform across providers and
features — chat, System Design, and any future LLM-backed surface inherit the
same accounting.

The mechanism is conservative: it never overcharges a user by guessing missing
fields, and it never undercharges by silently zeroing-out an unknown model.
Missing pricing surfaces as "cost unknown" rather than "cost zero" so the daily
cap and the per-message ticker can both render an honest "—".

## How it works

### Pricing table

`convex/lib/llmPricing.ts` defines a `PRICING` map keyed by
`"<provider>:<modelName>"` (`"openai:gpt-5"`, `"anthropic:claude-opus-4-8"`,
etc.). Each entry carries:

- `inputPerMillion` / `outputPerMillion` — USD per 1M tokens for uncached input
  and completion.
- `cacheReadPerMillion` (optional) — discounted rate for cache reads. Anthropic
  charges ~10% of input; OpenAI's automatic prompt cache costs 50% of input and
  is exposed via `cachedPromptTokens`. Both providers flow through this field.
- `cacheWritePerMillion` (optional, Anthropic-only) — premium ~125% of input for
  populating the cache.
- `reasoningPerMillion` (optional) — separate tier for reasoning tokens.
  Currently absent on all rows so the math falls back to the output rate
  (OpenAI's published behavior).
- Embedding rows (`openai:text-embedding-3-small`, `openai:text-embedding-3-large`)
  carry only `inputPerMillion` with `outputPerMillion: 0`. Embedding APIs return
  vectors, not generated tokens, so `estimateCostUsd` zeroes the output line
  cleanly; cache / reasoning fields are absent and short-circuit on their
  optional checks. The Library Ask hybrid RAG path
  (`convex/lib/artifactRag.ts:retrieveArtifactChunks`) and the artifact-indexing
  batches (`convex/artifactIndexing.ts`) both bill against the same daily cap
  via these rows.

`estimateCostUsd(provider, modelName, usage)` walks the `NormalizedUsage` and
returns USD or `undefined`. It returns `undefined` when the pair is missing from
the table OR when both `inputTokens` and `outputTokens` are missing (degenerate
stream that errored before any usage settled). Returning `undefined` — rather
than `0` — is the load-bearing signal that lets the daily-cap settlement
distinguish "no recordable spend" from "genuinely $0.00" (see
`convex/lib/llmPricing.ts:172-208`).

`costUsdToCents(costUsd)` ceilings to integer cents because the daily-cap
rate-limiter component speaks in cents and ceiling is the one rounding rule that
keeps the recorded sum always greater than or equal to real spend
(`convex/lib/llmPricing.ts:223-231`).

A coverage invariant — "every `MODEL_CATALOG` entry has a `PRICING` row" — is
asserted by `llmCatalog.test.ts` using the test-only export `TEST_INTERNALS`
(`convex/lib/llmPricing.ts:239-241`). Adding a catalog model without pricing
fails CI; there are no silent zero-cost models.

### Usage normalization in the gateway

The gateway collapses provider-specific shapes into a uniform `NormalizedUsage`
before any cost math runs. The cache-read measurement comes from the AI SDK v6
structural surface `sdkUsage.inputTokenDetails.cacheReadTokens` (mapped to
`NormalizedUsage.cachedInputTokens`) — both OpenAI's prompt cache and
Anthropic's explicit cache reads flow through this single field. Anthropic
cache writes are captured separately via
`sdkUsage.inputTokenDetails.cacheWriteTokens` (mapped to
`NormalizedUsage.cacheWriteTokens`); there is no OpenAI analog today.
`providerMetadata` is currently passed through unused — kept on the
`normalizeUsage` signature so a future provider-specific counter can land
without a call-site change.

### Per-message persistence (chat)

`messages` carries cost fields on the assistant reply (`convex/schema.ts`):

- `estimatedInputTokens`, `estimatedOutputTokens`
- `estimatedCachedInputTokens`, `estimatedReasoningTokens` — prompt-cache /
  reasoning breakdown for analytics dashboards
- `estimatedCostUsd` — USD computed from the gateway's `finalCostUsd` promise
- `provider`, `modelName` — pinned at message insertion so a later model picker
  change does not retroactively re-attribute a finished reply

All five are optional because pre-PR-A2 / pre-PR-A3 rows lack them; new writes
always set them when the gateway produced a usage frame. The fields are written
inside `finalizeAssistantReply` / `failAssistantReply` /
`markAssistantReplyCancelled` in `convex/chat/streaming.ts` — the cancel and
fail paths persist partial cost because that spend is real (billing happens
per-token, not on stream completion).

The gateway stream handle is hoisted in `convex/chat/generation.ts` so every
exit path (success, fail, cancel, aborted-orphan) can settle whatever
`finalUsage` + `finalCostUsd` resolved before the SSE tore down. `readGatewayUsage`
swallows resolution failures so partial → silent-undefined degrades gracefully
(`convex/chat/generation.ts:1250-1281`).

### Per-kind persistence (System Design)

`systemDesignKindRuns` is the append-only attempt log (`convex/schema.ts`). One
row per `(jobId, kind)` attempt — including cache hits and quality rejects — so
eval and cost analytics can distinguish "the kind ran" from "the kind resolved
without rerunning". Fields:

- `provider`, `modelName`, `promptVersion` — required (not optional like on
  `messages`)
- `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheWriteTokens`,
  `reasoningTokens` — full token mix
- `totalCostUsd` — USD from `estimateCostUsd` against the kind's normalized
  usage

The kind-run row is written by the Publication Settlement module through
`finalizeKindPublication` in `convex/systemDesign.ts`, called from the System
Design action in `convex/systemDesignKindRun.ts`. Cache hits, generated
markdown, quality rejects, and failures all pass through this seam. Generated,
failed, and quality-rejected outcomes settle actual usage/cost when available;
`cached_hit` skips settlement because the artifact was already paid for by the
run that produced it.

`jobs.estimatedCostUsd` summarizes the full run. The per-job number is fed by
the same `completeRunningJob` helper that powers chat job completion.

### Aggregation: raw breakdown

`convex/lib/userCost.ts` exposes an `internalQuery` that walks three sources:

1. `systemDesignKindRuns` via `by_owner_and_startedAt` — source of truth for
   the System Design path because the row already carries provider, model,
   normalized usage, and cost in one place.
2. `messages` via `by_ownerTokenIdentifier` — chat spend. The loop filters by
   `_creationTime` within the requested window
   (`sinceMs` inclusive, `untilMs` exclusive, default `Date.now()`).
3. `jobs.estimatedCostUsd` is intentionally NOT read. The same money is already
   counted under `messages` (chat) and `systemDesignKindRuns` (System Design);
   including jobs would double-count.

The query returns a `UserCostBreakdown` with `total`, `byProvider`, `byModel`
(keyed `${provider}:${modelName}`),
`byFeature.{chat, systemDesign, artifactIndexing, libraryRetrieval, titleGeneration}`,
and `byDay` (UTC-day rollup, sparse — zero-spend days omitted). Each dimension is
the same `CostBucket` shape (`usd`, `inputTokens`, `outputTokens`,
`cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens`, `count`) so a UI
that renders a stacked bar chart per provider can reuse the same accessor over
`byModel` or `byDay` without reshaping.

Chat rows without `provider`/`modelName` (legacy or pricing-miss rows) still
contribute to `total`, `byFeature.chat`, and `byDay`, but skip the per-provider
and per-model dimensions.

### Viewer usage summary rollups

The viewer settings usage card does NOT call `getUserCostBreakdown`. That
query is raw-row based and appropriate for CLI / admin inspection, but it can
grow with every assistant reply and every System Design kind run in the
requested window. The public viewer-facing query instead reads
`userUsageDailyRollups`, a bounded operational summary table.

`convex/lib/usageAccounting.ts` and
`convex/lib/usageAccountingMutations.ts` are the single feature-lifecycle
interface for this summary. Feature callers build one stable `sourceId`, call
`reserveUsageLifecycle` before the gateway call when a reservation/pre-check is
needed, then call either `settleUsageLifecycle` with normalized cost / tokens
or `releaseUsageLifecycle` when the gateway failed before usage existed.

`convex/lib/userCost.ts` remains the low-level user ledger / budget primitive.
`recordUserUsageEvent` is still the single rollup writer, but production
feature code reaches it through the lifecycle module so reservation release,
daily-cap settlement, durable event writes, and retry idempotency stay ordered
in one place. The lifecycle owns these invariants:

- empty, zero, negative, and non-finite usage is ignored;
- `sourceId` is required and must be non-empty;
- `settleUsageLifecycle` checks `userUsageEvents.by_sourceId` before consuming
  daily cap, so retries are idempotent across both usage rollups and cap spend;
- `releaseUsageLifecycle` records zero usage through `userCost`, releasing any
  matching reservation without writing rollups or consuming daily cap;
- the event is persisted in `userUsageEvents` as a durable dedupe ledger;
- the daily counter is written to one of 16 stable shards under
  `(ownerTokenIdentifier, yyyymmdd, feature, shard)`.

The sharding is deliberate. A single daily counter document would keep reads
cheap but concentrate every same-user same-day chat finalization into one
Convex document, creating avoidable OCC contention under tab-spam or parallel
System Design runs. Sixteen shards keep write contention low while the viewer
query remains bounded: at most `30 days * 5 features * 16 shards = 2400` rollup
rows. The query reads one extra row and throws if the cardinality invariant is
exceeded, so data-model drift cannot silently undercount user spend.

Current lifecycle source ids and policies:

| Lifecycle feature | User rollup feature | Source id format | User budget estimate | Sandbox daily cap |
| --- | --- | --- | --- | --- |
| `chatReply` | `chat` | `message:${messageId}` | `CHAT_REPLY_BUDGET_ESTIMATE_USD` | `precheckAndSettle` only when the reply is sandbox-grounded; non-sandbox chat overrides to `none` |
| `titleGeneration` | `titleGeneration` | `title:${threadId}:${userMessageId}` | `TITLE_GENERATION_BUDGET_ESTIMATE_USD` | `none` |
| `systemDesignGeneration` | `systemDesign` | `systemDesign:${jobId}:${kind}:${startedAt}` | `SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD` | `precheckAndSettle` |
| `artifactIndexingEmbedding` | `artifactIndexing` | `artifactIndexing:${artifactId}:${artifactVersion}:${batchIndex}` | `ARTIFACT_INDEXING_BATCH_BUDGET_ESTIMATE_USD` | `settleOnly` |
| `libraryRetrievalEmbedding` | `libraryRetrieval` | `libraryRetrieval:${messageOrThreadId}:${queryHash}` | `LIBRARY_RETRIEVAL_BUDGET_ESTIMATE_USD` | `settleOnly` |

`buildUsageSourceId.systemDesignKindRun(kindRunId)` is reserved for future
kind-run keyed settlements and currently preserves the
`systemDesignKindRun:${kindRunId}` format.

System Design `cached_hit` rows are intentionally skipped. They represent an
idempotency match against an already-paid artifact, not a new LLM call. Failed
or quality-rejected rows are recorded only when they carry real cost or token
usage; a transport failure with no usage frame remains absent from the viewer
summary instead of being counted as a free event.

### Daily cap settlement

Daily-cap settlement is also centralized in `settleUsageLifecycle`. The
mutation first checks the durable `userUsageEvents.by_sourceId` ledger; if the
source id was already recorded, it returns without consuming the cap. For
first-time settlements with `costUsdToCents(costUsd) > 0`, features whose
policy is not `none` call
`consumeSandboxDailyCost(ctx, {ownerTokenIdentifier, repositoryId, cents})`.
Then the lifecycle writes the user usage event / rollups through
`recordUserUsageEvent`, which also settles the user-budget reservation.

The settlement surfaces remain the same feature paths:

- Chat terminal mutations call the lifecycle once for completed, failed, and
  cancelled replies. Stale recovery still skips settlement because no reliable
  usage data exists.
- System Design publication, artifact drafts, and Mermaid repair route through
  `convex/lib/sandboxLibraryGenerationAccounting.ts`, now a thin adapter to
  the lifecycle.
- Artifact indexing and Library retrieval embedding call
  `embedWithAccounting`, which reserves, releases on gateway failure, and
  settles per embedding gateway call.

Cap config defaults live in `convex/lib/rateLimit.ts` under
`sandboxCostUsdPerUserDaily` and `sandboxCostUsdPerRepositoryDaily`. Live
consumption is observable via `peekSandboxDailyCostForUser` /
`peekSandboxDailyCostForRepository` in `convex/lib/rateLimit.ts`.

### CLI

`bun run report:user-costs --user=<ownerTokenIdentifier> [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]`

`scripts/reportUserCosts.ts` shells out to `bunx convex run lib/userCost:getUserCostBreakdown`
with the supplied window (default: last 30 days) and pretty-prints six sections
to stdout: window header, totals, by provider, by model (sorted desc by USD),
by feature, by day. USD prints at 4-decimal precision so sub-cent cache reads
do not round to zero.

The script does NOT talk to the Convex client SDK — that would require the
admin key on the operator's machine. `bunx convex run` reuses the same
deployment auth the CLI is already configured for.

## Failure modes & recovery

**Catalog entry without pricing row.** `llmCatalog.test.ts` cross-checks the
catalog against `TEST_INTERNALS.pricingKeys()` and fails CI when a model is
added to one without the other. Recovery: add the pricing row before merging.
No silent zero-cost models can land.

**Provider usage normalization gap.** `providerMetadata` shape differs across
providers, and a new provider (or an OpenAI/Anthropic API change) can introduce
a token bucket the gateway doesn't recognize. Defensive lookups in the gateway
mean the unknown bucket emits zero; the rest of the costs still flow.
Operator-visible signal: a "cost suddenly drops" alert on the
`systemdesign_kind_cost_usd` / per-user rollup time series. Recovery: extend
the normalization map and the relevant `LlmPricing` field in
`convex/lib/llmPricing.ts`.

**Per-user cost accuracy spot-check.** Re-derive `inputTokens * pricing.inputPerMillion / 1e6`
(plus the other token tiers) for a sample of assistant messages and compare to
`messages.estimatedCostUsd`. Drift indicates either (a) a pricing table edit
that wasn't backfilled, or (b) a gateway change that altered the
`finalCostUsd` resolution. The accuracy verification is the documented manual
step in the rollout plan.

**Partial / cancelled / failed replies.** The gateway's `finalUsage` /
`finalCostUsd` promises can settle even after an abort if the upstream sent its
final usage frame before tear-down. The chat action calls `readGatewayUsage`
on every terminal exit path (success, cancel, fail, aborted-orphan) and the
fail/cancel mutations persist whatever was returned, including partial cost
(`convex/chat/streaming.ts`). The daily cap settles on
partial cost too — better partial-pretty-good than none-at-all.

**Stale chat recovery.** Stale-recovery in `convex/chat/streaming.ts:626-645`
deliberately does NOT settle cost. The action that stalled never reached the
finalize / fail mutation, so the usage is unknown. Recording an arbitrary
fixed cost would either double-count (if the action actually completed and
its settlement raced the recovery) or fabricate spend. The trade-off is
accepted: a stalled reply may slip the daily cap by its actual cost, but the
recovery itself is rare.

**Settlement bug ("daily cap doesn't trigger").** If a metered path bypasses
`settleUsageLifecycle`, runaway spend won't bounce off the cap. The
`peekSandboxDailyCostForUser` query reflects live consumed cents for the
current UTC day — if a high-spend user shows zero or implausibly low cents,
trace the feature's source id through `usageAccountingMutations` and confirm
the terminal path called the lifecycle exactly once.

## Future evolution

**Materialized per-user monthly cost table.** Today `getUserCostBreakdown`
scans every `systemDesignKindRuns` and `messages` row in the requested window
in-memory. When the windowed scan grows past the latency budget for the admin
UI, add a `userMonthlyCost` rollup table populated by a nightly cron. The
aggregation logic in `convex/lib/userCost.ts` reuses cleanly — no rewrite, just
persistence.

**OpenAI prompt-cache accounting redesign.** OpenAI currently applies an
automatic 50% discount on input and exposes the cached-token slice via
`cachedPromptTokens`. The pricing math treats this as a separate cache-read
tier through `cacheReadPerMillion`. If OpenAI moves to a different accounting
shape (e.g. explicit cache write / read tokens, like Anthropic), revisit the
normalization in the gateway and the per-model `LlmPricing` rows so the new
shape feeds the same `CostBucket` dimensions.

**Per-user billing surface.** Per-user invoices and monthly statements would
consume `getUserCostBreakdown` directly. The internal-query surface needs a
public wrapper with explicit auth (the calling user's role check) before it
goes live; no schema change needed beyond that.
