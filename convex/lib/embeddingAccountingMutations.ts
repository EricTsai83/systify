import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { settleUsageLifecycleInMutation } from "./usageAccountingMutations";

const embeddingAccountingFeatureValidator = v.union(v.literal("artifactIndexing"), v.literal("libraryRetrieval"));

const usageAccountingFeatureByEmbeddingFeature = {
  artifactIndexing: "artifactIndexingEmbedding",
  libraryRetrieval: "libraryRetrievalEmbedding",
} as const;

export const settleAndRecordUsage = internalMutation({
  args: {
    sourceId: v.string(),
    ownerTokenIdentifier: v.string(),
    feature: embeddingAccountingFeatureValidator,
    repositoryId: v.union(v.id("repositories"), v.null()),
    cents: v.number(),
    occurredAtMs: v.number(),
    usd: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    await settleUsageLifecycleInMutation(ctx, {
      sourceId: args.sourceId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      feature: usageAccountingFeatureByEmbeddingFeature[args.feature],
      occurredAtMs: args.occurredAtMs,
      usage: {
        costUsd: args.usd,
        inputTokens: args.inputTokens,
      },
    });

    return null;
  },
});
