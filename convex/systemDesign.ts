import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { requireActiveRepositoryForViewer } from "./lib/repositoryAccess";
import { assertFeatureAccess, requiresHighReasoningAccess, requiresPremiumModelAccess } from "./lib/entitlements";
import { isOwnedBy, loadOwnedDoc } from "./lib/ownedDocs";
import { enqueueJob, findActiveJob } from "./lib/jobs";
import {
  ensureSystemDesignFolders,
  SYSTEM_DESIGN_KIND_TO_FOLDER,
  systemDesignKindValidator,
  type SystemDesignKind,
} from "./lib/systemDesign";
import { createArtifactInMutation, deleteArtifactInternal } from "./artifactStore";
import {
  completeRunningJob,
  failRunningJob,
  failStaleActiveJob,
  isJobStaleAndRecoverable,
  markQueuedJobRunning,
  refreshRunningJobLease,
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
import { listPickableModels, reasoningEffortValidator, type ReasoningEffort } from "./lib/llmCatalog";
import { llmProviderValidator, type LlmProvider } from "./lib/llmProvider";
import { loadViewerModelPreferences } from "./lib/userPreferences";
import { costUsdToCents } from "./lib/llmPricing";
import {
  persistedArtifactResultValidator,
  recordedKindRunResultValidator,
  startedResultValidator,
} from "./lib/functionResultSchemas";
import { logInfo, logWarn } from "./lib/observability";
import { SYSTEM_DESIGN_PROMPT_VERSIONS } from "./lib/systemDesignPrompts";
import { SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD, recordUserUsageEvent, reserveUserUsageBudget } from "./lib/userCost";
import {
  SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE,
  buildSystemDesignJobSummary,
  normalizeSystemDesignSelections,
  planSystemDesignGenerationRequest,
  resolveSystemDesignCachePreviewModel,
} from "./lib/systemDesignPlanning";
import { systemDesignFailureReasonValidator } from "./lib/systemDesignFailures";

/**
 * Loop guard for the stale-recovery auto-resume path. A System Design
 * job that overruns its lease with partial progress (some kinds
 * completed, some not) is re-enqueued up to this many times before
 * the recovery gives up and marks the job failed. Two attempts is
 * empirically enough to absorb a single bad sandbox / one transient
 * provider outage; anything more is signal of a deeper bug worth
 * surfacing as a failure rather than absorbing as retries.
 */
const MAX_RESUME_ATTEMPTS = 2;

/**
 * Status set treated as "this kind is done, no need to re-run on
 * resume". `quality_rejected` is included because re-running the same
 * (prompt, model, commit) is overwhelmingly likely to reproduce the
 * same reject — the user has to bump promptVersion or pick a different
 * model to break out of the loop. `failed` is intentionally absent
 * so a transient transport blip on attempt N gets another shot on
 * attempt N+1.
 */
const KIND_RUN_TERMINAL_STATUSES = new Set<Doc<"systemDesignKindRuns">["status"]>([
  "succeeded",
  "cached_hit",
  "quality_rejected",
]);

/**
 * Library System Design generation entry point.
 *
 * The user opens the Generate System Design dialog from the Library panel,
 * ticks the kinds they want, and submits — this mutation validates the
 * request, ensures the default folder tree exists, creates a tracking job,
 * and schedules the Node action that performs the actual generation.
 *
 * Jobs are tagged with `kind: "system_design"` so the existing job-runner
 * accounting, cost-cap path, and stale-recovery infrastructure pick them up
 * uniformly with the other sandbox-backed jobs. Progress and final status
 * flow back to the UI through the standard job subscription.
 */
export const requestSystemDesignGeneration = mutation({
  args: {
    repositoryId: v.id("repositories"),
    selections: v.array(systemDesignKindValidator),
    /**
     * Multi-provider LLM pick. Both args travel together — supplying
     * one without the other throws. When neither is set, the job
     * falls back to the System Design Planning Module's default model.
     */
    provider: v.optional(llmProviderValidator),
    modelName: v.optional(v.string()),
    /**
     * Reasoning-effort override applied to every kind in this job.
     * `undefined` falls back to the catalog entry's default at gateway
     * time. The dialog's reasoning picker hides for non-reasoning
     * models, so a stale value cannot land on a model that wouldn't
     * accept it.
     */
    reasoningEffort: v.optional(reasoningEffortValidator),
    /**
     * When `true`, the per-kind cache lookup is skipped and the
     * generator re-runs every selected kind. Set by the Generate
     * dialog's "Regenerate even if cached" checkbox. Does NOT bypass
     * the active-job dedup (a regenerate while another job is in
     * flight returns that job's id) — the user's intent is "make the
     * new artifact land", not "spawn a parallel job".
     */
    forceRegenerate: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ jobId: Id<"jobs"> }> => {
    const { identity, repository } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
    });
    const modelPreferences = await loadViewerModelPreferences(ctx, identity.tokenIdentifier);
    await assertFeatureAccess(ctx, identity, "generateSystemDesign");
    await assertFeatureAccess(ctx, identity, "sandboxGrounding");

    const generationPlan = planSystemDesignGenerationRequest({
      selections: args.selections,
      modelPreferences,
      picker: args,
    });
    if (requiresPremiumModelAccess(generationPlan.modelChoice.provider, generationPlan.modelChoice.modelName)) {
      await assertFeatureAccess(ctx, identity, "premiumModels");
    }
    if (requiresHighReasoningAccess(generationPlan.modelChoice.reasoningEffort)) {
      await assertFeatureAccess(ctx, identity, "highReasoning");
    }

    const now = Date.now();

    // Every System Design kind is LLM-backed and reads live source through a
    // sandbox, so the action always runs `ensureSandboxReady`. The repository's
    // current `latestSandboxId` is attached to the job row so audit surfaces
    // can correlate the request with whatever sandbox existed at queue time;
    // if `ensureSandboxReady` provisions a new one mid-flight, the action
    // patches the new row's id onto downstream artifact records.
    const sandboxId: Id<"sandboxes"> | undefined = repository.latestSandboxId ?? undefined;

    // Per-repository dedup: only one active System Design job per
    // repository at a time. Two concurrent triggers against the same
    // repo (e.g. two browser tabs) collapse to the first job's id.
    // Cross-user collisions are not possible today — each repository
    // belongs to exactly one owner — but the scope key uses
    // repository rather than user so a future shared-repo model
    // inherits this dedup automatically.
    const activeJob = await findActiveLibrarySystemDesignJob(ctx, repository._id, now);
    if (activeJob) {
      return { jobId: activeJob._id };
    }

    await consumeSystemDesignRateLimit(ctx, identity.tokenIdentifier);
    await consumeDaytonaGlobalRateLimit(ctx);

    await ensureSystemDesignFolders(ctx, {
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    // The lease is set at insert time so the stale-job sweep
    // (`by_status_and_kind_and_leaseExpiresAt` + `lt(leaseExpiresAt, now)`)
    // can pick this row up if the Node action never runs or dies before
    // `markGenerationStarted` patches the lease.
    const jobId = await enqueueJob(ctx, {
      kind: "system_design",
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId,
      costCategory: "system_design",
      triggerSource: "user",
      outputSummary: buildSystemDesignJobSummary(generationPlan.selections, "queued"),
      selections: generationPlan.selections,
      leaseMs: SYSTEM_DESIGN_JOB_LEASE_MS,
    });

    // Bake provider/model onto the job row so a stale-recovery auto-resume
    // picks up the same pair without rederiving from defaults — keeps
    // the cache key consistent across resume boundaries.
    await ctx.db.patch(jobId, {
      provider: generationPlan.modelChoice.provider,
      modelName: generationPlan.modelChoice.modelName,
      ...(generationPlan.modelChoice.reasoningEffort !== undefined
        ? { reasoningEffort: generationPlan.modelChoice.reasoningEffort }
        : {}),
    });

    await ctx.scheduler.runAfter(0, internal.systemDesignNode.runSystemDesignGeneration, {
      jobId,
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      selections: generationPlan.selections,
      forceRegenerate: args.forceRegenerate ?? false,
    });

    return { jobId };
  },
});

async function findActiveLibrarySystemDesignJob(
  ctx: QueryCtx,
  repositoryId: Id<"repositories">,
  now: number,
): Promise<Doc<"jobs"> | null> {
  return await findActiveJob(ctx, {
    kind: "system_design",
    scope: { type: "repository", id: repositoryId },
    now,
  });
}

/**
 * Listing helper: surface the most recent generation job for the repo so the
 * UI can render the "Generating 3 of 5…" pill above the folder navigator and
 * disable the Generate button while a job is in-flight.
 */
export const getActiveSystemDesignJob = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<Doc<"jobs"> | null> => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return null;
    }
    return await findActiveLibrarySystemDesignJob(ctx, args.repositoryId, Date.now());
  },
});

/**
 * Visibility window after a job reaches a terminal state during which the
 * Library banner still surfaces its outcome. Keeps the failure summary
 * visible long enough for the user to read it, then auto-clears so the
 * navigator isn't haunted by stale errors across sessions.
 */
const SYSTEM_DESIGN_BANNER_TERMINAL_WINDOW_MS = 10 * 60 * 1000;

/**
 * Banner-only listing helper: returns the most recent Library System Design
 * job for the repo regardless of status, but only while it is either
 * (a) active (queued / running) or (b) terminal and within
 * `SYSTEM_DESIGN_BANNER_TERMINAL_WINDOW_MS`. The dialog continues to use
 * `getActiveSystemDesignJob` for dedup — this query exists so the banner
 * can show post-completion failure summaries without changing that
 * "is there an in-flight job?" semantic.
 *
 * Scoped to `kind === "system_design"` via `by_repositoryId_and_kind` so
 * an active repository with a long tail of other-kind jobs (chat,
 * sandbox_activation, …) cannot push the latest system_design row past
 * any bounded scan.
 */
export const getLatestSystemDesignJob = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<Doc<"jobs"> | null> => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return null;
    }

    const job = await ctx.db
      .query("jobs")
      .withIndex("by_repositoryId_and_kind", (q) => q.eq("repositoryId", args.repositoryId).eq("kind", "system_design"))
      .order("desc")
      .first();

    if (!job) {
      return null;
    }
    if (job.status === "queued" || job.status === "running") {
      return job;
    }
    const now = Date.now();
    if (typeof job.completedAt === "number" && now - job.completedAt < SYSTEM_DESIGN_BANNER_TERMINAL_WINDOW_MS) {
      return job;
    }
    return null;
  },
});

export const markGenerationStarted = internalMutation({
  args: { jobId: v.id("jobs"), selections: v.array(systemDesignKindValidator) },
  returns: startedResultValidator,
  handler: async (ctx, args): Promise<{ started: boolean }> => {
    const now = Date.now();
    const result = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      stage: "running",
      progress: 0,
      startedAt: now,
      // Refresh the lease at the queued→running transition so we get a
      // fresh window for the generator work. The mutation already wrote a
      // lease at insert time so the stale-sweep guard never sees an
      // unset value.
      leaseExpiresAt: now + SYSTEM_DESIGN_JOB_LEASE_MS,
    });
    if (result) {
      await ctx.db.patch(args.jobId, {
        outputSummary: buildSystemDesignJobSummary(args.selections as SystemDesignKind[], "running"),
      });
    }
    return { started: result !== null };
  },
});

/**
 * Extend the running job's lease between LLM kinds. Each LLM-backed kind
 * can take tens of seconds on a slow sandbox; without a periodic refresh
 * a long publication (e.g. all five LLM kinds with high step budgets)
 * could overrun the initial lease window and trigger a spurious stale-
 * recovery while the action is still making progress.
 */
export const refreshGenerationLease = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    await refreshRunningJobLease(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      leaseExpiresAt: Date.now() + SYSTEM_DESIGN_JOB_LEASE_MS,
    });
  },
});

export const updateGenerationProgress = internalMutation({
  args: {
    jobId: v.id("jobs"),
    completedCount: v.number(),
    totalCount: v.number(),
    stage: v.string(),
  },
  handler: async (ctx, args) => {
    const progress = args.totalCount === 0 ? 0 : args.completedCount / args.totalCount;
    await updateRunningJobProgress(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      stage: args.stage,
      progress,
    });
  },
});

export const recordKindFailure = internalMutation({
  args: {
    jobId: v.id("jobs"),
    kind: systemDesignKindValidator,
    errorId: v.string(),
    message: v.string(),
    reason: v.optional(systemDesignFailureReasonValidator),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const previous = job.kindFailures ?? [];
    await ctx.db.patch(args.jobId, {
      kindFailures: [
        ...previous,
        {
          kind: args.kind,
          errorId: args.errorId,
          message: args.message.slice(0, 200),
          reason: args.reason,
        },
      ],
    });
  },
});

export const completeGeneration = internalMutation({
  args: {
    jobId: v.id("jobs"),
    selections: v.array(systemDesignKindValidator),
    succeededCount: v.number(),
    failedCount: v.number(),
  },
  handler: async (ctx, args) => {
    const summary =
      args.failedCount === 0
        ? `Generated ${args.succeededCount} of ${args.selections.length} document${
            args.selections.length === 1 ? "" : "s"
          }.`
        : `Generated ${args.succeededCount} of ${args.selections.length}; ${args.failedCount} failed.`;
    await completeRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      completedAt: Date.now(),
      outputSummary: summary,
      progress: 1,
    });
  },
});

export const failGeneration = internalMutation({
  args: { jobId: v.id("jobs"), errorMessage: v.string() },
  handler: async (ctx, args) => {
    await failRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      completedAt: Date.now(),
      errorMessage: args.errorMessage,
    });
  },
});

const STALE_SYSTEM_DESIGN_JOB_ERROR_MESSAGE =
  "The System Design generation stalled and was automatically marked as failed.";

const STALE_SYSTEM_DESIGN_RESUME_EXHAUSTED_MESSAGE =
  "The System Design generation stalled repeatedly and was marked as failed after exhausting resume attempts.";

/**
 * Background stale-job recovery for System Design generation. Called by
 * `opsNode.recoverStaleInteractiveJobs` when a `system_design`-kind job
 * has overrun its lease.
 *
 * Distinguishes between two outcomes:
 *
 *   1. **Auto-resume** — the job has partial progress (some kinds
 *      already covered by terminal `systemDesignKindRuns` rows) AND
 *      its `resumeAttempts` counter is still under
 *      {@link MAX_RESUME_ATTEMPTS}. The mutation patches the row back
 *      to `queued`, bumps the resume counter and lease, and re-enqueues
 *      the Node action. The action's per-kind cache lookup
 *      (`findCachedArtifact`) will skip already-succeeded kinds and
 *      only re-run the remainder, so a 7-kind job that lost the action
 *      after kind 4 only pays for kinds 5–7 on resume.
 *
 *   2. **Mark failed** — either every selected kind already has a
 *      terminal kindRun (no progress *to* resume — something fired
 *      `completeGeneration` for some kinds but never closed the job),
 *      or `resumeAttempts >= MAX_RESUME_ATTEMPTS` (loop-guard: a job
 *      that keeps stalling is signal of a deeper bug, surface it
 *      rather than absorbing forever).
 */
export const recoverStaleSystemDesignJob = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<{ recovered: boolean; resumed: boolean }> => {
    const now = Date.now();
    const job = await ctx.db.get(args.jobId);
    if (!isJobStaleAndRecoverable(job, now, { expectedKind: "system_design" })) {
      return { recovered: false, resumed: false };
    }

    const selections = (job.selections ?? []) as SystemDesignKind[];
    if (selections.length === 0 || !job.repositoryId) {
      // Defensive: a system_design job without selections / repositoryId
      // is malformed (the request mutation rejects both). Fall straight
      // through to fail recovery — there's no work to resume.
      const failed = await failStaleActiveJob(ctx, {
        jobId: args.jobId,
        expectedKind: "system_design",
        now,
        errorMessage: STALE_SYSTEM_DESIGN_JOB_ERROR_MESSAGE,
      });
      return { recovered: failed !== null, resumed: false };
    }

    const kindRuns = await ctx.db
      .query("systemDesignKindRuns")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const completedKinds = new Set<SystemDesignKind>(
      kindRuns.filter((row) => KIND_RUN_TERMINAL_STATUSES.has(row.status)).map((row) => row.kind as SystemDesignKind),
    );
    const remaining = selections.filter((kind) => !completedKinds.has(kind));

    const resumeAttempts = job.resumeAttempts ?? 0;
    const canResume = remaining.length > 0 && resumeAttempts < MAX_RESUME_ATTEMPTS;
    if (!canResume) {
      const errorMessage =
        resumeAttempts >= MAX_RESUME_ATTEMPTS
          ? STALE_SYSTEM_DESIGN_RESUME_EXHAUSTED_MESSAGE
          : STALE_SYSTEM_DESIGN_JOB_ERROR_MESSAGE;
      const failed = await failStaleActiveJob(ctx, {
        jobId: args.jobId,
        expectedKind: "system_design",
        now,
        errorMessage,
      });
      logInfo("systemDesign", "stale_recovery_failed", {
        jobId: args.jobId,
        repositoryId: job.repositoryId,
        resumeAttempts,
        remainingCount: remaining.length,
        reason: resumeAttempts >= MAX_RESUME_ATTEMPTS ? "resume_exhausted" : "no_progress",
      });
      return { recovered: failed !== null, resumed: false };
    }

    // Resume: patch back to queued so the action's transition guard
    // succeeds, bump resume counter + lease, and re-enqueue. The
    // forwarded `forceRegenerate` is `false` — the cache from the
    // original attempt is intentionally trusted (kinds that completed
    // hit cache on resume).
    await ctx.db.patch(args.jobId, {
      status: "queued",
      stage: `resuming (attempt ${resumeAttempts + 1})`,
      progress: kindRuns.length === 0 ? 0 : Math.min(1, completedKinds.size / selections.length),
      resumeAttempts: resumeAttempts + 1,
      leaseExpiresAt: now + SYSTEM_DESIGN_JOB_LEASE_MS,
      // Clear the previous attempt's transient error message; resume
      // is taking another swing.
      errorMessage: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.systemDesignNode.runSystemDesignGeneration, {
      jobId: args.jobId,
      repositoryId: job.repositoryId,
      ownerTokenIdentifier: job.ownerTokenIdentifier,
      selections,
      forceRegenerate: false,
    });
    logInfo("systemDesign", "stale_recovery_resumed", {
      jobId: args.jobId,
      repositoryId: job.repositoryId,
      resumeAttempts: resumeAttempts + 1,
      remainingCount: remaining.length,
    });
    return { recovered: true, resumed: true };
  },
});

/**
 * Internal-only query loading the context the Node action needs to run the
 * generators. Returns `null` when the repository is missing or no longer
 * owned by the viewer that scheduled the job — the action treats that as a
 * cancellation and skips work.
 */
export const getGenerationContext = internalQuery({
  args: { repositoryId: v.id("repositories"), ownerTokenIdentifier: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    repository: Doc<"repositories">;
  } | null> => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!isOwnedBy(repository, args.ownerTokenIdentifier)) return null;
    return { repository };
  },
});

/**
 * Internal-only artifact persister called by the Node action once a kind's
 * markdown is ready. Resolves the destination folder by `systemKey`, replaces
 * any existing artifact of the same kind in the same folder (so re-running
 * the publication overwrites rather than accumulates), and writes the new
 * row through the standard `createArtifactInMutation` path so chunking +
 * indexing kick in automatically.
 */
export const persistGeneratedArtifact = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    jobId: v.id("jobs"),
    kind: systemDesignKindValidator,
    title: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
    alignedImportCommitSha: v.optional(v.string()),
    /**
     * Provenance triple — together with `alignedImportCommitSha`,
     * forms the cache key the next generation run will probe via
     * `findCachedArtifact`.
     */
    generatedByProvider: v.optional(llmProviderValidator),
    generatedByModel: v.optional(v.string()),
    promptVersion: v.optional(v.number()),
  },
  returns: persistedArtifactResultValidator,
  handler: async (ctx, args): Promise<{ artifactId: Id<"artifacts"> }> => {
    const folderKey = SYSTEM_DESIGN_KIND_TO_FOLDER[args.kind as SystemDesignKind];
    // Tolerant lookup: `by_repositoryId_and_systemKey` is non-unique, so
    // `.unique()` would throw if two seeded folders ever share a key (e.g.
    // a race between concurrent `ensureSystemDesignFolders` callers). Take
    // up to 2 and pick the oldest deterministically (Convex orders by
    // `_creationTime` within an index), warning when we see a collision so
    // ops can dedup the table out-of-band.
    const candidates = await ctx.db
      .query("artifactFolders")
      .withIndex("by_repositoryId_and_systemKey", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("systemKey", folderKey),
      )
      .take(2);

    const targetFolder = candidates[0] ?? null;
    if (targetFolder === null) {
      throw new Error(`Destination folder for ${args.kind} (systemKey=${folderKey}) is missing.`);
    }
    if (candidates.length > 1) {
      logWarn("system_design", "duplicate_seeded_folder", {
        repositoryId: args.repositoryId,
        systemKey: folderKey,
        chosenFolderId: targetFolder._id,
      });
    }

    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId_and_folderId", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("folderId", targetFolder._id),
      )
      .collect();
    const stale = existing.find((row) => row.kind === args.kind);
    if (stale) {
      // Cascade through `deleteArtifactInternal` so `artifactChunks` are
      // dropped with the row. A raw `db.delete` here would leak orphan
      // chunks every time a kind is re-generated.
      await deleteArtifactInternal(ctx, stale._id);
    }

    const artifactId = await createArtifactInMutation(ctx, {
      repositoryId: args.repositoryId,
      jobId: args.jobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: args.kind,
      title: args.title,
      summary: args.summary,
      contentMarkdown: args.contentMarkdown,
      folderId: targetFolder._id,
      alignedImportCommitSha: args.alignedImportCommitSha,
      generatedByProvider: args.generatedByProvider,
      generatedByModel: args.generatedByModel,
      promptVersion: args.promptVersion,
    });

    return { artifactId };
  },
});

/**
 * Mutation arg validator for the `recordKindRun` insert. Mirrors the
 * schema's `kindRunStatus` union — keep them in sync.
 */
const recordKindRunStatus = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cached_hit"),
  v.literal("quality_rejected"),
);

type SystemDesignCacheKey = {
  repositoryId: Id<"repositories">;
  kind: SystemDesignKind;
  alignedImportCommitSha: string;
  generatedByProvider: LlmProvider;
  generatedByModel: string;
  promptVersion: number;
};

/**
 * Exact idempotency cache probe. Returns the most-recent artifact matching
 * the full `(repositoryId, kind, commitSha, provider, model, promptVersion)`
 * tuple, or `null` when no match exists. Legacy artifacts missing any cache
 * metadata field do not match this index lookup.
 */
async function findCachedArtifactByKey(ctx: QueryCtx, key: SystemDesignCacheKey): Promise<Doc<"artifacts"> | null> {
  return await ctx.db
    .query("artifacts")
    .withIndex("by_repo_kind_commit_provider_model_promptVersion", (q) =>
      q
        .eq("repositoryId", key.repositoryId)
        .eq("kind", key.kind)
        .eq("alignedImportCommitSha", key.alignedImportCommitSha)
        .eq("generatedByProvider", key.generatedByProvider)
        .eq("generatedByModel", key.generatedByModel)
        .eq("promptVersion", key.promptVersion),
    )
    .order("desc")
    .first();
}

export const findCachedArtifact = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    kind: systemDesignKindValidator,
    alignedImportCommitSha: v.string(),
    generatedByProvider: llmProviderValidator,
    generatedByModel: v.string(),
    promptVersion: v.number(),
  },
  handler: async (ctx, args): Promise<Doc<"artifacts"> | null> => {
    return await findCachedArtifactByKey(ctx, args);
  },
});

/**
 * Read the LLM provider + model the job was created against. The
 * row is patched once at request time and never updated, so a
 * stale-recovery resume picks up the same pair. Falls back to the
 * System Design defaults when the row is somehow missing them
 * (pre-PR-A2 rows, manual mutation) — non-fatal but logged.
 *
 * `reasoningEffort` rides alongside so the Node action can forward
 * the override into the gateway without re-reading the row.
 */
export const getJobModelChoice = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    provider: LlmProvider;
    modelName: string;
    reasoningEffort: ReasoningEffort | undefined;
  }> => {
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      throw new Error(`Job ${args.jobId} not found while resolving model choice.`);
    }
    if (job.provider && job.modelName) {
      return { provider: job.provider, modelName: job.modelName, reasoningEffort: job.reasoningEffort };
    }
    logWarn("systemDesign", "job_missing_model_choice", {
      jobId: args.jobId,
      provider: job.provider ?? null,
      modelName: job.modelName ?? null,
      hint: "Falling back to System Design defaults — expected for pre-PR-A2 jobs only.",
    });
    return {
      provider: SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE.provider,
      modelName: SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE.modelName,
      reasoningEffort: undefined,
    };
  },
});

/**
 * Per-kind sandbox-cost pre-check. Throws the structured
 * `SANDBOX_DAILY_CAP_EXCEEDED` / `SANDBOX_REPOSITORY_DAILY_CAP_EXCEEDED`
 * ConvexError when either cap would not have room for the kind's
 * projected cost. Action callers catch and record the kind as
 * failed with `transport_rate_limit` so a multi-kind job that runs
 * past the cap fails cleanly rather than crashes.
 *
 * Uses the existing chat-reply estimate (`getSandboxReplyEstimateCents`)
 * which sits at $0.10 by default — System Design kinds with full tool
 * loops can exceed that, but the estimate's role is "is the bucket
 * obviously empty?" not "exactly what will this cost". Settlement on
 * `recordKindRun` charges the actual cost.
 */
export const assertKindCostBudget = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    repositoryId: v.id("repositories"),
    jobId: v.id("jobs"),
    kind: systemDesignKindValidator,
    startedAt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    await assertSandboxDailyCostBudget(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      estimateCents: getSandboxReplyEstimateCents(),
    });
    await reserveUserUsageBudget(ctx, {
      sourceId: `systemDesign:${args.jobId}:${args.kind}:${args.startedAt}`,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      feature: "systemDesign",
      estimatedCostUsd: SYSTEM_DESIGN_KIND_BUDGET_ESTIMATE_USD,
      occurredAtMs: args.startedAt,
    });
  },
});

/**
 * Append a per-kind run row and settle daily-cap accounting in one
 * atomic mutation. Settlement uses the post-call `totalCostUsd` from
 * the gateway (not the pre-check estimate), so the daily cap reflects
 * actual spend.
 *
 * `cents <= 0` short-circuits the cap settle (heuristic / unknown
 * cost paths) — `consumeSandboxDailyCost` is idempotent on
 * non-positive amounts.
 */
export const recordKindRun = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    repositoryId: v.id("repositories"),
    jobId: v.id("jobs"),
    kind: systemDesignKindValidator,
    artifactId: v.optional(v.id("artifacts")),
    provider: llmProviderValidator,
    modelName: v.string(),
    promptVersion: v.number(),
    alignedImportCommitSha: v.optional(v.string()),
    stepCap: v.number(),
    actualSteps: v.number(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    totalCostUsd: v.optional(v.number()),
    durationMs: v.number(),
    status: recordKindRunStatus,
    failureReason: v.optional(systemDesignFailureReasonValidator),
    outputCharLength: v.optional(v.number()),
    missingSections: v.optional(v.array(v.string())),
    startedAt: v.number(),
    sourceId: v.optional(v.string()),
  },
  returns: recordedKindRunResultValidator,
  handler: async (ctx, args): Promise<{ kindRunId: Id<"systemDesignKindRuns"> }> => {
    const kindRunId = await ctx.db.insert("systemDesignKindRuns", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      jobId: args.jobId,
      kind: args.kind,
      artifactId: args.artifactId,
      provider: args.provider,
      modelName: args.modelName,
      promptVersion: args.promptVersion,
      alignedImportCommitSha: args.alignedImportCommitSha,
      stepCap: args.stepCap,
      actualSteps: args.actualSteps,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedInputTokens: args.cachedInputTokens,
      cacheWriteTokens: args.cacheWriteTokens,
      reasoningTokens: args.reasoningTokens,
      totalCostUsd: args.totalCostUsd,
      durationMs: args.durationMs,
      status: args.status,
      failureReason: args.failureReason,
      outputCharLength: args.outputCharLength,
      missingSections: args.missingSections,
      startedAt: args.startedAt,
    });

    if (args.status !== "cached_hit") {
      await recordUserUsageEvent(ctx, {
        sourceId: args.sourceId ?? `systemDesignKindRun:${kindRunId}`,
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        feature: "systemDesign",
        occurredAtMs: args.startedAt,
        usd: args.totalCostUsd,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        cachedInputTokens: args.cachedInputTokens,
        cacheWriteTokens: args.cacheWriteTokens,
        reasoningTokens: args.reasoningTokens,
      });
    }

    // Daily cap settlement. `cached_hit` rows have no incremental
    // spend (the artifact was already paid for). Non-positive costs
    // (heuristic, pricing miss) short-circuit inside
    // `consumeSandboxDailyCost`.
    const settleCents = args.status === "cached_hit" ? undefined : costUsdToCents(args.totalCostUsd);
    if (settleCents !== undefined && settleCents > 0) {
      await consumeSandboxDailyCost(ctx, {
        ownerTokenIdentifier: args.ownerTokenIdentifier,
        repositoryId: args.repositoryId,
        cents: settleCents,
      });
    }

    return { kindRunId };
  },
});

/**
 * Patch a previously-created artifact with the back-reference to its
 * originating `systemDesignKindRuns` row. Split out from
 * `persistGeneratedArtifact` because the kindRun is recorded AFTER
 * the artifact is written (so analytics see the artifact's success
 * before pulling the run trace).
 */
export const linkKindRun = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    kindRunId: v.id("systemDesignKindRuns"),
  },
  handler: async (ctx, args): Promise<void> => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) {
      return;
    }
    await ctx.db.patch(args.artifactId, { kindRunId: args.kindRunId });
    await ctx.db.patch(args.kindRunId, { artifactId: args.artifactId });
  },
});

/**
 * Catalog passthrough — exposes the model picker to the frontend
 * without leaking the gateway internals. Filters via
 * `listPickableModels` (drops internal-only entries) and optionally
 * scopes by capability tier so the System Design dialog only shows
 * sandbox-capable models.
 */
export const listAvailableModels = query({
  args: {
    capability: v.optional(v.union(v.literal("sandbox"), v.literal("library"), v.literal("discuss"))),
  },
  handler: async (
    _ctx,
    args,
  ): Promise<
    ReadonlyArray<{
      provider: LlmProvider;
      modelName: string;
      displayName: string;
      capability: "sandbox" | "library" | "discuss";
      supportsTools: boolean;
      contextWindow: number;
    }>
  > => {
    return listPickableModels({ capability: args.capability }).map((entry) => ({
      provider: entry.provider,
      modelName: entry.modelName,
      displayName: entry.displayName,
      // `listPickableModels` filters to `userPickable: true` entries; the
      // catalog only marks generation-tier rows as pickable, so this
      // cast preserves the documented narrower return type without a
      // runtime check.
      capability: entry.capability as "sandbox" | "library" | "discuss",
      supportsTools: entry.supportsTools,
      contextWindow: entry.contextWindow,
    }));
  },
});

/**
 * UI helper: given a planned (selections, provider, model) tuple,
 * return how many of the selected kinds already have a fresh cached
 * artifact aligned to the repository's last imported commit. Drives
 * the "5 of 7 already cached on this commit" preview in the Generate
 * dialog.
 *
 * Conservative: a kind whose `alignedImportCommitSha` is missing or
 * does not match the repo's `lastSyncedCommitSha` is treated as
 * "would regenerate" — the preview never under-reports cost.
 */
export const getCachedSelectionStatus = query({
  args: {
    repositoryId: v.id("repositories"),
    selections: v.array(systemDesignKindValidator),
    provider: v.optional(llmProviderValidator),
    modelName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    total: number;
    cachedKinds: SystemDesignKind[];
    pendingKinds: SystemDesignKind[];
  }> => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    const selections = normalizeSystemDesignSelections(args.selections);
    const { provider, modelName } = resolveSystemDesignCachePreviewModel(args);
    const commitSha = repository?.lastSyncedCommitSha;
    if (!repository || !commitSha) {
      return {
        total: selections.length,
        cachedKinds: [],
        pendingKinds: selections,
      };
    }
    const cachedKinds: SystemDesignKind[] = [];
    const pendingKinds: SystemDesignKind[] = [];
    for (const kind of selections) {
      const promptVersion = SYSTEM_DESIGN_PROMPT_VERSIONS[kind];
      const cached = await findCachedArtifactByKey(ctx, {
        repositoryId: args.repositoryId,
        kind,
        alignedImportCommitSha: commitSha,
        generatedByProvider: provider,
        generatedByModel: modelName,
        promptVersion,
      });
      if (cached) {
        cachedKinds.push(kind);
      } else {
        pendingKinds.push(kind);
      }
    }
    return { total: selections.length, cachedKinds, pendingKinds };
  },
});
