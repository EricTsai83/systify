"use node";

import { stepCountIs } from "ai";
import { z } from "zod";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { generateObjectViaGateway, generateViaGateway } from "./lib/llmGateway";
import type { NormalizedUsage } from "./lib/llmProvider";
import { logErrorWithId, logInfo } from "./lib/observability";
import {
  ARTIFACT_DRAFT_SANDBOX_STAGE_LABELS,
  combineSandboxLibraryGenerationCost,
  combineSandboxLibraryGenerationUsage,
  createSandboxLibraryGenerationTools,
  prepareSandboxLibraryGeneration,
  resolveSandboxLibraryGenerationModelChoice,
  type EnsureSandboxReadyResult,
} from "./lib/sandboxLibraryGeneration";
import { SandboxPreparationError } from "./lib/sandboxLiveness";
import { buildUsageSourceId } from "./lib/usageAccounting";
import { ARTIFACT_DRAFT_PROMPT_VERSION } from "./libraryArtifactDrafts";

const ARTIFACT_DRAFT_STEP_BUDGET = 12;

const draftOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  contentMarkdown: z.string().min(1),
  changeSummary: z.string().nullable(),
});

export const runArtifactDraft = internalAction({
  args: {
    draftId: v.id("artifactDrafts"),
    jobId: v.id("jobs"),
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const started = await ctx.runMutation(internal.libraryArtifactDrafts.markDraftRunning, {
      draftId: args.draftId,
      jobId: args.jobId,
    });
    if (!started.started) {
      return;
    }

    let usageAccounting:
      | {
          sourceId: string;
          occurredAtMs: number;
          usage: NormalizedUsage;
          totalCostUsd: number | undefined;
          handled: boolean;
        }
      | undefined;

    try {
      const context = await ctx.runQuery(internal.libraryArtifactDrafts.getDraftGenerationContext, {
        draftId: args.draftId,
        repositoryId: args.repositoryId,
        ownerTokenIdentifier: args.ownerTokenIdentifier,
      });
      if (context === null) {
        await ctx.runMutation(internal.libraryArtifactDrafts.failDraft, {
          draftId: args.draftId,
          jobId: args.jobId,
          errorMessage: "Repository or draft context was no longer available.",
        });
        return;
      }

      let prepared: EnsureSandboxReadyResult;
      try {
        prepared = await prepareSandboxLibraryGeneration(ctx, {
          repositoryId: args.repositoryId,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
          onStage: async (stage) => {
            await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
              jobId: args.jobId,
              stage: ARTIFACT_DRAFT_SANDBOX_STAGE_LABELS[stage],
              progress: stage === "cloning" ? 0.25 : 0.15,
            });
          },
        });
      } catch (error) {
        const message =
          error instanceof SandboxPreparationError
            ? toCodeAccessUserMessage(error.userFacingMessage)
            : "Repository code access was not available. Regenerate to try again.";
        await ctx.runMutation(internal.libraryArtifactDrafts.failDraft, {
          draftId: args.draftId,
          jobId: args.jobId,
          errorMessage: message,
        });
        if (error instanceof SandboxPreparationError) {
          logInfo("artifactDraft", "draft_failed_live_source_prep", {
            draftId: args.draftId,
            jobId: args.jobId,
            repositoryId: args.repositoryId,
            reason: error.reason,
          });
          return;
        }
        throw error;
      }

      const modelChoice = resolveSandboxLibraryGenerationModelChoice({
        provider: context.draft.generatedByProvider,
        modelName: context.draft.generatedByModel,
        reasoningEffort: context.draft.reasoningEffort,
        missingSelectionMessage: "Artifact draft job is missing its model selection.",
      });
      const startedAt = Date.now();
      const sourceId = buildUsageSourceId.artifactDraft(args.jobId, startedAt);
      usageAccounting = {
        sourceId,
        occurredAtMs: startedAt,
        usage: {},
        totalCostUsd: undefined,
        handled: false,
      };
      await ctx.runMutation(internal.libraryArtifactDrafts.assertDraftCostBudget, {
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        repositoryId: args.repositoryId,
        jobId: args.jobId,
        startedAt,
      });

      await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
        jobId: args.jobId,
        stage: "Drafting from codebase…",
        progress: 0.45,
      });

      const draftResult = await generateViaGateway(
        ctx,
        {
          provider: modelChoice.provider,
          modelName: modelChoice.modelName,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
          capability: "sandbox",
          feature: "system_design",
          jobId: args.jobId,
          threadId: context.draft.threadId,
        },
        {
          system: buildSystemPrompt(context.draft.operation),
          prompt: buildUserPrompt(context, prepared),
          tools: await createSandboxLibraryGenerationTools(prepared),
          stopWhen: stepCountIs(ARTIFACT_DRAFT_STEP_BUDGET),
          prepareStep: ({ stepNumber }) => {
            if (stepNumber === 0) {
              return undefined;
            }
            const remaining = ARTIFACT_DRAFT_STEP_BUDGET - stepNumber;
            return {
              system: `${buildSystemPrompt(context.draft.operation)}\n\n[Tool-budget reminder: you have used ${stepNumber} of ${ARTIFACT_DRAFT_STEP_BUDGET} tool steps; ${remaining} remain. If your evidence is sufficient, stop using tools and return the final structured object now. When 2 or fewer steps remain, prioritize producing the schema-valid object over additional inspection.]`,
            };
          },
          reasoningEffort: modelChoice.reasoningEffort,
        },
      );
      usageAccounting.usage = draftResult.usage;
      usageAccounting.totalCostUsd = draftResult.costUsd;
      const draftText = draftResult.text.trim();
      if (draftText.length === 0) {
        throw new Error("Artifact draft model returned an empty draft.");
      }

      await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
        jobId: args.jobId,
        stage: "Structuring draft…",
        progress: 0.75,
      });

      const result = await generateObjectViaGateway(
        ctx,
        {
          provider: modelChoice.provider,
          modelName: modelChoice.modelName,
          ownerTokenIdentifier: args.ownerTokenIdentifier,
          capability: "sandbox",
          feature: "system_design",
          jobId: args.jobId,
          threadId: context.draft.threadId,
        },
        {
          system: buildStructuringSystemPrompt(),
          prompt: buildStructuringPrompt(draftText),
          schema: draftOutputSchema,
          schemaName: "library_artifact_draft",
          schemaDescription: "A codebase-grounded Library artifact draft for human review before applying.",
          reasoningEffort: modelChoice.reasoningEffort,
        },
      );
      const usage = combineSandboxLibraryGenerationUsage(draftResult.usage, result.usage);
      const totalCostUsd = combineSandboxLibraryGenerationCost(draftResult.costUsd, result.costUsd);
      usageAccounting.usage = usage;
      usageAccounting.totalCostUsd = totalCostUsd;

      const output = result.object;
      const readyResult: { ready: boolean } = await ctx.runMutation(internal.libraryArtifactDrafts.markDraftReady, {
        draftId: args.draftId,
        jobId: args.jobId,
        title: output.title.trim(),
        summary: output.summary.trim(),
        contentMarkdown: output.contentMarkdown.trim(),
        changeSummary: output.changeSummary?.trim() || undefined,
        sandboxId: prepared.sandboxId,
        alignedImportCommitSha: context.repository.lastSyncedCommitSha,
        generatedByProvider: modelChoice.provider,
        generatedByModel: modelChoice.modelName,
        reasoningEffort: modelChoice.reasoningEffort,
        promptVersion: ARTIFACT_DRAFT_PROMPT_VERSION,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        totalCostUsd,
        sourceId,
      });
      if (!readyResult.ready) {
        throw new Error("Artifact draft could not be marked ready.");
      }
      usageAccounting.handled = true;

      logInfo("artifactDraft", "draft_ready", {
        draftId: args.draftId,
        jobId: args.jobId,
        repositoryId: args.repositoryId,
        provider: modelChoice.provider,
        modelName: modelChoice.modelName,
      });
    } catch (error) {
      if (usageAccounting && !usageAccounting.handled) {
        await settleFailedDraftUsage(ctx, {
          ownerTokenIdentifier: args.ownerTokenIdentifier,
          repositoryId: args.repositoryId,
          accounting: usageAccounting,
        });
        usageAccounting.handled = true;
      }
      const errorId = logErrorWithId("artifactDraft", "draft_generation_failed", error, {
        draftId: args.draftId,
        jobId: args.jobId,
        repositoryId: args.repositoryId,
      });
      await ctx.runMutation(internal.libraryArtifactDrafts.failDraft, {
        draftId: args.draftId,
        jobId: args.jobId,
        errorMessage: `Artifact draft failed. Regenerate to try again. (ref: ${errorId})`,
      });
    }
  },
});

async function settleFailedDraftUsage(
  ctx: ActionCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Doc<"repositories">["_id"];
    accounting: {
      sourceId: string;
      occurredAtMs: number;
      usage: NormalizedUsage;
      totalCostUsd: number | undefined;
    };
  },
): Promise<void> {
  const hasUsage =
    args.accounting.totalCostUsd !== undefined ||
    args.accounting.usage.inputTokens !== undefined ||
    args.accounting.usage.outputTokens !== undefined ||
    args.accounting.usage.cachedInputTokens !== undefined ||
    args.accounting.usage.cacheWriteTokens !== undefined ||
    args.accounting.usage.reasoningTokens !== undefined;

  if (!hasUsage) {
    await ctx.runMutation(internal.lib.usageAccountingMutations.releaseUsageLifecycle, {
      sourceId: args.accounting.sourceId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      feature: "systemDesignGeneration",
      occurredAtMs: args.accounting.occurredAtMs,
    });
    return;
  }

  await ctx.runMutation(internal.lib.usageAccountingMutations.settleUsageLifecycle, {
    sourceId: args.accounting.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    feature: "systemDesignGeneration",
    occurredAtMs: args.accounting.occurredAtMs,
    usage: {
      ...(args.accounting.totalCostUsd !== undefined ? { costUsd: args.accounting.totalCostUsd } : {}),
      ...(args.accounting.usage.inputTokens !== undefined ? { inputTokens: args.accounting.usage.inputTokens } : {}),
      ...(args.accounting.usage.outputTokens !== undefined ? { outputTokens: args.accounting.usage.outputTokens } : {}),
      ...(args.accounting.usage.cachedInputTokens !== undefined
        ? { cachedInputTokens: args.accounting.usage.cachedInputTokens }
        : {}),
      ...(args.accounting.usage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: args.accounting.usage.cacheWriteTokens }
        : {}),
      ...(args.accounting.usage.reasoningTokens !== undefined
        ? { reasoningTokens: args.accounting.usage.reasoningTokens }
        : {}),
    },
  });
}

function toCodeAccessUserMessage(message: string) {
  return message
    .replaceAll("Live source", "Repository code access")
    .replaceAll("live source", "repository code access");
}

function buildSystemPrompt(operation: "create" | "update") {
  const operationInstruction =
    operation === "create"
      ? "Create one new standalone Library artifact grounded in the repository codebase."
      : "Update the provided Library artifact. Treat the current artifact only as the revision target: preserve useful structure where it still fits, but replace stale or incomplete sections with codebase-grounded content.";
  return [
    "You draft Library artifacts for Systify. The user will review your draft before anything is written.",
    "The repository codebase is the single source of truth for implementation facts.",
    "You must inspect the repository code with the provided tools before drafting.",
    "Existing Library artifacts are not factual sources. Use them only for target title, structure, prior wording, and user intent.",
    "Do not keep or copy a factual claim from an existing artifact unless you verify it against the codebase in this run.",
    "When an existing artifact disagrees with the codebase, the codebase wins. Replace the stale claim or omit it.",
    "Use citations in prose with file paths and line references when you make source-backed claims.",
    "Return only the structured object requested by the schema. The contentMarkdown field must contain the full proposed markdown document.",
    operationInstruction,
  ].join("\n");
}

function buildUserPrompt(
  context: {
    draft: Doc<"artifactDrafts">;
    repository: Doc<"repositories">;
    targetArtifact: Doc<"artifacts"> | null;
  },
  prepared: EnsureSandboxReadyResult,
) {
  const target =
    context.targetArtifact === null
      ? ""
      : [
          "\nTarget artifact to revise. Use this as structure and prior wording only; verify every factual claim against the repository code before keeping it:",
          `Title: ${context.targetArtifact.title}`,
          `Summary: ${context.targetArtifact.summary}`,
          `Version: ${context.targetArtifact.version}`,
          "Current markdown:",
          context.targetArtifact.contentMarkdown,
        ].join("\n");
  return [
    `Repository: ${context.repository.sourceRepoFullName}`,
    `Repository path: ${prepared.repoPath}`,
    `Operation: ${context.draft.operation}`,
    `Requested title: ${context.draft.title}`,
    `User instruction: ${context.draft.prompt}`,
    target,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildStructuringSystemPrompt() {
  return [
    "You convert a codebase-grounded artifact draft into the requested structured object.",
    "Do not add new implementation facts, files, citations, or claims that are not present in the draft.",
    "Preserve the markdown document content and source citations from the draft.",
    "Return only the structured object requested by the schema.",
  ].join("\n");
}

function buildStructuringPrompt(draftText: string) {
  return [
    "Convert this draft into the schema fields:",
    "- title: concise artifact title",
    "- summary: one short sentence describing the artifact",
    "- contentMarkdown: the full markdown document",
    "- changeSummary: a short human-readable summary of what changed, or null if there is no useful change summary",
    "",
    "Draft:",
    draftText,
  ].join("\n");
}
