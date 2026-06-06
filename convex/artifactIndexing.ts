"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import {
  chunkArtifactMarkdown,
  DEFAULT_ARTIFACT_CHUNK_HARD_TOKEN_CAP,
  DEFAULT_ARTIFACT_CHUNK_SOFT_TOKEN_CAP,
} from "./lib/artifactChunking";
import { EMBEDDING_BUDGET_ESTIMATES, embedWithAccounting } from "./lib/embeddingAccounting";
import { logInfo, logWarn } from "./lib/observability";
import { isUsageBudgetExceededError } from "./lib/userCost";

const DEFAULT_EMBEDDING_BATCH_SIZE = 100;
const FAILED_INDEXING_RETRY_BACKOFF_MS = 30 * 60_000;
const FAILED_INDEXING_RETRY_LIMIT = 50;
const PENDING_INDEXING_BACKFILL_LIMIT = 20;
const REINDEX_ACTION_CONCURRENCY = 5;

export const reindexArtifact = internalAction({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx: ActionCtx, args): Promise<{ indexed: boolean; chunks?: number; reason?: string }> => {
    const artifact: Doc<"artifacts"> | null = await ctx.runQuery(internal.artifactStore.getArtifact, {
      artifactId: args.artifactId,
    });
    if (!artifact || !artifact.repositoryId) {
      return { indexed: false, reason: "missing_artifact_or_repository" as const };
    }

    const artifactVersion = artifact.version;
    const chunks = chunkArtifactMarkdown(artifact.contentMarkdown, {
      softTokenCap: readNumberEnv("ARTIFACT_CHUNK_SOFT_TOKEN_CAP", DEFAULT_ARTIFACT_CHUNK_SOFT_TOKEN_CAP),
      hardTokenCap: readNumberEnv("ARTIFACT_CHUNK_HARD_TOKEN_CAP", DEFAULT_ARTIFACT_CHUNK_HARD_TOKEN_CAP),
    });

    await ctx.runMutation(internal.artifactStore.markChunkingStatus, {
      artifactId: args.artifactId,
      status: "pending",
      version: artifactVersion,
    });

    const replaceResult: { replaced: boolean; count?: number; reason?: string } = await ctx.runMutation(
      internal.artifactChunkStore.replaceChunksForArtifact,
      {
        artifactId: args.artifactId,
        artifactVersion,
        chunks: chunks.map(({ chunkIndex: _chunkIndex, ...chunk }) => chunk),
      },
    );
    if (!replaceResult.replaced) {
      await ctx.runMutation(internal.artifactStore.markChunkingStatus, {
        artifactId: args.artifactId,
        status: "failed",
        version: artifactVersion,
      });
      return { indexed: false, reason: replaceResult.reason };
    }

    if (chunks.length === 0) {
      await ctx.runMutation(internal.artifactStore.markChunkingStatus, {
        artifactId: args.artifactId,
        status: "indexed",
        version: artifactVersion,
      });
      return { indexed: true, chunks: 0 };
    }

    try {
      const embeddings = await embedArtifactChunks(ctx, {
        artifactId: args.artifactId,
        artifactVersion,
        values: chunks.map((chunk) => chunk.content),
        ownerTokenIdentifier: artifact.ownerTokenIdentifier,
        repositoryId: artifact.repositoryId,
      });
      await ctx.runMutation(internal.artifactChunkStore.batchSetEmbeddings, {
        artifactId: args.artifactId,
        artifactVersion,
        embeddings: embeddings.map((embedding, chunkIndex) => ({ chunkIndex, embedding })),
      });
      await ctx.runMutation(internal.artifactStore.markChunkingStatus, {
        artifactId: args.artifactId,
        status: "indexed",
        version: artifactVersion,
      });
      logInfo("artifactIndexing", "artifact_indexed", {
        artifactId: args.artifactId,
        artifactVersion,
        chunks: chunks.length,
      });
      return { indexed: true, chunks: chunks.length };
    } catch (error) {
      const usageBudgetExceeded = isUsageBudgetExceededError(error);
      await ctx.runMutation(internal.artifactStore.markChunkingStatus, {
        artifactId: args.artifactId,
        status: "failed",
        version: artifactVersion,
        failureReason: usageBudgetExceeded ? "usage_budget_exceeded" : "embedding_failed",
      });
      logWarn("artifactIndexing", "embedding_failed", {
        artifactId: args.artifactId,
        artifactVersion,
        reason: usageBudgetExceeded ? "usage_budget_exceeded" : "embedding_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return { indexed: false, reason: usageBudgetExceeded ? "usage_budget_exceeded" : ("embedding_failed" as const) };
    }
  },
});

export const retryFailedArtifactIndexing = internalAction({
  args: {},
  handler: async (ctx: ActionCtx): Promise<{ scheduled: number }> => {
    const cutoff = Date.now() - FAILED_INDEXING_RETRY_BACKOFF_MS;
    const artifacts: Doc<"artifacts">[] = await ctx.runQuery(internal.artifactStore.listFailedArtifactsForReindex, {
      cutoff,
      limit: FAILED_INDEXING_RETRY_LIMIT,
    });
    await reindexArtifactsWithConcurrency(ctx, artifacts);
    return { scheduled: artifacts.length };
  },
});

export const backfillPendingArtifactChunks = internalAction({
  args: {},
  handler: async (ctx: ActionCtx): Promise<{ scheduled: number; done: boolean }> => {
    const artifacts: Doc<"artifacts">[] = await ctx.runQuery(internal.artifactStore.listPendingArtifactsForReindex, {
      limit: PENDING_INDEXING_BACKFILL_LIMIT,
    });
    await reindexArtifactsWithConcurrency(ctx, artifacts);
    if (artifacts.length === PENDING_INDEXING_BACKFILL_LIMIT) {
      await ctx.scheduler.runAfter(0, internal.artifactIndexing.backfillPendingArtifactChunks, {});
    }
    return { scheduled: artifacts.length, done: artifacts.length < PENDING_INDEXING_BACKFILL_LIMIT };
  },
});

async function reindexArtifactsWithConcurrency(ctx: ActionCtx, artifacts: Doc<"artifacts">[]): Promise<void> {
  for (let index = 0; index < artifacts.length; index += REINDEX_ACTION_CONCURRENCY) {
    const batch = artifacts.slice(index, index + REINDEX_ACTION_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((artifact) => ctx.runAction(internal.artifactIndexing.reindexArtifact, { artifactId: artifact._id })),
    );
    results.forEach((result, resultIndex) => {
      if (result.status === "rejected") {
        logWarn("artifactIndexing", "artifact_reindex_action_failed", {
          artifactId: batch[resultIndex]?._id,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  }
}

/**
 * Embed a list of chunk texts via the accounted embedding wrapper so
 * the call inherits gateway fairness, retry, normalized usage, budget
 * reservation, daily-cap settlement, and cost telemetry.
 *
 * Daily-cap settlement happens **per batch**. Settling once per
 * gateway call (rather than once per artifact) bounds the worst-case
 * overrun to a single batch's spend if the action crashes mid-loop —
 * the already-charged batches are durably recorded, the un-attempted
 * tail simply isn't charged. Aggregating cost across the whole
 * artifact and settling at the end would leak whichever batches ran
 * before the crash.
 */
async function embedArtifactChunks(
  ctx: ActionCtx,
  args: {
    artifactId: Doc<"artifacts">["_id"];
    artifactVersion: number;
    values: string[];
    ownerTokenIdentifier: string;
    repositoryId: Doc<"artifacts">["repositoryId"];
  },
): Promise<number[][]> {
  const batchSize = readNumberEnv("ARTIFACT_EMBEDDING_BATCH_SIZE", DEFAULT_EMBEDDING_BATCH_SIZE);
  const embeddings: number[][] = [];
  for (let index = 0; index < args.values.length; index += batchSize) {
    const batch = args.values.slice(index, index + batchSize);
    const sourceId = `artifactIndexing:${args.artifactId}:${args.artifactVersion}:${index}`;
    const result = await embedWithAccounting(ctx, {
      sourceId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId ?? null,
      usageFeature: "artifactIndexing",
      gatewayFeature: "indexing",
      estimatedCostUsd: EMBEDDING_BUDGET_ESTIMATES.artifactIndexing,
      values: batch,
    });
    embeddings.push(...result.embeddings);

    logInfo("artifactIndexing", "embedding_batch_completed", {
      model: result.modelName,
      batchSize: batch.length,
      tokens: result.usage.inputTokens,
      costUsd: result.costUsd,
      settledCents: result.settledCents,
    });
  }
  return embeddings;
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  // ARTIFACT_EMBEDDING_BATCH_SIZE intentionally truncates fractional values via Math.floor(parsed).
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
