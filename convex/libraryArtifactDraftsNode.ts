"use node";

import { createHash } from "node:crypto";
import { stepCountIs } from "ai";
import { z } from "zod";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { generateObjectViaGateway, generateViaGateway } from "./lib/llmGateway";
import type { LlmProvider, NormalizedUsage } from "./lib/llmProvider";
import { getCatalogEntry, isSupportedReasoningEffort, type ReasoningEffort } from "./lib/llmCatalog";
import { logErrorWithId, logInfo } from "./lib/observability";
import { retrieveArtifactChunks, type RetrievedChunk } from "./lib/artifactRag";
import { validateHtmlArtifact } from "./lib/htmlArtifacts";
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
import { buildUsageSourceId, type UsageAccountingPolicy } from "./lib/usageAccounting";
import { ARTIFACT_DRAFT_PROMPT_VERSION } from "./libraryArtifactDrafts";

const ARTIFACT_DRAFT_STEP_BUDGET = 12;
const HTML_DRAFT_RETRIEVAL_TOP_N = 10;
const HTML_DRAFT_RETRIEVAL_CANDIDATE_K = 24;
const HTML_DRAFT_CONTEXT_CHAR_LIMIT = 60_000;
const HTML_DRAFT_FULL_ARTIFACT_CHAR_LIMIT = 35_000;
const HTML_DRAFT_REPAIR_ATTEMPTS = 2;

const draftOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  contentMarkdown: z.string().min(1),
  changeSummary: z.string().nullable(),
});

const htmlDraftOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  contentMarkdown: z.string().min(1),
  html: z.string().min(1),
});

type DraftUsageAccounting = {
  sourceId: string;
  occurredAtMs: number;
  usage: NormalizedUsage;
  totalCostUsd: number | undefined;
  sandboxDailyCap: UsageAccountingPolicy["sandboxDailyCap"];
  handled: boolean;
};

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

    let usageAccounting: DraftUsageAccounting | undefined;

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

      if ((context.draft.outputFormat ?? "markdown") === "html") {
        const startedAt = Date.now();
        const sourceId = buildUsageSourceId.artifactDraft(args.jobId, startedAt);
        usageAccounting = {
          sourceId,
          occurredAtMs: startedAt,
          usage: {},
          totalCostUsd: undefined,
          sandboxDailyCap: "none",
          handled: false,
        };
        await ctx.runMutation(internal.libraryArtifactDrafts.assertDraftCostBudget, {
          ownerTokenIdentifier: args.ownerTokenIdentifier,
          repositoryId: args.repositoryId,
          jobId: args.jobId,
          startedAt,
          sandboxDailyCap: usageAccounting.sandboxDailyCap,
        });
        await runHtmlArtifactDraft(ctx, args, context, usageAccounting);
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
        sandboxDailyCap: "precheckAndSettle",
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
        outputFormat: "markdown",
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

async function runHtmlArtifactDraft(
  ctx: ActionCtx,
  args: {
    draftId: Id<"artifactDrafts">;
    jobId: Id<"jobs">;
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
  },
  context: {
    draft: Doc<"artifactDrafts">;
    repository: Doc<"repositories">;
    targetArtifact: Doc<"artifacts"> | null;
  },
  usageAccounting: DraftUsageAccounting,
): Promise<void> {
  const modelChoice = resolveHtmlDraftModelChoice({
    provider: context.draft.generatedByProvider,
    modelName: context.draft.generatedByModel,
    reasoningEffort: context.draft.reasoningEffort,
  });

  await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
    jobId: args.jobId,
    stage: "Retrieving Library knowledge…",
    progress: 0.2,
  });

  const retrievedChunks = await retrieveArtifactChunks(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    query: context.draft.prompt,
    topN: HTML_DRAFT_RETRIEVAL_TOP_N,
    candidateK: HTML_DRAFT_RETRIEVAL_CANDIDATE_K,
    ...(context.draft.threadId !== undefined ? { threadId: context.draft.threadId } : {}),
  });

  await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
    jobId: args.jobId,
    stage: "Drafting HTML report…",
    progress: 0.55,
  });

  const prompt = buildHtmlReportPrompt(context, retrievedChunks);
  const result = await generateObjectViaGateway(
    ctx,
    {
      provider: modelChoice.provider,
      modelName: modelChoice.modelName,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      capability: "library",
      feature: "system_design",
      jobId: args.jobId,
      threadId: context.draft.threadId,
    },
    {
      system: buildHtmlSystemPrompt(),
      prompt,
      schema: htmlDraftOutputSchema,
      schemaName: "library_html_report_draft",
      schemaDescription: "A Library-grounded self-contained HTML report draft with a markdown companion.",
      reasoningEffort: modelChoice.reasoningEffort,
    },
  );

  let output = normalizeHtmlDraftObject(result.object);
  let usage = result.usage;
  let totalCostUsd = result.costUsd;
  usageAccounting.usage = usage;
  usageAccounting.totalCostUsd = totalCostUsd;

  await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
    jobId: args.jobId,
    stage: "Validating HTML report…",
    progress: 0.78,
  });

  let validation = validateHtmlArtifact(output.html);
  for (let attempt = 0; !validation.valid && attempt < HTML_DRAFT_REPAIR_ATTEMPTS; attempt += 1) {
    const repair = await generateObjectViaGateway(
      ctx,
      {
        provider: modelChoice.provider,
        modelName: modelChoice.modelName,
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        capability: "library",
        feature: "system_design",
        jobId: args.jobId,
        threadId: context.draft.threadId,
      },
      {
        system: buildHtmlRepairSystemPrompt(),
        prompt: buildHtmlRepairPrompt(output, validation.errors),
        schema: htmlDraftOutputSchema,
        schemaName: "library_html_report_repair",
        schemaDescription: "A fully corrected HTML report object that satisfies the validation policy.",
        reasoningEffort: modelChoice.reasoningEffort,
      },
    );
    usage = combineSandboxLibraryGenerationUsage(usage, repair.usage);
    totalCostUsd = combineSandboxLibraryGenerationCost(totalCostUsd, repair.costUsd);
    usageAccounting.usage = usage;
    usageAccounting.totalCostUsd = totalCostUsd;
    output = normalizeHtmlDraftObject(repair.object);
    validation = validateHtmlArtifact(output.html);
  }

  if (!validation.valid) {
    throw new Error(`HTML report failed validation: ${validation.errors.join("; ")}`);
  }

  await ctx.runMutation(internal.libraryArtifactDrafts.updateDraftProgress, {
    jobId: args.jobId,
    stage: "Storing HTML report…",
    progress: 0.9,
  });

  const stored = await storeHtmlArtifactSource(ctx, validation.html);
  const sourceArtifacts = sourceArtifactsFromContext(context, retrievedChunks);
  const sourceChunkIds = retrievedChunks.map((chunk) => chunk.chunkId);

  const readyResult: { ready: boolean } = await ctx.runMutation(internal.libraryArtifactDrafts.markDraftReady, {
    draftId: args.draftId,
    jobId: args.jobId,
    title: output.title,
    summary: output.summary,
    contentMarkdown: output.contentMarkdown,
    outputFormat: "html",
    htmlStorageId: stored.storageId,
    htmlHash: stored.htmlHash,
    htmlByteLength: stored.htmlByteLength,
    sourceArtifacts,
    sourceChunkIds,
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
    sourceId: usageAccounting.sourceId,
    usageSandboxDailyCap: usageAccounting.sandboxDailyCap,
  });
  if (!readyResult.ready) {
    try {
      await ctx.storage.delete(stored.storageId);
    } catch {
      // The ready mutation may already have deleted the blob if the repository became inactive.
    }
    throw new Error("HTML artifact draft could not be marked ready.");
  }
  usageAccounting.handled = true;

  logInfo("artifactDraft", "html_draft_ready", {
    draftId: args.draftId,
    jobId: args.jobId,
    repositoryId: args.repositoryId,
    provider: modelChoice.provider,
    modelName: modelChoice.modelName,
    sourceChunkCount: sourceChunkIds.length,
    htmlByteLength: stored.htmlByteLength,
  });
}

function resolveHtmlDraftModelChoice(args: {
  provider: LlmProvider | undefined;
  modelName: string | undefined;
  reasoningEffort: ReasoningEffort | undefined;
}): { provider: LlmProvider; modelName: string; reasoningEffort: ReasoningEffort | undefined } {
  if (!args.provider || !args.modelName) {
    throw new Error("HTML artifact draft job is missing its model selection.");
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

function normalizeHtmlDraftObject(output: z.infer<typeof htmlDraftOutputSchema>) {
  return {
    title: output.title.trim(),
    summary: output.summary.trim(),
    contentMarkdown: output.contentMarkdown.trim(),
    html: output.html.trim(),
  };
}

async function storeHtmlArtifactSource(
  ctx: ActionCtx,
  html: string,
): Promise<{ storageId: Id<"_storage">; htmlHash: string; htmlByteLength: number }> {
  const htmlHash = createHash("sha256").update(html, "utf8").digest("hex");
  const htmlByteLength = new TextEncoder().encode(html).byteLength;
  const storageId = await ctx.storage.store(new Blob([html], { type: "text/html; charset=utf-8" }));
  return { storageId, htmlHash, htmlByteLength };
}

function buildHtmlSystemPrompt() {
  return [
    "You draft Library HTML report artifacts for Systify.",
    "Library markdown artifacts and retrieved chunks are the knowledge source. Do not claim you inspected live source code.",
    "Return a full structured object with title, summary, contentMarkdown, and html.",
    "contentMarkdown is the canonical searchable companion. Make it non-empty, source/provenance friendly, and include citations to the provided Library evidence labels.",
    "html is a presentation artifact. It must be a complete self-contained HTML document.",
    "HTML requirements: <!doctype html>, html/head/body, UTF-8 meta, responsive viewport meta, non-empty body, inline CSS only, no JavaScript, no forms, no iframes, no external network resources, no non-fragment links.",
    "Use semantic HTML and polished inline CSS. Fragment-only anchors such as #section are allowed.",
  ].join("\n");
}

function buildHtmlRepairSystemPrompt() {
  return [
    "You repair a Library HTML report artifact so it satisfies a strict validation policy.",
    "Return a full corrected object with title, summary, contentMarkdown, and html.",
    "Do not add new facts or external resources. Preserve the markdown companion unless the validation error requires a minimal correction.",
    "The html field must be a complete self-contained HTML document with no JavaScript, no forms, no iframes, no external URLs, and no non-fragment links.",
  ].join("\n");
}

function buildHtmlReportPrompt(
  context: {
    draft: Doc<"artifactDrafts">;
    repository: Doc<"repositories">;
    targetArtifact: Doc<"artifacts"> | null;
  },
  chunks: RetrievedChunk[],
): string {
  const sections: string[] = [
    `Repository: ${context.repository.sourceRepoFullName}`,
    `Operation: ${context.draft.operation}`,
    `Requested title: ${context.draft.title}`,
    `User instruction: ${context.draft.prompt}`,
    "Use only the Library evidence below. If evidence is insufficient for a claim, omit the claim or qualify it.",
    "Cite evidence in contentMarkdown with the provided source labels, such as [S1]. HTML may include a short Sources section using the same labels.",
  ];

  let budgetUsed = sections.join("\n\n").length;
  if (context.targetArtifact && context.targetArtifact.contentMarkdown.length <= HTML_DRAFT_FULL_ARTIFACT_CHAR_LIMIT) {
    const fullTarget = [
      "Explicitly scoped artifact full markdown:",
      `[TARGET] ${context.targetArtifact.title} v${context.targetArtifact.version}`,
      context.targetArtifact.contentMarkdown,
    ].join("\n");
    if (budgetUsed + fullTarget.length <= HTML_DRAFT_CONTEXT_CHAR_LIMIT) {
      sections.push(fullTarget);
      budgetUsed += fullTarget.length;
    }
  }

  const chunkSections: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const label = `S${index + 1}`;
    const heading = chunk.headingPath.length > 0 ? ` > ${chunk.headingPath.join(" > ")}` : "";
    const content = [`[${label}] ${chunk.artifactTitle} v${chunk.artifactVersion}${heading}`, chunk.content].join("\n");
    if (budgetUsed + content.length > HTML_DRAFT_CONTEXT_CHAR_LIMIT) {
      break;
    }
    chunkSections.push(content);
    budgetUsed += content.length;
  }

  if (chunkSections.length > 0) {
    sections.push(["Retrieved Library chunks:", ...chunkSections].join("\n\n"));
  } else {
    sections.push(
      "Retrieved Library chunks: none. Keep the report conservative and explain that no matching Library chunks were found.",
    );
  }

  return sections.join("\n\n");
}

function buildHtmlRepairPrompt(output: ReturnType<typeof normalizeHtmlDraftObject>, errors: string[]): string {
  return [
    "Validation errors:",
    ...errors.map((error) => `- ${error}`),
    "",
    "Previous full object:",
    JSON.stringify(output),
  ].join("\n");
}

function sourceArtifactsFromContext(
  context: {
    targetArtifact: Doc<"artifacts"> | null;
  },
  chunks: RetrievedChunk[],
): Array<{ artifactId: Id<"artifacts">; version: number; title: string }> {
  const sourceArtifacts = new Map<Id<"artifacts">, { artifactId: Id<"artifacts">; version: number; title: string }>();
  if (context.targetArtifact) {
    sourceArtifacts.set(context.targetArtifact._id, {
      artifactId: context.targetArtifact._id,
      version: context.targetArtifact.version,
      title: context.targetArtifact.title,
    });
  }
  for (const chunk of chunks) {
    if (!sourceArtifacts.has(chunk.artifactId)) {
      sourceArtifacts.set(chunk.artifactId, {
        artifactId: chunk.artifactId,
        version: chunk.artifactVersion,
        title: chunk.artifactTitle,
      });
    }
  }
  return [...sourceArtifacts.values()];
}

async function settleFailedDraftUsage(
  ctx: ActionCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Doc<"repositories">["_id"];
    accounting: DraftUsageAccounting;
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
      sandboxDailyCap: args.accounting.sandboxDailyCap,
      occurredAtMs: args.accounting.occurredAtMs,
    });
    return;
  }

  await ctx.runMutation(internal.lib.usageAccountingMutations.settleUsageLifecycle, {
    sourceId: args.accounting.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    feature: "systemDesignGeneration",
    sandboxDailyCap: args.accounting.sandboxDailyCap,
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
