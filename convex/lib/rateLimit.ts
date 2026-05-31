import { DAY, HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { components } from "../_generated/api";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { logInfo, logWarn } from "./observability";

export type RateLimitBucket =
  | "importRequests"
  | "systemDesignRequests"
  | "chatRequestsPerOwner"
  | "chatRequestsGlobal"
  | "daytonaRequestsGlobal"
  | "sandboxCostUsdPerUserDaily"
  | "sandboxCostUsdPerRepositoryDaily"
  | "llmRequestsPerUserPerMinute"
  | "llmConcurrentCallsPerUser";

export type InFlightBucket = "repositoryImportInFlight" | "repositorySystemDesignInFlight" | "threadChatInFlight";

type AppErrorCode =
  | "RATE_LIMIT_EXCEEDED"
  | "OPERATION_ALREADY_IN_PROGRESS"
  | "SANDBOX_DAILY_CAP_EXCEEDED"
  | "SANDBOX_REPOSITORY_DAILY_CAP_EXCEEDED";

function readPositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

const RATE_LIMIT_MESSAGES: Record<RateLimitBucket, string> = {
  importRequests: "Too many repository import requests. Please retry later.",
  systemDesignRequests: "Too many System Design generation requests. Please retry later.",
  chatRequestsPerOwner: "Too many chat requests. Please retry later.",
  chatRequestsGlobal: "Chat capacity is temporarily full. Please retry later.",
  daytonaRequestsGlobal: "Analysis capacity is temporarily full. Please retry later.",
  sandboxCostUsdPerUserDaily: "Daily sandbox spend cap reached. Resets at midnight UTC.",
  sandboxCostUsdPerRepositoryDaily: "Repository daily sandbox spend cap reached. Resets at midnight UTC.",
  llmRequestsPerUserPerMinute: "Too many LLM requests per minute. Please wait and retry.",
  llmConcurrentCallsPerUser: "Too many concurrent LLM calls. Close one and retry.",
};

const DEFAULT_IMPORTS_PER_HOUR = 5;
const DEFAULT_SYSTEM_DESIGN_PER_HOUR = 10;
const DEFAULT_CHAT_PER_MINUTE = 30;
const DEFAULT_CHAT_BURST_CAPACITY = 6;
const DEFAULT_GLOBAL_CHAT_PER_MINUTE = 300;
const DEFAULT_GLOBAL_CHAT_BURST_CAPACITY = 60;
const DEFAULT_DAYTONA_GLOBAL_PER_HOUR = 30;

/**
 * Per-user LLM-call fairness defaults.
 *
 * Both buckets sit OUTSIDE the provider's own rate limiting — provider
 * 429s are still the gateway's `withLlmRetry`'s job. These exist to
 * stop one user monopolising provider quota when multiple users share
 * the deployment.
 *
 * Defaults are loose enough that a single-user deployment never sees
 * an effective limit:
 *
 *   - **60 requests / minute / user** ≫ a real user's natural rate.
 *     A System Design job fires ~7 LLM calls over ~10 minutes
 *     (~0.7/min); chat tops out at maybe 1 message every few seconds
 *     at peak (~30/min). Multi-tab abuse (10 tabs × 6 msg/min each)
 *     would hit the cap; normal usage doesn't get close.
 *   - **5 concurrent calls / user** ≫ a real user's natural
 *     concurrency. 5 tabs / panels open simultaneously is plenty;
 *     opening 10 to monopolise the gateway is the bug we guard
 *     against.
 *
 * To tighten for multi-user joins, set `LLM_REQUESTS_PER_USER_PER_MINUTE`
 * / `LLM_CONCURRENT_CALLS_PER_USER` via `bunx convex env set` — no
 * schema or code change needed.
 */
const DEFAULT_LLM_REQUESTS_PER_USER_PER_MINUTE = 60;
const DEFAULT_LLM_CONCURRENT_CALLS_PER_USER = 5;

/**
 * Daily spend caps for sandbox-mode replies, denominated in **cents** so
 * the underlying token-bucket arithmetic stays integer (the
 * `@convex-dev/rate-limiter` component requires integer counts and
 * float `count` values produce drift across shards).
 *
 * `$5 / day` per user is the design default sized so a typical sandbox
 * reply (~$0.05–$0.20) yields ~25–100 replies before the cap fires —
 * enough headroom for a normal workday of investigation but tight enough
 * to bound a runaway loop. Repository cap is 10× higher so a user driving
 * multiple grounded threads against one repository doesn't bottleneck on
 * the repo cap before they hit their personal cap.
 */
const DEFAULT_SANDBOX_DAILY_CAP_PER_USER_USD = 5;
const DEFAULT_SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = 50;

/**
 * Fixed estimate the pre-check on `sendMessage` consults before letting
 * a sandbox reply queue. We don't know the actual cost yet (the
 * model hasn't run), so we project against a reasonable upper-mid case
 * for a sandbox reply that exercises a couple of `read_file` calls and
 * a final answer. The estimate need not be exact — its only role is to
 * gate "obviously over the cap" sends from happening at all. The
 * settlement on `finalizeAssistantReply` charges the actual cost.
 *
 * Tuning trade-off: too small and a user with a near-empty bucket can
 * still queue a $1 reply that pushes them well over the cap; too large
 * and a user with $0.30 of headroom is unfairly blocked from a $0.05
 * reply. $0.10 is the median of recent sandbox sessions plus a 50%
 * cushion — adjust via env if pricing or model selection moves.
 */
const DEFAULT_SANDBOX_REPLY_ESTIMATE_USD = 0.1;

function readPositiveFloatEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/**
 * Cap configuration is read fresh every call so test environments can
 * mutate `process.env` between cases without fighting a module-scope
 * cache. The reads are cheap (a few `Number()` parses) and amortize
 * trivially against the actual rate-limiter check.
 */
function getSandboxDailyCapCentsPerUser() {
  return Math.max(
    1,
    Math.round(readPositiveFloatEnv("SANDBOX_DAILY_CAP_PER_USER_USD", DEFAULT_SANDBOX_DAILY_CAP_PER_USER_USD) * 100),
  );
}

function getSandboxDailyCapCentsPerRepository() {
  return Math.max(
    1,
    Math.round(
      readPositiveFloatEnv("SANDBOX_DAILY_CAP_PER_REPOSITORY_USD", DEFAULT_SANDBOX_DAILY_CAP_PER_REPOSITORY_USD) * 100,
    ),
  );
}

export function getSandboxReplyEstimateCents() {
  return Math.max(
    1,
    Math.ceil(readPositiveFloatEnv("SANDBOX_REPLY_ESTIMATE_USD", DEFAULT_SANDBOX_REPLY_ESTIMATE_USD) * 100),
  );
}

/**
 * Wrap the repository id with a stable string prefix so the same `key`
 * never collides with future ID-keyed buckets that share the rate-limiter
 * namespace. Today this looks like `"repository:abc123"` — explicit so
 * a search for `key.startsWith("repository:")` will match every entry.
 */
export function repositoryCostKey(repositoryId: Id<"repositories">) {
  return `repository:${repositoryId}`;
}

export const CHAT_JOB_LEASE_MS = readPositiveIntEnv("CHAT_JOB_LEASE_MS", 10 * 60_000);
export const SYSTEM_DESIGN_JOB_LEASE_MS = readPositiveIntEnv("SYSTEM_DESIGN_JOB_LEASE_MS", 60 * 60_000);
export const SANDBOX_ACTIVATION_JOB_LEASE_MS = readPositiveIntEnv("SANDBOX_ACTIVATION_JOB_LEASE_MS", 5 * 60_000);

export function isLeaseActive(leaseExpiresAt: number | undefined, now = Date.now()) {
  return typeof leaseExpiresAt === "number" && leaseExpiresAt > now;
}

export function getLeaseRetryAfterMs(leaseExpiresAt: number | undefined, now = Date.now()) {
  if (!isLeaseActive(leaseExpiresAt, now)) {
    return undefined;
  }

  return Math.max(1, leaseExpiresAt! - now);
}

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  importRequests: {
    kind: "fixed window",
    rate: readPositiveIntEnv("RATE_LIMIT_IMPORT_PER_HOUR", DEFAULT_IMPORTS_PER_HOUR),
    period: HOUR,
  },
  systemDesignRequests: {
    kind: "fixed window",
    rate: readPositiveIntEnv("RATE_LIMIT_SYSTEM_DESIGN_PER_HOUR", DEFAULT_SYSTEM_DESIGN_PER_HOUR),
    period: HOUR,
  },
  chatRequestsPerOwner: {
    kind: "token bucket",
    rate: readPositiveIntEnv("RATE_LIMIT_CHAT_PER_MINUTE", DEFAULT_CHAT_PER_MINUTE),
    period: MINUTE,
    capacity: readPositiveIntEnv("RATE_LIMIT_CHAT_BURST_CAPACITY", DEFAULT_CHAT_BURST_CAPACITY),
  },
  chatRequestsGlobal: {
    kind: "token bucket",
    rate: readPositiveIntEnv("RATE_LIMIT_GLOBAL_CHAT_PER_MINUTE", DEFAULT_GLOBAL_CHAT_PER_MINUTE),
    period: MINUTE,
    capacity: readPositiveIntEnv("RATE_LIMIT_GLOBAL_CHAT_BURST_CAPACITY", DEFAULT_GLOBAL_CHAT_BURST_CAPACITY),
    shards: 10,
  },
  daytonaRequestsGlobal: {
    kind: "fixed window",
    rate: readPositiveIntEnv("RATE_LIMIT_DAYTONA_GLOBAL_PER_HOUR", DEFAULT_DAYTONA_GLOBAL_PER_HOUR),
    period: HOUR,
    shards: 10,
  },
  // LLM fairness buckets (`llmRequestsPerUserPerMinute`,
  // `llmConcurrentCallsPerUser`) are deliberately NOT registered
  // here. Same reason as the sandbox cost buckets below — we use
  // the inline-config pattern so env vars like
  // `LLM_REQUESTS_PER_USER_PER_MINUTE` and
  // `LLM_CONCURRENT_CALLS_PER_USER` can be changed at deploy time
  // (or in tests) without bouncing the runtime. Static config
  // captures values at module load and is then immutable. See
  // `getLlmRequestsPerMinuteConfig` / `getLlmConcurrencyConfig`
  // and `acquireLlmRequestRateSlot` /
  // `acquireLlmConcurrencySlot` below.
  // Sandbox cost buckets (`sandboxCostUsdPerUserDaily`,
  // `sandboxCostUsdPerRepositoryDaily`) are deliberately *not* registered
  // here. They use the inline-config pattern (config supplied per
  // call site) so env vars like `SANDBOX_DAILY_CAP_PER_USER_USD` can be
  // changed at deploy time (or in tests) without bouncing the runtime —
  // the static-config form captures values at module load and is then
  // immutable. See `getSandboxUserCapConfig` / `getSandboxRepositoryCapConfig`
  // and the `assertSandboxDailyCostBudget` / `consumeSandboxDailyCost`
  // call sites below. The bucket name strings are stable across calls
  // so the underlying rate-limit table keys consistently.
});

/**
 * Bucket name constants. Used as the `name` argument to
 * `rateLimiter.limit / check / getValue`. Kept as `as const` so the
 * `RateLimitBucket` type and the structured-error `bucket` field stay
 * a single source of truth.
 */
const SANDBOX_USER_COST_BUCKET = "sandboxCostUsdPerUserDaily" as const;
const SANDBOX_REPOSITORY_COST_BUCKET = "sandboxCostUsdPerRepositoryDaily" as const;

/**
 * Per-user daily sandbox cost cap configuration.
 *
 * Fixed window with `start: 0` so the window aligns to UTC midnight —
 * matches the user-facing "resets at midnight UTC" tooltip exactly.
 * A token-bucket alternative would refill continuously and force the
 * tooltip to read "you'll have budget back in ~3 hours" which is
 * harder to reason about and harder to communicate to billing.
 *
 * `rate: capacity` because a fixed window adds `rate` tokens at each
 * window boundary; we want one full daily allowance per UTC day.
 *
 * `maxReserved: capacity` lets the post-hoc settlement on
 * `finalizeAssistantReply` succeed even when an in-flight reply lands
 * the bucket below zero. Without it a user who happens to settle the
 * last cent on a $0.30 cap could see their cost recording silently
 * dropped (reserve=true would still reject when -value > maxReserved).
 * The pre-check uses `reserve: false` so it still blocks new sends as
 * soon as the bucket hits zero — the reserve is settlement-only.
 *
 * Read fresh on every call so env-var changes (deploy, test) take
 * effect without restart. Cost is a few `Number()` parses per call —
 * negligible against the rate-limiter's transactional overhead.
 */
function getSandboxUserCapConfig() {
  const cap = getSandboxDailyCapCentsPerUser();
  return {
    kind: "fixed window" as const,
    rate: cap,
    capacity: cap,
    period: DAY,
    maxReserved: cap,
    start: 0,
  };
}

/**
 * Per-repository daily sandbox cost cap configuration. Same
 * shape as the per-user variant; capacity defaults higher ($50 vs $5)
 * so a user driving several sandbox-grounded threads against the same
 * repository doesn't bottleneck on the repo cap before any one of them
 * hits the per-user cap.
 */
function getSandboxRepositoryCapConfig() {
  const cap = getSandboxDailyCapCentsPerRepository();
  return {
    kind: "fixed window" as const,
    rate: cap,
    capacity: cap,
    period: DAY,
    maxReserved: cap,
    start: 0,
  };
}

function throwAppError(
  code: AppErrorCode,
  bucket: RateLimitBucket | InFlightBucket,
  message: string,
  retryAfterMs?: number,
): never {
  throw new ConvexError({
    code,
    bucket,
    retryAfterMs,
    message,
  });
}

export function throwRateLimitExceeded(bucket: RateLimitBucket, retryAfterMs?: number): never {
  throwAppError(
    "RATE_LIMIT_EXCEEDED",
    bucket,
    RATE_LIMIT_MESSAGES[bucket],
    retryAfterMs ? Math.max(1, Math.ceil(retryAfterMs)) : undefined,
  );
}

export function throwOperationAlreadyInProgress(bucket: InFlightBucket, message: string, retryAfterMs?: number): never {
  throwAppError(
    "OPERATION_ALREADY_IN_PROGRESS",
    bucket,
    message,
    retryAfterMs ? Math.max(1, Math.ceil(retryAfterMs)) : undefined,
  );
}

async function consumeRateLimit(
  ctx: MutationCtx,
  bucket: RateLimitBucket,
  options?: {
    key?: string;
  },
) {
  const status = await rateLimiter.limit(ctx, bucket, options);
  if (!status.ok) {
    throwRateLimitExceeded(bucket, status.retryAfter);
  }
}

export async function consumeImportRateLimit(ctx: MutationCtx, ownerTokenIdentifier: string) {
  await consumeRateLimit(ctx, "importRequests", { key: ownerTokenIdentifier });
}

export async function consumeSystemDesignRateLimit(ctx: MutationCtx, ownerTokenIdentifier: string) {
  await consumeRateLimit(ctx, "systemDesignRequests", { key: ownerTokenIdentifier });
}

export async function consumeChatRateLimit(ctx: MutationCtx, ownerTokenIdentifier: string) {
  await consumeRateLimit(ctx, "chatRequestsPerOwner", { key: ownerTokenIdentifier });
}

export async function consumeChatGlobalRateLimit(ctx: MutationCtx) {
  await consumeRateLimit(ctx, "chatRequestsGlobal");
}

export async function consumeDaytonaGlobalRateLimit(ctx: MutationCtx) {
  await consumeRateLimit(ctx, "daytonaRequestsGlobal");
}

/**
 * Structured error thrown by the sandbox-cap pre-check on
 * `sendMessage`. Distinct from `RATE_LIMIT_EXCEEDED` so the frontend's
 * `toUserErrorMessage` can render a quota-specific UI surface (countdown
 * to midnight UTC, link to docs about the cap) without sniffing
 * `bucket` from the generic rate-limit error path.
 *
 * `retryAfterMs` is the millisecond delta to the next UTC midnight, so
 * the same value can drive both the toast and any "Try again at HH:MM"
 * countdown the UI may render.
 */
function throwSandboxDailyCapExceeded(scope: "user" | "repository", retryAfterMs: number, capUsd: number): never {
  const code: AppErrorCode = scope === "user" ? "SANDBOX_DAILY_CAP_EXCEEDED" : "SANDBOX_REPOSITORY_DAILY_CAP_EXCEEDED";
  const bucket: RateLimitBucket = scope === "user" ? "sandboxCostUsdPerUserDaily" : "sandboxCostUsdPerRepositoryDaily";
  throw new ConvexError({
    code,
    bucket,
    retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
    capUsd,
    message:
      scope === "user"
        ? `Daily sandbox spend cap of $${capUsd.toFixed(2)} reached. Resets at midnight UTC.`
        : `Repository daily sandbox spend cap of $${capUsd.toFixed(2)} reached. Resets at midnight UTC.`,
  });
}

export interface SandboxDailyCostBudget {
  /** Cents remaining in the current UTC day. Clamped to ≥ 0 for the UI. */
  remainingCents: number;
  /** Configured daily cap in cents (= bucket capacity). */
  capacityCents: number;
  /**
   * Wall-clock ms epoch at which the next UTC day starts (= when the
   * bucket replenishes). Drives the "Resets at midnight UTC" countdown.
   */
  resetAtMs: number;
}

/**
 * Peek the current sandbox-cost budget for a single bucket key without
 * consuming any tokens. Used by:
 *
 *   1. `lib/chatEligibility`'s cost-cap gate (via `threadContext` and
 *      `repositoryModeEligibility`) so the UI can disable the sandbox
 *      option before the user hits Send.
 *   2. The frontend cost-ticker tooltip ("$X.XX of $Y.YY remaining today").
 *
 * Computing `resetAtMs` from the snapshot's window timestamp keeps the
 * countdown stable across repeated peeks within the same window — the
 * rate-limiter component returns the same `ts` for every call until the
 * window rolls, so two queries 100 ms apart never drift.
 */
async function peekSandboxBucket(
  ctx: QueryCtx | MutationCtx,
  bucket: "sandboxCostUsdPerUserDaily" | "sandboxCostUsdPerRepositoryDaily",
  key: string,
): Promise<SandboxDailyCostBudget> {
  const config = bucket === SANDBOX_USER_COST_BUCKET ? getSandboxUserCapConfig() : getSandboxRepositoryCapConfig();
  const snapshot = await rateLimiter.getValue(ctx, bucket, { key, config });
  const capacity = snapshot.config.capacity ?? snapshot.config.rate;
  // The component's `value` field represents tokens *remaining*, including
  // a possibly negative balance during reserve-mode settlement overruns.
  // Clamp to ≥ 0 for the UI — "−12 cents remaining" is meaningless to the
  // user; "0 cents remaining (cap reached)" is the right thing to show.
  const remainingCents = Math.max(0, Math.floor(snapshot.value));
  const periodMs = snapshot.config.period;
  // `start` defaults to 0 in our sandbox cost buckets (UTC midnight alignment).
  // For other configurations the rate-limiter randomizes `start` so we
  // fall back to "snapshot.ts + period" which is the actual end of the
  // current window from the snapshot's perspective.
  let resetAtMs: number;
  if (snapshot.config.kind === "fixed window") {
    const start = snapshot.config.start ?? snapshot.ts;
    const elapsed = Math.max(0, Date.now() - start);
    const completedWindows = Math.floor(elapsed / periodMs);
    resetAtMs = start + (completedWindows + 1) * periodMs;
  } else {
    // Token bucket — the bucket refills continuously, so "reset at" is
    // when the bucket would be full again, given the current value. Not
    // used by the sandbox cost buckets today but kept for forward compatibility.
    const refillRatePerMs = snapshot.config.rate / snapshot.config.period;
    const missingCents = capacity - remainingCents;
    resetAtMs = Date.now() + Math.ceil(missingCents / refillRatePerMs);
  }
  return {
    remainingCents,
    capacityCents: capacity,
    resetAtMs,
  };
}

/**
 * Peek the user-level daily budget. Pure read; no consumption.
 */
export async function peekSandboxDailyCostForUser(
  ctx: QueryCtx | MutationCtx,
  ownerTokenIdentifier: string,
): Promise<SandboxDailyCostBudget> {
  return await peekSandboxBucket(ctx, "sandboxCostUsdPerUserDaily", ownerTokenIdentifier);
}

/**
 * Peek the repository-level daily budget. Pure read; no consumption.
 */
export async function peekSandboxDailyCostForRepository(
  ctx: QueryCtx | MutationCtx,
  repositoryId: Id<"repositories">,
): Promise<SandboxDailyCostBudget> {
  return await peekSandboxBucket(ctx, "sandboxCostUsdPerRepositoryDaily", repositoryCostKey(repositoryId));
}

/**
 * Pre-check both daily caps relevant to a sandbox-mode send and
 * throw a structured `SANDBOX_DAILY_CAP_EXCEEDED` /
 * `SANDBOX_REPOSITORY_DAILY_CAP_EXCEEDED` error if either would not have
 * room for `estimateCents`.
 *
 * Order of checks: user cap first, repository cap second. The user cap
 * is the more restrictive default ($5 vs $50) so the more common
 * blocking case surfaces a user-scoped tooltip; the repository cap fires
 * only when the user's own budget would have allowed the send.
 *
 * Important: pre-check uses `rateLimiter.check` (peek-only). This is
 * not a reservation — concurrent sends across multiple threads could
 * each pass the check independently and overrun the cap by their
 * collective settlements. The per-thread `threadChatInFlight` lease
 * caps concurrency to one per thread, and the bucket's `maxReserved`
 * absorbs the overrun on settlement. The user-facing experience: hard
 * stop on new sends as soon as the bucket hits zero, with the actual
 * spend potentially landing slightly above the cap due to in-flight
 * replies. The alternative (reserve at send time, refund at finalize)
 * isn't supported by the underlying component and would invite
 * estimate-vs-actual drift problems that are worse than slight overrun.
 */
export async function assertSandboxDailyCostBudget(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | null | undefined;
    estimateCents: number;
  },
): Promise<void> {
  if (args.estimateCents <= 0) {
    return;
  }

  const userStatus = await rateLimiter.check(ctx, SANDBOX_USER_COST_BUCKET, {
    key: args.ownerTokenIdentifier,
    count: args.estimateCents,
    config: getSandboxUserCapConfig(),
  });
  if (!userStatus.ok) {
    const userBudget = await peekSandboxDailyCostForUser(ctx, args.ownerTokenIdentifier);
    logInfo("rate_limit", "sandbox_daily_cap_blocked", {
      scope: "user",
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      remainingCents: userBudget.remainingCents,
      capacityCents: userBudget.capacityCents,
      estimateCents: args.estimateCents,
    });
    throwSandboxDailyCapExceeded("user", userStatus.retryAfter, userBudget.capacityCents / 100);
  }

  if (args.repositoryId) {
    const repositoryStatus = await rateLimiter.check(ctx, SANDBOX_REPOSITORY_COST_BUCKET, {
      key: repositoryCostKey(args.repositoryId),
      count: args.estimateCents,
      config: getSandboxRepositoryCapConfig(),
    });
    if (!repositoryStatus.ok) {
      const repositoryBudget = await peekSandboxDailyCostForRepository(ctx, args.repositoryId);
      logInfo("rate_limit", "sandbox_daily_cap_blocked", {
        scope: "repository",
        repositoryId: args.repositoryId,
        remainingCents: repositoryBudget.remainingCents,
        capacityCents: repositoryBudget.capacityCents,
        estimateCents: args.estimateCents,
      });
      throwSandboxDailyCapExceeded("repository", repositoryStatus.retryAfter, repositoryBudget.capacityCents / 100);
    }
  }
}

/**
 * Settle the actual sandbox cost on `finalizeAssistantReply`,
 * `failAssistantReply`, and `markAssistantReplyCancelled`. The cost has
 * already been incurred (the OpenAI call ran), so we record the spend
 * even if it lands the bucket below zero (`reserve: true` allows the
 * overrun up to `maxReserved`).
 *
 * Logs a warning if the call still rejects (which would happen only if
 * the cost exceeded `capacity + maxReserved` — a full day's overspend
 * in a single reply). That's a billing-alarm signal, not a user-facing
 * block: we already spent the money; the cap mechanism just couldn't
 * record it.
 */
async function consumeSandboxBucket(
  ctx: MutationCtx,
  bucket: "sandboxCostUsdPerUserDaily" | "sandboxCostUsdPerRepositoryDaily",
  key: string,
  cents: number,
): Promise<void> {
  const config = bucket === SANDBOX_USER_COST_BUCKET ? getSandboxUserCapConfig() : getSandboxRepositoryCapConfig();
  const status = await rateLimiter.limit(ctx, bucket, {
    key,
    count: cents,
    reserve: true,
    config,
  });
  if (!status.ok) {
    logWarn("rate_limit", "sandbox_daily_cap_settlement_dropped", {
      bucket,
      key,
      cents,
      retryAfterMs: status.retryAfter,
      hint: "Cost was incurred but exceeded capacity + maxReserved. The cap is intact for future sends; this single reply went over.",
    });
  }
}

/**
 * Record actual sandbox cost against per-user and (if attached)
 * per-repository daily buckets. Idempotent on `cents <= 0` (heuristic
 * replies, missing model pricing) so the call site can pass through the
 * `costUsd` from `estimateCostUsd` without checking it first.
 */
export async function consumeSandboxDailyCost(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | null | undefined;
    cents: number;
  },
): Promise<void> {
  if (args.cents <= 0) {
    return;
  }
  await consumeSandboxBucket(ctx, SANDBOX_USER_COST_BUCKET, args.ownerTokenIdentifier, args.cents);
  if (args.repositoryId) {
    await consumeSandboxBucket(ctx, SANDBOX_REPOSITORY_COST_BUCKET, repositoryCostKey(args.repositoryId), args.cents);
  }
}

/**
 * Action-callable internal mutation wrapping `consumeSandboxDailyCost`.
 * Used by background actions (e.g. `artifactIndexing` embedding batches)
 * that produce cost outside a mutation context and need to settle the
 * daily cap via `ctx.runMutation`. Mutation-context call sites
 * (`chat/streaming`, `systemDesign`) still call the bare helper directly.
 *
 * Idempotent on non-positive `cents` — the underlying helper short-circuits
 * so callers can pass the raw `costUsdToCents` output without branching.
 */
export const settleSandboxDailyCost = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    repositoryId: v.union(v.id("repositories"), v.null()),
    cents: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    await consumeSandboxDailyCost(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      cents: args.cents,
    });
    return null;
  },
});

// ===========================================================================
// LLM fairness buckets (per-user RPM + per-user concurrency).
//
// These DO NOT throw — the gateway maps a denied acquire into its own
// `LlmRateLimitError` so the frontend can branch on the discriminated
// `code` instead of sniffing `ConvexError.data.bucket`. The internal
// mutations wrap the helpers so the gateway action can call them via
// `ctx.runMutation(internal.lib.rateLimit.acquireLlmRequestSlot, …)`.
// ===========================================================================

export type LlmRateLimitStatus = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Per-user LLM request-rate cap. Token bucket so bursts (a few
 * messages in quick succession) are accepted up to `capacity`,
 * then the bucket refills at `rate` per minute. Counting requests
 * is exact — no estimation — which is why this is the layer where
 * we enforce per-user fairness instead of attempting per-user TPM
 * (provider TPM stays the provider's concern, handled by
 * `withLlmRetry` reading `Retry-After`).
 *
 * Read fresh each call so env-var changes (deploy, test) take
 * effect without restart — same pattern as the sandbox cost caps.
 */
function getLlmRequestsPerMinuteConfig() {
  const rate = readPositiveIntEnv("LLM_REQUESTS_PER_USER_PER_MINUTE", DEFAULT_LLM_REQUESTS_PER_USER_PER_MINUTE);
  const capacity = readPositiveIntEnv("LLM_REQUESTS_PER_USER_PER_MINUTE_BURST", rate);
  return {
    kind: "token bucket" as const,
    rate,
    period: MINUTE,
    capacity,
  };
}

/**
 * Per-user LLM-call concurrency cap, modelled as a fixed window
 * with capacity = max-concurrent and a long `period` so the
 * scheduled refill rarely fires before a paired release reaches
 * the gateway. The gateway acquires 1 token on entry
 * (`count: 1`) and refunds it on exit (`count: -1`) inside a
 * `finally` block — see `acquireLlmConcurrencySlot` /
 * `releaseLlmConcurrencySlot`.
 *
 * The HOUR period bounds slot leaks. If an action crashes between
 * acquire and release (process kill, deploy mid-stream), the
 * leaked slot resets at the next window boundary — worst case the
 * user's effective concurrency drops by 1 for up to an hour.
 * Acceptable at current scale; revisit when
 * `llm_concurrency_acquired` shows slots not returning after
 * expected releases.
 */
function getLlmConcurrencyConfig() {
  const cap = readPositiveIntEnv("LLM_CONCURRENT_CALLS_PER_USER", DEFAULT_LLM_CONCURRENT_CALLS_PER_USER);
  return {
    kind: "fixed window" as const,
    rate: cap,
    period: HOUR,
    capacity: cap,
  };
}

/**
 * Try to take one slot from the per-user RPM bucket. Non-throwing.
 * Returns `{ ok: true }` on success, `{ ok: false, retryAfterMs }` on
 * denial — the caller (gateway) maps the latter into its discriminated
 * error class.
 */
export async function acquireLlmRequestRateSlot(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
): Promise<LlmRateLimitStatus> {
  const status = await rateLimiter.limit(ctx, "llmRequestsPerUserPerMinute", {
    key: ownerTokenIdentifier,
    config: getLlmRequestsPerMinuteConfig(),
  });
  if (status.ok) {
    return { ok: true };
  }
  return { ok: false, retryAfterMs: Math.max(1, Math.ceil(status.retryAfter ?? 0)) };
}

/**
 * Try to take one slot from the per-user concurrency bucket.
 * Non-throwing. Counterpart: `releaseLlmConcurrencySlot`.
 *
 * Acquire consumes 1 token (`count: 1`); release refunds 1
 * (`count: -1`).
 */
export async function acquireLlmConcurrencySlot(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
): Promise<LlmRateLimitStatus> {
  const status = await rateLimiter.limit(ctx, "llmConcurrentCallsPerUser", {
    key: ownerTokenIdentifier,
    count: 1,
    config: getLlmConcurrencyConfig(),
  });
  if (status.ok) {
    return { ok: true };
  }
  return { ok: false, retryAfterMs: Math.max(1, Math.ceil(status.retryAfter ?? 0)) };
}

/**
 * Refund one slot to the per-user concurrency bucket. Always
 * succeeds — refunding a token cannot fail the limit check
 * (negative count never drives `value` below zero, only above the
 * cap on overshoot, which only happens if the caller has bugs in
 * acquire / release pairing).
 *
 * The `value` field can exceed `capacity` if the caller releases
 * more than it acquired (a bug). The cap restores at the next
 * window boundary; we do NOT log on overshoot because spotting the
 * pairing bug is the gateway's job, not the rate limiter's.
 */
export async function releaseLlmConcurrencySlot(ctx: MutationCtx, ownerTokenIdentifier: string): Promise<void> {
  await rateLimiter.limit(ctx, "llmConcurrentCallsPerUser", {
    key: ownerTokenIdentifier,
    count: -1,
    config: getLlmConcurrencyConfig(),
  });
}

/**
 * Action-callable internal mutation wrapping `acquireLlmRequestRateSlot`.
 * The gateway action calls this via `ctx.runMutation` because rate
 * limiter writes need a `MutationCtx`.
 */
export const acquireLlmRequestSlot = internalMutation({
  args: { ownerTokenIdentifier: v.string() },
  handler: async (ctx, args): Promise<LlmRateLimitStatus> => {
    return await acquireLlmRequestRateSlot(ctx, args.ownerTokenIdentifier);
  },
});

/**
 * Action-callable internal mutation wrapping `acquireLlmConcurrencySlot`.
 */
export const acquireLlmConcurrency = internalMutation({
  args: { ownerTokenIdentifier: v.string() },
  handler: async (ctx, args): Promise<LlmRateLimitStatus> => {
    return await acquireLlmConcurrencySlot(ctx, args.ownerTokenIdentifier);
  },
});

/**
 * Action-callable internal mutation wrapping `releaseLlmConcurrencySlot`.
 * Returns `null` — release is fire-and-forget; the gateway does not
 * wait on a status.
 */
export const releaseLlmConcurrency = internalMutation({
  args: { ownerTokenIdentifier: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await releaseLlmConcurrencySlot(ctx, args.ownerTokenIdentifier);
    return null;
  },
});
