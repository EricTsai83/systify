/**
 * System Design generator telemetry rollup.
 *
 * Reads append-only `systemDesignKindRuns` rows and returns the
 * observability surface the operator needs to answer questions like:
 *
 *   - "Which kinds are failing right now, and which failure category
 *      dominates (transport vs. quality vs. infra)?"
 *   - "After bumping `SYSTEM_DESIGN_PROMPT_VERSIONS[architecture_overview]`
 *      from 1 → 2, did the cost per success go up or down?"
 *   - "What share of attempts hit the artifact cache vs. ran the LLM?"
 *
 * Drives the `bun run report:system-design` CLI in
 * `scripts/reportSystemDesign.ts`. PR-C will extend this with
 * `aggregate.ts` and `eval:diff <sha-a> <sha-b>` on top of the same
 * `systemDesignKindRuns` source — `report.ts` stays focused on the
 * single-window operator rollup; cross-window diff arithmetic lives
 * with the eval harness next door.
 *
 * Index usage: the optional `(kind, provider, modelName)` filter uses
 * `by_kind_provider_model_and_startedAt` for a tight indexed scan.
 * The unfiltered / partial-filter path does a `collect()` over the
 * full table — acceptable today (one row per System Design kind
 * attempt; tens of thousands per month at full single-tenant load),
 * not appropriate when multi-user load grows. PR-C will add a
 * `by_startedAt` index if the rollup becomes hot.
 */

import { v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../_generated/server";
import { llmProviderValidator, type LlmProvider } from "../../lib/llmProvider";
import { systemDesignKindValidator, type SystemDesignKind } from "../../lib/systemDesign";

/** Status union mirrors `kindRunStatus` in `convex/schema.ts`. */
type KindRunStatus = "succeeded" | "failed" | "cached_hit" | "quality_rejected";

/**
 * Per-bucket accumulator. Shared across every grouping dimension so the
 * report consumer (CLI today, future eval HTML report) can iterate over
 * `byKind`, `byProviderModel`, etc. with one shape.
 *
 * `succeededRuns` / `failedRuns` count rows by terminal status; the
 * sums include `cached_hit` runs (no LLM call → zero cost / tokens) so
 * the rollup answers "what happened" in addition to "what cost money".
 */
export interface KindRunBucket {
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  cachedHitRuns: number;
  qualityRejectedRuns: number;
  /**
   * Mean step count across every run that recorded steps (cache hits
   * contribute zero by definition; `recordKindRun` writes `actualSteps:
   * 0` for them). NaN-safe — `meanSteps === 0` when `totalRuns === 0`.
   */
  meanSteps: number;
  /** Sum of `actualSteps`; useful for computing mean externally. */
  totalSteps: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  /** Sum of `durationMs`; mean = `totalDurationMs / totalRuns`. */
  totalDurationMs: number;
}

export interface KindRunStats {
  /**
   * Window summary echoed back so the consumer can render a header
   * without re-parsing the CLI args.
   */
  windowStart: number;
  windowEnd: number;
  windowDays: number;
  total: KindRunBucket;
  byStatus: Record<KindRunStatus, KindRunBucket>;
  /** Keyed by `SystemDesignKind` literal. */
  byKind: Record<string, KindRunBucket>;
  /** Keyed by `${provider}:${modelName}` for stable lookup. */
  byProviderModel: Record<string, KindRunBucket>;
  /**
   * Per-failure-reason rollup over `failed` and `quality_rejected`
   * rows. Lets the operator answer "what's the dominant failure
   * category right now?" without parsing every row.
   *
   * Keys correspond to `kindFailureReason` literals plus the
   * synthetic `"unknown"` bucket for rows whose `failureReason` is
   * absent (legacy rows / rows where the reason couldn't be
   * categorised at write time).
   */
  byFailureReason: Record<string, KindRunBucket>;
}

function makeBucket(): KindRunBucket {
  return {
    totalRuns: 0,
    succeededRuns: 0,
    failedRuns: 0,
    cachedHitRuns: 0,
    qualityRejectedRuns: 0,
    meanSteps: 0,
    totalSteps: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 0,
    totalDurationMs: 0,
  };
}

type RunRowLike = Pick<
  Doc<"systemDesignKindRuns">,
  | "status"
  | "actualSteps"
  | "totalCostUsd"
  | "inputTokens"
  | "outputTokens"
  | "cachedInputTokens"
  | "cacheWriteTokens"
  | "reasoningTokens"
  | "durationMs"
>;

function addRun(bucket: KindRunBucket, row: RunRowLike): void {
  bucket.totalRuns += 1;
  switch (row.status) {
    case "succeeded":
      bucket.succeededRuns += 1;
      break;
    case "failed":
      bucket.failedRuns += 1;
      break;
    case "cached_hit":
      bucket.cachedHitRuns += 1;
      break;
    case "quality_rejected":
      bucket.qualityRejectedRuns += 1;
      break;
  }
  bucket.totalSteps += row.actualSteps;
  // Skip non-finite OR negative cost. A negative `totalCostUsd` would
  // be a writer bug — surface as "nothing added" rather than letting
  // the rollup go negative and confuse the dashboard.
  bucket.totalCostUsd +=
    row.totalCostUsd && Number.isFinite(row.totalCostUsd) && row.totalCostUsd > 0 ? row.totalCostUsd : 0;
  bucket.totalInputTokens += row.inputTokens ?? 0;
  bucket.totalOutputTokens += row.outputTokens ?? 0;
  bucket.totalCachedInputTokens += row.cachedInputTokens ?? 0;
  bucket.totalCacheWriteTokens += row.cacheWriteTokens ?? 0;
  bucket.totalReasoningTokens += row.reasoningTokens ?? 0;
  bucket.totalDurationMs += row.durationMs;
}

function finalizeBucket(bucket: KindRunBucket): void {
  bucket.meanSteps = bucket.totalRuns > 0 ? bucket.totalSteps / bucket.totalRuns : 0;
}

const DEFAULT_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Aggregate `systemDesignKindRuns` rows in a sliding time window.
 *
 * Default window: last 7 days. Pass `windowDays: 30` for monthly
 * rollups. The `until` argument is exclusive and defaults to "now";
 * passing it explicitly lets eval scripts roll up a frozen historical
 * window without race conditions.
 *
 * Optional filters compose: `kind`, `provider`, `modelName` narrow the
 * scanned rows. Without filters every row in the window is included —
 * useful for "what's happening right now" overviews.
 */
export const aggregateRunStats = internalQuery({
  args: {
    windowDays: v.optional(v.number()),
    until: v.optional(v.number()),
    kind: v.optional(systemDesignKindValidator),
    provider: v.optional(llmProviderValidator),
    modelName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<KindRunStats> => {
    const windowDays = args.windowDays && args.windowDays > 0 ? args.windowDays : DEFAULT_WINDOW_DAYS;
    const windowEnd = args.until ?? Date.now();
    const windowStart = windowEnd - windowDays * MS_PER_DAY;

    const rows = await collectRowsInWindow(ctx, {
      windowStart,
      windowEnd,
      kind: args.kind,
      provider: args.provider,
      modelName: args.modelName,
    });

    const total = makeBucket();
    const byStatus: Record<KindRunStatus, KindRunBucket> = {
      succeeded: makeBucket(),
      failed: makeBucket(),
      cached_hit: makeBucket(),
      quality_rejected: makeBucket(),
    };
    const byKind: Record<string, KindRunBucket> = {};
    const byProviderModel: Record<string, KindRunBucket> = {};
    const byFailureReason: Record<string, KindRunBucket> = {};

    for (const row of rows) {
      addRun(total, row);
      addRun(byStatus[row.status], row);
      const kindBucket = (byKind[row.kind] ??= makeBucket());
      addRun(kindBucket, row);
      const pmKey = `${row.provider}:${row.modelName}`;
      const pmBucket = (byProviderModel[pmKey] ??= makeBucket());
      addRun(pmBucket, row);
      if (row.status === "failed" || row.status === "quality_rejected") {
        const reasonKey = row.failureReason ?? "unknown";
        const reasonBucket = (byFailureReason[reasonKey] ??= makeBucket());
        addRun(reasonBucket, row);
      }
    }

    finalizeBucket(total);
    for (const bucket of Object.values(byStatus)) finalizeBucket(bucket);
    for (const bucket of Object.values(byKind)) finalizeBucket(bucket);
    for (const bucket of Object.values(byProviderModel)) finalizeBucket(bucket);
    for (const bucket of Object.values(byFailureReason)) finalizeBucket(bucket);

    return {
      windowStart,
      windowEnd,
      windowDays,
      total,
      byStatus,
      byKind,
      byProviderModel,
      byFailureReason,
    };
  },
});

/**
 * Pull the window of `systemDesignKindRuns` rows the rollup will fold
 * over. When all three filters are supplied the
 * `by_kind_provider_model_and_startedAt` index is used directly — a
 * tight indexed range scan, no in-memory filtering. When any filter is
 * missing, fall back to a `collect()` over the entire table and filter
 * in memory; acceptable at PR-B's data volumes (one row per System
 * Design kind attempt). PR-C will introduce a `by_startedAt` index if
 * the unfiltered scan becomes hot.
 */
async function collectRowsInWindow(
  ctx: QueryCtx,
  args: {
    windowStart: number;
    windowEnd: number;
    kind?: SystemDesignKind;
    provider?: LlmProvider;
    modelName?: string;
  },
): Promise<Doc<"systemDesignKindRuns">[]> {
  if (args.kind && args.provider && args.modelName) {
    const kind = args.kind;
    const provider = args.provider;
    const modelName = args.modelName;
    return await ctx.db
      .query("systemDesignKindRuns")
      .withIndex("by_kind_provider_model_and_startedAt", (q) =>
        q
          .eq("kind", kind)
          .eq("provider", provider)
          .eq("modelName", modelName)
          .gte("startedAt", args.windowStart)
          .lt("startedAt", args.windowEnd),
      )
      .collect();
  }

  // No tight prefix — fall back to a full table scan with in-memory
  // filtering. Self-documenting cost: every dimension we DIDN'T filter
  // on still needs to be considered as a candidate for inclusion.
  const all = await ctx.db.query("systemDesignKindRuns").collect();
  return all.filter((row) => {
    if (row.startedAt < args.windowStart || row.startedAt >= args.windowEnd) return false;
    if (args.kind && row.kind !== args.kind) return false;
    if (args.provider && row.provider !== args.provider) return false;
    if (args.modelName && row.modelName !== args.modelName) return false;
    return true;
  });
}

/**
 * Test-only exports so vitest can verify bucket arithmetic without
 * spinning up a Convex backend.
 */
export const TEST_INTERNALS = {
  makeBucket,
  addRun,
  finalizeBucket,
} as const;
