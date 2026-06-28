# LLM Gateway

## Why this exists

Before the gateway, every LLM call site imported `@ai-sdk/openai` directly. The chat path,
the System Design generator, and the eval judge each built their own SDK invocation,
duplicated retry handling, and hard-coded the provider. Swapping a model, adding a per-user
rate-limit policy, or introducing a second provider meant editing every call site — and the
edits had to agree, which they predictably did not.

The gateway is the single chokepoint that owns provider dispatch, fairness, retry, usage
normalization, and cost. The caller decides `(provider, modelName)` per request and the
gateway runs it. Provider SDK imports (`@ai-sdk/openai`, `@ai-sdk/anthropic`) are confined to
`convex/lib/llmGateway.ts`; a provider-isolation test in
`convex/lib/llmGateway.architecture.test.ts` fails CI if either import leaks into another
file in `convex/`.

The gateway is a dispatcher, not a failover orchestrator. There is no "try OpenAI, fall back
to Claude" — that would break the per-message model semantics the picker promises ("the
model you chose ran your request"). When a provider fails, the failure surfaces to the
caller; the caller decides whether to retry with the same pick, surface to the user, or
record as a job failure.

## How it works

Three entry points live in `convex/lib/llmGateway.ts`:

- `generateViaGateway` — non-streaming. Awaits the full
  result and returns an `LlmGenerateResult` (`text`, `steps`, `usage`, `costUsd`,
  `rawResponseId`). Used by the per-kind System Design runner
  (`convex/systemDesignKindRun.ts`), artifact draft / repair actions, titles, and evals.
- `streamViaGateway` — streaming. Returns synchronously
  with an `LlmStreamResult` containing `fullStream` plus four `final*` promises (`finalText`,
  `finalUsage`, `finalCostUsd`, `finalSteps`) and `abort()`. Used by
  `convex/chat/replyStreamController.ts` for chat replies.
- `embedViaGateway` — batch embedding. Always goes
  through the AI SDK's `embedMany` (even for a single value) so per-batch usage settles
  once per gateway invocation. Returns an `LlmEmbedResult` (`embeddings` preserving input
  order, `usage` with `inputTokens` only, `costUsd`). The `callCtx.capability` MUST be
  `"embedding"` so an embedding-tier catalog row cannot be reached by a generate call site
  and vice versa.

All three helpers are plain TS async functions that accept the caller's `ActionCtx`. They
are not registered Convex actions — keeping dispatch inline avoids a `runMutation` hop per
call while still letting the helpers issue mutations against rate-limit tables.

### Per-call flow (9 steps, all three entry points)

1. **Catalog validation.** `assertCatalogPick` calls `isValidPick(provider, modelName)`
   from `convex/lib/llmCatalog.ts`. A model not in `MODEL_CATALOG` throws before any
   side-effect lands. The catalog is the single source of truth — the composer picker, the
   `chat.send` mutation, and the gateway all read it.
2. **Per-user RPM acquire.** `acquireRpmOrThrow` issues an
   `internal.lib.rateLimit.acquireLlmRequestSlot` mutation. On denial, the gateway throws
   `LlmRateLimitError("requests_per_minute_exceeded", retryAfterMs)`.
3. **Per-user concurrency acquire.** `acquireConcurrencyOrThrow` issues an
   `internal.lib.rateLimit.acquireLlmConcurrency` mutation. On denial, throws
   `LlmRateLimitError("concurrency_exceeded", retryAfterMs)`.
4. **SDK call wrapped in `withLlmRetry`.** `getSdkModel(provider, modelName)` dispatches
   on the provider literal and returns the AI SDK model handle.
   `buildProviderOptions(provider, args)` translates gateway-level knobs
   (`reasoningEffort`) into provider-specific `providerOptions`. The wrapped call runs with
   `maxRetries: 0` — the SDK's built-in retry would double-count attempts with the wrapper,
   per the contract in `convex/lib/withLlmRetry.ts:18`.
5. **Usage normalization.** `normalizeUsage(provider, sdkUsage, providerMetadata)` reads
   the AI SDK v6 structural usage (`inputTokenDetails.noCacheTokens`,
   `inputTokenDetails.cacheReadTokens`, `inputTokenDetails.cacheWriteTokens`,
   `outputTokenDetails.reasoningTokens`) and produces a uniform `NormalizedUsage`
   (`convex/lib/llmProvider.ts:57`). Cache + reasoning splits are non-overlapping so
   pricing can charge each tier once.
6. **Cost compute.** `estimateCostUsd(provider, modelName, usage)` from
   `convex/lib/llmPricing.ts` returns USD or `undefined` (pricing miss → "cost unknown",
   not zero).
7. **Concurrency slot release in `finally`.** `releaseConcurrencyBestEffort` runs on every
   exit path of all three helpers. Release errors are warn-logged, never re-thrown — the
   slot refreshes at the next bucket window even if the release patch fails. See the
   `finally` block at `convex/lib/llmGateway.ts:363` (non-streaming),
   `convex/lib/llmGateway.ts:466` (inside the stream `settle`), and
   `convex/lib/llmGateway.ts:295` (embedding).
8. **Metric emission.** Generate / stream emit `llm_tokens_used`; embed emits
   `llm_embedding_tokens_used`. Both are tagged with provider, model, and feature
   (`chat` | `system_design` | `eval_judge`); details carry the per-token-tier counts and
   the owner identifier.
9. **Uniform return.** Callers see the same `LlmGenerateResult` / `LlmStreamResult` /
   `LlmEmbedResult` shape regardless of provider.

### Provider dispatch

`getSdkModel` at `convex/lib/llmGateway.ts:578` is a switch on the `LlmProvider` literal:

```ts
function getSdkModel(provider: LlmProvider, modelName: string) {
  switch (provider) {
    case "openai":    return openai(modelName);
    case "anthropic": return anthropic(modelName);
  }
}
```

Adding a third provider is: one literal in `convex/lib/llmProvider.ts`, catalog rows in
`convex/lib/llmCatalog.ts`, pricing rows in `convex/lib/llmPricing.ts`, and one new `case`
here. Zero call site changes.

### Streaming settlement order

The streaming path is the failure-mode-critical bit. Synchronous pre-checks (catalog,
RPM, concurrency) run before `streamText` is invoked, so an acquire denial rejects the
returned promise without holding any resources. The `streamText` call itself is wrapped in
a `try/catch` that releases the concurrency slot before re-throwing on synchronous SDK
failure.

Once the stream is live, settlement runs exactly once through the `settle` closure at
`convex/lib/llmGateway.ts:424`. The closure awaits `sdkResult.text`, `sdkResult.totalUsage`,
`sdkResult.providerMetadata`, and `sdkResult.steps` in parallel, normalizes, emits the
metric, and releases the slot in its `finally`. The same `settlementPromise` projects into
all four `final*` promises, so any of them resolving means the slot has already released.

Streaming is intentionally NOT wrapped in `withLlmRetry` — retry on a streaming call would
require buffering and replaying the prompt; the chat / System Design call sites surface
stream errors directly to the user / job recorder instead.

### `LlmRateLimitError`

```ts
class LlmRateLimitError extends Error {
  code: "requests_per_minute_exceeded" | "concurrency_exceeded";
  retryAfterMs: number;
}
```

A plain `Error` subclass, not a `ConvexError` — gateway callers handle this inline (the
chat path surfaces it to the user; the System Design recorder maps both codes to
`failureReason: "transport_rate_limit"`). `ConvexError` would require throwing from a
mutation context, but the gateway is called from actions.

## Failure modes & recovery

**Catalog rejection, RPM denied, concurrency denied** — gateway-internal failures throw
before any provider call. `withLlmRetry` never sees them; retry is meaningless because the
condition is local. The caller branches on the error type:
`LlmRateLimitError` → surface retry-after to the user. Catalog rejection (plain `Error`) →
operator bug, fail the job.

**Provider 429 / 5xx / network** — wrapped through `withLlmRetry` (non-streaming only).
The wrapper reads `retry-after` and Anthropic's `anthropic-ratelimit-*-reset` headers when
present, otherwise exponential backoff (`BASE_DELAY_MS = 1s`, `MAX_DELAY_MS = 30s`,
`±20%` jitter, `MAX_RETRIES = 5`). Validation errors (4xx other than 429) fail fast — the
classifier in `convex/lib/withLlmRetry.ts:189` is deliberately conservative so a real
caller bug surfaces immediately instead of being masked by 5 retries.

**Stream mid-error.** The AI SDK reports partial usage through `sdkResult.totalUsage` even
when the stream errors. The `settle` closure resolves `finalUsage` with whatever the SDK
provided, runs the full `finally` (metric emit + slot release), and then rejects
`finalText` with the original error. Callers awaiting `finalText` see the error; callers
awaiting `finalUsage` see partial usage. The slot release happens regardless.

**Caller abort.** `abort()` calls the underlying `AbortController.abort()` which tears
down the SDK's HTTP/SSE stream. The for-await consumer either ends naturally or throws an
abort error; either way `settle` runs once and the slot releases. The chat path wires this
through a poll loop that watches the job's `cancelled` flag —
`convex/chat/generation.ts:391` calls `stream?.abort()` when the poll catches a cancel,
which works whether the abort lands before or after the stream handle is assigned.

**Concurrency slot leak.** The most common semaphore bug — a missed release path on an
error branch. `generateViaGateway`, `streamViaGateway`, and `embedViaGateway` each wire
release into a `finally`. The non-streaming path has a unit test at
`convex/llmGateway.test.ts:264` that forces the SDK to throw and asserts the slot count
returns to baseline so a follow-up call is not blocked by a leaked semaphore slot.

**Release failure.** `releaseConcurrencyBestEffort` swallows release errors with a warn
log because re-throwing would mask the original LLM error and confuse the caller. The slot
refreshes at the next bucket window boundary either way.

## Future evolution

**Adding Gemini (or any third provider).** Five edits, all additive, zero call site
changes:

1. Add `"gemini"` to the `llmProviderValidator` union in `convex/lib/llmProvider.ts`.
2. Add catalog rows to `MODEL_CATALOG` in `convex/lib/llmCatalog.ts`.
3. Add pricing rows to `PRICING` in `convex/lib/llmPricing.ts`.
4. Add a `case "gemini": return gemini(modelName)` arm to `getSdkModel` in
   `convex/lib/llmGateway.ts:578`.
5. Add a `case "gemini":` arm to `buildProviderOptions` in
   `convex/lib/llmGateway.ts:613` if Gemini needs a non-default `providerOptions` mapping
   (e.g. its own reasoning / safety knob).

The provider-isolation test catches a forgotten import-confinement change at CI time.

**Anthropic thinking-budget knob.** `buildProviderOptions` accepts `reasoningEffort`
silently for Anthropic today — the OpenAI shape is forwarded, the Anthropic case is a
no-op. PR-A3 (planned, not yet landed) will wire Anthropic's `thinking_budget` parameter
through a separate gateway arg, mapped per-provider inside `buildProviderOptions`.

**Streaming abort wiring.** Already in place end-to-end as of the chat-cancel path at
`convex/chat/generation.ts:391`. The poll-based design (rather than checking a flag inside
the for-await) ensures a long tool-call stretch with no deltas can still be cancelled
within one poll interval.

**Global RPM backstop.** Today's RPM fairness is per-user only. When multi-user load makes
provider-side aggregate rate limits a real concern, add a `llmRequestsGlobalPerMinute`
bucket alongside the per-user bucket, acquired in the same step 2 sequence. The pattern is
already proven by the existing per-user acquire (`internal.lib.rateLimit.acquireLlmRequestSlot`).
