import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { extractMermaidCodeBlocks, replaceMermaidCodeBlocks } from "./lib/mermaidMarkdown";
import { assertOwnedBy } from "./lib/ownedDocs";

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

export const getRepairContext = internalQuery({
  args: {
    artifactId: v.id("artifacts"),
    ownerTokenIdentifier: v.string(),
    chart: v.string(),
  },
  handler: async (ctx, args): Promise<MermaidRepairContext> => {
    const artifact = await ctx.db.get(args.artifactId);
    assertOwnedBy(artifact, args.ownerTokenIdentifier, "Artifact not found.");

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

export const applyRepairedBlock = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    ownerTokenIdentifier: v.string(),
    expectedVersion: v.number(),
    originalChart: v.string(),
    repairedChart: v.string(),
  },
  handler: async (ctx, args): Promise<ApplyMermaidRepairResult> => {
    const artifact = await ctx.db.get(args.artifactId);
    assertOwnedBy(artifact, args.ownerTokenIdentifier, "Artifact not found.");

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

    const patch: {
      contentMarkdown: string;
      version: number;
      updatedAt: number;
      chunkingStatus?: Doc<"artifacts">["chunkingStatus"];
    } = {
      contentMarkdown: replacement.contentMarkdown,
      version: artifact.version + 1,
      updatedAt: Date.now(),
    };
    if (artifact.repositoryId) {
      patch.chunkingStatus = "pending";
    }

    await ctx.db.patch(artifact._id, patch);
    if (artifact.repositoryId) {
      await ctx.scheduler.runAfter(0, internal.artifactIndexing.reindexArtifact, {
        artifactId: artifact._id,
      });
    }

    return {
      updated: true,
      version: patch.version,
      blockIndex: replacement.blockIndex,
    };
  },
});
