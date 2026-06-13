import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { costUsdToCents } from "./llmPricing";
import { assertSandboxDailyCostBudget, consumeSandboxDailyCost, getSandboxReplyEstimateCents } from "./rateLimit";
import { recordUserUsageEvent, reserveUserUsageBudget } from "./userCost";
import {
  getUsageAccountingPolicy,
  normalizeUsageAccountingSourceId,
  usageAccountingFeatureValidator,
  usageAccountingSandboxDailyCapValidator,
  usageAccountingUsageValidator,
  type UsageAccountingLifecycleArgs,
  type UsageAccountingPolicy,
  type UsageAccountingUsage,
} from "./usageAccounting";

type LifecycleArgs = UsageAccountingLifecycleArgs & {
  sandboxDailyCap?: UsageAccountingPolicy["sandboxDailyCap"];
};

function effectiveSandboxDailyCap(args: LifecycleArgs): UsageAccountingPolicy["sandboxDailyCap"] {
  return args.sandboxDailyCap ?? getUsageAccountingPolicy(args.feature).sandboxDailyCap;
}

async function usageEventExists(ctx: MutationCtx, sourceId: string): Promise<boolean> {
  const existingEvent = await ctx.db
    .query("userUsageEvents")
    .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
    .unique();
  return existingEvent !== null;
}

export async function reserveUsageLifecycleInMutation(
  ctx: MutationCtx,
  args: LifecycleArgs,
): Promise<{ reserved: boolean; periodKey: string | null }> {
  const sourceId = normalizeUsageAccountingSourceId(args.sourceId);
  const policy = getUsageAccountingPolicy(args.feature);
  const sandboxDailyCap = effectiveSandboxDailyCap(args);

  if (sandboxDailyCap === "precheckAndSettle") {
    await assertSandboxDailyCostBudget(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      estimateCents: getSandboxReplyEstimateCents(),
    });
  }

  if (policy.userBudgetEstimateUsd === undefined) {
    return { reserved: false, periodKey: null };
  }

  return await reserveUserUsageBudget(ctx, {
    sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: policy.usageFeature,
    estimatedCostUsd: policy.userBudgetEstimateUsd,
    occurredAtMs: args.occurredAtMs,
  });
}

export async function settleUsageLifecycleInMutation(
  ctx: MutationCtx,
  args: LifecycleArgs & { usage: UsageAccountingUsage },
): Promise<{ recorded: boolean; settledCents: number | null }> {
  const sourceId = normalizeUsageAccountingSourceId(args.sourceId);
  const policy = getUsageAccountingPolicy(args.feature);
  if (await usageEventExists(ctx, sourceId)) {
    return { recorded: false, settledCents: null };
  }

  const settleCents = costUsdToCents(args.usage.costUsd);
  const sandboxDailyCap = effectiveSandboxDailyCap(args);
  if (sandboxDailyCap !== "none" && settleCents !== undefined && settleCents > 0) {
    await consumeSandboxDailyCost(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      cents: settleCents,
    });
  }

  const recorded = await recordUserUsageEvent(ctx, {
    sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: policy.usageFeature,
    occurredAtMs: args.occurredAtMs,
    usd: args.usage.costUsd,
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    cachedInputTokens: args.usage.cachedInputTokens,
    cacheWriteTokens: args.usage.cacheWriteTokens,
    reasoningTokens: args.usage.reasoningTokens,
  });

  return {
    recorded,
    settledCents: sandboxDailyCap !== "none" && settleCents !== undefined && settleCents > 0 ? settleCents : null,
  };
}

export async function releaseUsageLifecycleInMutation(ctx: MutationCtx, args: LifecycleArgs): Promise<null> {
  const sourceId = normalizeUsageAccountingSourceId(args.sourceId);
  const policy = getUsageAccountingPolicy(args.feature);
  await recordUserUsageEvent(ctx, {
    sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: policy.usageFeature,
    occurredAtMs: args.occurredAtMs,
  });
  return null;
}

export const reserveUsageLifecycle = internalMutation({
  args: {
    sourceId: v.string(),
    ownerTokenIdentifier: v.string(),
    repositoryId: v.union(v.id("repositories"), v.null()),
    occurredAtMs: v.number(),
    feature: usageAccountingFeatureValidator,
    sandboxDailyCap: v.optional(usageAccountingSandboxDailyCapValidator),
  },
  handler: async (ctx, args): Promise<{ reserved: boolean; periodKey: string | null }> => {
    return await reserveUsageLifecycleInMutation(ctx, args);
  },
});

export const settleUsageLifecycle = internalMutation({
  args: {
    sourceId: v.string(),
    ownerTokenIdentifier: v.string(),
    repositoryId: v.union(v.id("repositories"), v.null()),
    occurredAtMs: v.number(),
    feature: usageAccountingFeatureValidator,
    sandboxDailyCap: v.optional(usageAccountingSandboxDailyCapValidator),
    usage: usageAccountingUsageValidator,
  },
  handler: async (ctx, args): Promise<{ recorded: boolean; settledCents: number | null }> => {
    return await settleUsageLifecycleInMutation(ctx, args);
  },
});

export const releaseUsageLifecycle = internalMutation({
  args: {
    sourceId: v.string(),
    ownerTokenIdentifier: v.string(),
    repositoryId: v.union(v.id("repositories"), v.null()),
    occurredAtMs: v.number(),
    feature: usageAccountingFeatureValidator,
    sandboxDailyCap: v.optional(usageAccountingSandboxDailyCapValidator),
  },
  handler: async (ctx, args): Promise<null> => {
    return await releaseUsageLifecycleInMutation(ctx, args);
  },
});
