/**
 * Per-user provider-cost monitoring.
 *
 * Viewer-facing reads are served from bounded rollup tables. Raw chat
 * messages / System Design kind rows remain useful for CLI forensics, but
 * the Settings surface never scans them.
 */

import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requireViewerIdentity } from "./auth";
import { peekSandboxDailyCostForUser } from "./rateLimit";
import type { LlmProvider } from "./llmProvider";

const VIEWER_USAGE_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USAGE_ROLLUP_SHARD_COUNT = 16;
const USAGE_HISTORY_PERIODS = 12;
const USAGE_FEATURES = ["chat", "systemDesign", "artifactIndexing", "libraryRetrieval", "titleGeneration"] as const;
const USAGE_ROLLUP_FEATURE_COUNT = USAGE_FEATURES.length;
const MAX_ROLLUP_ROWS_PER_PERIOD = USAGE_ROLLUP_FEATURE_COUNT * USAGE_ROLLUP_SHARD_COUNT;
const VIEWER_USAGE_ROLLUP_MAX_ROWS = VIEWER_USAGE_WINDOW_DAYS * MAX_ROLLUP_ROWS_PER_PERIOD;
const VIEWER_USAGE_HISTORY_MAX_ROWS = USAGE_HISTORY_PERIODS * MAX_ROLLUP_ROWS_PER_PERIOD * 2;
const USAGE_TOTALS_MAX_ROWS = MAX_ROLLUP_ROWS_PER_PERIOD;
const DEFAULT_CYCLE_ANCHOR_DAY = 1;
const DEFAULT_TIME_ZONE = "UTC";

export const CHAT_REPLY_BUDGET_ESTIMATE_USD = 0.05;
export const SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD = 0.1;
export const ARTIFACT_INDEXING_BATCH_BUDGET_ESTIMATE_USD = 0.01;
export const LIBRARY_RETRIEVAL_BUDGET_ESTIMATE_USD = 0.001;
export const TITLE_GENERATION_BUDGET_ESTIMATE_USD = 0.001;

export function isUsageBudgetExceededError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return false;
  }
  const data = error.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    return data.code === "USER_USAGE_BUDGET_EXCEEDED";
  }
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        "code" in parsed &&
        parsed.code === "USER_USAGE_BUDGET_EXCEEDED"
      );
    } catch {
      return false;
    }
  }
  return false;
}

const usageFeatureValidator = v.union(
  v.literal("chat"),
  v.literal("systemDesign"),
  v.literal("artifactIndexing"),
  v.literal("libraryRetrieval"),
  v.literal("titleGeneration"),
);

export type UsageFeature = (typeof USAGE_FEATURES)[number];

interface EffectiveUsageProfile {
  cycleAnchorDay: number;
  timeZone: string;
  budgetUsd: number | null;
  hardCapEnabled: boolean;
}

interface UsagePeriod {
  periodKey: string;
  periodStartMs: number;
  periodEndMs: number;
  cycleAnchorDay: number;
  timeZone: string;
}

interface UsageDelta {
  costUsd: number;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

/**
 * Per-bucket money + token accumulator. Reused across every grouping
 * dimension so the shape stays consistent for downstream consumers.
 */
export interface CostBucket {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  count: number;
}

export interface UsageFeatureSummary {
  costUsd: number;
  events: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface UsageBucketSummary extends UsageFeatureSummary {
  byFeature: Record<UsageFeature, UsageFeatureSummary>;
}

export interface UsagePeriodSummary extends UsageBucketSummary {
  periodKey: string;
  periodStartMs: number;
  periodEndMs: number;
  cycleAnchorDay: number;
  timeZone: string;
}

export interface UserCostBreakdown {
  total: CostBucket;
  byProvider: Record<LlmProvider, CostBucket>;
  byModel: Record<string, CostBucket>;
  byFeature: Record<UsageFeature, CostBucket>;
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

function makeFeatureBuckets(): Record<UsageFeature, CostBucket> {
  return {
    chat: makeBucket(),
    systemDesign: makeBucket(),
    artifactIndexing: makeBucket(),
    libraryRetrieval: makeBucket(),
    titleGeneration: makeBucket(),
  };
}

function positiveFiniteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function eventCountOrDefault(value: number | undefined): number {
  if (value === undefined) return 1;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function addToBucket(
  bucket: CostBucket,
  args: {
    usd?: number;
    count?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  },
): void {
  bucket.count += eventCountOrDefault(args.count);
  bucket.usd += positiveFiniteOrZero(args.usd);
  bucket.inputTokens += positiveFiniteOrZero(args.inputTokens);
  bucket.outputTokens += positiveFiniteOrZero(args.outputTokens);
  bucket.cachedInputTokens += positiveFiniteOrZero(args.cachedInputTokens);
  bucket.cacheWriteTokens += positiveFiniteOrZero(args.cacheWriteTokens);
  bucket.reasoningTokens += positiveFiniteOrZero(args.reasoningTokens);
}

function utcDayKey(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function utcDayStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function addUtcDays(dayStartMs: number, days: number): number {
  return dayStartMs + days * MS_PER_DAY;
}

function stableShardForKey(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % USAGE_ROLLUP_SHARD_COUNT;
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

function hasRecordableUsage(args: {
  usd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): boolean {
  return (
    positiveFiniteOrZero(args.usd) > 0 ||
    positiveFiniteOrZero(args.inputTokens) > 0 ||
    positiveFiniteOrZero(args.outputTokens) > 0 ||
    positiveFiniteOrZero(args.cachedInputTokens) > 0 ||
    positiveFiniteOrZero(args.cacheWriteTokens) > 0 ||
    positiveFiniteOrZero(args.reasoningTokens) > 0
  );
}

function summarizeFeatureBucket(bucket: CostBucket): UsageFeatureSummary {
  return {
    costUsd: bucket.usd,
    events: bucket.count,
    totalTokens: tokenTotal(bucket),
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cachedInputTokens: bucket.cachedInputTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    reasoningTokens: bucket.reasoningTokens,
  };
}

function summarizeBucket(total: CostBucket, byFeature: Record<UsageFeature, CostBucket>): UsageBucketSummary {
  return {
    ...summarizeFeatureBucket(total),
    byFeature: {
      chat: summarizeFeatureBucket(byFeature.chat),
      systemDesign: summarizeFeatureBucket(byFeature.systemDesign),
      artifactIndexing: summarizeFeatureBucket(byFeature.artifactIndexing),
      libraryRetrieval: summarizeFeatureBucket(byFeature.libraryRetrieval),
      titleGeneration: summarizeFeatureBucket(byFeature.titleGeneration),
    },
  };
}

function emptyPeriodSummary(period: UsagePeriod): UsagePeriodSummary {
  const total = makeBucket();
  return {
    periodKey: period.periodKey,
    periodStartMs: period.periodStartMs,
    periodEndMs: period.periodEndMs,
    cycleAnchorDay: period.cycleAnchorDay,
    timeZone: period.timeZone,
    ...summarizeBucket(total, makeFeatureBuckets()),
  };
}

function makeDelta(args: {
  usd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): UsageDelta {
  return {
    costUsd: positiveFiniteOrZero(args.usd),
    events: 1,
    inputTokens: positiveFiniteOrZero(args.inputTokens),
    outputTokens: positiveFiniteOrZero(args.outputTokens),
    cachedInputTokens: positiveFiniteOrZero(args.cachedInputTokens),
    cacheWriteTokens: positiveFiniteOrZero(args.cacheWriteTokens),
    reasoningTokens: positiveFiniteOrZero(args.reasoningTokens),
  };
}

function periodKey(periodStartMs: number, periodEndMs: number): string {
  return `${periodStartMs}:${periodEndMs}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addLocalMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta;
  return {
    year: Math.floor(zeroBased / 12),
    month: (zeroBased % 12) + 1,
  };
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = zonedFormatters.get(timeZone);
  if (existing) {
    return existing;
  }
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  zonedFormatters.set(timeZone, formatter);
  return formatter;
}

function getZonedParts(
  ms: number,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = getZonedFormatter(timeZone).formatToParts(new Date(ms));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localDateTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desiredAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedParts(guess, timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const diff = desiredAsUtc - actualAsUtc;
    if (diff === 0) {
      return guess;
    }
    guess += diff;
  }

  return guess;
}

function cycleBoundaryForLocalMonth(profile: EffectiveUsageProfile, year: number, month: number): number {
  const anchorDay = Math.min(profile.cycleAnchorDay, daysInMonth(year, month));
  return localDateTimeToUtcMs(profile.timeZone, year, month, anchorDay);
}

function getUsagePeriodForMs(ms: number, profile: EffectiveUsageProfile): UsagePeriod {
  const local = getZonedParts(ms, profile.timeZone);
  let startYear = local.year;
  let startMonth = local.month;
  let startMs = cycleBoundaryForLocalMonth(profile, startYear, startMonth);

  if (ms < startMs) {
    const previous = addLocalMonths(startYear, startMonth, -1);
    startYear = previous.year;
    startMonth = previous.month;
    startMs = cycleBoundaryForLocalMonth(profile, startYear, startMonth);
  }

  const next = addLocalMonths(startYear, startMonth, 1);
  const endMs = cycleBoundaryForLocalMonth(profile, next.year, next.month);
  return {
    periodKey: periodKey(startMs, endMs),
    periodStartMs: startMs,
    periodEndMs: endMs,
    cycleAnchorDay: profile.cycleAnchorDay,
    timeZone: profile.timeZone,
  };
}

function getPreviousUsagePeriod(profile: EffectiveUsageProfile, period: UsagePeriod): UsagePeriod {
  const localStart = getZonedParts(period.periodStartMs, profile.timeZone);
  const previous = addLocalMonths(localStart.year, localStart.month, -1);
  const startMs = cycleBoundaryForLocalMonth(profile, previous.year, previous.month);
  const endMs = period.periodStartMs;
  return {
    periodKey: periodKey(startMs, endMs),
    periodStartMs: startMs,
    periodEndMs: endMs,
    cycleAnchorDay: profile.cycleAnchorDay,
    timeZone: profile.timeZone,
  };
}

function getUsageHistoryPeriods(profile: EffectiveUsageProfile, currentPeriod: UsagePeriod): UsagePeriod[] {
  const periods: UsagePeriod[] = [];
  let cursor = currentPeriod;
  for (let index = 0; index < USAGE_HISTORY_PERIODS; index += 1) {
    periods.push(cursor);
    cursor = getPreviousUsagePeriod(profile, cursor);
  }
  return periods;
}

function normalizeTimeZone(timeZone: string): string | null {
  const trimmed = timeZone.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function validateCycleAnchorDay(cycleAnchorDay: number): number {
  if (!Number.isInteger(cycleAnchorDay) || cycleAnchorDay < 1 || cycleAnchorDay > 31) {
    throw new ConvexError({
      code: "INVALID_USAGE_PROFILE",
      message: "Cycle anchor day must be an integer from 1 through 31.",
    });
  }
  return cycleAnchorDay;
}

function validateBudgetUsd(budgetUsd: number | null): number | null {
  if (budgetUsd === null) {
    return null;
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0.01 || budgetUsd > 10_000) {
    throw new ConvexError({
      code: "INVALID_USAGE_PROFILE",
      message: "Budget must be a finite USD amount from 0.01 through 10000, or blank.",
    });
  }
  return budgetUsd;
}

async function getViewerUsageProfile(
  ctx: QueryCtx | MutationCtx,
  ownerTokenIdentifier: string,
): Promise<EffectiveUsageProfile> {
  const profile = await ctx.db
    .query("userUsageProfiles")
    .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
    .unique();

  if (!profile) {
    return {
      cycleAnchorDay: DEFAULT_CYCLE_ANCHOR_DAY,
      timeZone: DEFAULT_TIME_ZONE,
      budgetUsd: null,
      hardCapEnabled: false,
    };
  }

  return {
    cycleAnchorDay: profile.cycleAnchorDay,
    timeZone: profile.timeZone,
    budgetUsd: profile.budgetUsd ?? null,
    hardCapEnabled: profile.hardCapEnabled,
  };
}

async function upsertDailyRollup(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    yyyymmdd: string;
    feature: UsageFeature;
    shard: number;
    delta: UsageDelta;
    now: number;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("userUsageDailyRollups")
    .withIndex("by_ownerTokenIdentifier_and_yyyymmdd_and_feature_and_shard", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .eq("yyyymmdd", args.yyyymmdd)
        .eq("feature", args.feature)
        .eq("shard", args.shard),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      costUsd: existing.costUsd + args.delta.costUsd,
      events: existing.events + args.delta.events,
      inputTokens: existing.inputTokens + args.delta.inputTokens,
      outputTokens: existing.outputTokens + args.delta.outputTokens,
      cachedInputTokens: existing.cachedInputTokens + args.delta.cachedInputTokens,
      cacheWriteTokens: existing.cacheWriteTokens + args.delta.cacheWriteTokens,
      reasoningTokens: existing.reasoningTokens + args.delta.reasoningTokens,
      updatedAt: args.now,
    });
    return;
  }

  await ctx.db.insert("userUsageDailyRollups", {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    yyyymmdd: args.yyyymmdd,
    feature: args.feature,
    shard: args.shard,
    ...args.delta,
    updatedAt: args.now,
  });
}

async function upsertCycleRollup(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    period: UsagePeriod;
    feature: UsageFeature;
    shard: number;
    delta: UsageDelta;
    now: number;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("userUsageCycleRollups")
    .withIndex("by_ownerTokenIdentifier_and_periodKey_and_feature_and_shard", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .eq("periodKey", args.period.periodKey)
        .eq("feature", args.feature)
        .eq("shard", args.shard),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      costUsd: existing.costUsd + args.delta.costUsd,
      events: existing.events + args.delta.events,
      inputTokens: existing.inputTokens + args.delta.inputTokens,
      outputTokens: existing.outputTokens + args.delta.outputTokens,
      cachedInputTokens: existing.cachedInputTokens + args.delta.cachedInputTokens,
      cacheWriteTokens: existing.cacheWriteTokens + args.delta.cacheWriteTokens,
      reasoningTokens: existing.reasoningTokens + args.delta.reasoningTokens,
      updatedAt: args.now,
    });
    return;
  }

  await ctx.db.insert("userUsageCycleRollups", {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    periodKey: args.period.periodKey,
    periodStartMs: args.period.periodStartMs,
    periodEndMs: args.period.periodEndMs,
    cycleAnchorDay: args.period.cycleAnchorDay,
    timeZone: args.period.timeZone,
    feature: args.feature,
    shard: args.shard,
    ...args.delta,
    updatedAt: args.now,
  });
}

async function upsertUsageTotal(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    feature: UsageFeature;
    shard: number;
    delta: UsageDelta;
    now: number;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("userUsageTotals")
    .withIndex("by_ownerTokenIdentifier_and_feature_and_shard", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("feature", args.feature).eq("shard", args.shard),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      costUsd: existing.costUsd + args.delta.costUsd,
      events: existing.events + args.delta.events,
      inputTokens: existing.inputTokens + args.delta.inputTokens,
      outputTokens: existing.outputTokens + args.delta.outputTokens,
      cachedInputTokens: existing.cachedInputTokens + args.delta.cachedInputTokens,
      cacheWriteTokens: existing.cacheWriteTokens + args.delta.cacheWriteTokens,
      reasoningTokens: existing.reasoningTokens + args.delta.reasoningTokens,
      updatedAt: args.now,
    });
    return;
  }

  await ctx.db.insert("userUsageTotals", {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: args.feature,
    shard: args.shard,
    ...args.delta,
    updatedAt: args.now,
  });
}

async function getBudgetPeriod(ctx: QueryCtx | MutationCtx, ownerTokenIdentifier: string, periodKeyValue: string) {
  return await ctx.db
    .query("userUsageBudgetPeriods")
    .withIndex("by_ownerTokenIdentifier_and_periodKey", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("periodKey", periodKeyValue),
    )
    .unique();
}

async function upsertBudgetPeriod(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    period: UsagePeriod;
    budgetUsd: number;
    spentUsd?: number;
    reservedUsd?: number;
    now: number;
  },
) {
  const existing = await getBudgetPeriod(ctx, args.ownerTokenIdentifier, args.period.periodKey);
  if (existing) {
    const nextReservedUsd = args.reservedUsd ?? existing.reservedUsd;
    const nextSpentUsd = args.spentUsd ?? existing.spentUsd;
    await ctx.db.patch(existing._id, {
      budgetUsd: args.budgetUsd,
      spentUsd: nextSpentUsd,
      reservedUsd: Math.max(0, nextReservedUsd),
      updatedAt: args.now,
    });
    return {
      ...existing,
      budgetUsd: args.budgetUsd,
      spentUsd: nextSpentUsd,
      reservedUsd: Math.max(0, nextReservedUsd),
    };
  }

  const id = await ctx.db.insert("userUsageBudgetPeriods", {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    periodKey: args.period.periodKey,
    periodStartMs: args.period.periodStartMs,
    periodEndMs: args.period.periodEndMs,
    budgetUsd: args.budgetUsd,
    spentUsd: args.spentUsd ?? 0,
    reservedUsd: Math.max(0, args.reservedUsd ?? 0),
    createdAt: args.now,
    updatedAt: args.now,
  });
  return await ctx.db.get(id);
}

function addRollupRowToBuckets(
  total: CostBucket,
  byFeature: Record<UsageFeature, CostBucket>,
  row: {
    feature: UsageFeature;
    events: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  },
) {
  const payload = {
    count: row.events,
    usd: row.costUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
  };
  addToBucket(total, payload);
  addToBucket(byFeature[row.feature], payload);
}

async function aggregateCyclePeriod(
  ctx: QueryCtx | MutationCtx,
  ownerTokenIdentifier: string,
  periodKeyValue: string,
): Promise<UsageBucketSummary> {
  const total = makeBucket();
  const byFeature = makeFeatureBuckets();
  const rows = await ctx.db
    .query("userUsageCycleRollups")
    .withIndex("by_ownerTokenIdentifier_and_periodKey_and_feature_and_shard", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("periodKey", periodKeyValue),
    )
    .take(MAX_ROLLUP_ROWS_PER_PERIOD + 1);

  if (rows.length > MAX_ROLLUP_ROWS_PER_PERIOD) {
    throw new Error("Usage cycle rollup cardinality invariant exceeded");
  }

  for (const row of rows) {
    addRollupRowToBuckets(total, byFeature, row);
  }
  return summarizeBucket(total, byFeature);
}

async function settleBudgetReservation(
  ctx: MutationCtx,
  args: {
    sourceId: string;
    actualCostUsd: number;
    now: number;
  },
): Promise<boolean> {
  const reservation = await ctx.db
    .query("userUsageBudgetReservations")
    .withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId))
    .unique();

  if (!reservation || reservation.status !== "reserved") {
    return false;
  }

  const budgetPeriod = await getBudgetPeriod(ctx, reservation.ownerTokenIdentifier, reservation.periodKey);
  if (budgetPeriod) {
    await ctx.db.patch(budgetPeriod._id, {
      spentUsd: Math.max(0, budgetPeriod.spentUsd + args.actualCostUsd),
      reservedUsd: Math.max(0, budgetPeriod.reservedUsd - reservation.estimatedCostUsd),
      updatedAt: args.now,
    });
  }

  await ctx.db.patch(reservation._id, {
    actualCostUsd: args.actualCostUsd,
    status: args.actualCostUsd > 0 ? "settled" : "released",
    updatedAt: args.now,
  });
  return true;
}

function throwUsageBudgetExceeded(args: {
  period: UsagePeriod;
  budgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  estimatedCostUsd: number;
}): never {
  throw new ConvexError({
    code: "USER_USAGE_BUDGET_EXCEEDED",
    message: "Usage budget reached for the current cycle.",
    periodStartMs: args.period.periodStartMs,
    periodEndMs: args.period.periodEndMs,
    budgetUsd: args.budgetUsd,
    spentUsd: args.spentUsd,
    reservedUsd: args.reservedUsd,
    estimatedCostUsd: args.estimatedCostUsd,
  });
}

export async function reserveUserUsageBudget(
  ctx: MutationCtx,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    feature: UsageFeature;
    estimatedCostUsd: number;
    occurredAtMs: number;
  },
): Promise<{ reserved: boolean; periodKey: string | null }> {
  const sourceId = args.sourceId.trim();
  if (!sourceId) {
    throw new Error("Usage budget reservation sourceId must be non-empty");
  }
  const estimatedCostUsd = positiveFiniteOrZero(args.estimatedCostUsd);
  if (estimatedCostUsd <= 0) {
    return { reserved: false, periodKey: null };
  }

  const profile = await getViewerUsageProfile(ctx, args.ownerTokenIdentifier);
  if (profile.budgetUsd === null) {
    return { reserved: false, periodKey: null };
  }

  const period = getUsagePeriodForMs(args.occurredAtMs, profile);
  const existingReservation = await ctx.db
    .query("userUsageBudgetReservations")
    .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
    .unique();
  if (existingReservation) {
    return { reserved: existingReservation.status === "reserved", periodKey: existingReservation.periodKey };
  }

  const [budgetPeriod, periodUsage] = await Promise.all([
    getBudgetPeriod(ctx, args.ownerTokenIdentifier, period.periodKey),
    aggregateCyclePeriod(ctx, args.ownerTokenIdentifier, period.periodKey),
  ]);
  const spentUsd = Math.max(budgetPeriod?.spentUsd ?? 0, periodUsage.costUsd);
  const reservedUsd = budgetPeriod?.reservedUsd ?? 0;

  if (profile.hardCapEnabled && spentUsd + reservedUsd + estimatedCostUsd > profile.budgetUsd) {
    throwUsageBudgetExceeded({
      period,
      budgetUsd: profile.budgetUsd,
      spentUsd,
      reservedUsd,
      estimatedCostUsd,
    });
  }

  const now = Date.now();
  await upsertBudgetPeriod(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    period,
    budgetUsd: profile.budgetUsd,
    spentUsd,
    reservedUsd: reservedUsd + estimatedCostUsd,
    now,
  });
  await ctx.db.insert("userUsageBudgetReservations", {
    sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    periodKey: period.periodKey,
    feature: args.feature,
    estimatedCostUsd,
    status: "reserved",
    createdAt: now,
    updatedAt: now,
  });

  return { reserved: true, periodKey: period.periodKey };
}

export async function assertUserUsageBudgetAvailable(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    feature: UsageFeature;
    estimatedCostUsd: number;
    occurredAtMs: number;
  },
): Promise<void> {
  const estimatedCostUsd = positiveFiniteOrZero(args.estimatedCostUsd);
  if (estimatedCostUsd <= 0) {
    return;
  }

  const profile = await getViewerUsageProfile(ctx, args.ownerTokenIdentifier);
  if (profile.budgetUsd === null) {
    return;
  }

  const period = getUsagePeriodForMs(args.occurredAtMs, profile);
  const [budgetPeriod, periodUsage] = await Promise.all([
    getBudgetPeriod(ctx, args.ownerTokenIdentifier, period.periodKey),
    aggregateCyclePeriod(ctx, args.ownerTokenIdentifier, period.periodKey),
  ]);
  const spentUsd = Math.max(budgetPeriod?.spentUsd ?? 0, periodUsage.costUsd);
  const reservedUsd = budgetPeriod?.reservedUsd ?? 0;

  if (profile.hardCapEnabled && spentUsd + reservedUsd + estimatedCostUsd > profile.budgetUsd) {
    throwUsageBudgetExceeded({
      period,
      budgetUsd: profile.budgetUsd,
      spentUsd,
      reservedUsd,
      estimatedCostUsd,
    });
  }
}

export async function recordUserUsageEvent(
  ctx: MutationCtx,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    feature: UsageFeature;
    occurredAtMs: number;
    usd?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  },
): Promise<boolean> {
  const sourceId = args.sourceId.trim();
  if (!sourceId) {
    throw new Error("Usage rollup sourceId must be non-empty");
  }

  const now = Date.now();
  if (!hasRecordableUsage(args)) {
    await settleBudgetReservation(ctx, { sourceId, actualCostUsd: 0, now });
    return false;
  }

  const existingEvent = await ctx.db
    .query("userUsageEvents")
    .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
    .unique();
  if (existingEvent) {
    return false;
  }

  const profile = await getViewerUsageProfile(ctx, args.ownerTokenIdentifier);
  const usagePeriod = getUsagePeriodForMs(args.occurredAtMs, profile);
  const yyyymmdd = utcDayKey(args.occurredAtMs);
  const shard = stableShardForKey(sourceId);
  const delta = makeDelta(args);

  await ctx.db.insert("userUsageEvents", {
    sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    yyyymmdd,
    feature: args.feature,
    shard,
    costUsd: delta.costUsd,
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    cachedInputTokens: delta.cachedInputTokens,
    cacheWriteTokens: delta.cacheWriteTokens,
    reasoningTokens: delta.reasoningTokens,
    createdAt: now,
  });

  await upsertDailyRollup(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    yyyymmdd,
    feature: args.feature,
    shard,
    delta,
    now,
  });
  await upsertCycleRollup(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    period: usagePeriod,
    feature: args.feature,
    shard,
    delta,
    now,
  });
  await upsertUsageTotal(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: args.feature,
    shard,
    delta,
    now,
  });

  const settledReservation = await settleBudgetReservation(ctx, {
    sourceId,
    actualCostUsd: delta.costUsd,
    now,
  });

  if (profile.budgetUsd !== null && !settledReservation) {
    const budgetPeriod = await getBudgetPeriod(ctx, args.ownerTokenIdentifier, usagePeriod.periodKey);
    if (!budgetPeriod) {
      await upsertBudgetPeriod(ctx, {
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        period: usagePeriod,
        budgetUsd: profile.budgetUsd,
        spentUsd: delta.costUsd,
        reservedUsd: 0,
        now,
      });
    } else {
      await ctx.db.patch(budgetPeriod._id, {
        budgetUsd: profile.budgetUsd,
        spentUsd: budgetPeriod.spentUsd + delta.costUsd,
        updatedAt: now,
      });
    }
  }

  return true;
}

export const reserveUsageBudget = internalMutation({
  args: {
    sourceId: v.string(),
    ownerTokenIdentifier: v.string(),
    feature: usageFeatureValidator,
    estimatedCostUsd: v.number(),
    occurredAtMs: v.number(),
  },
  handler: async (ctx, args): Promise<{ reserved: boolean; periodKey: string | null }> => {
    return await reserveUserUsageBudget(ctx, args);
  },
});

export const recordUsageEvent = internalMutation({
  args: {
    sourceId: v.string(),
    ownerTokenIdentifier: v.string(),
    feature: usageFeatureValidator,
    occurredAtMs: v.number(),
    usd: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    await recordUserUsageEvent(ctx, args);
    return null;
  },
});

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
  const byFeature = makeFeatureBuckets();
  const dayMap = new Map<string, CostBucket>();
  const bucketForDay = (dayKey: string): CostBucket => {
    const existing = dayMap.get(dayKey);
    if (existing) return existing;
    const created = makeBucket();
    dayMap.set(dayKey, created);
    return created;
  };

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
    if (!hasRecordableUsage(payload)) {
      continue;
    }
    addToBucket(total, payload);
    addToBucket(byProvider[provider], payload);
    addToBucket((byModel[modelKey] ??= makeBucket()), payload);
    addToBucket(byFeature.systemDesign, payload);
    addToBucket(bucketForDay(dayKey), payload);
  }

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
    if (!hasRecordableUsage(payload)) {
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

async function aggregateViewerUsageRollups(
  ctx: QueryCtx,
  args: {
    ownerTokenIdentifier: string;
    sinceDay: string;
    untilDayExclusive: string;
  },
): Promise<Pick<UserCostBreakdown, "total" | "byFeature">> {
  const total = makeBucket();
  const byFeature = makeFeatureBuckets();

  const rows = await ctx.db
    .query("userUsageDailyRollups")
    .withIndex("by_ownerTokenIdentifier_and_yyyymmdd", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .gte("yyyymmdd", args.sinceDay)
        .lt("yyyymmdd", args.untilDayExclusive),
    )
    .take(VIEWER_USAGE_ROLLUP_MAX_ROWS + 1);

  if (rows.length > VIEWER_USAGE_ROLLUP_MAX_ROWS) {
    throw new Error("Usage rollup cardinality invariant exceeded");
  }

  for (const row of rows) {
    addRollupRowToBuckets(total, byFeature, row);
  }

  return { total, byFeature };
}

function applyPeriodRow(
  summaries: Map<string, { period: UsagePeriod; total: CostBucket; byFeature: Record<UsageFeature, CostBucket> }>,
  row: {
    periodKey: string;
    periodStartMs: number;
    periodEndMs: number;
    cycleAnchorDay: number;
    timeZone: string;
    feature: UsageFeature;
    events: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  },
) {
  let entry = summaries.get(row.periodKey);
  if (!entry) {
    entry = {
      period: {
        periodKey: row.periodKey,
        periodStartMs: row.periodStartMs,
        periodEndMs: row.periodEndMs,
        cycleAnchorDay: row.cycleAnchorDay,
        timeZone: row.timeZone,
      },
      total: makeBucket(),
      byFeature: makeFeatureBuckets(),
    };
    summaries.set(row.periodKey, entry);
  }
  addRollupRowToBuckets(entry.total, entry.byFeature, row);
}

function toPeriodSummary(entry: {
  period: UsagePeriod;
  total: CostBucket;
  byFeature: Record<UsageFeature, CostBucket>;
}): UsagePeriodSummary {
  return {
    periodKey: entry.period.periodKey,
    periodStartMs: entry.period.periodStartMs,
    periodEndMs: entry.period.periodEndMs,
    cycleAnchorDay: entry.period.cycleAnchorDay,
    timeZone: entry.period.timeZone,
    ...summarizeBucket(entry.total, entry.byFeature),
  };
}

async function aggregateUsageTotals(ctx: QueryCtx, ownerTokenIdentifier: string): Promise<UsageBucketSummary> {
  const total = makeBucket();
  const byFeature = makeFeatureBuckets();
  const rows = await ctx.db
    .query("userUsageTotals")
    .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
    .take(USAGE_TOTALS_MAX_ROWS + 1);

  if (rows.length > USAGE_TOTALS_MAX_ROWS) {
    throw new Error("Usage totals cardinality invariant exceeded");
  }

  for (const row of rows) {
    addRollupRowToBuckets(total, byFeature, row);
  }
  return summarizeBucket(total, byFeature);
}

function budgetState(configured: boolean, budgetUsd: number | null, usedUsd: number, reservedUsd: number) {
  if (!configured || budgetUsd === null) {
    return {
      remainingUsd: null,
      percentUsed: null,
      state: "unset" as const,
    };
  }
  const consumedUsd = usedUsd + reservedUsd;
  const percentUsed = budgetUsd > 0 ? (consumedUsd / budgetUsd) * 100 : 100;
  const state = percentUsed >= 100 ? "exceeded" : percentUsed >= 80 ? "warning" : percentUsed >= 50 ? "notice" : "ok";
  return {
    remainingUsd: Math.max(0, budgetUsd - consumedUsd),
    percentUsed,
    state,
  };
}

export const getViewerUsageDashboard = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    const ownerTokenIdentifier = identity.tokenIdentifier;
    const profile = await getViewerUsageProfile(ctx, ownerTokenIdentifier);
    const currentPeriod = getUsagePeriodForMs(Date.now(), profile);
    const historyPeriods = getUsageHistoryPeriods(profile, currentPeriod);
    const previousPeriodTemplate = historyPeriods[1] ?? null;
    const earliestStartMs = historyPeriods[historyPeriods.length - 1]?.periodStartMs ?? currentPeriod.periodStartMs;

    const summaryEntries = new Map<
      string,
      { period: UsagePeriod; total: CostBucket; byFeature: Record<UsageFeature, CostBucket> }
    >();
    for (const period of historyPeriods) {
      summaryEntries.set(period.periodKey, {
        period,
        total: makeBucket(),
        byFeature: makeFeatureBuckets(),
      });
    }

    const rows = await ctx.db
      .query("userUsageCycleRollups")
      .withIndex("by_ownerTokenIdentifier_and_periodStartMs", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier).gte("periodStartMs", earliestStartMs),
      )
      .take(VIEWER_USAGE_HISTORY_MAX_ROWS + 1);

    if (rows.length > VIEWER_USAGE_HISTORY_MAX_ROWS) {
      throw new Error("Usage history rollup cardinality invariant exceeded");
    }

    for (const row of rows) {
      applyPeriodRow(summaryEntries, row);
    }

    const summaries = Array.from(summaryEntries.values())
      .map(toPeriodSummary)
      .sort((left, right) => right.periodStartMs - left.periodStartMs);
    const currentSummary =
      summaries.find((summary) => summary.periodKey === currentPeriod.periodKey) ?? emptyPeriodSummary(currentPeriod);
    const previousSummary = previousPeriodTemplate
      ? (summaries.find((summary) => summary.periodKey === previousPeriodTemplate.periodKey) ??
        emptyPeriodSummary(previousPeriodTemplate))
      : null;
    const history = summaries.slice(0, USAGE_HISTORY_PERIODS);
    const allTime = await aggregateUsageTotals(ctx, ownerTokenIdentifier);
    const currentBudgetPeriod = await getBudgetPeriod(ctx, ownerTokenIdentifier, currentPeriod.periodKey);
    const configured = profile.budgetUsd !== null;
    const usedUsd = currentSummary.costUsd;
    const reservedUsd = configured ? (currentBudgetPeriod?.reservedUsd ?? 0) : 0;
    const state = budgetState(configured, profile.budgetUsd, usedUsd, reservedUsd);

    return {
      profile: {
        cycleAnchorDay: profile.cycleAnchorDay,
        timeZone: profile.timeZone,
        budgetUsd: profile.budgetUsd,
        hardCapEnabled: profile.hardCapEnabled,
      },
      currentPeriod: currentSummary,
      previousPeriod: previousSummary,
      allTime,
      history,
      budget: {
        configured,
        hardCapEnabled: profile.hardCapEnabled && configured,
        budgetUsd: profile.budgetUsd,
        usedUsd,
        reservedUsd,
        remainingUsd: state.remainingUsd,
        percentUsed: state.percentUsed,
        state: state.state,
      },
    };
  },
});

export const updateViewerUsageProfile = mutation({
  args: {
    cycleAnchorDay: v.number(),
    timeZone: v.string(),
    budgetUsd: v.union(v.number(), v.null()),
    hardCapEnabled: v.boolean(),
  },
  handler: async (ctx, args): Promise<null> => {
    const identity = await requireViewerIdentity(ctx);
    const cycleAnchorDay = validateCycleAnchorDay(args.cycleAnchorDay);
    const normalizedTimeZone = normalizeTimeZone(args.timeZone);
    if (normalizedTimeZone === null) {
      throw new ConvexError({
        code: "INVALID_USAGE_PROFILE",
        message: "Time zone must be a valid IANA time zone.",
      });
    }
    const budgetUsd = validateBudgetUsd(args.budgetUsd);
    const now = Date.now();
    const existing = await ctx.db
      .query("userUsageProfiles")
      .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", identity.tokenIdentifier))
      .unique();
    const patch = {
      cycleAnchorDay,
      timeZone: normalizedTimeZone,
      ...(budgetUsd === null ? { budgetUsd: undefined } : { budgetUsd }),
      hardCapEnabled: args.hardCapEnabled,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return null;
    }

    await ctx.db.insert("userUsageProfiles", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      cycleAnchorDay,
      timeZone: normalizedTimeZone,
      ...(budgetUsd === null ? {} : { budgetUsd }),
      hardCapEnabled: args.hardCapEnabled,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const getViewerUsageSummary = query({
  args: {},
  handler: async (ctx): Promise<ViewerUsageSummary> => {
    const identity = await requireViewerIdentity(ctx);
    const untilMs = Date.now();
    const todayStartMs = utcDayStartMs(untilMs);
    const sinceMs = addUtcDays(todayStartMs, -(VIEWER_USAGE_WINDOW_DAYS - 1));
    const sinceDay = utcDayKey(sinceMs);
    const untilDayExclusive = utcDayKey(addUtcDays(todayStartMs, 1));
    const breakdown = await aggregateViewerUsageRollups(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      sinceDay,
      untilDayExclusive,
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
        chat: {
          costUsd: breakdown.byFeature.chat.usd,
          events: breakdown.byFeature.chat.count,
          totalTokens: tokenTotal(breakdown.byFeature.chat),
        },
        systemDesign: {
          costUsd: breakdown.byFeature.systemDesign.usd,
          events: breakdown.byFeature.systemDesign.count,
          totalTokens: tokenTotal(breakdown.byFeature.systemDesign),
        },
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

export const TEST_INTERNALS = {
  makeBucket,
  addToBucket,
  utcDayKey,
  utcDayStartMs,
  stableShardForKey,
  hasRecordableUsage,
  tokenTotal,
  getUsagePeriodForMs,
  getPreviousUsagePeriod,
  normalizeTimeZone,
  validateCycleAnchorDay,
  validateBudgetUsd,
} as const;
