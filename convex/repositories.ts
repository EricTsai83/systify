import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { mutation, query, internalQuery, internalMutation, type MutationCtx } from "./_generated/server";
import { drainMessageToolCallEvents } from "./chat/toolCallEventStore";
import { getDefaultThreadMode } from "./chatModeResolver";
import { requireViewerIdentity } from "./lib/auth";
import { getRepositorySandboxStatus } from "./lib/repositorySandbox";
import { makeRepositoryTitle, parseGitHubUrl } from "./lib/github";
import { CASCADE_BATCH_SIZE } from "./lib/constants";
import { ensureRepositoryWorkspace } from "./lib/workspaces";
import { clearLastActiveWorkspaceIfMatches } from "./lib/userPreferences";
import {
  hasRemoteUpdates,
  isRepositoryArchived,
  isRepositoryDeleting,
  loadAccessibleRepositoryForViewer,
  requireActiveRepositoryForViewer,
} from "./lib/repositoryAccess";
import {
  consumeDaytonaGlobalRateLimit,
  consumeImportRateLimit,
  SANDBOX_ACTIVATION_JOB_LEASE_MS,
  throwOperationAlreadyInProgress,
} from "./lib/rateLimit";
import { failRunningJob, completeRunningJob, markQueuedJobRunning, failStaleActiveJob } from "./jobLifecycle";

const FILE_COUNT_DISPLAY_LIMIT = 400;
const REPOSITORY_DETAIL_IMPORT_ARTIFACT_LIMIT = 10;
const REPOSITORY_DELETE_RETRY_MS = 5_000;
const STREAM_CHUNK_DRAIN_PASS_LIMIT = 8;
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
  const jobId = await ctx.db.insert("jobs", {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    kind: "import",
    status: "queued",
    stage: "queued",
    progress: 0,
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
 * Resources page — cross-workspace inventory of the viewer's active
 * repositories joined with their latest sandbox + sync status.
 *
 * One query feeds the page so the client renders without an N+1 over
 * `getRepositoryDetail`. We re-use the same helpers the per-repo TopBar
 * status pill consumes (`getRepositorySandboxStatus`, the remote-sha diff for
 * `hasRemoteUpdates`) so the Resources cards and the per-thread chrome
 * never disagree about what a given sandbox is doing.
 *
 * Workspace ids ride along so each row can link straight into the right
 * `/w/:wid` URL — Resources is a navigation surface, not a control plane.
 * Stop / restart sandbox affordances stay on the per-workspace TopBar
 * where the user already has the full context.
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

    // Per-repo point lookup against `by_ownerTokenIdentifier_and_repositoryId`.
    // The data-model invariant is one workspace per (owner, repo); a compound-
    // key index hit is cheaper than the full-workspace scan + map-build the
    // previous implementation did, and the page no longer silently truncates
    // when the viewer has more workspaces than the `repositories.take()`
    // limit. Issued in parallel alongside the sandbox `get` so both round
    // trips share one network batch.
    const inventory = await Promise.all(
      activeRepositories.map(async (repo) => {
        const [sandboxStatus, workspace] = await Promise.all([
          getRepositorySandboxStatus(ctx, repo),
          ctx.db
            .query("workspaces")
            .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
              q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("repositoryId", repo._id),
            )
            .unique(),
        ]);
        const { sandboxModeStatus, sandbox } = sandboxStatus;
        return {
          repositoryId: repo._id,
          workspaceId: workspace?._id ?? null,
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
      });

      repository = await ctx.db.get(repositoryId);
    }

    if (!repositoryId || !repository) {
      throw new Error("Failed to create repository.");
    }

    const workspaceId = await ensureRepositoryWorkspace(ctx, {
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      name: repository.sourceRepoFullName,
    });

    const defaultThread = defaultThreadId ? await ctx.db.get(defaultThreadId) : null;
    let defaultThreadMode: Doc<"threads">["mode"];
    if (
      !defaultThread ||
      defaultThread.ownerTokenIdentifier !== identity.tokenIdentifier ||
      defaultThread.repositoryId !== repositoryId
    ) {
      // Matches `resolveChatModes(true, 'none' | 'provisioning' | …).defaultMode`
      // for any repo-attached thread, so the auto-created default thread
      // and a manually-created one start on the same mode.
      defaultThreadMode = getDefaultThreadMode(true);
      defaultThreadId = await ctx.db.insert("threads", {
        workspaceId,
        repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        title: `${makeRepositoryTitle(repository.sourceRepoFullName)} chat`,
        mode: defaultThreadMode,
        lastMessageAt: Date.now(),
      });
    } else {
      defaultThreadMode = defaultThread.mode;
      if (defaultThread.workspaceId !== workspaceId) {
        await ctx.db.patch(defaultThread._id, { workspaceId });
      }
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
    // (`/w/:wid/discuss/:tid`) instead of bouncing through the legacy
    // `/w/:wid/t/:tid` redirect for a flash of unmounted chrome.
    return {
      repositoryId,
      importId,
      jobId,
      defaultThreadId,
      defaultThreadMode,
      workspaceId,
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
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Repository not found.");
    }

    if (isRepositoryDeleting(repository)) {
      throw new Error("Repository is being deleted and cannot be archived.");
    }

    if (isRepositoryArchived(repository)) {
      return;
    }

    await ctx.db.patch(args.repositoryId, {
      archivedAt: Date.now(),
    });

    // Stop any live sandbox to release Daytona resources. Threads, messages,
    // and artifacts stay intact so Restore lets the user pick up where they
    // left off.
    await ctx.runMutation(internal.ops.scheduleRepositorySandboxCleanup, {
      repositoryId: args.repositoryId,
    });
  },
});

export const restoreRepository = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Repository not found.");
    }

    if (isRepositoryDeleting(repository)) {
      throw new Error("Repository is being deleted and cannot be restored.");
    }

    if (!isRepositoryArchived(repository)) {
      return;
    }

    await ctx.db.patch(args.repositoryId, {
      archivedAt: undefined,
    });
  },
});

export const deleteRepository = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Repository not found.");
    }

    if (isRepositoryDeleting(repository)) {
      return;
    }

    if (!isRepositoryArchived(repository)) {
      throw new Error("Archive the repository before deleting it permanently.");
    }

    await ctx.db.patch(args.repositoryId, {
      deletionRequestedAt: Date.now(),
    });

    await ctx.runMutation(internal.ops.scheduleRepositorySandboxCleanup, {
      repositoryId: args.repositoryId,
    });

    // Schedule cascading deletion of all related data once background jobs have
    // had a chance to observe the tombstone and stop cleanly.
    await ctx.scheduler.runAfter(0, internal.repositories.cascadeDeleteRepository, {
      repositoryId: args.repositoryId,
    });
  },
});

async function drainArtifactsByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("artifacts")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainRepoChunksByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("repoChunks")
    .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainRepoFilesByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("repoFiles")
    .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainImportsByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("imports")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainJobsByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("jobs")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainArtifactViewsByRepository(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; repositoryId: Id<"repositories"> },
): Promise<boolean> {
  const docs = await ctx.db
    .query("artifactViews")
    .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("repositoryId", args.repositoryId),
    )
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainRepositoryViewerBootstrapsByRepository(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; repositoryId: Id<"repositories"> },
): Promise<boolean> {
  // At most one row per (owner, repo), so this never paginates in
  // practice. The take/loop form is kept for parity with the other
  // drains so the cascade pattern stays uniform.
  const docs = await ctx.db
    .query("repositoryViewerBootstraps")
    .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("repositoryId", args.repositoryId),
    )
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length === CASCADE_BATCH_SIZE;
}

export const cascadeDeleteRepository = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const cleanupState: { pendingCleanupCount: number } = await ctx.runMutation(
      internal.ops.scheduleRepositorySandboxCleanup,
      {
        repositoryId: args.repositoryId,
      },
    );
    let more = false;
    let waitingOnSandboxCleanup = cleanupState.pendingCleanupCount > 0;

    // Delete threads and their messages (threads need special handling)
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", args.repositoryId))
      .take(CASCADE_BATCH_SIZE);
    for (const thread of threads) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
        .take(CASCADE_BATCH_SIZE);
      for (const msg of msgs) {
        // Plan 06 — drain orphan tool-call events before deleting the
        // message. Events are bounded per message (≤ step budget × 2) and
        // are normally cleaned up at finalize / fail; this is the
        // belt-and-braces path that catches any row that survived a
        // mid-stream crash. Order matters: delete child events first so a
        // partially-failed cascade leaves no row pointing at a missing
        // `messageId`.
        await drainMessageToolCallEvents(ctx, msg._id);
        await ctx.db.delete(msg._id);
      }

      const streams = await ctx.db
        .query("messageStreams")
        .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
        .take(CASCADE_BATCH_SIZE);
      let streamChunksDrained = true;
      for (const stream of streams) {
        let streamChunksFullyDrained = false;
        for (let pass = 0; pass < STREAM_CHUNK_DRAIN_PASS_LIMIT; pass += 1) {
          const streamChunks = await ctx.db
            .query("messageStreamChunks")
            .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", stream._id))
            .take(CASCADE_BATCH_SIZE);
          for (const chunk of streamChunks) {
            await ctx.db.delete(chunk._id);
          }
          if (streamChunks.length < CASCADE_BATCH_SIZE) {
            streamChunksFullyDrained = true;
            break;
          }
        }
        if (streamChunksFullyDrained) {
          await ctx.db.delete(stream._id);
        } else {
          streamChunksDrained = false;
          more = true;
        }
      }

      if (streams.length === CASCADE_BATCH_SIZE) {
        more = true;
      }

      let artifactsDrained = true;
      let artifactMore = false;
      for (let pass = 0; pass < STREAM_CHUNK_DRAIN_PASS_LIMIT; pass += 1) {
        const artifacts = await ctx.db
          .query("artifacts")
          .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
          .take(CASCADE_BATCH_SIZE);
        for (const artifact of artifacts) {
          await ctx.db.delete(artifact._id);
        }
        if (artifacts.length === CASCADE_BATCH_SIZE) {
          artifactMore = true;
        } else {
          artifactsDrained = true;
          break;
        }
      }
      if (artifactMore) {
        artifactsDrained = false;
        more = true;
      }

      if (
        msgs.length < CASCADE_BATCH_SIZE &&
        streams.length < CASCADE_BATCH_SIZE &&
        streamChunksDrained &&
        artifactsDrained
      ) {
        await ctx.db.delete(thread._id);
      } else {
        more = true;
      }
    }
    if (threads.length === CASCADE_BATCH_SIZE) more = true;

    // Drain remaining tables, but keep cleanup jobs until sandbox deletion has finished.
    // Per-viewer rows (artifactViews, repositoryViewerBootstraps) need
    // the owner token because their indexes are owner-scoped. The repo
    // row is always present at this point — the cascade only deletes
    // it after every drain has reported empty, at the bottom of this
    // handler — so a single read here is safe for the lifetime of all
    // drain passes that can find rows to delete.
    const cascadeRepository = await ctx.db.get(args.repositoryId);
    if (cascadeRepository) {
      more =
        (await drainArtifactViewsByRepository(ctx, {
          ownerTokenIdentifier: cascadeRepository.ownerTokenIdentifier,
          repositoryId: args.repositoryId,
        })) || more;
      more =
        (await drainRepositoryViewerBootstrapsByRepository(ctx, {
          ownerTokenIdentifier: cascadeRepository.ownerTokenIdentifier,
          repositoryId: args.repositoryId,
        })) || more;
    }
    more = (await drainArtifactsByRepositoryId(ctx, args.repositoryId)) || more;
    more = (await drainRepoChunksByRepositoryId(ctx, args.repositoryId)) || more;
    more = (await drainRepoFilesByRepositoryId(ctx, args.repositoryId)) || more;
    more = (await drainImportsByRepositoryId(ctx, args.repositoryId)) || more;

    const sandboxes = await ctx.db
      .query("sandboxes")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(CASCADE_BATCH_SIZE);
    for (const sandbox of sandboxes) {
      if (sandbox.status === "archived") {
        await ctx.db.delete(sandbox._id);
      } else {
        waitingOnSandboxCleanup = true;
      }
    }
    if (sandboxes.length === CASCADE_BATCH_SIZE) {
      more = true;
    }

    if (!waitingOnSandboxCleanup) {
      more = (await drainJobsByRepositoryId(ctx, args.repositoryId)) || more;
    }

    // Self-schedule if any table still has remaining records
    if (more || waitingOnSandboxCleanup) {
      await ctx.scheduler.runAfter(
        waitingOnSandboxCleanup ? REPOSITORY_DELETE_RETRY_MS : 0,
        internal.repositories.cascadeDeleteRepository,
        {
          repositoryId: args.repositoryId,
        },
      );
      return;
    }

    const repository = await ctx.db.get(args.repositoryId);
    if (repository) {
      const workspaces = await ctx.db
        .query("workspaces")
        .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
          q.eq("ownerTokenIdentifier", repository.ownerTokenIdentifier).eq("repositoryId", args.repositoryId),
        )
        .take(CASCADE_BATCH_SIZE);
      for (const workspace of workspaces) {
        await clearLastActiveWorkspaceIfMatches(ctx, {
          ownerTokenIdentifier: repository.ownerTokenIdentifier,
          workspaceId: workspace._id,
        });
        await ctx.db.delete(workspace._id);
      }
      if (workspaces.length === CASCADE_BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.repositories.cascadeDeleteRepository, {
          repositoryId: args.repositoryId,
        });
        return;
      }

      await ctx.db.delete(args.repositoryId);
    }
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
    if (!repository || repository.ownerTokenIdentifier !== args.ownerTokenIdentifier) {
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
const SANDBOX_ACTIVATION_ACTIVE_SCAN_LIMIT = 4;

async function findActiveSandboxActivationJob(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories">; now: number },
) {
  const [queued, running] = await Promise.all([
    ctx.db
      .query("jobs")
      .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("kind", "sandbox_activation")
          .eq("status", "queued")
          .gte("leaseExpiresAt", args.now),
      )
      .take(SANDBOX_ACTIVATION_ACTIVE_SCAN_LIMIT),
    ctx.db
      .query("jobs")
      .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("kind", "sandbox_activation")
          .eq("status", "running")
          .gte("leaseExpiresAt", args.now),
      )
      .take(SANDBOX_ACTIVATION_ACTIVE_SCAN_LIMIT),
  ]);
  return running[0] ?? queued[0] ?? null;
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

    const jobId = await ctx.db.insert("jobs", {
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId: repository.latestSandboxId,
      kind: "sandbox_activation",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "ops",
      triggerSource: "user",
      leaseExpiresAt: now + SANDBOX_ACTIVATION_JOB_LEASE_MS,
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
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (
      !job ||
      job.kind !== "sandbox_activation" ||
      (job.status !== "queued" && job.status !== "running") ||
      typeof job.leaseExpiresAt !== "number" ||
      job.leaseExpiresAt > now
    ) {
      return;
    }
    await failStaleActiveJob(ctx, {
      jobId: args.jobId,
      expectedKind: "sandbox_activation",
      now,
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
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return { kind: "idle", activeJob: null, sandbox: null };
    }

    const now = Date.now();
    const [queuedJobs, runningJobs] = await Promise.all([
      ctx.db
        .query("jobs")
        .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
          q
            .eq("repositoryId", args.repositoryId)
            .eq("kind", "sandbox_activation")
            .eq("status", "queued")
            .gte("leaseExpiresAt", now),
        )
        .take(SANDBOX_ACTIVATION_ACTIVE_SCAN_LIMIT),
      ctx.db
        .query("jobs")
        .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
          q
            .eq("repositoryId", args.repositoryId)
            .eq("kind", "sandbox_activation")
            .eq("status", "running")
            .gte("leaseExpiresAt", now),
        )
        .take(SANDBOX_ACTIVATION_ACTIVE_SCAN_LIMIT),
    ]);
    const activeJob = runningJobs[0] ?? queuedJobs[0] ?? null;
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
