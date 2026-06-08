"use node";

import type { ToolSet } from "ai";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { createSandboxTools } from "../chat/sandboxTools";
import { getSandboxFsClient } from "../daytona";
import { getCatalogEntry, isSupportedReasoningEffort, type ReasoningEffort } from "./llmCatalog";
import type { LlmProvider, NormalizedUsage } from "./llmProvider";
import { ensureSandboxReady, type EnsureSandboxReadyResult, type SandboxPreparationStage } from "./sandboxLiveness";

export type { EnsureSandboxReadyResult, SandboxPreparationStage };

export type SandboxLibraryGenerationModelChoice = {
  provider: LlmProvider;
  modelName: string;
  reasoningEffort: ReasoningEffort | undefined;
};

export const SYSTEM_DESIGN_SANDBOX_STAGE_LABELS = {
  probing: "Preparing environment for your request…",
  waking: "Waking up the repository sandbox…",
  provisioning: "Setting up the repository sandbox…",
  cloning: "Cloning repository…",
  polling: "Preparing environment for your request…",
} satisfies Record<SandboxPreparationStage, string>;

export const ARTIFACT_DRAFT_SANDBOX_STAGE_LABELS = {
  probing: "Preparing code access…",
  waking: "Preparing code access…",
  provisioning: "Preparing code access…",
  cloning: "Reading codebase…",
  polling: "Preparing code access…",
} satisfies Record<SandboxPreparationStage, string>;

export function resolveSandboxLibraryGenerationModelChoice(args: {
  provider: LlmProvider | undefined;
  modelName: string | undefined;
  reasoningEffort: ReasoningEffort | undefined;
  missingSelectionMessage: string;
}): SandboxLibraryGenerationModelChoice {
  if (!args.provider || !args.modelName) {
    throw new Error(args.missingSelectionMessage);
  }
  const catalogEntry = getCatalogEntry(args.provider, args.modelName);
  const reasoningEffort = isSupportedReasoningEffort(args.provider, args.modelName, args.reasoningEffort)
    ? (args.reasoningEffort ?? catalogEntry?.reasoningEffort)
    : catalogEntry?.reasoningEffort;
  return {
    provider: args.provider,
    modelName: args.modelName,
    reasoningEffort,
  };
}

export async function prepareSandboxLibraryGeneration(
  ctx: ActionCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
    onStage: (stage: SandboxPreparationStage) => Promise<void>;
  },
): Promise<EnsureSandboxReadyResult> {
  return await ensureSandboxReady(
    ctx,
    {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
    },
    args.onStage,
  );
}

export async function createSandboxLibraryGenerationTools(
  prepared: Pick<EnsureSandboxReadyResult, "remoteId" | "repoPath">,
): Promise<ToolSet> {
  return createSandboxTools(await getSandboxFsClient(prepared.remoteId), prepared.repoPath);
}

export function combineSandboxLibraryGenerationUsage(first: NormalizedUsage, second: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: sumOptional(first.inputTokens, second.inputTokens),
    outputTokens: sumOptional(first.outputTokens, second.outputTokens),
    cachedInputTokens: sumOptional(first.cachedInputTokens, second.cachedInputTokens),
    cacheWriteTokens: sumOptional(first.cacheWriteTokens, second.cacheWriteTokens),
    reasoningTokens: sumOptional(first.reasoningTokens, second.reasoningTokens),
  };
}

export function combineSandboxLibraryGenerationCost(
  firstCostUsd: number | undefined,
  secondCostUsd: number | undefined,
): number | undefined {
  return firstCostUsd === undefined && secondCostUsd === undefined
    ? undefined
    : (firstCostUsd ?? 0) + (secondCostUsd ?? 0);
}

function sumOptional(first: number | undefined, second: number | undefined) {
  return first === undefined && second === undefined ? undefined : (first ?? 0) + (second ?? 0);
}
