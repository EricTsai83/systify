"use node";

/**
 * System Design kind-run executor.
 *
 * The Interface is intentionally small: execute one selected System Design
 * kind and return whether the job-level orchestrator should count it as
 * succeeded. The Implementation hides the cache probe, budget check, LLM
 * call, quality gate, artifact persistence, kind-run telemetry row, cost
 * settlement, and per-kind metrics.
 */

import { APICallError, stepCountIs } from "ai";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { createSandboxTools } from "./chat/sandboxTools";
import { getSandboxFsClient } from "./daytona";
import { generateViaGateway, LlmRateLimitError } from "./lib/llmGateway";
import type { LlmProvider, NormalizedUsage } from "./lib/llmProvider";
import { emitMetric, logErrorWithId, logWarn } from "./lib/observability";
import { SandboxPreparationError, type EnsureSandboxReadyResult } from "./lib/sandboxLiveness";
import { SYSTEM_DESIGN_KIND_TITLES, type SystemDesignKind } from "./lib/systemDesign";
import {
  budgetSuffix,
  getKindRunConfig,
  validateMermaidBlock,
  validateRequiredSections,
} from "./lib/systemDesignPrompts";
import { isUsageBudgetExceededError } from "./lib/userCost";
import type { ReasoningEffort } from "./lib/llmCatalog";

type KindRunStatus = Doc<"systemDesignKindRuns">["status"];
type KindFailureReason = NonNullable<Doc<"systemDesignKindRuns">["failureReason"]>;

interface SystemDesignKindRunModelChoice {
  provider: LlmProvider;
  modelName: string;
}

export interface RunSystemDesignKindArgs {
  jobId: Id<"jobs">;
  repositoryId: Id<"repositories">;
  ownerTokenIdentifier: string;
  kind: SystemDesignKind;
  repository: Doc<"repositories">;
  prepared: EnsureSandboxReadyResult;
  modelChoice: SystemDesignKindRunModelChoice;
  reasoningEffort: ReasoningEffort | undefined;
  commitSha?: string;
  forceRegenerate: boolean;
}

export interface SystemDesignKindRunOutcome {
  kind: SystemDesignKind;
  title: string;
  status: KindRunStatus;
  countsAsSucceeded: boolean;
}

export async function runSystemDesignKind(
  ctx: ActionCtx,
  args: RunSystemDesignKindArgs,
): Promise<SystemDesignKindRunOutcome> {
  const startedAt = Date.now();
  const config = getKindRunConfig(args.kind);
  const title = SYSTEM_DESIGN_KIND_TITLES[args.kind];

  emitMetric("systemdesign_kind_started", {
    tags: {
      kind: args.kind,
      provider: args.modelChoice.provider,
      model: args.modelChoice.modelName,
      prompt_version: config.promptVersion,
    },
    details: { jobId: args.jobId, repositoryId: args.repositoryId },
  });

  let runStatus: KindRunStatus = "failed";
  let failureReason: KindFailureReason | undefined;
  let artifactId: Id<"artifacts"> | undefined;
  let usage: NormalizedUsage = {};
  let costUsd: number | undefined;
  let actualSteps = 0;
  let outputCharLength = 0;
  let missingSections: string[] | undefined;

  if (!args.forceRegenerate && args.commitSha) {
    const cached = await ctx.runQuery(internal.systemDesign.findCachedArtifact, {
      repositoryId: args.repositoryId,
      kind: args.kind,
      alignedImportCommitSha: args.commitSha,
      generatedByProvider: args.modelChoice.provider,
      generatedByModel: args.modelChoice.modelName,
      promptVersion: config.promptVersion,
    });
    if (cached) {
      runStatus = "cached_hit";
      artifactId = cached._id;
      outputCharLength = cached.contentMarkdown.length;
      emitMetric("systemdesign_kind_cache_hit", {
        tags: { kind: args.kind, provider: args.modelChoice.provider, model: args.modelChoice.modelName },
        details: { repositoryId: args.repositoryId, commitSha: args.commitSha },
      });
    }
  }

  if (runStatus !== "cached_hit") {
    try {
      await ctx.runMutation(internal.systemDesign.assertKindCostBudget, {
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        repositoryId: args.repositoryId,
        jobId: args.jobId,
        kind: args.kind,
        startedAt,
      });

      const result = await generateViaGateway(
        ctx,
        {
          provider: args.modelChoice.provider,
          modelName: args.modelChoice.modelName,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
          capability: "sandbox",
          feature: "system_design",
          jobId: args.jobId,
        },
        {
          system: config.prompt + budgetSuffix(config.stepBudget),
          prompt: buildUserPrompt(args.repository),
          tools: createSandboxTools(await getSandboxFsClient(args.prepared.remoteId), args.prepared.repoPath),
          stopWhen: stepCountIs(config.stepBudget),
          reasoningEffort: args.reasoningEffort,
        },
      );

      usage = result.usage;
      costUsd = result.costUsd;
      actualSteps = result.steps.length;
      const text = result.text.trim();
      outputCharLength = text.length;

      if (text.length === 0) {
        runStatus = "failed";
        failureReason = "model_empty_output";
      } else {
        const validation = validateRequiredSections(text, config.expectedSections);
        const mermaidOk = args.kind !== "architecture_diagram" || validateMermaidBlock(text);
        if (!validation.ok || !mermaidOk) {
          runStatus = "quality_rejected";
          failureReason = "output_quality";
          missingSections = [...validation.missingSections];
          if (!mermaidOk) {
            missingSections.push("mermaid_block");
          }
        } else {
          const persisted = await ctx.runMutation(internal.systemDesign.persistGeneratedArtifact, {
            repositoryId: args.repositoryId,
            ownerTokenIdentifier: args.ownerTokenIdentifier,
            jobId: args.jobId,
            kind: args.kind,
            title,
            summary: extractSummary(text),
            contentMarkdown: text,
            alignedImportCommitSha: args.commitSha,
            generatedByProvider: args.modelChoice.provider,
            generatedByModel: args.modelChoice.modelName,
            promptVersion: config.promptVersion,
          });
          artifactId = persisted.artifactId;
          runStatus = "succeeded";
        }
      }
    } catch (error) {
      runStatus = "failed";
      failureReason = classifySystemDesignKindRunError(error);
      const errorId = logErrorWithId("systemDesign", "kind_generation_failed", error, {
        jobId: args.jobId,
        repositoryId: args.repositoryId,
        kind: args.kind,
        provider: args.modelChoice.provider,
        modelName: args.modelChoice.modelName,
        failureReason,
      });
      logWarn("systemDesign", "kind_skipped", {
        jobId: args.jobId,
        kind: args.kind,
        errorId,
        failureReason,
      });
      const rawMessage = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.systemDesign.recordKindFailure, {
        jobId: args.jobId,
        kind: args.kind,
        errorId,
        message: rawMessage,
        reason: failureReason,
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  const recorded = await ctx.runMutation(internal.systemDesign.recordKindRun, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    jobId: args.jobId,
    kind: args.kind,
    ...(runStatus === "cached_hit" && artifactId ? { artifactId } : {}),
    provider: args.modelChoice.provider,
    modelName: args.modelChoice.modelName,
    promptVersion: config.promptVersion,
    alignedImportCommitSha: args.commitSha,
    stepCap: config.stepBudget,
    actualSteps,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
    totalCostUsd: costUsd,
    durationMs,
    status: runStatus,
    failureReason,
    outputCharLength: outputCharLength > 0 ? outputCharLength : undefined,
    missingSections,
    startedAt,
    sourceId: `systemDesign:${args.jobId}:${args.kind}:${startedAt}`,
  });

  if (artifactId && runStatus !== "cached_hit") {
    await ctx.runMutation(internal.systemDesign.linkKindRun, {
      artifactId,
      kindRunId: recorded.kindRunId,
    });
  }

  emitKindRunMetrics({
    jobId: args.jobId,
    kind: args.kind,
    provider: args.modelChoice.provider,
    modelName: args.modelChoice.modelName,
    status: runStatus,
    failureReason,
    durationMs,
    stepBudget: config.stepBudget,
    actualSteps,
    usage,
    costUsd,
  });

  return {
    kind: args.kind,
    title,
    status: runStatus,
    countsAsSucceeded: runStatus === "succeeded" || runStatus === "cached_hit",
  };
}

function emitKindRunMetrics(args: {
  jobId: Id<"jobs">;
  kind: SystemDesignKind;
  provider: LlmProvider;
  modelName: string;
  status: KindRunStatus;
  failureReason: KindFailureReason | undefined;
  durationMs: number;
  stepBudget: number;
  actualSteps: number;
  usage: NormalizedUsage;
  costUsd: number | undefined;
}): void {
  emitMetric("systemdesign_kind_duration_ms", {
    value: args.durationMs,
    tags: {
      kind: args.kind,
      provider: args.provider,
      model: args.modelName,
      status: args.status,
    },
    details: { jobId: args.jobId },
  });
  emitMetric("systemdesign_kind_steps_used", {
    value: args.actualSteps,
    tags: {
      kind: args.kind,
      provider: args.provider,
      model: args.modelName,
      hit_budget: args.actualSteps >= args.stepBudget,
    },
    details: { jobId: args.jobId },
  });
  if (args.costUsd !== undefined) {
    emitMetric("systemdesign_kind_cost_usd", {
      value: args.costUsd,
      tags: { kind: args.kind, provider: args.provider, model: args.modelName },
      details: { jobId: args.jobId },
    });
  }
  if (args.usage.inputTokens !== undefined || args.usage.outputTokens !== undefined) {
    emitMetric("systemdesign_kind_tokens", {
      tags: { kind: args.kind, provider: args.provider, model: args.modelName },
      details: {
        input: args.usage.inputTokens,
        output: args.usage.outputTokens,
        cached_input: args.usage.cachedInputTokens,
        cache_write: args.usage.cacheWriteTokens,
        reasoning: args.usage.reasoningTokens,
      },
    });
  }
  if (args.status === "failed" || args.status === "quality_rejected") {
    emitMetric("systemdesign_kind_failed", {
      tags: {
        kind: args.kind,
        provider: args.provider,
        model: args.modelName,
        reason: args.failureReason ?? "unknown",
      },
      details: { jobId: args.jobId },
    });
  }
}

/**
 * Map an LLM call exception into one of the structured
 * `kindFailureReason` literals.
 */
function classifySystemDesignKindRunError(error: unknown): KindFailureReason {
  if (error instanceof SandboxPreparationError) {
    return "live_source_unavailable";
  }
  if (error instanceof LlmRateLimitError) {
    return "transport_rate_limit";
  }
  if (isUsageBudgetExceededError(error)) {
    return "transport_rate_limit";
  }
  if (error instanceof APICallError) {
    if (error.statusCode === 429) {
      return "transport_rate_limit";
    }
    return "transport_other";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/empty document/i.test(message)) {
    return "model_empty_output";
  }
  return "infra";
}

/**
 * Per-kind user-prompt shell. The system prompt carries the per-kind
 * directive; this prompt supplies the repository identity and opening
 * instruction.
 */
function buildUserPrompt(repository: Doc<"repositories">): string {
  return [
    `Repository: ${repository.sourceRepoFullName ?? "(unknown)"}`,
    repository.defaultBranch ? `Default branch: ${repository.defaultBranch}` : null,
    "",
    "Begin by listing the repository root, then inspect the most relevant files",
    "before writing the document. Stay within the repo subtree.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Extract a 1-line preview from a generated markdown document.
 */
function extractSummary(markdown: string): string {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.slice(0, 280);
  }
  return "Generated by Library System Design.";
}
