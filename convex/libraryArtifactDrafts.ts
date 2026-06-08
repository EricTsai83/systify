import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { createArtifactInMutation } from "./artifactStore";
import { llmProviderValidator, type LlmProvider } from "./lib/llmProvider";
import { requireViewerIdentity } from "./lib/auth";
import { assertFeatureAccess, requiresHighReasoningAccess, requiresPremiumModelAccess } from "./lib/entitlements";
import { isOwnedBy, loadOwnedDoc, requireOwnedDoc } from "./lib/ownedDocs";
import { requireActiveRepositoryForViewer } from "./lib/repositoryAccess";
import {
  enqueueJob,
  failRunningJob,
  markQueuedJobRunning,
  runStaleJobRecovery,
  updateRunningJobProgress,
} from "./lib/jobs";
import {
  assertSandboxDailyCostBudget,
  consumeDaytonaGlobalRateLimit,
  consumeSandboxDailyCost,
  consumeSystemDesignRateLimit,
  getSandboxReplyEstimateCents,
  SYSTEM_DESIGN_JOB_LEASE_MS,
} from "./lib/rateLimit";
import { reasoningEffortValidator, type ReasoningEffort } from "./lib/llmCatalog";
import { loadViewerModelPreferences } from "./lib/userPreferences";
import { resolveSystemDesignRequestModelChoice, SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE } from "./lib/systemDesignPlanning";
import { costUsdToCents } from "./lib/llmPricing";
import { SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD, recordUserUsageEvent, reserveUserUsageBudget } from "./lib/userCost";
import { startedResultValidator } from "./lib/functionResultSchemas";

export const ARTIFACT_DRAFT_PROMPT_VERSION = 1;

const ARTIFACT_DRAFT_LIST_LIMIT = 20;
const STALE_ARTIFACT_DRAFT_JOB_ERROR_MESSAGE =
  "Artifact draft stalled and was automatically marked as failed. Regenerate to try again.";
const VERSION_MISMATCH_MESSAGE = "This artifact changed since the draft was generated. Regenerate before applying.";

const draftOperationValidator = v.union(v.literal("create"), v.literal("update"));

type DraftWithJob = {
  draft: Doc<"artifactDrafts">;
  job: Doc<"jobs"> | null;
};

export const requestDraft = mutation({
  args: {
    repositoryId: v.id("repositories"),
    threadId: v.optional(v.id("threads")),
    operation: draftOperationValidator,
    prompt: v.string(),
    targetArtifactId: v.optional(v.id("artifacts")),
    title: v.optional(v.string()),
    folderId: v.optional(v.id("artifactFolders")),
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
    await assertFeatureAccess(ctx, identity, "sandboxGrounding");

    const modelPreferences = await loadViewerModelPreferences(ctx, identity.tokenIdentifier);
    const modelChoice = resolveSystemDesignRequestModelChoice({
      modelPreferences,
      picker: {
        provider: args.provider,
        modelName: args.modelName,
        reasoningEffort: args.reasoningEffort,
      },
    });
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
    await consumeDaytonaGlobalRateLimit(ctx);

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

    const now = Date.now();
    if (draft.operation === "create") {
      const artifactId = await createArtifactInMutation(ctx, {
        repositoryId: draft.repositoryId,
        threadId: draft.threadId,
        ownerTokenIdentifier: draft.ownerTokenIdentifier,
        jobId: draft.jobId,
        kind: "custom_document",
        title: draft.title,
        summary: draft.summary,
        contentMarkdown: draft.contentMarkdown,
        folderId: draft.folderId,
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

    const result = await ctx.runMutation(internal.artifactStore.updateArtifact, {
      artifactId: target._id,
      title: draft.title,
      summary: draft.summary,
      contentMarkdown: draft.contentMarkdown,
      expectedVersion: draft.targetArtifactVersion,
      lastVerifiedAt: now,
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
    await requireActiveRepositoryForViewer(ctx, { repositoryId: draft.repositoryId });
    await assertFeatureAccess(ctx, identity, "libraryAsk");
    await assertFeatureAccess(ctx, identity, "generateSystemDesign");
    await assertFeatureAccess(ctx, identity, "sandboxGrounding");

    const provider = draft.generatedByProvider ?? SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE.provider;
    const modelName = draft.generatedByModel ?? SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE.modelName;
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
    await consumeDaytonaGlobalRateLimit(ctx);

    return await enqueueArtifactDraft(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: draft.repositoryId,
      threadId: draft.threadId,
      operation: draft.operation,
      prompt: draft.prompt,
      title: prepared.title,
      folderId: prepared.folderId,
      targetArtifactId: prepared.targetArtifactId,
      targetArtifactVersion: prepared.targetArtifactVersion,
      provider,
      modelName,
      reasoningEffort: draft.reasoningEffort,
    });
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
    return await joinDraftJobs(ctx, drafts);
  },
});

export const listRecentByRepository = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<DraftWithJob[]> => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return [];
    }
    const statuses: Doc<"artifactDrafts">["status"][] = [
      "queued",
      "running",
      "ready",
      "failed",
      "applied",
      "discarded",
    ];
    const drafts = (
      await Promise.all(
        statuses.map((status) =>
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
    const running = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "artifact_draft",
      stage: "Preparing live source…",
      progress: 0.05,
      startedAt: now,
      leaseExpiresAt: now + SYSTEM_DESIGN_JOB_LEASE_MS,
    });
    if (!running) {
      return { started: false };
    }
    const draft = await ctx.db.get(args.draftId);
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
    await assertSandboxDailyCostBudget(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      estimateCents: getSandboxReplyEstimateCents(),
    });
    await reserveUserUsageBudget(ctx, {
      sourceId: `artifactDraft:${args.jobId}:${args.startedAt}`,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      feature: "systemDesign",
      estimatedCostUsd: SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD,
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
    sandboxId: v.id("sandboxes"),
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
    sourceId: v.string(),
  },
  handler: async (ctx, args): Promise<{ ready: boolean }> => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.jobId !== args.jobId || draft.status !== "running") {
      return { ready: false };
    }
    const now = Date.now();
    await ctx.db.patch(args.draftId, {
      status: "ready",
      title: args.title,
      summary: args.summary,
      contentMarkdown: args.contentMarkdown,
      changeSummary: args.changeSummary,
      sandboxId: args.sandboxId,
      alignedImportCommitSha: args.alignedImportCommitSha,
      generatedByProvider: args.generatedByProvider,
      generatedByModel: args.generatedByModel,
      reasoningEffort: args.reasoningEffort,
      promptVersion: args.promptVersion,
      generatedAt: now,
      updatedAt: now,
      errorMessage: undefined,
    });
    await recordUserUsageEvent(ctx, {
      sourceId: args.sourceId,
      ownerTokenIdentifier: draft.ownerTokenIdentifier,
      feature: "systemDesign",
      occurredAtMs: now,
      usd: args.totalCostUsd,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedInputTokens: args.cachedInputTokens,
      cacheWriteTokens: args.cacheWriteTokens,
      reasoningTokens: args.reasoningTokens,
    });
    const settleCents = costUsdToCents(args.totalCostUsd);
    if (settleCents !== undefined && settleCents > 0) {
      await consumeSandboxDailyCost(ctx, {
        ownerTokenIdentifier: draft.ownerTokenIdentifier,
        repositoryId: draft.repositoryId,
        cents: settleCents,
      });
    }
    await ctx.db.patch(args.jobId, {
      sandboxId: args.sandboxId,
      estimatedInputTokens: args.inputTokens,
      estimatedOutputTokens: args.outputTokens,
      estimatedCostUsd: args.totalCostUsd,
    });
    await ctx.db.patch(args.jobId, {
      status: "completed",
      stage: "Ready to review",
      progress: 1,
      completedAt: now,
      outputSummary: "Artifact draft ready to review.",
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
    stage: "Preparing live source…",
    outputSummary: "Queued artifact draft.",
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
