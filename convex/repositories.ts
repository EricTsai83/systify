import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { mutation, query, internalQuery, internalMutation, type MutationCtx } from "./_generated/server";
import { drainMessageToolCallEvents } from "./chat/toolCallEventStore";
import { getDefaultThreadMode } from "./chatModeResolver";
import { requireViewerIdentity } from "./lib/auth";
import { getSandboxModeStatus } from "./lib/sandboxAvailability";
import { makeRepositoryTitle, parseGitHubUrl } from "./lib/github";
import { CASCADE_BATCH_SIZE } from "./lib/constants";
import { ensureRepositoryWorkspace } from "./lib/workspaces";
import { clearLastActiveWorkspaceIfMatches } from "./lib/userPreferences";
import {
  isRepositoryArchived,
  isRepositoryDeleting,
  loadAccessibleRepositoryForViewer,
  requireActiveRepositoryForViewer,
} from "./lib/repositoryAccess";
import {
  consumeDaytonaGlobalRateLimit,
  consumeImportRateLimit,
  throwOperationAlreadyInProgress,
} from "./lib/rateLimit";

const FILE_COUNT_DISPLAY_LIMIT = 400;
const REPOSITORY_DETAIL_ARTIFACT_LIMIT = 20;
const REPOSITORY_DETAIL_IMPORT_ARTIFACT_LIMIT = 10;
const REPOSITORY_DELETE_RETRY_MS = 5_000;
const STREAM_CHUNK_DRAIN_PASS_LIMIT = 8;
const REPOSITORY_LIST_TAKE = 200;
const ARCHIVED_REPOSITORY_LIST_TAKE = 200;

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

export const listArchivedRepositories = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    const archived = await ctx.db
      .query("repositories")
      .withIndex("by_ownerTokenIdentifier_and_archivedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).gt("archivedAt", 0),
      )
      .order("desc")
      .take(ARCHIVED_REPOSITORY_LIST_TAKE);

    return archived.filter((repo) => repo.deletionRequestedAt === undefined);
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
        hasRemoteUpdates:
          !!repo.latestRemoteSha && !!repo.lastSyncedCommitSha && repo.latestRemoteSha !== repo.lastSyncedCommitSha,
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

    const currentImportArtifacts = repository.latestImportJobId
      ? await ctx.db
          .query("artifacts")
          .withIndex("by_jobId", (q) => q.eq("jobId", repository.latestImportJobId!))
          .take(REPOSITORY_DETAIL_IMPORT_ARTIFACT_LIMIT)
      : [];
    const remainingArtifactSlots = Math.max(0, REPOSITORY_DETAIL_ARTIFACT_LIMIT - currentImportArtifacts.length);
    const recentDeepAnalysisArtifacts =
      remainingArtifactSlots > 0
        ? await ctx.db
            .query("artifacts")
            .withIndex("by_repositoryId_and_kind", (q) =>
              q.eq("repositoryId", args.repositoryId).eq("kind", "deep_analysis"),
            )
            .order("desc")
            .take(remainingArtifactSlots)
        : [];

    const artifactsById = new Map<string, (typeof currentImportArtifacts)[number]>();
    for (const artifact of [...currentImportArtifacts, ...recentDeepAnalysisArtifacts]) {
      if (!artifactsById.has(artifact._id)) {
        artifactsById.set(artifact._id, artifact);
      }
    }
    const artifacts = Array.from(artifactsById.values());
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(30);
    const now = Date.now();
    const activeQueuedDeepAnalysisJob = await ctx.db
      .query("jobs")
      .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("kind", "deep_analysis")
          .eq("status", "queued")
          .gt("leaseExpiresAt", now),
      )
      .first();
    const activeRunningDeepAnalysisJob = await ctx.db
      .query("jobs")
      .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("kind", "deep_analysis")
          .eq("status", "running")
          .gt("leaseExpiresAt", now),
      )
      .first();
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(10);

    const fileCount = repository.fileCount;
    const fileCountLabel = fileCount >= FILE_COUNT_DISPLAY_LIMIT ? `${FILE_COUNT_DISPLAY_LIMIT}+` : String(fileCount);

    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;

    const sandboxModeStatus = getSandboxModeStatus(sandbox);

    // Determine whether the remote has commits we haven't synced yet
    const hasRemoteUpdates =
      !!repository.latestRemoteSha &&
      !!repository.lastSyncedCommitSha &&
      repository.latestRemoteSha !== repository.lastSyncedCommitSha;

    return {
      repository,
      isArchived,
      archivedAt: repository.archivedAt ?? null,
      artifacts,
      jobs,
      activeDeepAnalysisJob: activeRunningDeepAnalysisJob ?? activeQueuedDeepAnalysisJob,
      threads,
      fileCount,
      fileCountLabel,
      sandboxModeStatus,
      hasRemoteUpdates,
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
    await consumeDaytonaGlobalRateLimit(ctx);

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
    if (
      !defaultThread ||
      defaultThread.ownerTokenIdentifier !== identity.tokenIdentifier ||
      defaultThread.repositoryId !== repositoryId
    ) {
      defaultThreadId = await ctx.db.insert("threads", {
        workspaceId,
        repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        title: `${makeRepositoryTitle(repository.sourceRepoFullName)} chat`,
        // Matches `resolveChatModes(true, 'none' | 'provisioning' | …).defaultMode`
        // for any repo-attached thread, so the auto-created default thread
        // and a manually-created one start on the same mode.
        mode: getDefaultThreadMode(true),
        lastMessageAt: Date.now(),
      });
    } else if (defaultThread.workspaceId !== workspaceId) {
      await ctx.db.patch(defaultThread._id, { workspaceId });
    }

    await ctx.db.patch(repositoryId, { accessMode, defaultThreadId });

    const { jobId, importId } = await queueImportWorkflow(ctx, {
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sourceUrl: parsed.normalizedUrl,
      branch: args.branch ?? parsed.branch ?? repository.defaultBranch,
    });

    return {
      repositoryId,
      importId,
      jobId,
      defaultThreadId,
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
    await consumeDaytonaGlobalRateLimit(ctx);

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
