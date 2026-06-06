import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { consumeSandboxDailyCost } from "./rateLimit";
import { recordUserUsageEvent } from "./userCost";

const embeddingAccountingFeatureValidator = v.union(v.literal("artifactIndexing"), v.literal("libraryRetrieval"));

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
    const sourceId = args.sourceId.trim();
    if (!sourceId) {
      throw new Error("Embedding usage sourceId must be non-empty");
    }

    const existingEvent = await ctx.db
      .query("userUsageEvents")
      .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
      .unique();
    if (existingEvent) {
      return null;
    }

    await consumeSandboxDailyCost(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      cents: args.cents,
    });
    await recordUserUsageEvent(ctx, {
      sourceId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      feature: args.feature,
      occurredAtMs: args.occurredAtMs,
      ...(args.usd !== undefined ? { usd: args.usd } : {}),
      ...(args.inputTokens !== undefined ? { inputTokens: args.inputTokens } : {}),
    });

    return null;
  },
});
