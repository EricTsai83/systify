import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { mutation, query, internalQuery, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertFeatureAccess } from "./lib/entitlements";
import { requireViewerIdentity } from "./lib/auth";
import { isOwnedBy, loadOwnedDoc } from "./lib/ownedDocs";
import { getRepositorySandboxStatus } from "./lib/repositorySandbox";
import { startedResultValidator } from "./lib/functionResultSchemas";
import { runRepositoryCascadeDelete } from "./lib/repositoryCascade";
import {
  archiveOwnedRepository,
  cancelRepositoryGenerationJobs as cancelRepositoryGenerationJobsForRetirement,
  requestRepositoryDeletion,
  restoreOwnedRepository,
} from "./lib/repositoryRetirement";
import {
  hasRemoteUpdates,
  isRepositoryArchived,
  loadAccessibleRepositoryForViewer,
  requireActiveRepositoryForViewer,
} from "./lib/repositoryAccess";
import { consumeDaytonaGlobalRateLimit, SANDBOX_ACTIVATION_JOB_LEASE_MS } from "./lib/rateLimit";
import {
  enqueueJob,
  failRunningJob,
  completeRunningJob,
  findActiveJob,
  markQueuedJobRunning,
  runStaleJobRecovery,
} from "./lib/jobs";
import { startRepositoryImportFromUrl, startRepositorySyncImport } from "./lib/repositoryImportWorkflow";
import { resolveSandboxActivityLifecycleStatus } from "./lib/liveSourceLifecycle";

const FILE_COUNT_DISPLAY_LIMIT = 400;
const REPOSITORY_DETAIL_IMPORT_ARTIFACT_LIMIT = 10;
const REPOSITORY_LIST_TAKE = 200;

export const listRepositories = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    const repositories = await ctx.db
      .query("repositories")
      .withIndex("by_ownerTokenIdentifier_and_deletionRequestedAt_and_importedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("deletionRequestedAt", undefined),
      )
      .order("desc")
      .take(REPOSITORY_LIST_TAKE);

    return repositories.filter((repo) => repo.archivedAt === undefined);
  },
});

/**
 * Resources page — cross-repository inventory of the viewer's active
 * repositories joined with their latest sandbox + sync status.
 *
 * One query feeds the page so the client renders without an N+1 over
 * `getRepositoryDetail`. We re-use the same helpers the per-repo TopBar
 * status pill consumes so the Resources cards and the per-thread chrome
 * never disagree about what a given sandbox is doing.
 */
export const listResourceInventory = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);

    const repositories = await ctx.db
      .query("repositories")
      .withIndex("by_ownerTokenIdentifier_and_deletionRequestedAt_and_importedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("deletionRequestedAt", undefined),
      )
      .order("desc")
      .take(REPOSITORY_LIST_TAKE);

    const activeRepositories = repositories.filter((repo) => repo.archivedAt === undefined);

    const inventory = await Promise.all(
      activeRepositories.map(async (repo) => {
        const sandboxStatus = await getRepositorySandboxStatus(ctx, repo);
        const { sandboxModeStatus, sandbox } = sandboxStatus;
        return {
          repositoryId: repo._id,
          fullName: repo.sourceRepoFullName,
          importStatus: repo.importStatus,
          lastImportedAt: repo.lastImportedAt,
          hasRemoteUpdates: hasRemoteUpdates(repo),
          sandboxModeStatus,
          sandbox: sandbox
            ? {
                status: sandbox.status,
                ttlExpiresAt: sandbox.ttlExpiresAt,
                autoStopIntervalMinutes: sandbox.autoStopIntervalMinutes,
                autoArchiveIntervalMinutes: sandbox.autoArchiveIntervalMinutes,
              }
            : null,
        };
      }),
    );

    return inventory;
  },
});

/**
 * Paginated archive listing with optional full-text search over
 * `sourceRepoFullName`. Two execution paths:
 *
 *   - **Browse** (no `searchTerm`) — uses `by_ownerTokenIdentifier_and_archivedAt`
 *     ordered by `archivedAt` desc. Fully reactive: archive/restore mutations
 *     refresh the page automatically.
 *   - **Search** (`searchTerm` set) — uses the `search_full_name` text index,
 *     ranked by relevance. Convex paginated search is not reactive, but the
 *     archive view treats search as a bursty find-something interaction so
 *     the user re-runs the query after data changes anyway.
 *
 * Both branches post-filter by `deletionRequestedAt === undefined` (and the
 * search branch additionally requires `archivedAt > 0`, since the search
 * index is shared with the active-repo table). Post-filtering trims the
 * page below `numItems` in some batches; the cursor still advances against
 * the underlying scan, so infinite scroll keeps working — the client only
 * stops when `isDone` is true.
 */
export const listArchivedRepositories = query({
  args: {
    paginationOpts: paginationOptsValidator,
    searchTerm: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const trimmed = args.searchTerm?.trim();

    if (trimmed) {
      const result = await ctx.db
        .query("repositories")
        .withSearchIndex("search_full_name", (q) =>
          q.search("sourceRepoFullName", trimmed).eq("ownerTokenIdentifier", identity.tokenIdentifier),
        )
        .paginate(args.paginationOpts);

      return {
        ...result,
        page: result.page.filter((repo) => (repo.archivedAt ?? 0) > 0 && repo.deletionRequestedAt === undefined),
      };
    }

    const result = await ctx.db
      .query("repositories")
      .withIndex("by_ownerTokenIdentifier_and_archivedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).gt("archivedAt", 0),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: result.page.filter((repo) => repo.deletionRequestedAt === undefined),
    };
  },
});

/**
 * Returns a summary of all imported repositories for the current user,
 * keyed by `sourceRepoFullName`. Used by the authorized-repos dialog
 * to show import status alongside each GitHub-authorised repo. Excludes
 * archived repositories — the import dialog only surfaces actively-tracked
 * repos so a re-import of an archived URL will go through `createRepositoryImport`.
 */
export const getImportedRepoSummaries = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    const repos = await ctx.db
      .query("repositories")
      .withIndex("by_ownerTokenIdentifier_and_deletionRequestedAt_and_importedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("deletionRequestedAt", undefined),
      )
      .take(REPOSITORY_LIST_TAKE);

    const summaries: Record<
      string,
      {
        importStatus: string;
        lastImportedAt: number | undefined;
        hasRemoteUpdates: boolean;
      }
    > = {};

    for (const repo of repos) {
      if (repo.archivedAt !== undefined) {
        continue;
      }
      summaries[repo.sourceRepoFullName] = {
        importStatus: repo.importStatus,
        lastImportedAt: repo.lastImportedAt,
        hasRemoteUpdates: hasRemoteUpdates(repo),
      };
    }

    return summaries;
  },
});

export const getRepositoryDetail = query({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const { identity, repository } = await loadAccessibleRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
    });
    if (!repository) {
      return null;
    }

    const isArchived = isRepositoryArchived(repository);

    const artifacts = repository.latestImportJobId
      ? await ctx.db
          .query("artifacts")
          .withIndex("by_jobId", (q) => q.eq("jobId", repository.latestImportJobId!))
          .take(REPOSITORY_DETAIL_IMPORT_ARTIFACT_LIMIT)
      : [];
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(30);

    // `latestImportJobId` on the repository row points at the last *successful*
    // import (`applyImportCompletionState` writes it), so it's the wrong source
    // for surfacing failure details — for a repo whose first import failed it's
    // undefined, and for a re-sync failure it points at the previous success.
    // `jobs` is already ordered by `_creationTime` desc, so the first matching
    // entry is the most recent failed import job and its `errorMessage` is what
    // `markImportFailed` wrote.
    const latestFailedImportError =
      jobs.find((job) => job.kind === "import" && job.status === "failed")?.errorMessage ?? null;

    const threads = await ctx.db
      .query("threads")
      .withIndex("by_owner_repo_delete_archive_lastMsg", (q) =>
        q
          .eq("ownerTokenIdentifier", identity.tokenIdentifier)
          .eq("repositoryId", args.repositoryId)
          .eq("deletionRequestedAt", undefined)
          .eq("archivedAt", undefined),
      )
      .order("desc")
      .take(10);

    const fileCount = repository.fileCount;
    const fileCountLabel = fileCount >= FILE_COUNT_DISPLAY_LIMIT ? `${FILE_COUNT_DISPLAY_LIMIT}+` : String(fileCount);

    const { sandboxModeStatus, sandbox } = await getRepositorySandboxStatus(ctx, repository);

    return {
      repository,
      isArchived,
      archivedAt: repository.archivedAt ?? null,
      artifacts,
      jobs,
      threads,
      fileCount,
      fileCountLabel,
      sandboxModeStatus,
      hasRemoteUpdates: hasRemoteUpdates(repository),
      latestFailedImportError,
      sandbox: sandbox
        ? {
            status: sandbox.status,
            ttlExpiresAt: sandbox.ttlExpiresAt,
            autoStopIntervalMinutes: sandbox.autoStopIntervalMinutes,
            autoArchiveIntervalMinutes: sandbox.autoArchiveIntervalMinutes,
          }
        : null,
    };
  },
});

export const createRepositoryImport = mutation({
  args: {
    url: v.string(),
    branch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    await assertFeatureAccess(ctx, identity, "repoImport");
    const result = await startRepositoryImportFromUrl(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      url: args.url,
      branch: args.branch,
    });

    // `defaultThreadMode` rides alongside `defaultThreadId` so the import
    // callback can route the user straight to the canonical mode-aware URL
    // (`/r/:repositoryId/discuss/:tid`) without any intermediate redirect.
    return result;
  },
});

export const syncRepository = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const { identity, repository } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
    });
    await assertFeatureAccess(ctx, identity, "syncRepository");

    const { jobId, importId } = await startRepositorySyncImport(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repository,
    });

    return { jobId, importId };
  },
});

export const archiveRepository = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    await archiveOwnedRepository(ctx, args);
  },
});

export const restoreRepository = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    await restoreOwnedRepository(ctx, args);
  },
});

export const deleteRepository = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    await requestRepositoryDeletion(ctx, args);
  },
});

export const cascadeDeleteRepository = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await runRepositoryCascadeDelete(ctx, args);
    return null;
  },
});

export const cancelRepositoryGenerationJobs = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await cancelRepositoryGenerationJobsForRetirement(ctx, args);
    return null;
  },
});

export const updateRepoVisibility = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    visibility: v.union(v.literal("public"), v.literal("private")),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return;
    await ctx.db.patch(args.repositoryId, { visibility: args.visibility });
  },
});

/**
 * Snapshot used by `ensureSandboxReady` to decide whether to return the
 * existing sandbox, wake a stopped one, or provision a fresh one. Returns
 * `null` when the repository is missing or no longer owned by the
 * requesting identity — the caller treats that as a fatal "repository
 * went away" error rather than provisioning blindly.
 */
export const getRepositorySandboxForPreparation = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!isOwnedBy(repository, args.ownerTokenIdentifier)) {
      return null;
    }
    if (repository.deletionRequestedAt || repository.archivedAt) {
      return null;
    }
    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
    return { repository, sandbox };
  },
});

export const getRepositoryForProcessing = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository) {
      throw new Error("Repository not found.");
    }

    const artifacts = repository.latestImportJobId
      ? await ctx.db
          .query("artifacts")
          .withIndex("by_jobId", (q) => q.eq("jobId", repository.latestImportJobId!))
          .take(20)
      : [];
    const chunks = repository.latestImportId
      ? await ctx.db
          .query("repoChunks")
          .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", repository.latestImportId!))
          .take(60)
      : [];

    return {
      repository,
      artifacts,
      chunks,
    };
  },
});

const SANDBOX_EXPIRING_SOON_MS = 5 * 60_000;

async function findActiveSandboxActivationJob(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories">; now: number },
) {
  return await findActiveJob(ctx, {
    kind: "sandbox_activation",
    scope: { type: "repository", id: args.repositoryId },
    now: args.now,
  });
}

async function findActiveSandboxBackedJob(
  ctx: QueryCtx,
  args: { repositoryId: Id<"repositories">; now: number },
): Promise<Doc<"jobs"> | null> {
  const jobCandidates = await Promise.all([
    findActiveJob(ctx, {
      kind: "chat",
      scope: { type: "repository", id: args.repositoryId },
      now: args.now,
      predicate: (job) => job.costCategory === "system_design",
      limit: 5,
    }),
    findActiveJob(ctx, {
      kind: "system_design",
      scope: { type: "repository", id: args.repositoryId },
      now: args.now,
    }),
    findActiveJob(ctx, {
      kind: "artifact_draft",
      scope: { type: "repository", id: args.repositoryId },
      now: args.now,
    }),
    findActiveJob(ctx, {
      kind: "sandbox_activation",
      scope: { type: "repository", id: args.repositoryId },
      now: args.now,
    }),
  ]);

  return (
    jobCandidates
      .filter((job): job is Doc<"jobs"> => job !== null)
      .sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === "running" ? -1 : 1;
        }
        return right._creationTime - left._creationTime;
      })[0] ?? null
  );
}

/**
 * Compatibility/debug request to wake or provision the repository's
 * sandbox. Main user flows call `ensureSandboxReady` lazily from the
 * task action (chat, artifact draft, System Design); this mutation is
 * retained so internal tools and older clients do not break.
 *
 * Dedup is per-repository: an in-flight `sandbox_activation` job
 * short-circuits to its existing id so a double-click never queues two
 * concurrent provisions.
 */
export const requestSandboxActivation = mutation({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<{ jobId: Id<"jobs"> }> => {
    const { identity, repository } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
    });
    await assertFeatureAccess(ctx, identity, "sandboxGrounding");

    const now = Date.now();
    const existing = await findActiveSandboxActivationJob(ctx, { repositoryId: repository._id, now });
    if (existing) {
      return { jobId: existing._id };
    }

    await consumeDaytonaGlobalRateLimit(ctx);

    const jobId = await enqueueJob(ctx, {
      kind: "sandbox_activation",
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId: repository.latestSandboxId,
      costCategory: "ops",
      triggerSource: "user",
      leaseMs: SANDBOX_ACTIVATION_JOB_LEASE_MS,
    });

    await ctx.scheduler.runAfter(0, internal.sandboxActivationNode.runSandboxActivation, {
      jobId,
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    return { jobId };
  },
});

export const markSandboxActivationStarted = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: startedResultValidator,
  handler: async (ctx, args): Promise<{ started: boolean }> => {
    const now = Date.now();
    const result = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "sandbox_activation",
      stage: "Preparing environment…",
      progress: 0.1,
      startedAt: now,
      leaseExpiresAt: now + SANDBOX_ACTIVATION_JOB_LEASE_MS,
    });
    return { started: result !== null };
  },
});

export const updateSandboxActivationStage = internalMutation({
  args: {
    jobId: v.id("jobs"),
    stage: v.string(),
    progress: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.kind !== "sandbox_activation" || job.status !== "running") {
      return;
    }
    await ctx.db.patch(args.jobId, {
      stage: args.stage,
      progress: args.progress,
      leaseExpiresAt: Date.now() + SANDBOX_ACTIVATION_JOB_LEASE_MS,
    });
  },
});

export const completeSandboxActivation = internalMutation({
  args: { jobId: v.id("jobs"), sandboxId: v.id("sandboxes") },
  handler: async (ctx, args) => {
    const completedJob = await completeRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "sandbox_activation",
      completedAt: Date.now(),
      outputSummary: "Live source ready.",
    });
    // `recoverStaleSandboxActivationJob` can race ahead and mark this
    // job `failed` between the action starting and finishing.
    // `completeRunningJob` only patches when the job is still `running`
    // and returns `null` otherwise — patching `sandboxId` onto a failed
    // job would leave the terminal state inconsistent.
    if (!completedJob) return;
    await ctx.db.patch(args.jobId, { sandboxId: args.sandboxId });
  },
});

export const failSandboxActivation = internalMutation({
  args: { jobId: v.id("jobs"), errorMessage: v.string() },
  handler: async (ctx, args) => {
    await failRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "sandbox_activation",
      completedAt: Date.now(),
      errorMessage: args.errorMessage,
    });
  },
});

const STALE_SANDBOX_ACTIVATION_JOB_ERROR_MESSAGE = "Sandbox activation stalled and was automatically marked as failed.";

/**
 * Background stale-job recovery for sandbox activation. Called by
 * `opsNode.reconcileStaleInteractiveJobs` when a `sandbox_activation`-kind
 * job has overrun its lease.
 */
export const recoverStaleSandboxActivationJob = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    await runStaleJobRecovery(ctx, {
      jobId: args.jobId,
      expectedKind: "sandbox_activation",
      errorMessage: STALE_SANDBOX_ACTIVATION_JOB_ERROR_MESSAGE,
    });
  },
});

/**
 * Lightweight status read for the chat sandbox-mode status pill. Returns
 * one of:
 *
 *   - `idle`           — no ready/provisioning sandbox and no active
 *                        sandbox-backed job. UI shows passive prepare-on-send.
 *   - `preparing`      — an active sandbox-backed job exists, or the latest
 *                        sandbox row is provisioning.
 *                        UI shows progress.
 *   - `ready`          — sandbox is ready and not expiring soon.
 *   - `expiring_soon`  — sandbox is ready but TTL is < 5 min away.
 */
export const getSandboxActivityStatus = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    kind: "idle" | "preparing" | "ready" | "expiring_soon";
    activeJob: Doc<"jobs"> | null;
    sandbox: Doc<"sandboxes"> | null;
  }> => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return { kind: "idle", activeJob: null, sandbox: null };
    }

    const now = Date.now();
    const activeJob = await findActiveSandboxBackedJob(ctx, { repositoryId: args.repositoryId, now });
    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;

    const kind = resolveSandboxActivityLifecycleStatus({
      activeJob,
      sandbox,
      now,
      expiringSoonMs: SANDBOX_EXPIRING_SOON_MS,
    });
    return {
      kind,
      activeJob: kind === "preparing" ? activeJob : null,
      sandbox,
    };
  },
});
