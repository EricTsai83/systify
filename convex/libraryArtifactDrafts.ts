import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { createArtifactWrite, updateArtifactWrite } from "./lib/artifactWrites";
import { llmProviderValidator, type LlmProvider } from "./lib/llmProvider";
import { requireViewerIdentity } from "./lib/auth";
import { assertFeatureAccess, requiresHighReasoningAccess, requiresPremiumModelAccess } from "./lib/entitlements";
import { isOwnedBy, loadOwnedDoc, requireOwnedDoc } from "./lib/ownedDocs";
import {
  isActiveRepository,
  isRepositoryArchived,
  isRepositoryDeleting,
  requireActiveRepositoryForViewer,
} from "./lib/repositoryAccess";
import {
  enqueueJob,
  failRunningJob,
  markQueuedJobRunning,
  runStaleJobRecovery,
  updateRunningJobProgress,
} from "./lib/jobs";
import {
  consumeDaytonaGlobalRateLimit,
  consumeSystemDesignRateLimit,
  SYSTEM_DESIGN_JOB_LEASE_MS,
} from "./lib/rateLimit";
import {
  getCatalogEntry,
  isSupportedReasoningEffort,
  isUserPickableModel,
  listPickableModels,
  reasoningEffortValidator,
  ROLE_MODELS,
  type ReasoningEffort,
} from "./lib/llmCatalog";
import {
  applyModelPreferences,
  isModelEnabledInPreferences,
  loadViewerModelPreferences,
  type UserModelPreferences,
} from "./lib/userPreferences";
import { resolveSystemDesignRequestModelChoice, SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE } from "./lib/systemDesignPlanning";
import { startedResultValidator } from "./lib/functionResultSchemas";
import {
  reserveSandboxLibraryGenerationBudget,
  settleSandboxLibraryGenerationUsage,
} from "./lib/sandboxLibraryGenerationAccounting";
import { buildUsageSourceId } from "./lib/usageAccounting";

export const ARTIFACT_DRAFT_PROMPT_VERSION = 1;

const ARTIFACT_DRAFT_LIST_LIMIT = 20;
const RECENT_REPOSITORY_DRAFT_STATUSES = ["queued", "running", "ready", "failed"] satisfies ReadonlyArray<
  Doc<"artifactDrafts">["status"]
>;
const STALE_ARTIFACT_DRAFT_JOB_ERROR_MESSAGE =
  "Artifact draft stalled and was automatically marked as failed. Regenerate to try again.";
const VERSION_MISMATCH_MESSAGE = "This artifact changed since the draft was generated. Regenerate before applying.";
const INACTIVE_DRAFT_REPOSITORY_MESSAGE = "Repository is no longer active.";

const draftOperationValidator = v.union(v.literal("create"), v.literal("update"));
const artifactDraftOutputFormatValidator = v.union(v.literal("markdown"), v.literal("html"));
const sourceArtifactValidator = v.object({
  artifactId: v.id("artifacts"),
  version: v.number(),
  title: v.string(),
});

type ArtifactDraftOutputFormat = "markdown" | "html";
type ArtifactSourceReference = {
  artifactId: Id<"artifacts">;
  version: number;
  title: string;
};

type DraftWithJob = {
  draft: Doc<"artifactDrafts">;
  job: Doc<"jobs"> | null;
};

async function requireActiveRepositoryForDraft(ctx: QueryCtx | MutationCtx, draft: Doc<"artifactDrafts">) {
  const repository = await ctx.db.get(draft.repositoryId);
  if (!isOwnedBy(repository, draft.ownerTokenIdentifier) || isRepositoryDeleting(repository)) {
    throw new Error("Draft not found.");
  }
  if (isRepositoryArchived(repository)) {
    throw new Error("Repository is archived. Restore it before applying drafts.");
  }
  return repository;
}

function resolveLibraryReportModelChoice(args: {
  modelPreferences: UserModelPreferences;
  picker: {
    provider?: LlmProvider;
    modelName?: string;
    reasoningEffort?: ReasoningEffort;
  };
}): { provider: LlmProvider; modelName: string; reasoningEffort?: ReasoningEffort } {
  assertCompleteModelPick(args.picker);

  let provider = args.picker.provider ?? ROLE_MODELS.defaultLibrary.provider;
  let modelName = args.picker.modelName ?? ROLE_MODELS.defaultLibrary.modelName;

  if (
    args.picker.provider === undefined &&
    !isModelEnabledInPreferences(args.modelPreferences, { provider, modelName }, "library")
  ) {
    const firstEnabled = applyModelPreferences(
      listPickableModels({ capability: "library" }),
      args.modelPreferences,
      "library",
    )[0];
    if (firstEnabled) {
      provider = firstEnabled.provider;
      modelName = firstEnabled.modelName;
    }
  }

  if (
    !isUserPickableModel(provider, modelName, "library") ||
    !isModelEnabledInPreferences(args.modelPreferences, { provider, modelName }, "library")
  ) {
    throw new ConvexError({
      code: "invalid_model_pick",
      message: `Unsupported model selection: ${provider}:${modelName}`,
    });
  }
  if (!isSupportedReasoningEffort(provider, modelName, args.picker.reasoningEffort)) {
    throw new ConvexError({
      code: "unsupported_reasoning_effort",
      message: `Unsupported reasoning effort "${args.picker.reasoningEffort}" for ${provider}:${modelName}.`,
    });
  }

  const catalogEntry = getCatalogEntry(provider, modelName);
  const reasoningEffort = args.picker.reasoningEffort ?? catalogEntry?.reasoningEffort;
  return {
    provider,
    modelName,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

function assertCompleteModelPick(args: { provider?: LlmProvider; modelName?: string }): void {
  if ((args.provider === undefined) !== (args.modelName === undefined)) {
    throw new ConvexError({
      code: "invalid_model_pick",
      message: "provider and modelName must be supplied together.",
    });
  }
}

function requireHtmlFieldsForApply(
  draft: Doc<"artifactDrafts">,
  outputFormat: ArtifactDraftOutputFormat,
):
  | {
      htmlStorageId: Id<"_storage">;
      htmlHash: string;
      htmlByteLength: number;
      htmlValidationErrors?: string[];
      sourceArtifacts?: ArtifactSourceReference[];
      sourceChunkIds?: Id<"artifactChunks">[];
    }
  | Record<string, never> {
  if (outputFormat !== "html") {
    return {};
  }
  if (!draft.htmlStorageId || !draft.htmlHash || draft.htmlByteLength === undefined) {
    throw new Error("HTML draft is missing its stored report.");
  }
  return {
    htmlStorageId: draft.htmlStorageId,
    htmlHash: draft.htmlHash,
    htmlByteLength: draft.htmlByteLength,
    htmlValidationErrors: draft.htmlValidationErrors,
    sourceArtifacts: draft.sourceArtifacts,
    sourceChunkIds: draft.sourceChunkIds,
  };
}

async function deleteUnappliedDraftHtmlStorage(ctx: MutationCtx, draft: Doc<"artifactDrafts">): Promise<void> {
  if ((draft.outputFormat ?? "markdown") !== "html" || !draft.htmlStorageId) {
    return;
  }
  await ctx.storage.delete(draft.htmlStorageId);
}

export const requestDraft = mutation({
  args: {
    repositoryId: v.id("repositories"),
    threadId: v.optional(v.id("threads")),
    operation: draftOperationValidator,
    prompt: v.string(),
    targetArtifactId: v.optional(v.id("artifacts")),
    title: v.optional(v.string()),
    folderId: v.optional(v.id("artifactFolders")),
    outputFormat: v.optional(artifactDraftOutputFormatValidator),
    provider: v.optional(llmProviderValidator),
    modelName: v.optional(v.string()),
    reasoningEffort: v.optional(reasoningEffortValidator),
  },
  handler: async (ctx, args): Promise<{ draftId: Id<"artifactDrafts">; jobId: Id<"jobs"> }> => {
    const { identity, repository } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
    });
    await assertFeatureAccess(ctx, identity, "libraryAsk");
    await assertFeatureAccess(ctx, identity, "generateSystemDesign");
    const outputFormat = args.outputFormat ?? "markdown";
    if (outputFormat === "markdown") {
      await assertFeatureAccess(ctx, identity, "sandboxGrounding");
    }

    const modelPreferences = await loadViewerModelPreferences(ctx, identity.tokenIdentifier);
    const picker = {
      provider: args.provider,
      modelName: args.modelName,
      reasoningEffort: args.reasoningEffort,
    };
    const modelChoice =
      outputFormat === "html"
        ? resolveLibraryReportModelChoice({ modelPreferences, picker })
        : resolveSystemDesignRequestModelChoice({ modelPreferences, picker });
    if (requiresPremiumModelAccess(modelChoice.provider, modelChoice.modelName)) {
      await assertFeatureAccess(ctx, identity, "premiumModels");
    }
    if (requiresHighReasoningAccess(modelChoice.reasoningEffort)) {
      await assertFeatureAccess(ctx, identity, "highReasoning");
    }

    const prompt = args.prompt.trim();
    if (!prompt) {
      throw new ConvexError({ code: "INVALID_PROMPT", message: "Describe what this artifact should cover." });
    }

    const thread = args.threadId ? await ctx.db.get(args.threadId) : null;
    if (args.threadId) {
      if (
        !isOwnedBy(thread, identity.tokenIdentifier) ||
        thread.repositoryId !== repository._id ||
        thread.mode !== "library"
      ) {
        throw new Error("Library Ask thread not found.");
      }
    }

    const prepared = await prepareDraftRequest(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: repository._id,
      operation: args.operation,
      title: args.title,
      folderId: args.folderId,
      targetArtifactId: args.targetArtifactId,
    });

    await consumeSystemDesignRateLimit(ctx, identity.tokenIdentifier);
    if (outputFormat === "markdown") {
      await consumeDaytonaGlobalRateLimit(ctx);
    }

    return await enqueueArtifactDraft(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: repository._id,
      threadId: args.threadId,
      operation: args.operation,
      prompt,
      title: prepared.title,
      folderId: prepared.folderId,
      targetArtifactId: prepared.targetArtifactId,
      targetArtifactVersion: prepared.targetArtifactVersion,
      outputFormat,
      provider: modelChoice.provider,
      modelName: modelChoice.modelName,
      reasoningEffort: modelChoice.reasoningEffort,
    });
  },
});

export const applyDraft = mutation({
  args: { draftId: v.id("artifactDrafts") },
  handler: async (ctx, args): Promise<{ artifactId: Id<"artifacts"> }> => {
    const { doc: draft } = await requireOwnedDoc(ctx, args.draftId, { notFoundMessage: "Draft not found." });
    if (draft.status !== "ready") {
      throw new ConvexError({ code: "DRAFT_NOT_READY", message: "This draft is not ready to apply." });
    }
    await requireActiveRepositoryForDraft(ctx, draft);

    const now = Date.now();
    const outputFormat = draft.outputFormat ?? "markdown";
    const htmlFields = requireHtmlFieldsForApply(draft, outputFormat);
    if (draft.operation === "create") {
      const artifactId = await createArtifactWrite(ctx, {
        repositoryId: draft.repositoryId,
        threadId: draft.threadId,
        ownerTokenIdentifier: draft.ownerTokenIdentifier,
        jobId: draft.jobId,
        kind: "custom_document",
        title: draft.title,
        summary: draft.summary,
        contentMarkdown: draft.contentMarkdown,
        renderFormat: outputFormat,
        ...htmlFields,
        folderId: draft.folderId,
        lastVerifiedAt: outputFormat === "html" ? null : now,
        alignedImportCommitSha: draft.alignedImportCommitSha,
        generatedByProvider: draft.generatedByProvider,
        generatedByModel: draft.generatedByModel,
        promptVersion: draft.promptVersion,
      });
      await ctx.db.patch(draft._id, {
        status: "applied",
        appliedAt: now,
        updatedAt: now,
      });
      return { artifactId };
    }

    if (!draft.targetArtifactId || draft.targetArtifactVersion === undefined) {
      throw new Error("Update draft is missing its target artifact.");
    }
    const target = await ctx.db.get(draft.targetArtifactId);
    if (!isOwnedBy(target, draft.ownerTokenIdentifier) || target.repositoryId !== draft.repositoryId) {
      throw new Error("Target artifact not found.");
    }
    if (target.version !== draft.targetArtifactVersion) {
      throw new ConvexError({
        code: "ARTIFACT_VERSION_MISMATCH",
        message: VERSION_MISMATCH_MESSAGE,
      });
    }

    const result = await updateArtifactWrite(ctx, {
      artifactId: target._id,
      title: draft.title,
      summary: draft.summary,
      contentMarkdown: draft.contentMarkdown,
      renderFormat: outputFormat,
      ...htmlFields,
      expectedVersion: draft.targetArtifactVersion,
      ...(outputFormat === "markdown" ? { lastVerifiedAt: now } : {}),
      alignedImportCommitSha: draft.alignedImportCommitSha,
      generatedByProvider: draft.generatedByProvider,
      generatedByModel: draft.generatedByModel,
      promptVersion: draft.promptVersion,
    });
    if (!result.updated && result.reason === "version_mismatch") {
      throw new ConvexError({
        code: "ARTIFACT_VERSION_MISMATCH",
        message: VERSION_MISMATCH_MESSAGE,
      });
    }

    await ctx.db.patch(draft._id, {
      status: "applied",
      appliedAt: now,
      updatedAt: now,
    });
    return { artifactId: target._id };
  },
});

export const discardDraft = mutation({
  args: { draftId: v.id("artifactDrafts") },
  handler: async (ctx, args): Promise<{ discarded: true }> => {
    const { doc: draft } = await requireOwnedDoc(ctx, args.draftId, { notFoundMessage: "Draft not found." });
    if (draft.status !== "ready" && draft.status !== "failed") {
      throw new ConvexError({ code: "DRAFT_NOT_DISCARDABLE", message: "This draft cannot be discarded yet." });
    }
    const now = Date.now();
    await deleteUnappliedDraftHtmlStorage(ctx, draft);
    await ctx.db.patch(draft._id, {
      status: "discarded",
      discardedAt: now,
      updatedAt: now,
    });
    return { discarded: true };
  },
});

export const regenerateDraft = mutation({
  args: { draftId: v.id("artifactDrafts") },
  handler: async (ctx, args): Promise<{ draftId: Id<"artifactDrafts">; jobId: Id<"jobs"> }> => {
    const { identity, doc: draft } = await requireOwnedDoc(ctx, args.draftId, { notFoundMessage: "Draft not found." });
    if (draft.status !== "ready" && draft.status !== "failed") {
      throw new ConvexError({ code: "DRAFT_NOT_REGENERABLE", message: "This draft cannot be regenerated." });
    }
    await requireActiveRepositoryForViewer(ctx, { repositoryId: draft.repositoryId });
    await assertFeatureAccess(ctx, identity, "libraryAsk");
    await assertFeatureAccess(ctx, identity, "generateSystemDesign");
    const outputFormat = draft.outputFormat ?? "markdown";
    if (outputFormat === "markdown") {
      await assertFeatureAccess(ctx, identity, "sandboxGrounding");
    }

    const fallback = outputFormat === "html" ? ROLE_MODELS.defaultLibrary : SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE;
    const provider = draft.generatedByProvider ?? fallback.provider;
    const modelName = draft.generatedByModel ?? fallback.modelName;
    if (requiresPremiumModelAccess(provider, modelName)) {
      await assertFeatureAccess(ctx, identity, "premiumModels");
    }
    if (requiresHighReasoningAccess(draft.reasoningEffort)) {
      await assertFeatureAccess(ctx, identity, "highReasoning");
    }

    const prepared = await prepareDraftRequest(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: draft.repositoryId,
      operation: draft.operation,
      title: draft.title,
      folderId: draft.folderId,
      targetArtifactId: draft.targetArtifactId,
    });

    await consumeSystemDesignRateLimit(ctx, identity.tokenIdentifier);
    if (outputFormat === "markdown") {
      await consumeDaytonaGlobalRateLimit(ctx);
    }

    const replacement = await enqueueArtifactDraft(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: draft.repositoryId,
      threadId: draft.threadId,
      operation: draft.operation,
      prompt: draft.prompt,
      title: prepared.title,
      folderId: prepared.folderId,
      targetArtifactId: prepared.targetArtifactId,
      targetArtifactVersion: prepared.targetArtifactVersion,
      outputFormat,
      provider,
      modelName,
      reasoningEffort: draft.reasoningEffort,
    });
    const now = Date.now();
    await deleteUnappliedDraftHtmlStorage(ctx, draft);
    await ctx.db.patch(draft._id, {
      status: "discarded",
      discardedAt: now,
      updatedAt: now,
    });
    return replacement;
  },
});

export const listByThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args): Promise<DraftWithJob[]> => {
    const { doc: thread } = await loadOwnedDoc(ctx, args.threadId);
    if (!thread) {
      return [];
    }
    const drafts = await ctx.db
      .query("artifactDrafts")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(ARTIFACT_DRAFT_LIST_LIMIT);
    return await joinDraftJobs(
      ctx,
      drafts.sort((left, right) => left.createdAt - right.createdAt),
    );
  },
});

export const listRecentByRepository = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<DraftWithJob[]> => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return [];
    }
    const drafts = (
      await Promise.all(
        RECENT_REPOSITORY_DRAFT_STATUSES.map((status) =>
          ctx.db
            .query("artifactDrafts")
            .withIndex("by_repositoryId_and_status", (q) =>
              q.eq("repositoryId", args.repositoryId).eq("status", status),
            )
            .order("desc")
            .take(ARTIFACT_DRAFT_LIST_LIMIT),
        ),
      )
    )
      .flat()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, ARTIFACT_DRAFT_LIST_LIMIT);
    return await joinDraftJobs(ctx, drafts);
  },
});

export const getById = query({
  args: { draftId: v.id("artifactDrafts") },
  handler: async (ctx, args): Promise<DraftWithJob | null> => {
    const { doc: draft } = await loadOwnedDoc(ctx, args.draftId);
    if (!draft) {
      return null;
    }
    return await joinDraftJob(ctx, draft);
  },
});

export const getByJob = query({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<DraftWithJob | null> => {
    const identity = await requireViewerIdentity(ctx);
    const draft = await ctx.db
      .query("artifactDrafts")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!isOwnedBy(draft, identity.tokenIdentifier)) {
      return null;
    }
    return await joinDraftJob(ctx, draft);
  },
});

export const getDraftGenerationContext = internalQuery({
  args: {
    draftId: v.id("artifactDrafts"),
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    draft: Doc<"artifactDrafts">;
    repository: Doc<"repositories">;
    targetArtifact: Doc<"artifacts"> | null;
  } | null> => {
    const draft = await ctx.db.get(args.draftId);
    if (
      !isOwnedBy(draft, args.ownerTokenIdentifier) ||
      draft.repositoryId !== args.repositoryId ||
      draft.status !== "running"
    ) {
      return null;
    }
    const repository = await ctx.db.get(args.repositoryId);
    if (!isOwnedBy(repository, args.ownerTokenIdentifier) || repository.deletionRequestedAt || repository.archivedAt) {
      return null;
    }
    const targetArtifact = draft.targetArtifactId ? await ctx.db.get(draft.targetArtifactId) : null;
    if (draft.operation === "update") {
      if (!isOwnedBy(targetArtifact, args.ownerTokenIdentifier) || targetArtifact.repositoryId !== args.repositoryId) {
        return null;
      }
    }
    return { draft, repository, targetArtifact };
  },
});

export const markDraftRunning = internalMutation({
  args: { draftId: v.id("artifactDrafts"), jobId: v.id("jobs") },
  returns: startedResultValidator,
  handler: async (ctx, args): Promise<{ started: boolean }> => {
    const now = Date.now();
    const draft = await ctx.db.get(args.draftId);
    const outputFormat = draft?.outputFormat ?? "markdown";
    const running = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "artifact_draft",
      stage: outputFormat === "html" ? "Retrieving Library knowledge…" : "Preparing code access…",
      progress: 0.05,
      startedAt: now,
      leaseExpiresAt: now + SYSTEM_DESIGN_JOB_LEASE_MS,
    });
    if (!running) {
      return { started: false };
    }
    if (draft?.jobId !== args.jobId || draft.status !== "queued") {
      await failRunningJob(ctx, {
        jobId: args.jobId,
        expectedKind: "artifact_draft",
        completedAt: now,
        errorMessage: "Artifact draft could not start.",
      });
      return { started: false };
    }
    await ctx.db.patch(args.draftId, {
      status: "running",
      updatedAt: now,
    });
    return { started: true };
  },
});

export const updateDraftProgress = internalMutation({
  args: { jobId: v.id("jobs"), stage: v.string(), progress: v.number() },
  handler: async (ctx, args) => {
    await updateRunningJobProgress(ctx, {
      jobId: args.jobId,
      expectedKind: "artifact_draft",
      stage: args.stage,
      progress: Math.max(0, Math.min(0.99, args.progress)),
    });
    const draft = await ctx.db
      .query("artifactDrafts")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (draft && draft.status === "running") {
      await ctx.db.patch(draft._id, { updatedAt: Date.now() });
    }
  },
});

export const assertDraftCostBudget = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    repositoryId: v.id("repositories"),
    jobId: v.id("jobs"),
    startedAt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    await reserveSandboxLibraryGenerationBudget(ctx, {
      sourceId: buildUsageSourceId.artifactDraft(args.jobId, args.startedAt),
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      occurredAtMs: args.startedAt,
    });
  },
});

export const markDraftReady = internalMutation({
  args: {
    draftId: v.id("artifactDrafts"),
    jobId: v.id("jobs"),
    title: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
    changeSummary: v.optional(v.string()),
    outputFormat: artifactDraftOutputFormatValidator,
    sandboxId: v.optional(v.id("sandboxes")),
    htmlStorageId: v.optional(v.id("_storage")),
    htmlHash: v.optional(v.string()),
    htmlByteLength: v.optional(v.number()),
    htmlValidationErrors: v.optional(v.array(v.string())),
    sourceArtifacts: v.optional(v.array(sourceArtifactValidator)),
    sourceChunkIds: v.optional(v.array(v.id("artifactChunks"))),
    alignedImportCommitSha: v.optional(v.string()),
    generatedByProvider: llmProviderValidator,
    generatedByModel: v.string(),
    reasoningEffort: v.optional(reasoningEffortValidator),
    promptVersion: v.number(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    totalCostUsd: v.optional(v.number()),
    sourceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ready: boolean }> => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.jobId !== args.jobId || draft.status !== "running") {
      return { ready: false };
    }
    if (args.outputFormat === "markdown" && !args.sourceId) {
      throw new Error("Markdown draft is missing its usage source.");
    }
    if (args.outputFormat === "html" && (!args.htmlStorageId || !args.htmlHash || args.htmlByteLength === undefined)) {
      throw new Error("HTML draft is missing its stored report metadata.");
    }
    const now = Date.now();
    const repository = await ctx.db.get(draft.repositoryId);
    if (!isOwnedBy(repository, draft.ownerTokenIdentifier) || !isActiveRepository(repository)) {
      if (args.htmlStorageId) {
        await ctx.storage.delete(args.htmlStorageId);
      }
      if (args.outputFormat === "markdown" && args.sourceId) {
        await settleSandboxLibraryGenerationUsage(ctx, {
          sourceId: args.sourceId,
          ownerTokenIdentifier: draft.ownerTokenIdentifier,
          repositoryId: draft.repositoryId,
          occurredAtMs: now,
          totalCostUsd: args.totalCostUsd,
          usage: {
            inputTokens: args.inputTokens,
            outputTokens: args.outputTokens,
            cachedInputTokens: args.cachedInputTokens,
            cacheWriteTokens: args.cacheWriteTokens,
            reasoningTokens: args.reasoningTokens,
          },
        });
      }
      await ctx.db.patch(args.draftId, {
        status: "failed",
        errorMessage: INACTIVE_DRAFT_REPOSITORY_MESSAGE,
        updatedAt: now,
      });
      await failRunningJob(ctx, {
        jobId: args.jobId,
        expectedKind: "artifact_draft",
        completedAt: now,
        errorMessage: INACTIVE_DRAFT_REPOSITORY_MESSAGE,
      });
      return { ready: false };
    }
    await ctx.db.patch(args.draftId, {
      status: "ready",
      title: args.title,
      summary: args.summary,
      contentMarkdown: args.contentMarkdown,
      changeSummary: args.changeSummary,
      outputFormat: args.outputFormat,
      sandboxId: args.sandboxId,
      htmlStorageId: args.htmlStorageId,
      htmlHash: args.htmlHash,
      htmlByteLength: args.htmlByteLength,
      htmlValidationErrors: args.htmlValidationErrors,
      sourceArtifacts: args.sourceArtifacts,
      sourceChunkIds: args.sourceChunkIds,
      alignedImportCommitSha: args.alignedImportCommitSha,
      generatedByProvider: args.generatedByProvider,
      generatedByModel: args.generatedByModel,
      reasoningEffort: args.reasoningEffort,
      promptVersion: args.promptVersion,
      generatedAt: now,
      updatedAt: now,
      errorMessage: undefined,
    });
    if (args.outputFormat === "markdown" && args.sourceId) {
      await settleSandboxLibraryGenerationUsage(ctx, {
        sourceId: args.sourceId,
        ownerTokenIdentifier: draft.ownerTokenIdentifier,
        repositoryId: draft.repositoryId,
        occurredAtMs: now,
        totalCostUsd: args.totalCostUsd,
        usage: {
          inputTokens: args.inputTokens,
          outputTokens: args.outputTokens,
          cachedInputTokens: args.cachedInputTokens,
          cacheWriteTokens: args.cacheWriteTokens,
          reasoningTokens: args.reasoningTokens,
        },
      });
    }
    await ctx.db.patch(args.jobId, {
      ...(args.sandboxId !== undefined ? { sandboxId: args.sandboxId } : {}),
      estimatedInputTokens: args.inputTokens,
      estimatedOutputTokens: args.outputTokens,
      estimatedCostUsd: args.totalCostUsd,
    });
    await ctx.db.patch(args.jobId, {
      status: "completed",
      stage: "Ready to review",
      progress: 1,
      completedAt: now,
      outputSummary:
        args.outputFormat === "html" ? "HTML report draft ready to review." : "Artifact draft ready to review.",
      leaseExpiresAt: undefined,
    });
    return { ready: true };
  },
});

export const failDraft = internalMutation({
  args: { draftId: v.id("artifactDrafts"), jobId: v.id("jobs"), errorMessage: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    await failRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "artifact_draft",
      completedAt: now,
      errorMessage: args.errorMessage,
    });
    const draft = await ctx.db.get(args.draftId);
    if (draft?.jobId === args.jobId && (draft.status === "queued" || draft.status === "running")) {
      await ctx.db.patch(args.draftId, {
        status: "failed",
        errorMessage: args.errorMessage,
        updatedAt: now,
      });
    }
  },
});

export const recoverStaleArtifactDraftJob = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<{ recovered: boolean }> => {
    const result = await runStaleJobRecovery(ctx, {
      jobId: args.jobId,
      expectedKind: "artifact_draft",
      errorMessage: STALE_ARTIFACT_DRAFT_JOB_ERROR_MESSAGE,
    });
    if (result.recovered) {
      const draft = await ctx.db
        .query("artifactDrafts")
        .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
        .unique();
      if (draft && (draft.status === "queued" || draft.status === "running")) {
        await ctx.db.patch(draft._id, {
          status: "failed",
          errorMessage: STALE_ARTIFACT_DRAFT_JOB_ERROR_MESSAGE,
          updatedAt: Date.now(),
        });
      }
    }
    return result;
  },
});

async function prepareDraftRequest(
  ctx: QueryCtx | MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    operation: "create" | "update";
    title?: string;
    folderId?: Id<"artifactFolders">;
    targetArtifactId?: Id<"artifacts">;
  },
): Promise<{
  title: string;
  folderId?: Id<"artifactFolders">;
  targetArtifactId?: Id<"artifacts">;
  targetArtifactVersion?: number;
}> {
  if (args.folderId) {
    const folder = await ctx.db.get(args.folderId);
    if (!isOwnedBy(folder, args.ownerTokenIdentifier) || folder.repositoryId !== args.repositoryId) {
      throw new Error("Folder not found.");
    }
  }

  if (args.operation === "create") {
    const title = args.title?.trim();
    if (!title) {
      throw new ConvexError({ code: "INVALID_TITLE", message: "Add a title for the new artifact." });
    }
    return { title, folderId: args.folderId };
  }

  if (!args.targetArtifactId) {
    throw new ConvexError({ code: "MISSING_TARGET_ARTIFACT", message: "Open an artifact before drafting an update." });
  }
  const target = await ctx.db.get(args.targetArtifactId);
  if (!isOwnedBy(target, args.ownerTokenIdentifier) || target.repositoryId !== args.repositoryId) {
    throw new Error("Target artifact not found.");
  }
  return {
    title: target.title,
    folderId: target.folderId,
    targetArtifactId: target._id,
    targetArtifactVersion: target.version,
  };
}

async function enqueueArtifactDraft(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    threadId?: Id<"threads">;
    operation: "create" | "update";
    prompt: string;
    title: string;
    folderId?: Id<"artifactFolders">;
    targetArtifactId?: Id<"artifacts">;
    targetArtifactVersion?: number;
    outputFormat: ArtifactDraftOutputFormat;
    provider: LlmProvider;
    modelName: string;
    reasoningEffort?: ReasoningEffort;
  },
): Promise<{ draftId: Id<"artifactDrafts">; jobId: Id<"jobs"> }> {
  const jobId = await enqueueJob(ctx, {
    kind: "artifact_draft",
    repositoryId: args.repositoryId,
    threadId: args.threadId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    costCategory: "system_design",
    triggerSource: "user",
    stage: args.outputFormat === "html" ? "Retrieving Library knowledge…" : "Preparing code access…",
    outputSummary: args.outputFormat === "html" ? "Queued HTML report draft." : "Queued artifact draft.",
    leaseMs: SYSTEM_DESIGN_JOB_LEASE_MS,
  });
  await ctx.db.patch(jobId, {
    provider: args.provider,
    modelName: args.modelName,
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  });

  const now = Date.now();
  const draftId = await ctx.db.insert("artifactDrafts", {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    threadId: args.threadId,
    jobId,
    operation: args.operation,
    status: "queued",
    prompt: args.prompt,
    targetArtifactId: args.targetArtifactId,
    targetArtifactVersion: args.targetArtifactVersion,
    folderId: args.folderId,
    title: args.title,
    summary: "",
    contentMarkdown: "",
    outputFormat: args.outputFormat,
    generatedByProvider: args.provider,
    generatedByModel: args.modelName,
    reasoningEffort: args.reasoningEffort,
    promptVersion: ARTIFACT_DRAFT_PROMPT_VERSION,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.libraryArtifactDraftsNode.runArtifactDraft, {
    draftId,
    jobId,
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
  });

  return { draftId, jobId };
}

async function joinDraftJobs(ctx: QueryCtx, drafts: Doc<"artifactDrafts">[]): Promise<DraftWithJob[]> {
  return await Promise.all(drafts.map((draft) => joinDraftJob(ctx, draft)));
}

async function joinDraftJob(ctx: QueryCtx, draft: Doc<"artifactDrafts">): Promise<DraftWithJob> {
  return {
    draft,
    job: await ctx.db.get(draft.jobId),
  };
}
