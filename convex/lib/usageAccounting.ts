import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { NormalizedUsage } from "./llmProvider";
import {
  ARTIFACT_INDEXING_BATCH_BUDGET_ESTIMATE_USD,
  CHAT_REPLY_BUDGET_ESTIMATE_USD,
  LIBRARY_RETRIEVAL_BUDGET_ESTIMATE_USD,
  SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD,
  TITLE_GENERATION_BUDGET_ESTIMATE_USD,
  type UsageFeature,
} from "./userCost";

export const usageAccountingFeatureValidator = v.union(
  v.literal("chatReply"),
  v.literal("titleGeneration"),
  v.literal("systemDesignGeneration"),
  v.literal("artifactIndexingEmbedding"),
  v.literal("libraryRetrievalEmbedding"),
);

export type UsageAccountingFeature = Infer<typeof usageAccountingFeatureValidator>;

export type UsageAccountingPolicy = {
  usageFeature: UsageFeature;
  userBudgetEstimateUsd?: number;
  sandboxDailyCap: "none" | "precheckAndSettle" | "settleOnly";
  gatewayFeature: "chat" | "system_design" | "indexing";
};

export type UsageAccountingUsage = NormalizedUsage & {
  costUsd?: number;
};

export type UsageAccountingLifecycleArgs = {
  sourceId: string;
  ownerTokenIdentifier: string;
  repositoryId: Id<"repositories"> | null;
  occurredAtMs: number;
  feature: UsageAccountingFeature;
};

export const usageAccountingUsageValidator = v.object({
  costUsd: v.optional(v.number()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  cacheWriteTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
});

export const usageAccountingSandboxDailyCapValidator = v.union(
  v.literal("none"),
  v.literal("precheckAndSettle"),
  v.literal("settleOnly"),
);

export const USAGE_ACCOUNTING_POLICIES = {
  chatReply: {
    usageFeature: "chat",
    userBudgetEstimateUsd: CHAT_REPLY_BUDGET_ESTIMATE_USD,
    sandboxDailyCap: "precheckAndSettle",
    gatewayFeature: "chat",
  },
  titleGeneration: {
    usageFeature: "titleGeneration",
    userBudgetEstimateUsd: TITLE_GENERATION_BUDGET_ESTIMATE_USD,
    sandboxDailyCap: "none",
    gatewayFeature: "chat",
  },
  systemDesignGeneration: {
    usageFeature: "systemDesign",
    userBudgetEstimateUsd: SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD,
    sandboxDailyCap: "precheckAndSettle",
    gatewayFeature: "system_design",
  },
  artifactIndexingEmbedding: {
    usageFeature: "artifactIndexing",
    userBudgetEstimateUsd: ARTIFACT_INDEXING_BATCH_BUDGET_ESTIMATE_USD,
    sandboxDailyCap: "settleOnly",
    gatewayFeature: "indexing",
  },
  libraryRetrievalEmbedding: {
    usageFeature: "libraryRetrieval",
    userBudgetEstimateUsd: LIBRARY_RETRIEVAL_BUDGET_ESTIMATE_USD,
    sandboxDailyCap: "settleOnly",
    gatewayFeature: "chat",
  },
} as const satisfies Record<UsageAccountingFeature, UsageAccountingPolicy>;

export function getUsageAccountingPolicy(feature: UsageAccountingFeature): UsageAccountingPolicy {
  return USAGE_ACCOUNTING_POLICIES[feature];
}

export function normalizeUsageAccountingSourceId(sourceId: string): string {
  const trimmed = sourceId.trim();
  if (!trimmed) {
    throw new Error("Usage accounting sourceId must be non-empty");
  }
  return trimmed;
}

export const buildUsageSourceId = {
  chatReply(messageId: Id<"messages">): string {
    return `message:${messageId}`;
  },
  title(threadId: Id<"threads">, userMessageId: Id<"messages">): string {
    return `title:${threadId}:${userMessageId}`;
  },
  systemDesign(jobId: Id<"jobs">, kind: string, startedAt: number): string {
    return `systemDesign:${jobId}:${kind}:${startedAt}`;
  },
  systemDesignKindRun(kindRunId: Id<"systemDesignKindRuns">): string {
    return `systemDesignKindRun:${kindRunId}`;
  },
  artifactDraft(jobId: Id<"jobs">, startedAt: number): string {
    return `artifactDraft:${jobId}:${startedAt}`;
  },
  mermaidRepair(artifactId: Id<"artifacts">, version: number, startedAt: number): string {
    return `mermaidRepair:${artifactId}:${version}:${startedAt}`;
  },
  artifactIndexing(artifactId: Id<"artifacts">, artifactVersion: number, batchIndex: number): string {
    return `artifactIndexing:${artifactId}:${artifactVersion}:${batchIndex}`;
  },
  libraryRetrieval(messageOrThreadId: Id<"messages"> | Id<"threads"> | "unattributed", queryHash: string): string {
    return `libraryRetrieval:${messageOrThreadId}:${queryHash}`;
  },
};
