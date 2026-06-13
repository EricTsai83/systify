"use node";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { embedViaGateway, type LlmCallContext, type LlmEmbedResult } from "./llmGateway";
import type { LlmProvider } from "./llmProvider";
import { assertFeatureAccess } from "./entitlements";
import { logWarn } from "./observability";
import {
  ARTIFACT_INDEXING_BATCH_BUDGET_ESTIMATE_USD,
  LIBRARY_RETRIEVAL_BUDGET_ESTIMATE_USD,
  type UsageFeature,
} from "./userCost";
import type { UsageAccountingFeature } from "./usageAccounting";

/**
 * Embedding model shared by artifact chunk indexing and Library semantic
 * retrieval. Must match an OpenAI `capability: "embedding"` entry in
 * `MODEL_CATALOG`; the gateway refuses uncatalogued picks.
 */
export const DEFAULT_ARTIFACT_EMBEDDING_MODEL = "text-embedding-3-small";

const DEFAULT_ARTIFACT_EMBEDDING_PROVIDER: LlmProvider = "openai";

export type EmbeddingAccountingFeature = Extract<UsageFeature, "artifactIndexing" | "libraryRetrieval">;

const USAGE_ACCOUNTING_FEATURE_BY_EMBEDDING_FEATURE = {
  artifactIndexing: "artifactIndexingEmbedding",
  libraryRetrieval: "libraryRetrievalEmbedding",
} as const satisfies Record<EmbeddingAccountingFeature, UsageAccountingFeature>;

export interface AccountedEmbeddingResult extends LlmEmbedResult {
  provider: LlmProvider;
  modelName: string;
  settledCents: number | undefined;
}

export interface EmbedWithAccountingArgs {
  values: string[];
  sourceId: string;
  ownerTokenIdentifier: string;
  repositoryId: Id<"repositories"> | null;
  usageFeature: EmbeddingAccountingFeature;
  gatewayFeature: LlmCallContext["feature"];
  provider?: LlmProvider;
  modelName?: string;
  occurredAtMs?: number;
  threadId?: Id<"threads">;
  messageId?: Id<"messages">;
  jobId?: Id<"jobs">;
}

export const EMBEDDING_BUDGET_ESTIMATES = {
  artifactIndexing: ARTIFACT_INDEXING_BATCH_BUDGET_ESTIMATE_USD,
  libraryRetrieval: LIBRARY_RETRIEVAL_BUDGET_ESTIMATE_USD,
} as const satisfies Record<EmbeddingAccountingFeature, number>;

export function resolveArtifactEmbeddingModel(): string {
  return process.env.ARTIFACT_EMBEDDING_MODEL ?? DEFAULT_ARTIFACT_EMBEDDING_MODEL;
}

/**
 * Embeds values through the gateway and owns the budget/accounting ceremony:
 * reservation, gateway dispatch, failure release, sandbox daily-cap
 * settlement, and durable usage-event recording.
 */
export async function embedWithAccounting(
  ctx: ActionCtx,
  args: EmbedWithAccountingArgs,
): Promise<AccountedEmbeddingResult> {
  const provider = args.provider ?? DEFAULT_ARTIFACT_EMBEDDING_PROVIDER;
  const modelName = args.modelName ?? resolveArtifactEmbeddingModel();
  const occurredAtMs = args.occurredAtMs ?? Date.now();
  if (args.usageFeature === "artifactIndexing") {
    await assertFeatureAccess(ctx, args.ownerTokenIdentifier, "artifactIndexing");
  }

  const usageAccountingFeature = USAGE_ACCOUNTING_FEATURE_BY_EMBEDDING_FEATURE[args.usageFeature];

  await ctx.runMutation(internal.lib.usageAccountingMutations.reserveUsageLifecycle, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    feature: usageAccountingFeature,
    occurredAtMs,
  });

  const result = await embedViaGateway(
    ctx,
    {
      provider,
      modelName,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      capability: "embedding",
      feature: args.gatewayFeature,
      ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
      ...(args.messageId !== undefined ? { messageId: args.messageId } : {}),
      ...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
    },
    { values: args.values },
  ).catch(async (error: unknown) => {
    const originalError = error;
    const [failureRecord] = await Promise.allSettled([
      recordEmbeddingFailure(ctx, {
        sourceId: args.sourceId,
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        usageFeature: args.usageFeature,
        usageAccountingFeature,
        repositoryId: args.repositoryId,
        occurredAtMs,
        error: originalError,
      }),
    ]);
    if (failureRecord.status === "rejected") {
      logWarn("embeddingAccounting", "failure_release_failed", {
        sourceId: args.sourceId,
        feature: args.usageFeature,
        originalError: originalError instanceof Error ? originalError.message : String(originalError),
        releaseError:
          failureRecord.reason instanceof Error ? failureRecord.reason.message : String(failureRecord.reason),
      });
    }
    throw originalError;
  });

  const settledCents = await settleEmbeddingUsage(ctx, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    usageFeature: args.usageFeature,
    usageAccountingFeature,
    occurredAtMs,
    result,
  });

  return {
    ...result,
    provider,
    modelName,
    settledCents,
  };
}

async function recordEmbeddingFailure(
  ctx: ActionCtx,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    usageFeature: EmbeddingAccountingFeature;
    usageAccountingFeature: UsageAccountingFeature;
    repositoryId: Id<"repositories"> | null;
    occurredAtMs: number;
    error: unknown;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.lib.usageAccountingMutations.releaseUsageLifecycle, {
      sourceId: args.sourceId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      feature: args.usageAccountingFeature,
      occurredAtMs: args.occurredAtMs,
    });
  } catch (recordError) {
    logWarn("embeddingAccounting", "failure_usage_event_recording_failed", {
      sourceId: args.sourceId,
      feature: args.usageFeature,
      originalError: args.error instanceof Error ? args.error.message : String(args.error),
      recordError: recordError instanceof Error ? recordError.message : String(recordError),
    });
  }
}

async function settleEmbeddingUsage(
  ctx: ActionCtx,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | null;
    usageFeature: EmbeddingAccountingFeature;
    usageAccountingFeature: UsageAccountingFeature;
    occurredAtMs: number;
    result: LlmEmbedResult;
  },
): Promise<number | undefined> {
  const settlement = await ctx.runMutation(internal.lib.usageAccountingMutations.settleUsageLifecycle, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    feature: args.usageAccountingFeature,
    occurredAtMs: args.occurredAtMs,
    usage: {
      ...(args.result.costUsd !== undefined ? { costUsd: args.result.costUsd } : {}),
      ...(args.result.usage.inputTokens !== undefined ? { inputTokens: args.result.usage.inputTokens } : {}),
    },
  });

  return settlement.settledCents ?? undefined;
}
