import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { extractMermaidCodeBlocks, replaceMermaidCodeBlocks } from "./lib/mermaidMarkdown";
import { assertOwnedBy } from "./lib/ownedDocs";
import { updateArtifactWrite } from "./lib/artifactWrites";
import {
  reserveSandboxLibraryGenerationBudget,
  settleSandboxLibraryGenerationUsage,
} from "./lib/sandboxLibraryGenerationAccounting";
import { consumeSystemDesignRateLimit } from "./lib/rateLimit";
import { isActiveRepository } from "./lib/repositoryAccess";
import type { NormalizedUsage } from "./lib/llmProvider";

export interface MermaidBlockReplacement {
  contentMarkdown: string;
  blockIndex: number;
}

export interface MermaidRepairContext {
  artifactId: Id<"artifacts">;
  version: number;
  contentMarkdown: string;
  ownerTokenIdentifier: string;
  repositoryId: Id<"repositories"> | undefined;
  generatedByProvider: Doc<"artifacts">["generatedByProvider"];
  generatedByModel: string | undefined;
}

export interface ApplyMermaidRepairResult {
  updated: boolean;
  version: number;
  blockIndex: number;
}

export function replaceMatchingMermaidBlock(args: {
  contentMarkdown: string;
  originalChart: string;
  repairedChart: string;
}): MermaidBlockReplacement | null {
  const blocks = extractMermaidCodeBlocks(args.contentMarkdown);
  const lines = args.contentMarkdown.split(/\r?\n/);
  const originalChart = args.originalChart.trim();
  const rawBlocks = blocks.map((block) => ({
    block,
    rawBlock: lines.slice(block.startLineIndex - 1, block.endLineIndex + 1).join("\n"),
  }));

  const selectedRawBlock =
    selectOnlyMatch(
      rawBlocks,
      ({ rawBlock }) => rawBlock === args.originalChart || rawBlock.trim() === originalChart,
    ) ??
    selectOnlyMatch(rawBlocks, ({ block }) => block.code === args.originalChart) ??
    selectOnlyMatch(rawBlocks, ({ block }) => block.code.trim() === originalChart);

  if (!selectedRawBlock) {
    return null;
  }

  return {
    contentMarkdown: replaceMermaidCodeBlocks(
      args.contentMarkdown,
      new Map([[selectedRawBlock.block.blockIndex, args.repairedChart.trim()]]),
    ),
    blockIndex: selectedRawBlock.block.blockIndex,
  };
}

function selectOnlyMatch<T>(values: readonly T[], predicate: (value: T) => boolean): T | null {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

async function requireActiveRepairArtifact(
  ctx: QueryCtx | MutationCtx,
  args: {
    artifactId: Id<"artifacts">;
    ownerTokenIdentifier: string;
  },
): Promise<Doc<"artifacts">> {
  const artifact = await ctx.db.get(args.artifactId);
  assertOwnedBy(artifact, args.ownerTokenIdentifier, "Artifact not found.");
  if (!artifact.repositoryId) {
    return artifact;
  }

  const repository = await ctx.db.get(artifact.repositoryId);
  if (!repository || repository.ownerTokenIdentifier !== args.ownerTokenIdentifier || !isActiveRepository(repository)) {
    throw new Error("Artifact not found.");
  }

  return artifact;
}

export const getRepairContext = internalQuery({
  args: {
    artifactId: v.id("artifacts"),
    ownerTokenIdentifier: v.string(),
    chart: v.string(),
  },
  handler: async (ctx, args): Promise<MermaidRepairContext> => {
    const artifact = await requireActiveRepairArtifact(ctx, args);

    const replacement = replaceMatchingMermaidBlock({
      contentMarkdown: artifact.contentMarkdown,
      originalChart: args.chart,
      repairedChart: args.chart,
    });
    if (!replacement) {
      throw new Error("This diagram changed. Reload the artifact and try again.");
    }

    return {
      artifactId: artifact._id,
      version: artifact.version,
      contentMarkdown: artifact.contentMarkdown,
      ownerTokenIdentifier: artifact.ownerTokenIdentifier,
      repositoryId: artifact.repositoryId,
      generatedByProvider: artifact.generatedByProvider,
      generatedByModel: artifact.generatedByModel,
    };
  },
});

export const reserveRepairBudget = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    ownerTokenIdentifier: v.string(),
    expectedVersion: v.number(),
    sourceId: v.string(),
    occurredAtMs: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    const artifact = await requireActiveRepairArtifact(ctx, args);
    if (artifact.version !== args.expectedVersion) {
      throw new Error("This artifact changed while the diagram was being repaired. Reload and try again.");
    }
    await consumeSystemDesignRateLimit(ctx, args.ownerTokenIdentifier);
    await reserveSandboxLibraryGenerationBudget(ctx, {
      sourceId: args.sourceId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: artifact.repositoryId,
      occurredAtMs: args.occurredAtMs,
    });
    return null;
  },
});

export const settleRepairUsage = internalMutation({
  args: {
    sourceId: v.string(),
    artifactId: v.id("artifacts"),
    ownerTokenIdentifier: v.string(),
    occurredAtMs: v.number(),
    totalCostUsd: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    const artifact = await ctx.db.get(args.artifactId);
    const repositoryId =
      artifact && artifact.ownerTokenIdentifier === args.ownerTokenIdentifier ? artifact.repositoryId : null;
    const usage: NormalizedUsage = {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedInputTokens: args.cachedInputTokens,
      cacheWriteTokens: args.cacheWriteTokens,
      reasoningTokens: args.reasoningTokens,
    };
    await settleSandboxLibraryGenerationUsage(ctx, {
      sourceId: args.sourceId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      occurredAtMs: args.occurredAtMs,
      totalCostUsd: args.totalCostUsd,
      usage,
    });
    return null;
  },
});

export const applyRepairedBlock = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    ownerTokenIdentifier: v.string(),
    expectedVersion: v.number(),
    originalChart: v.string(),
    repairedChart: v.string(),
  },
  handler: async (ctx, args): Promise<ApplyMermaidRepairResult> => {
    const artifact = await requireActiveRepairArtifact(ctx, args);

    if (artifact.version !== args.expectedVersion) {
      throw new Error("This artifact changed while the diagram was being repaired. Reload and try again.");
    }

    const replacement = replaceMatchingMermaidBlock({
      contentMarkdown: artifact.contentMarkdown,
      originalChart: args.originalChart,
      repairedChart: args.repairedChart,
    });
    if (!replacement) {
      throw new Error("This diagram changed. Reload the artifact and try again.");
    }

    if (replacement.contentMarkdown === artifact.contentMarkdown) {
      return {
        updated: false,
        version: artifact.version,
        blockIndex: replacement.blockIndex,
      };
    }

    const updateResult = await updateArtifactWrite(ctx, {
      artifactId: artifact._id,
      expectedVersion: args.expectedVersion,
      contentMarkdown: replacement.contentMarkdown,
    });
    if (!updateResult.updated) {
      throw new Error("This artifact changed while the diagram was being repaired. Reload and try again.");
    }

    return {
      updated: true,
      version: artifact.version + 1,
      blockIndex: replacement.blockIndex,
    };
  },
});
