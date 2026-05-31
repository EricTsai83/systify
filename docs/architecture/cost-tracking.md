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

`estimateCostUsd(provider, modelName, usage)` walks the `NormalizedUsage` and
returns USD or `undefined`. It returns `undefined` when the pair is missing from
the table OR when both `inputTokens` and `outputTokens` are missing (degenerate
stream that errored before any usage settled). Returning `undefined` — rather
than `0` — is the load-bearing signal that lets the daily-cap settlement
distinguish "no recordable spend" from "genuinely $0.00" (see
`convex/lib/llmPricing.ts:157-193`).

`costUsdToCents(costUsd)` ceilings to integer cents because the daily-cap
rate-limiter component speaks in cents and ceiling is the one rounding rule that
keeps the recorded sum always greater than or equal to real spend
(`convex/lib/llmPricing.ts:208-216`).

A coverage invariant — "every `MODEL_CATALOG` entry has a `PRICING` row" — is
asserted by `llmCatalog.test.ts` using the test-only export `TEST_INTERNALS`
(`convex/lib/llmPricing.ts:224-226`). Adding a catalog model without pricing
fails CI; there are no silent zero-cost models.

### Usage normalization in the gateway

The gateway collapses provider-specific shapes into a uniform `NormalizedUsage`
before any cost math runs. `providerMetadata.openai.cachedPromptTokens` and
`providerMetadata.anthropic.cacheReadInputTokens` both feed
`NormalizedUsage.cachedInputTokens`. Anthropic cache writes are captured as a
separate field (`cacheWriteTokens`) — there is no OpenAI analog today.

### Per-message persistence (chat)

`messages` carries cost fields on the assistant reply
(`convex/schema.ts:798-858`):

- `estimatedInputTokens`, `estimatedOutputTokens`
- `estimatedCachedInputTokens`, `estimatedReasoningTokens` — prompt-cache /
  reasoning breakdown for analytics dashboards
- `estimatedCostUsd` — USD computed from the gateway's `finalCostUsd` promise
- `provider`, `modelName` — pinned at message insertion so a later model picker
  change does not retroactively re-attribute a finished reply

All five are optional because pre-PR-A2 / pre-PR-A3 rows lack them; new writes
always set them when the gateway produced a usage frame. The fields are written
inside `finalizeAssistantReply` / `failAssistantReply` / `markAssistantReplyCancelled`
in `convex/chat/streaming.ts:475-616` — the cancel and fail paths persist
partial cost because that spend is real (billing happens per-token, not on
stream completion).

The gateway stream handle is hoisted in `convex/chat/generation.ts` so every
exit path (success, fail, cancel, aborted-orphan) can settle whatever
`finalUsage` + `finalCostUsd` resolved before the SSE tore down. `readGatewayUsage`
swallows resolution failures so partial → silent-undefined degrades gracefully
(`convex/chat/generation.ts:1250-1281`).

### Per-kind persistence (System Design)

`systemDesignKindRuns` is the append-only attempt log
(`convex/schema.ts:1187-1242`). One row per `(jobId, kind)` attempt — including
cache hits and quality rejects — so eval and cost analytics can distinguish "the
kind ran" from "the kind resolved without rerunning". Fields:

- `provider`, `modelName`, `promptVersion` — required (not optional like on
  `messages`)
- `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheWriteTokens`,
  `reasoningTokens` — full token mix
- `totalCostUsd` — USD from `estimateCostUsd` against the kind's normalized
  usage

The kind-run row is written by `recordKindRun` in `convex/systemDesign.ts`,
called from the System Design action at `convex/systemDesignNode.ts:327-350`
which passes `totalCostUsd: costUsd` directly.

`jobs.estimatedCostUsd` (`convex/schema.ts:347`) summarizes the full run. The
per-job number is fed by the same `completeRunningJob` helper that powers chat
job completion.

### Aggregation: `getUserCostBreakdown`

`convex/lib/userCost.ts` exposes an `internalQuery` that walks three sources:

1. `systemDesignKindRuns` via `by_owner_and_startedAt`
   (`convex/schema.ts:1242`) — source of truth for the System Design path
   because the row already carries provider, model, normalized usage, and cost
   in one place.
2. `messages` via `by_ownerTokenIdentifier` (`convex/schema.ts:999`) — chat
   spend. The loop filters by `_creationTime` within the requested window
   (`sinceMs` inclusive, `untilMs` exclusive, default `Date.now()`).
3. `jobs.estimatedCostUsd` is intentionally NOT read. The same money is already
   counted under `messages` (chat) and `systemDesignKindRuns` (System Design);
   including jobs would double-count.

The query returns a `UserCostBreakdown` with `total`, `byProvider`, `byModel`
(keyed `${provider}:${modelName}`), `byFeature.{chat, systemDesign}`, and
`byDay` (UTC-day rollup, sparse — zero-spend days omitted). Each dimension is
the same `CostBucket` shape (`usd`, `inputTokens`, `outputTokens`,
`cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens`, `count`) so a UI
that renders a stacked bar chart per provider can reuse the same accessor over
`byModel` or `byDay` without reshaping.

Chat rows without `provider`/`modelName` (legacy or pricing-miss rows) still
contribute to `total`, `byFeature.chat`, and `byDay`, but skip the per-provider
and per-model dimensions — the loop branches on
`if (message.provider && message.modelName)` at `convex/lib/userCost.ts:229`.

### Daily cap settlement

Two settlement call sites, both routing through
`consumeSandboxDailyCost(ctx, {ownerTokenIdentifier, repositoryId, cents})`
(`convex/lib/rateLimit.ts:597-612`):

- Chat: `settleChatSandboxDailyCost` inside `convex/chat/streaming.ts:130-163`,
  invoked from the chat finalize / fail / cancel mutations. Converts
  `args.costUsd` via `costUsdToCents`, looks up the thread's `repositoryId`, and
  settles against both the per-user and per-repository buckets. A heuristic
  reply (no `OPENAI_API_KEY`) and a pricing-miss reply both arrive with
  `cents === undefined`; the helper returns early without settlement (the
  conservative direction — better to under-settle than to fabricate a number
  that starves a user's quota).
- System Design: `convex/systemDesign.ts:835-842` settles after writing the
  kindRun row. `cached_hit` runs skip settlement (the artifact was already paid
  for on the run that produced it). The `consumeSandboxDailyCost` short-circuit
  on `cents <= 0` handles pricing misses uniformly.

Cap config defaults live in `convex/lib/rateLimit.ts` under
`sandboxCostUsdPerUserDaily` and `sandboxCostUsdPerRepositoryDaily`. Live
consumption is observable via `peekSandboxDailyCostForUser` /
`peekSandboxDailyCostForRepository` (`convex/lib/rateLimit.ts:465-480`).

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
(`convex/chat/streaming.ts:551-560`, `595-616`). The daily cap settles on
partial cost too — better partial-pretty-good than none-at-all.

**Stale chat recovery.** Stale-recovery in `convex/chat/streaming.ts:626-645`
deliberately does NOT settle cost. The action that stalled never reached the
finalize / fail mutation, so the usage is unknown. Recording an arbitrary
fixed cost would either double-count (if the action actually completed and
its settlement raced the recovery) or fabricate spend. The trade-off is
accepted: a stalled reply may slip the daily cap by its actual cost, but the
recovery itself is rare.

**Settlement bug ("daily cap doesn't trigger").** If `consumeSandboxDailyCost`
is skipped on a code path, runaway spend won't bounce off the cap. The
`peekSandboxDailyCostForUser` query reflects live consumed cents for the
current UTC day — if a high-spend user shows zero or implausibly low cents,
settlement has a bug on whichever path generated the spend. Trace from the
peek value back to the offending finalize/fail/cancel mutation.

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
