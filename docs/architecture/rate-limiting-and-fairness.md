# Rate Limiting and Fairness

## Why this exists

Multi-user production deployments share a single set of provider quotas. OpenAI
TPM/RPM limits, Anthropic per-organization concurrency, and the bare HTTP rate
that the provider's edge enforces are all global to our Anthropic / OpenAI
account — not partitioned by our end-user. Without app-level fairness, a single
tenant opening ten tabs or driving a runaway loop can drain the provider quota
and starve every other tenant for the duration of the burst.

Token-based coordination was considered and rejected. Tool-loop token counts
are too variable to estimate usefully: a 7-step System Design kind ranges
30k–200k tokens depending on which file paths the LLM reads, how many
artifacts it cites, and whether reasoning expanded. A pre-call estimate would
either over-reserve (wasting quota) or under-reserve (cap never bites).
Request-based coordination is exact — counting requests needs no estimation,
and the gateway acquires before the SDK call so the accounting is observed
synchronously.

Three independent layers exist because three different abuse shapes hit at
three different time horizons. A single bigger bucket cannot simultaneously
enforce all three: the cost cap catches long-tail spend over a day; the RPM
cap catches burst abuse over a minute; the concurrency cap catches tab-spam
in a single instant. Collapsing them would force a tradeoff that lets at least
one shape through.

## How it works

### The three fairness layers

All three layers use mechanisms that need no token estimation. They run
independently — each catches a different abuse pattern and surfaces a
distinct error.

1. **Per-user daily cost cap.** Buckets `sandboxCostUsdPerUserDaily` and
   `sandboxCostUsdPerRepositoryDaily` in `convex/lib/rateLimit.ts`. Fixed-window
   bucket aligned to UTC midnight (`start: 0`). Default `$5/day/user` and
   `$50/day/repository`. The chat path's pre-check on `sendMessage` is
   peek-only: `assertRepositoryModeEligible` (`convex/repositoryModeEligibility.ts`)
   calls `computeSandboxCostCapEvaluation` (`convex/lib/chatEligibility.ts`),
   which `peek`s both buckets against a `SANDBOX_REPLY_ESTIMATE_USD` (default
   `$0.10`) and closes the Sandbox grounding axis when either bucket has
   insufficient headroom — the gate surfaces as a structured `ConvexError`
   via the eligibility resolver, never via a direct rate-limiter throw on the
   chat path. Hard pre-checks and actual-cost settlement are owned by
   `convex/lib/usageAccountingMutations.ts`; it calls the bucket primitives
   `assertSandboxDailyCostBudget` and `consumeSandboxDailyCost` from
   `convex/lib/rateLimit.ts` according to each lifecycle feature policy.
   `rateLimit.ts` remains the bucket implementation, not the feature lifecycle.
   `maxReserved` absorbs settlement overruns when an in-flight reply lands the
   bucket below zero.
2. **Per-user requests per minute.** Bucket `llmRequestsPerUserPerMinute`,
   default `60/min` (env `LLM_REQUESTS_PER_USER_PER_MINUTE`). Token bucket so
   short bursts are accepted up to `capacity` then drained at `rate/period`.
   Acquired in `acquireLlmRequestRateSlot` (`convex/lib/rateLimit.ts:708`),
   exposed to the gateway via the `acquireLlmRequestSlot` internal mutation
   (`convex/lib/rateLimit.ts:769`).
3. **Per-user concurrent calls in flight.** Bucket `llmConcurrentCallsPerUser`,
   default `5` (env `LLM_CONCURRENT_CALLS_PER_USER`). Fixed window with
   `period: HOUR`, acquired with `count: 1` and released with `count: -1`.
   Acquired in `acquireLlmConcurrencySlot` (`convex/lib/rateLimit.ts:729`),
   released in `releaseLlmConcurrencySlot` (`convex/lib/rateLimit.ts:756`).
   Exposed to the gateway via `acquireLlmConcurrency` and `releaseLlmConcurrency`
   internal mutations.

Defaults are deliberately loose enough that a single-user deployment never
sees an effective limit: `60 req/min` ≫ natural user rate (a System Design
job is ~0.7/min); `5 concurrent` ≫ natural concurrency (5 tabs is plenty).
To tighten for multi-user joins, set the env vars via
`bunx convex env set LLM_REQUESTS_PER_USER_PER_MINUTE=20` — no schema or
code change needed.

### Gateway acquire / release sequence

`convex/lib/llmGateway.ts` is the single chokepoint. Every LLM call —
`generateViaGateway`, `streamViaGateway`, and `embedViaGateway` —
follows the same acquire-then-release shape:

1. `assertCatalogPick` — fail-fast on unsupported `(provider, model)` pair.
2. `acquireRpmOrThrow` (`llmGateway.ts:509`) — runs the RPM mutation; on
   denial throws `LlmRateLimitError("requests_per_minute_exceeded", retryAfterMs)`.
   No slot consumed yet on the concurrency bucket.
3. `acquireConcurrencyOrThrow` (`llmGateway.ts:527`) — runs the concurrency
   mutation; on denial throws `LlmRateLimitError("concurrency_exceeded", …)`.
4. Provider SDK call wrapped in `withLlmRetry` (or, for streaming, called
   without retry because replay isn't supported).
5. `releaseConcurrencyBestEffort` (`llmGateway.ts:551`) runs in `finally`
   — on natural completion, on retry exhaustion, on caller abort.
   Acquire order is RPM-then-concurrency; release order is concurrency only
   (RPM is a window cap, not a held resource).

Embedding calls (`embedViaGateway`) are not exempt: every batched
`embedMany` invocation acquires the same per-user RPM token and the same
per-user concurrency slot before the SDK call and releases the slot in
`finally`. A burst of artifact-indexing embedding batches therefore counts
against the same fairness buckets as chat / Design Docs generations,
preventing a runaway indexing job from starving interactive replies.

For streaming, `streamViaGateway` returns four `final*` promises and an
`abort()`. The release is wired into a single `settle()` (`llmGateway.ts:424`)
that runs exactly once and is awaited by every `final*` projection, so any
caller that awaits any of the four implicitly waits for the slot release.

### Provider-level 429 handling

`withLlmRetry` (`convex/lib/withLlmRetry.ts`) is the **only** defense against
provider-level rate limits. Constants mirror `convex/lib/daytonaRetry.ts`:
`MAX_RETRIES = 5`, `BASE_DELAY_MS = 1_000`, `MAX_DELAY_MS = 30_000`,
`JITTER_RATIO = 0.2`. The classifier `isRetriable`
(`withLlmRetry.ts:189`) retries on `APICallError` with status `429` or
`5xx`, or on undefined status (transport fault), or on a known transient
network code (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`,
`EPIPE`). The `provider` argument is currently a no-op dispatch but kept
on the signature so a future provider with idiosyncratic semantics (Gemini's
`RESOURCE_EXHAUSTED`) can branch without a call-site change.

The wrapper reads `retry-after`, `anthropic-ratelimit-tokens-reset`, and
`anthropic-ratelimit-requests-reset` from `error.responseHeaders` in priority
order. Numeric-seconds and RFC3339 timestamps both parse. Server hint is
capped at `MAX_DELAY_MS` so a misbehaving upstream returning
`retry-after: 300` doesn't sleep longer than the surrounding action's lease.
When no server hint is present, delay falls back to exponential backoff with
±20% symmetric jitter.

**Critical contract**: every caller of `generateText`/`streamText` MUST set
`maxRetries: 0`. The gateway sets it inline; non-gateway use would
double-count attempts (`5 × 3 = 15` effective retries).

## Failure modes & recovery

### Three distinct rate-limit failure surfaces

| Origin | Caught by | Surface to caller |
|---|---|---|
| A. Provider 429 / 5xx / transport | `withLlmRetry` automatic backoff | success-after-retry, or original `APICallError` after 5 attempts exhausted |
| B. Gateway RPM denial | `acquireRpmOrThrow` | `LlmRateLimitError("requests_per_minute_exceeded", retryAfterMs)` — no SDK call attempted, no retry |
| C. Gateway concurrency denial | `acquireConcurrencyOrThrow` | `LlmRateLimitError("concurrency_exceeded", retryAfterMs)` — no SDK call attempted, no retry |

Failure modes B and C deliberately do not retry. The provider never saw
the call, so backoff would only delay surfacing the fairness signal to the
user. The frontend branches on `LlmRateLimitError.code` for per-cause copy;
the System Design failure recorder maps both codes to
`failureReason: "transport_rate_limit"` and re-enqueues via auto-resume
(see `system-design-generation.md`).

The cost-cap failure mode is fourth and separate, and surfaces through two
distinct entry points before any LLM call lands:

- **Chat path** uses peek-only `computeSandboxCostCapEvaluation`
  (`convex/lib/chatEligibility.ts`) via `assertRepositoryModeEligible`.
  When either bucket lacks headroom, the eligibility resolver closes the
  Sandbox grounding axis and `assertRepositoryModeEligible` throws a
  structured `ConvexError` whose `code` matches the disabled-reason code
  (`sandbox_user_cap_exceeded` / `sandbox_repository_cap_exceeded`),
  surfaced to the UI with a midnight-UTC countdown via the same gate the
  composer renders.
- **Metered lifecycle pre-check** uses
  `usageAccountingMutations.reserveUsageLifecycle`. For features with
  `sandboxDailyCap: "precheckAndSettle"` (sandbox chat replies and System
  Design generation), the lifecycle calls `assertSandboxDailyCostBudget` before
  reserving user budget. On denial it throws a `ConvexError` with
  `code: "SANDBOX_DAILY_CAP_EXCEEDED"` (or
  `"SANDBOX_REPOSITORY_DAILY_CAP_EXCEEDED"`); the per-kind action catches it and
  records the kind as failed with `failureReason: "transport_rate_limit"`.

Both entry points read the same `peekSandboxDailyCost*` snapshots, so
"is the bucket empty?" gives the same answer either way; what differs is
the surface (eligibility verdict vs. lifecycle throw) and the caller that
handles it.

### Concurrency slot leak on action crash

If an action crashes between `acquireConcurrencySlot` and
`releaseConcurrencySlot` (process kill, deploy mid-stream, OOM), the slot
stays acquired. The bucket's `period: HOUR` configuration bounds the leak:
worst case the user's effective concurrency drops by 1 until the next
window boundary — up to one hour.

The mitigation is intentionally NOT built. A robust fix would require a
slot reservation table keyed by an idempotency token, plus a cleanup cron
that releases stale reservations. The complexity isn't justified at current
scale; the `llm_concurrency_acquired` / `llm_concurrency_released` metric
pair is the canary. Revisit if dashboards show released-count not returning
to baseline after expected releases (indicating leaked slots accumulating).

The release path itself is best-effort and swallows mutation errors
(`releaseConcurrencyBestEffort`, `llmGateway.ts:551`) with a `logWarn` so
a transient release failure cannot mask the original error to the caller.
The same window-rollover safety net catches missed releases from this path.

### Caller patterns

- **Chat** (`convex/chat/send.ts`, `convex/chat/generation.ts`): surfaces
  `LlmRateLimitError` to the user via the existing error toast pipeline.
  The error's `retryAfterMs` field drives the toast countdown copy.
- **System Design** (`convex/systemDesignNode.ts`): records the error as
  `failureReason: "transport_rate_limit"` on the job and relies on the
  auto-resume cron to re-enqueue. The cron's existing backoff schedule
  handles the timing — the gateway error does not need to surface a wait
  hint up the System Design path.
- **Eval judge** (`convex/eval/systemDesign/judge.ts`): treats the error
  as a hard run failure; the judge harness re-runs from the orchestrator,
  not the call site.

## Future evolution

- **Global RPM backstop.** When multi-user join volume makes per-user
  fairness insufficient (e.g. ten users each at their per-user 60/min
  totalling 600/min against a provider RPM of 500), add an
  `llmRequestsGlobalPerMinute` bucket using the same inline-config pattern
  as the sandbox cost caps. The acquire becomes a third call between RPM
  and concurrency; no other change.
- **Slot reservation table for crash-safe concurrency.** When the
  `llm_concurrency_acquired` metric shows persistent drift between
  acquired and released counts, replace the in-bucket counter with a
  dedicated `llmSlotReservations` table keyed by `(ownerTokenIdentifier,
  reservationId)` with a `leaseExpiresAt`. A cleanup cron releases
  expired reservations. Keeps the gateway API identical — only the
  acquire / release mutations change.
- **Per-feature limits.** Today all three fairness layers are per-user.
  If a single feature (e.g. eval harness in CI) starts dominating a
  user's quota, partition by `feature` tag — add `llmRequestsPerFeaturePerMinute`
  with the same shape. Defer until metrics show the need.
- **Tuning playbook.** Cap-tightening guidance for multi-user joins is
  documented in `convex/eval/systemDesign/README.md`. The env vars
  (`LLM_REQUESTS_PER_USER_PER_MINUTE`, `LLM_CONCURRENT_CALLS_PER_USER`,
  `SANDBOX_DAILY_CAP_PER_USER_USD`) are the only knobs that need turning
  for the first wave of multi-tenant traffic.
