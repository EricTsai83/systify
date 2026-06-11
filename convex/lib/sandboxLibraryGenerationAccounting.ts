import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { NormalizedUsage } from "./llmProvider";
import { costUsdToCents } from "./llmPricing";
import { assertSandboxDailyCostBudget, consumeSandboxDailyCost, getSandboxReplyEstimateCents } from "./rateLimit";
import { SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD, recordUserUsageEvent, reserveUserUsageBudget } from "./userCost";

export async function reserveSandboxLibraryGenerationBudget(
  ctx: MutationCtx,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | null | undefined;
    occurredAtMs: number;
  },
) {
  await assertSandboxDailyCostBudget(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    estimateCents: getSandboxReplyEstimateCents(),
  });
  await reserveUserUsageBudget(ctx, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: "systemDesign",
    estimatedCostUsd: SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD,
    occurredAtMs: args.occurredAtMs,
  });
}

export async function settleSandboxLibraryGenerationUsage(
  ctx: MutationCtx,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | null | undefined;
    occurredAtMs: number;
    totalCostUsd: number | undefined;
    usage: NormalizedUsage;
  },
) {
  const recorded = await recordUserUsageEvent(ctx, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: "systemDesign",
    occurredAtMs: args.occurredAtMs,
    usd: args.totalCostUsd,
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    cachedInputTokens: args.usage.cachedInputTokens,
    cacheWriteTokens: args.usage.cacheWriteTokens,
    reasoningTokens: args.usage.reasoningTokens,
  });
  if (!recorded) {
    return;
  }

  const settleCents = costUsdToCents(args.totalCostUsd);
  if (settleCents !== undefined && settleCents > 0) {
    await consumeSandboxDailyCost(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      cents: settleCents,
    });
  }
}
