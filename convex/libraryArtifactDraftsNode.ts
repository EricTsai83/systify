"use node";

import { stepCountIs } from "ai";
import { z } from "zod";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { createSandboxTools } from "./chat/sandboxTools";
import { getSandboxFsClient } from "./daytona";
import type { LlmProvider } from "./lib/llmProvider";
import { getCatalogEntry, isSupportedReasoningEffort, type ReasoningEffort } from "./lib/llmCatalog";
import { generateObjectViaGateway } from "./lib/llmGateway";
import { logErrorWithId, logInfo } from "./lib/observability";
import {
  ensureSandboxReady,
  SandboxPreparationError,
  type EnsureSandboxReadyResult,
  type SandboxPreparationStage,
} from "./lib/sandboxLiveness";
import { ARTIFACT_DRAFT_PROMPT_VERSION } from "./libraryArtifactDrafts";

const ARTIFACT_DRAFT_STEP_BUDGET = 8;

const draftOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  contentMarkdown: z.string().min(1),
  changeSummary: z.string().optional(),
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

      const stageLabel: Record<SandboxPreparationStage, string> = {
        probing: "Preparing live source…",
        waking: "Preparing live source…",
        provisioning: "Preparing live source…",
        cloning: "Reading codebase…",
        polling: "Preparing live source…",
      };
      let prepared: EnsureSandboxReadyResult;
      try {
        prepared = await ensureSandboxReady(
          ctx,
          {
            repositoryId: args.repositoryId,
            ownerTokenIdentifier: args.ownerTokenIdentifier,
          },
          async (stage) => {
            await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
              jobId: args.jobId,
              stage: stageLabel[stage] ?? "Preparing live source…",
              progress: stage === "cloning" ? 0.25 : 0.15,
            });
          },
        );
      } catch (error) {
        const message =
          error instanceof SandboxPreparationError
            ? error.userFacingMessage
            : "Live source was not available. Regenerate to try again.";
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

      const modelChoice = resolveDraftModelChoice({
        provider: context.draft.generatedByProvider,
        modelName: context.draft.generatedByModel,
        reasoningEffort: context.draft.reasoningEffort,
      });
      const startedAt = Date.now();
      await ctx.runMutation(internal.libraryArtifactDrafts.assertDraftCostBudget, {
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        repositoryId: args.repositoryId,
        jobId: args.jobId,
        startedAt,
      });

      await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
        jobId: args.jobId,
        stage: "Drafting artifact…",
        progress: 0.45,
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
          system: buildSystemPrompt(context.draft.operation),
          prompt: buildUserPrompt(context, prepared),
          schema: draftOutputSchema,
          schemaName: "library_artifact_draft",
          schemaDescription: "A proposed Library artifact draft for human review before applying.",
          tools: createSandboxTools(await getSandboxFsClient(prepared.remoteId), prepared.repoPath),
          stopWhen: stepCountIs(ARTIFACT_DRAFT_STEP_BUDGET),
          reasoningEffort: modelChoice.reasoningEffort,
        },
      );

      const output = result.object;
      await ctx.runMutation(internal.libraryArtifactDrafts.markDraftReady, {
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
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        reasoningTokens: result.usage.reasoningTokens,
        totalCostUsd: result.costUsd,
        sourceId: `artifactDraft:${args.jobId}:${startedAt}`,
      });

      logInfo("artifactDraft", "draft_ready", {
        draftId: args.draftId,
        jobId: args.jobId,
        repositoryId: args.repositoryId,
        provider: modelChoice.provider,
        modelName: modelChoice.modelName,
      });
    } catch (error) {
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

function resolveDraftModelChoice(args: {
  provider: LlmProvider | undefined;
  modelName: string | undefined;
  reasoningEffort: ReasoningEffort | undefined;
}): { provider: LlmProvider; modelName: string; reasoningEffort: ReasoningEffort | undefined } {
  if (!args.provider || !args.modelName) {
    throw new Error("Artifact draft job is missing its model selection.");
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

function buildSystemPrompt(operation: "create" | "update") {
  const operationInstruction =
    operation === "create"
      ? "Create one new standalone Library artifact."
      : "Update the provided Library artifact. Preserve useful existing structure, but replace stale or incomplete sections with live-source-grounded content.";
  return [
    "You draft Library artifacts for Systify. The user will review your draft before anything is written.",
    "You must inspect the live repository source with the provided tools before drafting.",
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
          "\nCurrent artifact to update:",
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
