import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { NormalizedUsage } from "./llmProvider";
import {
  releaseUsageLifecycleInMutation,
  reserveUsageLifecycleInMutation,
  settleUsageLifecycleInMutation,
} from "./usageAccountingMutations";
import type { UsageAccountingPolicy } from "./usageAccounting";

export async function reserveSandboxLibraryGenerationBudget(
  ctx: MutationCtx,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | null | undefined;
    occurredAtMs: number;
    sandboxDailyCap?: UsageAccountingPolicy["sandboxDailyCap"];
  },
) {
  await reserveUsageLifecycleInMutation(ctx, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId ?? null,
    feature: "systemDesignGeneration",
    occurredAtMs: args.occurredAtMs,
    sandboxDailyCap: args.sandboxDailyCap,
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
  await settleUsageLifecycleInMutation(ctx, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId ?? null,
    feature: "systemDesignGeneration",
    occurredAtMs: args.occurredAtMs,
    usage: {
      costUsd: args.totalCostUsd,
      inputTokens: args.usage.inputTokens,
      outputTokens: args.usage.outputTokens,
      cachedInputTokens: args.usage.cachedInputTokens,
      cacheWriteTokens: args.usage.cacheWriteTokens,
      reasoningTokens: args.usage.reasoningTokens,
    },
  });
}

export async function releaseSandboxLibraryGenerationUsage(
  ctx: MutationCtx,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | null | undefined;
    occurredAtMs: number;
  },
) {
  await releaseUsageLifecycleInMutation(ctx, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId ?? null,
    feature: "systemDesignGeneration",
    occurredAtMs: args.occurredAtMs,
  });
}
