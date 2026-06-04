/**
 * Per-user cost aggregation for the `report:user-costs` CLI and
 * future admin / billing surfaces.
 *
 * Reads from three sources:
 *
 *   1. `systemDesignKindRuns` — per-kind System Design spend with
 *      full provider / model attribution + token mix breakdown.
 *      This is the source of truth for the System Design path
 *      because the row carries everything (provider, model,
 *      normalized usage, costUsd, timing) in one place.
 *
 *   2. `messages` — chat-path per-message cost. PR-A2 chat does NOT
 *      yet carry `provider` / `modelName` on the row (those land in
 *      PR-A3), so chat spend is aggregated as a single
 *      `byFeature.chat` bucket without per-provider attribution. The
 *      same query gracefully gains provider attribution in PR-A3
 *      with no signature change — the optional fields on the row
 *      simply become populated.
 *
 *   3. `jobs.estimatedCostUsd` is intentionally NOT read here. The
 *      same money is already counted under `messages` (chat jobs) and
 *      `systemDesignKindRuns` (System Design jobs) — including jobs
 *      would double-count.
 *
 * The query is `internalQuery`-scoped: a CLI / admin tool can invoke
 * via `bunx convex run convex/lib/userCost:getUserCostBreakdown` with
 * `{ownerTokenIdentifier, sinceMs}`. Wiring this up to a public
 * surface needs explicit access control (auth check on the calling
 * user's role) — not added today.
 */

import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "../_generated/server";
import { requireViewerIdentity } from "./auth";
import { peekSandboxDailyCostForUser } from "./rateLimit";
import type { LlmProvider } from "./llmProvider";

const VIEWER_USAGE_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Per-bucket money + token accumulator. Reused across every grouping
 * dimension so the shape stays consistent for downstream consumers
 * (a UI that renders a stacked bar chart per provider can reuse the
 * same accessor over `byProvider`, `byModel`, `byDay`).
 */
export interface CostBucket {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /**
   * Anthropic cache-write tokens. Always 0 for OpenAI-only slices.
   * Distinct from `cachedInputTokens` so a cost dashboard can show
   * the "you paid to populate the cache" line separately from
   * "you read from the cache cheaply" line.
   */
  cacheWriteTokens: number;
  /**
   * Reasoning tokens. Charged at the output rate today (OpenAI) but
   * tracked separately so the dashboard can attribute the "thinking"
   * portion of spend.
   */
  reasoningTokens: number;
  /** Row count contributing to this bucket. Useful for averages. */
  count: number;
}

export interface UserCostBreakdown {
  total: CostBucket;
  byProvider: Record<LlmProvider, CostBucket>;
  /** Keyed by `${provider}:${modelName}` for stable lookup. */
  byModel: Record<string, CostBucket>;
  byFeature: {
    chat: CostBucket;
    systemDesign: CostBucket;
  };
  /**
   * Per-UTC-day rollup in `YYYY-MM-DD` form, sorted ascending. Use
   * for time-series charts. Days with zero spend are omitted (sparse
   * representation).
   */
  byDay: Array<{ yyyymmdd: string; bucket: CostBucket }>;
}

export interface ViewerUsageSummary {
  window: {
    sinceMs: number;
    untilMs: number;
    days: number;
  };
  totals: {
    costUsd: number;
    events: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  byFeature: {
    chat: {
      costUsd: number;
      events: number;
      totalTokens: number;
    };
    systemDesign: {
      costUsd: number;
      events: number;
      totalTokens: number;
    };
  };
  sandboxDailyBudget: {
    usedUsd: number;
    remainingUsd: number;
    capacityUsd: number;
    resetAtMs: number;
  };
}

function makeBucket(): CostBucket {
  return {
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    count: 0,
  };
}

function addToBucket(
  bucket: CostBucket,
  args: {
    usd?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  },
): void {
  bucket.count += 1;
  if (args.usd !== undefined && Number.isFinite(args.usd) && args.usd > 0) {
    bucket.usd += args.usd;
  }
  bucket.inputTokens += args.inputTokens ?? 0;
  bucket.outputTokens += args.outputTokens ?? 0;
  bucket.cachedInputTokens += args.cachedInputTokens ?? 0;
  bucket.cacheWriteTokens += args.cacheWriteTokens ?? 0;
  bucket.reasoningTokens += args.reasoningTokens ?? 0;
}

function utcDayKey(ms: number): string {
  const d = new Date(ms);
  // Pad month/day to two digits manually — `Date.toISOString().slice(0,10)`
  // also works but is heavier on V8's parse path.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function tokenTotal(bucket: CostBucket): number {
  return (
    bucket.inputTokens +
    bucket.outputTokens +
    bucket.cachedInputTokens +
    bucket.cacheWriteTokens +
    bucket.reasoningTokens
  );
}

function summarizeBucket(bucket: CostBucket): { costUsd: number; events: number; totalTokens: number } {
  return {
    costUsd: bucket.usd,
    events: bucket.count,
    totalTokens: tokenTotal(bucket),
  };
}

async function aggregateUserCostBreakdown(
  ctx: QueryCtx,
  args: {
    ownerTokenIdentifier: string;
    sinceMs: number;
    untilMs?: number;
  },
): Promise<UserCostBreakdown> {
  const untilMs = args.untilMs ?? Date.now();
  const total = makeBucket();
  const byProvider: Record<LlmProvider, CostBucket> = {
    openai: makeBucket(),
    anthropic: makeBucket(),
  };
  const byModel: Record<string, CostBucket> = {};
  const byFeature = {
    chat: makeBucket(),
    systemDesign: makeBucket(),
  };
  const dayMap = new Map<string, CostBucket>();
  const bucketForDay = (dayKey: string): CostBucket => {
    const existing = dayMap.get(dayKey);
    if (existing) return existing;
    const created = makeBucket();
    dayMap.set(dayKey, created);
    return created;
  };

  // ── System Design path ──────────────────────────────────────────
  // `systemDesignKindRuns` carries provider + model + full token
  // mix, so the breakdown dimensions all populate from this slice.
  const kindRuns = await ctx.db
    .query("systemDesignKindRuns")
    .withIndex("by_owner_and_startedAt", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).gte("startedAt", args.sinceMs).lt("startedAt", untilMs),
    )
    .collect();

  for (const row of kindRuns) {
    const provider = row.provider;
    const modelKey = `${row.provider}:${row.modelName}`;
    const dayKey = utcDayKey(row.startedAt);
    const payload = {
      usd: row.totalCostUsd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
    };
    addToBucket(total, payload);
    addToBucket(byProvider[provider], payload);
    addToBucket((byModel[modelKey] ??= makeBucket()), payload);
    addToBucket(byFeature.systemDesign, payload);
    addToBucket(bucketForDay(dayKey), payload);
  }

  // ── Chat path ───────────────────────────────────────────────────
  // PR-A2: messages do NOT carry `provider` / `modelName` yet — that
  // lands in PR-A3. Aggregation here adds to `byFeature.chat` (and
  // `total`, `byDay`) but does NOT populate `byProvider` / `byModel`
  // for chat rows. When PR-A3 lands the same loop reads the new
  // optional columns and routes them into the provider / model
  // dimensions automatically.
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_ownerTokenIdentifier", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .gte("_creationTime", args.sinceMs)
        .lt("_creationTime", untilMs),
    )
    .collect();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const payload = {
      usd: message.estimatedCostUsd,
      inputTokens: message.estimatedInputTokens,
      outputTokens: message.estimatedOutputTokens,
      cachedInputTokens: message.estimatedCachedInputTokens,
      reasoningTokens: message.estimatedReasoningTokens,
    };
    // Skip rows with no recordable cost / tokens — heuristic replies
    // and library-mode rows that never went through pricing.
    if (
      (payload.usd === undefined || payload.usd === 0) &&
      (payload.inputTokens ?? 0) === 0 &&
      (payload.outputTokens ?? 0) === 0
    ) {
      continue;
    }
    addToBucket(total, payload);
    addToBucket(byFeature.chat, payload);
    addToBucket(bucketForDay(utcDayKey(message._creationTime)), payload);
    if (message.provider && message.modelName) {
      addToBucket(byProvider[message.provider], payload);
      const modelKey = `${message.provider}:${message.modelName}`;
      addToBucket((byModel[modelKey] ??= makeBucket()), payload);
    }
  }

  const byDay: UserCostBreakdown["byDay"] = Array.from(dayMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([yyyymmdd, bucket]) => ({ yyyymmdd, bucket }));

  return { total, byProvider, byModel, byFeature, byDay };
}

export const getViewerUsageSummary = query({
  args: {},
  handler: async (ctx): Promise<ViewerUsageSummary> => {
    const identity = await requireViewerIdentity(ctx);
    const untilMs = Date.now();
    const sinceMs = untilMs - VIEWER_USAGE_WINDOW_DAYS * MS_PER_DAY;
    const breakdown = await aggregateUserCostBreakdown(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      sinceMs,
      untilMs,
    });
    const dailyBudget = await peekSandboxDailyCostForUser(ctx, identity.tokenIdentifier);
    const usedCents = Math.max(0, dailyBudget.capacityCents - dailyBudget.remainingCents);

    return {
      window: {
        sinceMs,
        untilMs,
        days: VIEWER_USAGE_WINDOW_DAYS,
      },
      totals: {
        costUsd: breakdown.total.usd,
        events: breakdown.total.count,
        totalTokens: tokenTotal(breakdown.total),
        inputTokens: breakdown.total.inputTokens,
        outputTokens: breakdown.total.outputTokens,
        cachedInputTokens: breakdown.total.cachedInputTokens,
        cacheWriteTokens: breakdown.total.cacheWriteTokens,
        reasoningTokens: breakdown.total.reasoningTokens,
      },
      byFeature: {
        chat: summarizeBucket(breakdown.byFeature.chat),
        systemDesign: summarizeBucket(breakdown.byFeature.systemDesign),
      },
      sandboxDailyBudget: {
        usedUsd: usedCents / 100,
        remainingUsd: dailyBudget.remainingCents / 100,
        capacityUsd: dailyBudget.capacityCents / 100,
        resetAtMs: dailyBudget.resetAtMs,
      },
    };
  },
});

/**
 * Aggregate a single user's LLM spend across an arbitrary time window.
 *
 * `sinceMs` is inclusive; `untilMs` is exclusive (defaults to "now").
 * Both are wall-clock milliseconds. The window is bounded so a
 * runaway-large query (`sinceMs: 0`) on a busy user still scans only
 * their own slice via the per-owner index — but the in-memory totals
 * still grow O(rows).
 */
export const getUserCostBreakdown = internalQuery({
  args: {
    ownerTokenIdentifier: v.string(),
    sinceMs: v.number(),
    untilMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<UserCostBreakdown> => {
    return await aggregateUserCostBreakdown(ctx, args);
  },
});

/**
 * Test-only export of the bucket primitives so vitest can verify
 * aggregation arithmetic without spinning up a Convex backend.
 */
export const TEST_INTERNALS = {
  makeBucket,
  addToBucket,
  utcDayKey,
  tokenTotal,
} as const;
