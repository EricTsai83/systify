import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { requireActiveRepositoryForOwner } from "./lib/repositoryAccess";
import {
  ensureSystemDesignFolders,
  SYSTEM_DESIGN_KIND_GENERATOR,
  SYSTEM_DESIGN_KIND_TITLES,
  SYSTEM_DESIGN_KIND_TO_FOLDER,
  systemDesignKindValidator,
  type SystemDesignKind,
} from "./lib/systemDesign";
import { createArtifactInMutation, deleteArtifactInternal } from "./artifactStore";
import { getSandboxAvailability } from "./lib/sandboxAvailability";
import {
  completeRunningJob,
  failRunningJob,
  failStaleActiveJob,
  markQueuedJobRunning,
  refreshRunningJobLease,
  updateRunningJobProgress,
} from "./jobLifecycle";
import {
  consumeDaytonaGlobalRateLimit,
  consumeSystemDesignRateLimit,
  SYSTEM_DESIGN_JOB_LEASE_MS,
} from "./lib/rateLimit";
import { logWarn } from "./lib/observability";

const FAILURE_MODE_REQUESTED_COMMAND_PREFIX = "failure_mode_analysis:";

function isFailureModeJob(job: Doc<"jobs">): boolean {
  return job.requestedCommand?.startsWith(FAILURE_MODE_REQUESTED_COMMAND_PREFIX) ?? false;
}

function hasLlmSelection(selections: ReadonlyArray<SystemDesignKind>): boolean {
  return selections.some((kind) => SYSTEM_DESIGN_KIND_GENERATOR[kind] === "llm");
}

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
 * uniformly with the other sandbox-backed analyses (Failure Mode Analysis).
 * Progress and final status flow back to the UI through the standard job
 * subscription.
 */
export const requestSystemDesignGeneration = mutation({
  args: {
    repositoryId: v.id("repositories"),
    selections: v.array(systemDesignKindValidator),
  },
  handler: async (ctx, args): Promise<{ jobId: Id<"jobs"> }> => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await requireActiveRepositoryForOwner(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    if (args.selections.length === 0) {
      throw new Error("Select at least one document to generate.");
    }

    const uniqueSelections = Array.from(new Set(args.selections)) as SystemDesignKind[];
    const requiresSandbox = hasLlmSelection(uniqueSelections);
    const now = Date.now();

    // Sandbox preflight: LLM-backed kinds need a ready sandbox. We reject the
    // whole request here so the user gets one clear error instead of N
    // per-kind failures in the job summary later.
    let sandboxId: Id<"sandboxes"> | undefined;
    if (requiresSandbox) {
      const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
      const availability = getSandboxAvailability(sandbox, now);
      if (!availability.available || !sandbox) {
        throw new Error(
          availability.message ??
            "A live sandbox is required for the selected documents. Sync the repository to provision one.",
        );
      }
      sandboxId = sandbox._id;
    }

    // Library System Design generation and Failure Mode Analysis both ride the
    // `system_design` job kind. FMA jobs are distinguished by a
    // `failure_mode_analysis:` requestedCommand prefix; the dedup below
    // ignores those so an in-flight FMA does not block a Library
    // generation (and vice versa via FMA's own thread-scoped guard).
    const activeJob = await findActiveLibrarySystemDesignJob(ctx, repository._id, now);
    if (activeJob) {
      return { jobId: activeJob._id };
    }

    await consumeSystemDesignRateLimit(ctx, identity.tokenIdentifier);
    if (requiresSandbox) {
      await consumeDaytonaGlobalRateLimit(ctx);
    }

    await ensureSystemDesignFolders(ctx, {
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    const jobId = await ctx.db.insert("jobs", {
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId,
      kind: "system_design",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "system_design",
      triggerSource: "user",
      outputSummary: buildJobSummary(uniqueSelections, "queued"),
      // Set the lease at insert time so the stale-job sweep
      // (`by_status_and_kind_and_leaseExpiresAt` + `lt(leaseExpiresAt, now)`)
      // can pick this row up if the Node action never runs or dies before
      // `markGenerationStarted` patches the lease.
      leaseExpiresAt: now + SYSTEM_DESIGN_JOB_LEASE_MS,
    });

    await ctx.scheduler.runAfter(0, internal.systemDesignNode.runSystemDesignGeneration, {
      jobId,
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      selections: uniqueSelections,
    });

    return { jobId };
  },
});

const LIBRARY_SYSTEM_DESIGN_ACTIVE_SCAN_LIMIT = 8;

async function findActiveLibrarySystemDesignJob(
  ctx: QueryCtx,
  repositoryId: Id<"repositories">,
  now: number,
): Promise<Doc<"jobs"> | null> {
  // Bounded scan via the existing `(repositoryId, kind, status, leaseExpiresAt)`
  // index. We page a few rows per (queued, running) bucket and exclude FMA
  // jobs in JS — FMA volume per repo is small, so a couple of `.take(8)`s
  // beats `.collect()` + JS filter on the unindexed status/kind pair. We
  // prefer `running` over `queued` so the dialog shows the most-advanced
  // active job when both states coexist.
  const [queuedCandidates, runningCandidates] = await Promise.all([
    ctx.db
      .query("jobs")
      .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q
          .eq("repositoryId", repositoryId)
          .eq("kind", "system_design")
          .eq("status", "queued")
          .gte("leaseExpiresAt", now),
      )
      .take(LIBRARY_SYSTEM_DESIGN_ACTIVE_SCAN_LIMIT),
    ctx.db
      .query("jobs")
      .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q
          .eq("repositoryId", repositoryId)
          .eq("kind", "system_design")
          .eq("status", "running")
          .gte("leaseExpiresAt", now),
      )
      .take(LIBRARY_SYSTEM_DESIGN_ACTIVE_SCAN_LIMIT),
  ]);
  for (const job of [...runningCandidates, ...queuedCandidates]) {
    if (!isFailureModeJob(job)) {
      return job;
    }
  }
  return null;
}

/**
 * Listing helper: surface the most recent generation job for the repo so the
 * UI can render the "Generating 3 of 5…" pill above the folder navigator and
 * disable the Generate button while a job is in-flight.
 */
export const getActiveSystemDesignJob = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<Doc<"jobs"> | null> => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
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
 */
const LIBRARY_SYSTEM_DESIGN_LATEST_SCAN_LIMIT = 16;

export const getLatestSystemDesignJob = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<Doc<"jobs"> | null> => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }

    // Paginated scan: iteratively fetch batches until we find the first
    // non-FMA `system_design` job, bounded by a hard cap to keep cost predictable.
    const now = Date.now();
    const hardCap = LIBRARY_SYSTEM_DESIGN_LATEST_SCAN_LIMIT * 4;
    let batchSize = LIBRARY_SYSTEM_DESIGN_LATEST_SCAN_LIMIT;
    let scanned = 0;

    while (scanned < hardCap) {
      const batch = await ctx.db
        .query("jobs")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .order("desc")
        .take(batchSize);

      // Only scan the new items in this batch (beyond what we already checked).
      const startIdx = Math.max(0, scanned);
      for (let i = startIdx; i < batch.length; i++) {
        const job = batch[i];
        if (job.kind !== "system_design") continue;
        if (isFailureModeJob(job)) continue;
        if (job.status === "queued" || job.status === "running") {
          return job;
        }
        if (typeof job.completedAt === "number" && now - job.completedAt < SYSTEM_DESIGN_BANNER_TERMINAL_WINDOW_MS) {
          return job;
        }
        // Found the latest Library System Design job but it's terminal and
        // outside the visibility window — stop here rather than walking back
        // through older history.
        return null;
      }

      scanned = batch.length;
      if (batch.length < batchSize) {
        // No more jobs available.
        break;
      }
      batchSize = Math.min(batchSize * 2, hardCap);
    }
    return null;
  },
});

export const markGenerationStarted = internalMutation({
  args: { jobId: v.id("jobs"), selections: v.array(systemDesignKindValidator) },
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
        outputSummary: buildJobSummary(args.selections as SystemDesignKind[], "running"),
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
  args: { jobId: v.id("jobs"), kind: systemDesignKindValidator, errorId: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;
    const previous = job.kindFailures ?? [];
    await ctx.db.patch(args.jobId, {
      kindFailures: [...previous, { kind: args.kind, errorId: args.errorId, message: args.message.slice(0, 200) }],
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

/**
 * Background stale-job recovery for System Design generation. Called by
 * `opsNode.recoverStaleInteractiveJobs` when a `system_design`-kind job
 * without the FMA `requestedCommand` prefix has overrun its lease.
 */
export const recoverStaleSystemDesignJob = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (
      !job ||
      job.kind !== "system_design" ||
      (job.status !== "queued" && job.status !== "running") ||
      isFailureModeJob(job) ||
      typeof job.leaseExpiresAt !== "number" ||
      job.leaseExpiresAt > now
    ) {
      return;
    }
    await failStaleActiveJob(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      now,
      errorMessage: STALE_SYSTEM_DESIGN_JOB_ERROR_MESSAGE,
    });
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
    folders: Array<{ systemKey: string; folderId: Id<"artifactFolders"> }>;
    activeSandbox: Doc<"sandboxes"> | null;
  } | null> => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== args.ownerTokenIdentifier) return null;

    const folders = await ctx.db
      .query("artifactFolders")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .collect();

    const activeSandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;

    return {
      repository,
      folders: folders
        .filter((folder) => folder.systemKey !== undefined)
        .map((folder) => ({ systemKey: folder.systemKey as string, folderId: folder._id })),
      activeSandbox,
    };
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
/**
 * Read every `repoFiles` row for the repo. The heuristic generators in
 * `systemDesignNode.ts` consume this list to recompute languages,
 * entrypoints, and important-file annotations without re-cloning the repo.
 *
 * Bounded by `take(2000)` because Convex queries cannot collect unbounded
 * rows; 2000 is well above the typical small-to-medium repo file count
 * and below the per-transaction read cap. Repositories larger than that
 * will silently lose the tail — acceptable for a heuristic doc, but flagged
 * via a `logWarn` in the action when truncation is detected.
 */
export const listRepoFilesForHeuristics = internalQuery({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<Doc<"repoFiles">[]> => {
    return await ctx.db
      .query("repoFiles")
      .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", args.repositoryId))
      .take(2000);
  },
});

export const persistGeneratedArtifact = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    jobId: v.id("jobs"),
    kind: systemDesignKindValidator,
    title: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
    source: v.union(v.literal("heuristic"), v.literal("llm"), v.literal("sandbox")),
    alignedImportCommitSha: v.optional(v.string()),
  },
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
      source: args.source,
      folderId: targetFolder._id,
      alignedImportCommitSha: args.alignedImportCommitSha,
    });

    return { artifactId };
  },
});

function buildJobSummary(selections: SystemDesignKind[], state: "queued" | "running"): string {
  const titles = selections.map((kind) => SYSTEM_DESIGN_KIND_TITLES[kind]);
  const verb = state === "queued" ? "Queued" : "Generating";
  if (titles.length === 0) {
    return `${verb} System Design documents`;
  }
  if (titles.length <= 2) {
    return `${verb} ${titles.join(" + ")}`;
  }
  return `${verb} ${titles.length} System Design documents`;
}
