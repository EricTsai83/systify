import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { mutation, query, internalQuery, internalMutation, type MutationCtx } from "./_generated/server";
import { getDefaultThreadMode } from "./lib/chatMode";
import { requireViewerIdentity } from "./lib/auth";
import { isOwnedBy, loadOwnedDoc } from "./lib/ownedDocs";
import { getRepositorySandboxStatus } from "./lib/repositorySandbox";
import { makeRepositoryTitle, parseGitHubUrl } from "./lib/github";
import { pickNextRepositoryColor, touchRepositoryLastAccessed } from "./lib/repositoryPalette";
import { startedResultValidator } from "./lib/functionResultSchemas";
import { runRepositoryCascadeDelete } from "./lib/repositoryCascade";
import { archiveOwnedRepository, requestRepositoryDeletion, restoreOwnedRepository } from "./lib/repositoryRetirement";
import {
  hasRemoteUpdates,
  isRepositoryArchived,
  loadAccessibleRepositoryForViewer,
  requireActiveRepositoryForViewer,
} from "./lib/repositoryAccess";
import {
  consumeDaytonaGlobalRateLimit,
  consumeImportRateLimit,
  SANDBOX_ACTIVATION_JOB_LEASE_MS,
  throwOperationAlreadyInProgress,
} from "./lib/rateLimit";
import {
  enqueueJob,
  failRunningJob,
  completeRunningJob,
  findActiveJob,
  markQueuedJobRunning,
  runStaleJobRecovery,
} from "./lib/jobs";

const FILE_COUNT_DISPLAY_LIMIT = 400;
const REPOSITORY_DETAIL_IMPORT_ARTIFACT_LIMIT = 10;
const REPOSITORY_LIST_TAKE = 200;

async function queueImportWorkflow(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
    sourceUrl: string;
    branch?: string;
    clearLatestRemoteSha?: boolean;
  },
) {
  const jobId = await enqueueJob(ctx, {
    kind: "import",
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    costCategory: "indexing",
    triggerSource: "user",
  });

  const importId = await ctx.db.insert("imports", {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sourceUrl: args.sourceUrl,
    branch: args.branch,
    adapterKind: "git_clone",
    status: "queued",
    jobId,
  });

  await ctx.db.patch(args.repositoryId, {
    importStatus: "queued",
    ...(args.clearLatestRemoteSha ? { latestRemoteSha: undefined } : {}),
  });

  await ctx.scheduler.runAfter(0, internal.importsNode.runImportPipeline, {
    importId,
  });

  return { jobId, importId };
}

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
          sandbox: sandbox ? { status: sandbox.status, ttlExpiresAt: sandbox.ttlExpiresAt } : null,
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
    const { repository } = await loadAccessibleRepositoryForViewer(ctx, {
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
      .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", args.repositoryId))
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
    const parsed = parseGitHubUrl(args.url);

    // Check if user has GitHub connected via GitHub App installation
    const installation = await ctx.db
      .query("githubInstallations")
      .withIndex("by_ownerTokenIdentifier_and_status", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("status", "active"),
      )
      .first();

    if (!installation) {
      throw new Error("Please connect your GitHub account first to import repositories.");
    }

    // Installation tokens can access both public and private repos
    const accessMode = "private" as const;

    // There may be more than one record if a previous deletion is still
    // cascading (soft-deleted row lingers until background cleanup finishes)
    // or if the user archived the repo previously and is now re-importing.
    // Prefer an active (non-archived, non-deleting) row; fall back to the
    // archived row and clear `archivedAt` so the user picks up where they
    // left off without creating a duplicate.
    const candidates = await ctx.db
      .query("repositories")
      .withIndex("by_ownerTokenIdentifier_and_sourceUrl_and_deletionRequestedAt", (q) =>
        q
          .eq("ownerTokenIdentifier", identity.tokenIdentifier)
          .eq("sourceUrl", parsed.normalizedUrl)
          .eq("deletionRequestedAt", undefined),
      )
      .take(10);

    let repository = candidates.find((row) => row.archivedAt === undefined) ?? null;
    if (!repository) {
      const archived = candidates
        .filter((row) => typeof row.archivedAt === "number")
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))[0];
      if (archived) {
        await ctx.db.patch(archived._id, { archivedAt: undefined });
        repository = (await ctx.db.get(archived._id)) ?? null;
      }
    }

    let repositoryId = repository?._id;
    let defaultThreadId = repository?.defaultThreadId;

    if (repository && (repository.importStatus === "queued" || repository.importStatus === "running")) {
      throwOperationAlreadyInProgress(
        "repositoryImportInFlight",
        "An import is already in progress for this repository.",
      );
    }

    await consumeImportRateLimit(ctx, identity.tokenIdentifier);

    if (!repository) {
      // Visibility will be updated after the import pipeline checks GitHub API.
      // Default to 'unknown' until the actual check completes.
      const color = await pickNextRepositoryColor(ctx, identity.tokenIdentifier);
      repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier: identity.tokenIdentifier,
        sourceHost: "github",
        sourceUrl: parsed.normalizedUrl,
        sourceRepoFullName: parsed.fullName,
        sourceRepoOwner: parsed.owner,
        sourceRepoName: parsed.repo,
        defaultBranch: args.branch ?? parsed.branch,
        visibility: "unknown",
        accessMode,
        importStatus: "idle",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color,
        lastAccessedAt: Date.now(),
      });

      repository = await ctx.db.get(repositoryId);
    } else {
      await touchRepositoryLastAccessed(ctx, { repositoryId: repository._id });
    }

    if (!repositoryId || !repository) {
      throw new Error("Failed to create repository.");
    }

    const defaultThread = defaultThreadId ? await ctx.db.get(defaultThreadId) : null;
    let defaultThreadMode: Doc<"threads">["mode"];
    if (!isOwnedBy(defaultThread, identity.tokenIdentifier) || defaultThread.repositoryId !== repositoryId) {
      // Matches `resolveChatModes(true).defaultMode` for any repo-attached
      // thread, so the auto-created default thread and a manually-created
      // one start on the same mode.
      defaultThreadMode = getDefaultThreadMode(true);
      defaultThreadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        title: `${makeRepositoryTitle(repository.sourceRepoFullName)} chat`,
        mode: defaultThreadMode,
        lastMessageAt: Date.now(),
      });
    } else {
      defaultThreadMode = defaultThread.mode;
    }

    await ctx.db.patch(repositoryId, { accessMode, defaultThreadId });

    const { jobId, importId } = await queueImportWorkflow(ctx, {
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sourceUrl: parsed.normalizedUrl,
      branch: args.branch ?? parsed.branch ?? repository.defaultBranch,
    });

    // `defaultThreadMode` rides alongside `defaultThreadId` so the import
    // callback can route the user straight to the canonical mode-aware URL
    // (`/r/:repositoryId/discuss/:tid`) without any intermediate redirect.
    return {
      repositoryId,
      importId,
      jobId,
      defaultThreadId,
      defaultThreadMode,
    };
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

    // Check if user has an active GitHub installation
    const installation = await ctx.db
      .query("githubInstallations")
      .withIndex("by_ownerTokenIdentifier_and_status", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("status", "active"),
      )
      .first();

    if (!installation) {
      throw new Error("Please connect your GitHub account first to sync repositories.");
    }

    // Prevent duplicate syncs while one is already running
    if (repository.importStatus === "queued" || repository.importStatus === "running") {
      throwOperationAlreadyInProgress("repositoryImportInFlight", "A sync is already in progress for this repository.");
    }

    await consumeImportRateLimit(ctx, identity.tokenIdentifier);

    const { jobId, importId } = await queueImportWorkflow(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sourceUrl: repository.sourceUrl,
      branch: repository.defaultBranch,
      clearLatestRemoteSha: true,
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
  handler: async (ctx, args) => {
    await runRepositoryCascadeDelete(ctx, args);
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

/**
 * Explicit chat-side request to wake or provision the repository's
 * sandbox. The mutation is deliberately separate from the chat send
 * flow so the user keeps control over when sandbox compute is charged
 * — `chat.sendMessage` no longer auto-provisions silently in sandbox
 * mode (Phase D goal).
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
 *   - `idle`           — no sandbox, or sandbox in stopped/archived/failed.
 *                        UI shows "Live source inactive" + Activate button.
 *   - `activating`     — an in-flight `sandbox_activation` job exists.
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
    kind: "idle" | "activating" | "ready" | "expiring_soon";
    activeJob: Doc<"jobs"> | null;
    sandbox: Doc<"sandboxes"> | null;
  }> => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return { kind: "idle", activeJob: null, sandbox: null };
    }

    const now = Date.now();
    const activeJob = await findActiveJob(ctx, {
      kind: "sandbox_activation",
      scope: { type: "repository", id: args.repositoryId },
      now,
    });
    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;

    if (activeJob) {
      return { kind: "activating", activeJob, sandbox };
    }
    if (sandbox && sandbox.status === "ready" && sandbox.remoteId && sandbox.repoPath && sandbox.ttlExpiresAt > now) {
      const remainingMs = sandbox.ttlExpiresAt - now;
      return {
        kind: remainingMs < SANDBOX_EXPIRING_SOON_MS ? "expiring_soon" : "ready",
        activeJob: null,
        sandbox,
      };
    }
    return { kind: "idle", activeJob: null, sandbox };
  },
});
