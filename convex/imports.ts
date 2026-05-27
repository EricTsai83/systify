import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import {
  CASCADE_BATCH_SIZE,
  DEFAULT_AUTO_ARCHIVE_MINUTES,
  DEFAULT_AUTO_DELETE_MINUTES,
  DEFAULT_AUTO_STOP_MINUTES,
} from "./lib/constants";
import {
  cancelActiveJob,
  completeRunningJob,
  failRunningJob,
  markQueuedJobRunning,
  updateRunningJobProgress,
} from "./lib/jobs";
import { ensureSystemDesignFolders } from "./lib/systemDesign";
import { isOwnedBy } from "./lib/ownedDocs";

const REPOSITORY_DELETION_CANCEL_REASON =
  "Repository deletion is in progress. The import was cancelled before it could finish.";
const REPOSITORY_ARCHIVED_CANCEL_REASON = "Repository was archived. The import was cancelled before it could finish.";
const PROVISIONING_SANDBOX_TTL_MS = 30 * 60_000;

function reasonForRepositoryTombstone(repository: Doc<"repositories"> | null | undefined): string {
  if (!repository) {
    return REPOSITORY_DELETION_CANCEL_REASON;
  }
  if (repository.deletionRequestedAt) {
    return REPOSITORY_DELETION_CANCEL_REASON;
  }
  if (repository.archivedAt) {
    return REPOSITORY_ARCHIVED_CANCEL_REASON;
  }
  return REPOSITORY_DELETION_CANCEL_REASON;
}
const repoFileRecordValidator = v.object({
  path: v.string(),
  parentPath: v.string(),
  fileType: v.union(v.literal("file"), v.literal("dir")),
  extension: v.optional(v.string()),
  language: v.optional(v.string()),
  sizeBytes: v.number(),
  isEntryPoint: v.boolean(),
  isConfig: v.boolean(),
  isImportant: v.boolean(),
  summary: v.optional(v.string()),
});
const repoChunkRecordValidator = v.object({
  path: v.string(),
  chunkIndex: v.number(),
  startLine: v.number(),
  endLine: v.number(),
  chunkKind: v.union(v.literal("code"), v.literal("summary"), v.literal("readme")),
  symbolName: v.optional(v.string()),
  symbolKind: v.optional(v.string()),
  summary: v.string(),
  content: v.string(),
});
type PersistGuardResult =
  | {
      kind: "ready";
      importRecord: Doc<"imports">;
      repository: Doc<"repositories">;
    }
  | { kind: "completed" }
  | { kind: "cancelled" };

async function finalizeImportCancellation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
    reason: string;
  },
) {
  const importRecord = await ctx.db.get(args.importId);
  const job = await ctx.db.get(args.jobId);

  if (importRecord?.status === "completed") {
    return { kind: "completed" as const };
  }

  if (importRecord?.status === "cancelled") {
    return { kind: "cancelled" as const };
  }

  const now = Date.now();

  if (importRecord) {
    await ctx.db.patch(args.importId, {
      status: "cancelled",
      completedAt: now,
      errorMessage: args.reason,
    });
  }

  if (job) {
    await cancelActiveJob(ctx, {
      jobId: args.jobId,
      expectedKind: "import",
      completedAt: now,
      outputSummary: args.reason,
      errorMessage: args.reason,
    });
  }

  await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, {
    importId: args.importId,
    importJobId: args.jobId,
  });

  return {
    kind: "cancelled" as const,
  };
}

async function applyImportRunningState(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
  },
) {
  const now = Date.now();
  const runningJob = await markQueuedJobRunning(ctx, {
    jobId: args.jobId,
    expectedKind: "import",
    stage: "fetching_repository",
    progress: 0.1,
    startedAt: now,
  });
  if (!runningJob) {
    return { started: false as const };
  }

  await ctx.db.patch(args.importId, {
    status: "running",
    startedAt: now,
  });
  return { started: true as const };
}

async function applyImportCompletionState(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    repositoryId: Id<"repositories">;
    jobId: Id<"jobs">;
    commitSha: string;
    branch?: string;
    detectedLanguages: string[];
    packageManagers: string[];
    entrypoints: string[];
    fileCount: number;
    summary: string;
    readmeSummary: string;
    architectureSummary: string;
    repositoryDefaultBranch?: string;
  },
) {
  const completedAt = Date.now();
  const completedJob = await completeRunningJob(ctx, {
    jobId: args.jobId,
    expectedKind: "import",
    completedAt,
    outputSummary: args.summary,
  });
  if (!completedJob) {
    return { completed: false as const };
  }

  await ctx.db.patch(args.importId, {
    status: "completed",
    commitSha: args.commitSha,
    branch: args.branch,
    completedAt,
  });
  // Import no longer touches `latestSandboxId` — sandbox provisioning is
  // owned by Sandbox Mode / System Design via `ensureSandboxReady`. A
  // previously-published sandbox (from a legacy import or a prior sandbox-
  // mode session) stays as the live source until the user does something
  // that explicitly re-provisions it.
  await ctx.db.patch(args.repositoryId, {
    importStatus: "completed",
    latestImportId: args.importId,
    latestImportJobId: args.jobId,
    defaultBranch: args.branch ?? args.repositoryDefaultBranch,
    summary: args.summary,
    readmeSummary: args.readmeSummary,
    architectureSummary: args.architectureSummary,
    detectedLanguages: args.detectedLanguages,
    packageManagers: args.packageManagers,
    entrypoints: args.entrypoints,
    fileCount: args.fileCount,
    lastImportedAt: completedAt,
    lastIndexedAt: completedAt,
    lastSyncedCommitSha: args.commitSha,
  });
  return { completed: true as const };
}

async function guardPersistStage(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
  },
): Promise<PersistGuardResult> {
  const importRecord = await ctx.db.get(args.importId);
  if (!importRecord) {
    return { kind: "cancelled" };
  }

  if (importRecord.status === "completed") {
    return { kind: "completed" };
  }

  if (importRecord.status === "cancelled" || importRecord.status === "failed") {
    return { kind: "cancelled" };
  }

  const repository = await ctx.db.get(importRecord.repositoryId);
  if (!repository || repository.deletionRequestedAt || repository.archivedAt) {
    await finalizeImportCancellation(ctx, {
      importId: args.importId,
      jobId: args.jobId,
      reason: reasonForRepositoryTombstone(repository),
    });
    return { kind: "cancelled" };
  }

  return {
    kind: "ready",
    importRecord,
    repository,
  };
}

export const getImportContext = internalQuery({
  args: {
    importId: v.id("imports"),
  },
  handler: async (ctx, args) => {
    const importRecord = await ctx.db.get(args.importId);
    if (!importRecord) {
      return null;
    }

    if (importRecord.status === "completed") {
      return {
        kind: "completed" as const,
      };
    }

    if (importRecord.status === "cancelled" || importRecord.status === "failed") {
      return {
        kind: "cancelled" as const,
        jobId: importRecord.jobId,
        reason: importRecord.errorMessage ?? "Import is already in a terminal state.",
      };
    }

    const repository = await ctx.db.get(importRecord.repositoryId);
    if (!repository || repository.deletionRequestedAt || repository.archivedAt) {
      return {
        kind: "cancelled" as const,
        jobId: importRecord.jobId,
        reason: reasonForRepositoryTombstone(repository),
      };
    }

    return {
      kind: "ready" as const,
      repositoryId: repository._id,
      jobId: importRecord.jobId,
      branch: importRecord.branch,
      sourceUrl: importRecord.sourceUrl,
      ownerTokenIdentifier: importRecord.ownerTokenIdentifier,
      accessMode: repository.accessMode,
      sourceRepoFullName: repository.sourceRepoFullName,
    };
  },
});

export const markImportRunning = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const importRecord = await ctx.db.get(args.importId);
    const job = await ctx.db.get(args.jobId);
    const repository = importRecord ? await ctx.db.get(importRecord.repositoryId) : null;

    if (importRecord?.status === "completed") {
      return {
        kind: "completed" as const,
      };
    }

    if (importRecord?.status === "cancelled" || importRecord?.status === "failed") {
      return {
        kind: "cancelled" as const,
        reason: importRecord.errorMessage ?? "Import is already in a terminal state.",
      };
    }

    if (!importRecord || !job || !repository || repository.deletionRequestedAt || repository.archivedAt) {
      return {
        kind: "cancelled" as const,
        reason: reasonForRepositoryTombstone(repository),
      };
    }

    const running = await applyImportRunningState(ctx, args);
    if (!running.started) {
      return {
        kind: "cancelled" as const,
        reason: "Import job is already in a terminal state.",
      };
    }

    return {
      kind: "running" as const,
    };
  },
});

async function insertProvisioningSandboxRow(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
    sourceAdapter: "git_clone" | "source_service";
  },
): Promise<Id<"sandboxes">> {
  return await ctx.db.insert("sandboxes", {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    provider: "daytona",
    sourceAdapter: args.sourceAdapter,
    remoteId: "",
    status: "provisioning",
    workDir: "",
    repoPath: "",
    cpuLimit: 0,
    memoryLimitGiB: 0,
    diskLimitGiB: 0,
    ttlExpiresAt: Date.now() + PROVISIONING_SANDBOX_TTL_MS,
    autoStopIntervalMinutes: DEFAULT_AUTO_STOP_MINUTES,
    autoArchiveIntervalMinutes: DEFAULT_AUTO_ARCHIVE_MINUTES,
    autoDeleteIntervalMinutes: DEFAULT_AUTO_DELETE_MINUTES,
    networkBlockAll: false,
  });
}

/**
 * Repository-scoped variant for on-demand sandbox preparation (chat
 * activation, System Design retry after archive). Inserts a new
 * `provisioning` sandbox row and points the repository at it so the
 * standard `getSandboxAvailability` / `verifyAndSyncSandbox` paths see
 * the in-progress sandbox without going through the import pipeline.
 *
 * Used by `ensureSandboxReady`. Idempotent in the sense that callers
 * are expected to dedup at the orchestrator layer: if the repository
 * already has a usable sandbox, callers should not reach this mutation.
 */
export const reserveOnDemandSandboxRow = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    sourceAdapter: v.union(v.literal("git_clone"), v.literal("source_service")),
  },
  handler: async (ctx, args): Promise<{ sandboxId: Id<"sandboxes">; alreadyExisted: boolean }> => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository) {
      throw new Error("Repository not found.");
    }
    if (!isOwnedBy(repository, args.ownerTokenIdentifier)) {
      throw new Error("Repository does not belong to owner.");
    }
    if (repository.deletionRequestedAt || repository.archivedAt) {
      throw new Error("Repository is no longer active.");
    }

    if (repository.latestSandboxId) {
      const existing = await ctx.db.get(repository.latestSandboxId);
      if (existing && (existing.status === "provisioning" || existing.status === "ready")) {
        return { sandboxId: existing._id, alreadyExisted: true };
      }
    }

    const sandboxId = await insertProvisioningSandboxRow(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      sourceAdapter: args.sourceAdapter,
    });

    await ctx.db.patch(args.repositoryId, {
      latestSandboxId: sandboxId,
    });

    return { sandboxId, alreadyExisted: false };
  },
});

/**
 * Attach Daytona handle to an in-flight on-demand sandbox row, before the
 * clone step runs. Splitting attach from "mark ready" means that a clone
 * failure leaves the row with a valid `remoteId`, letting
 * `scheduleSandboxCleanup` delete the Daytona sandbox.
 */
export const attachOnDemandSandboxRemoteInfo = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    remoteId: v.string(),
    workDir: v.string(),
    repoPath: v.string(),
    cpuLimit: v.number(),
    memoryLimitGiB: v.number(),
    diskLimitGiB: v.number(),
    autoStopIntervalMinutes: v.number(),
    autoArchiveIntervalMinutes: v.number(),
    autoDeleteIntervalMinutes: v.number(),
    networkBlockAll: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sandboxId, {
      remoteId: args.remoteId,
      workDir: args.workDir,
      repoPath: args.repoPath,
      cpuLimit: args.cpuLimit,
      memoryLimitGiB: args.memoryLimitGiB,
      diskLimitGiB: args.diskLimitGiB,
      ttlExpiresAt: Date.now() + args.autoDeleteIntervalMinutes * 60_000,
      autoStopIntervalMinutes: args.autoStopIntervalMinutes,
      autoArchiveIntervalMinutes: args.autoArchiveIntervalMinutes,
      autoDeleteIntervalMinutes: args.autoDeleteIntervalMinutes,
      networkBlockAll: args.networkBlockAll,
    });
  },
});

/**
 * Mark an on-demand provisioned sandbox row as `ready` once Daytona has
 * acknowledged the sandbox started and the repository tree is cloned on
 * disk. Updates `lastSyncedCommitSha` on the parent repository when a
 * fresh commit was cloned so subsequent reads can tell the on-demand
 * provision apart from a stale snapshot.
 */
export const markOnDemandSandboxReady = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    repositoryId: v.id("repositories"),
    commitSha: v.optional(v.string()),
    branch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db.get(args.sandboxId);

    if (args.commitSha && sandbox && sandbox.repositoryId !== args.repositoryId) {
      console.warn(
        `Sandbox ${args.sandboxId} repositoryId mismatch: expected ${args.repositoryId}, got ${sandbox.repositoryId}`,
      );
      return;
    }

    const now = Date.now();
    await ctx.db.patch(args.sandboxId, {
      status: "ready",
      lastHeartbeatAt: now,
      lastUsedAt: now,
    });

    if (args.commitSha) {
      const repository = await ctx.db.get(args.repositoryId);
      if (repository) {
        await ctx.db.patch(args.repositoryId, {
          lastSyncedCommitSha: args.commitSha,
          defaultBranch: args.branch ?? repository.defaultBranch,
        });
      }
    }
  },
});

/**
 * Mark an in-flight on-demand provisioning attempt as failed. The
 * sandbox row stays in the table so observers see "failed" rather than
 * a phantom missing record, and is then cascaded to cleanup via the
 * existing `scheduleSandboxCleanup` path by the action.
 */
export const failOnDemandSandboxProvisioning = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db.get(args.sandboxId);
    if (!sandbox) {
      return;
    }
    if (sandbox.status === "ready" || sandbox.status === "archived") {
      return;
    }
    await ctx.db.patch(args.sandboxId, {
      status: "failed",
      lastErrorMessage: args.errorMessage.slice(0, 500),
    });
  },
});

export const persistImportHeader = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    commitSha: v.string(),
    branch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const state = await guardPersistStage(ctx, {
      importId: args.importId,
      jobId: args.jobId,
    });

    if (state.kind !== "ready") {
      return state;
    }

    const progressedJob = await updateRunningJobProgress(ctx, {
      jobId: args.jobId,
      expectedKind: "import",
      stage: "persisting_files",
      progress: 0.5,
    });
    if (!progressedJob) {
      return {
        kind: "cancelled" as const,
      };
    }

    await ensureSystemDesignFolders(ctx, {
      repositoryId: state.repository._id,
      ownerTokenIdentifier: state.repository.ownerTokenIdentifier,
    });

    await ctx.db.patch(args.importId, {
      commitSha: args.commitSha,
      branch: args.branch,
    });

    return {
      kind: "ready" as const,
    };
  },
});

export const persistRepoFilesBatch = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    files: v.array(repoFileRecordValidator),
  },
  handler: async (ctx, args) => {
    const state = await guardPersistStage(ctx, {
      importId: args.importId,
      jobId: args.jobId,
    });

    if (state.kind !== "ready") {
      return state;
    }

    for (const file of args.files) {
      const existingFile = await ctx.db
        .query("repoFiles")
        .withIndex("by_importId_and_path", (q) => q.eq("importId", args.importId).eq("path", file.path))
        .unique();

      if (existingFile) {
        continue;
      }

      await ctx.db.insert("repoFiles", {
        repositoryId: state.repository._id,
        ownerTokenIdentifier: state.repository.ownerTokenIdentifier,
        importId: args.importId,
        ...file,
      });
    }

    return {
      kind: "ready" as const,
    };
  },
});

export const persistRepoChunksBatch = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    chunks: v.array(repoChunkRecordValidator),
  },
  handler: async (ctx, args) => {
    const state = await guardPersistStage(ctx, {
      importId: args.importId,
      jobId: args.jobId,
    });

    if (state.kind !== "ready") {
      return state;
    }

    const progressedJob = await updateRunningJobProgress(ctx, {
      jobId: args.jobId,
      expectedKind: "import",
      stage: "persisting_chunks",
      progress: 0.75,
    });
    if (!progressedJob) {
      return {
        kind: "cancelled" as const,
      };
    }

    const fileIdsByPath = new Map<string, Id<"repoFiles">>();
    for (const chunk of args.chunks) {
      let fileId = fileIdsByPath.get(chunk.path);
      if (!fileId) {
        const file = await ctx.db
          .query("repoFiles")
          .withIndex("by_importId_and_path", (q) => q.eq("importId", args.importId).eq("path", chunk.path))
          .unique();
        if (!file) {
          continue;
        }
        fileId = file._id;
        fileIdsByPath.set(chunk.path, fileId);
      }

      const existingChunk = await ctx.db
        .query("repoChunks")
        .withIndex("by_importId_and_path_and_chunkIndex", (q) =>
          q.eq("importId", args.importId).eq("path", chunk.path).eq("chunkIndex", chunk.chunkIndex),
        )
        .unique();

      if (existingChunk) {
        continue;
      }

      await ctx.db.insert("repoChunks", {
        repositoryId: state.repository._id,
        ownerTokenIdentifier: state.repository.ownerTokenIdentifier,
        importId: args.importId,
        fileId,
        ...chunk,
      });
    }

    return {
      kind: "ready" as const,
    };
  },
});

export const finalizeImportCompletion = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    commitSha: v.string(),
    branch: v.optional(v.string()),
    detectedLanguages: v.array(v.string()),
    packageManagers: v.array(v.string()),
    entrypoints: v.array(v.string()),
    fileCount: v.number(),
    summary: v.string(),
    readmeSummary: v.string(),
    architectureSummary: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await guardPersistStage(ctx, {
      importId: args.importId,
      jobId: args.jobId,
    });

    if (state.kind !== "ready") {
      return {
        kind: state.kind,
      };
    }

    const previousCompletedImportId = state.repository.latestImportId;
    const previousCompletedImportJobId = state.repository.latestImportJobId;

    const completed = await applyImportCompletionState(ctx, {
      importId: args.importId,
      repositoryId: state.repository._id,
      jobId: args.jobId,
      commitSha: args.commitSha,
      branch: args.branch,
      detectedLanguages: args.detectedLanguages,
      packageManagers: args.packageManagers,
      entrypoints: args.entrypoints,
      fileCount: args.fileCount,
      summary: args.summary,
      readmeSummary: args.readmeSummary,
      architectureSummary: args.architectureSummary,
      repositoryDefaultBranch: state.repository.defaultBranch,
    });
    if (!completed.completed) {
      return {
        kind: "cancelled" as const,
      };
    }

    if (
      previousCompletedImportId &&
      (previousCompletedImportId !== args.importId || previousCompletedImportJobId !== args.jobId)
    ) {
      await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, {
        importId: previousCompletedImportId,
        importJobId: previousCompletedImportJobId,
      });
    }
    // Import no longer publishes a new sandbox, so there is nothing to retire
    // here. The repository's `latestSandboxId` (if any) keeps pointing at the
    // last sandbox provisioned by Sandbox Mode / System Design; that path
    // owns its own lifecycle and cleanup.

    return {
      kind: "completed" as const,
    };
  },
});

export const cleanupSupersededImportSnapshot = internalMutation({
  args: {
    importId: v.id("imports"),
    importJobId: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
    const repoFiles = await ctx.db
      .query("repoFiles")
      .withIndex("by_importId", (q) => q.eq("importId", args.importId))
      .take(CASCADE_BATCH_SIZE);
    const repoChunks = await ctx.db
      .query("repoChunks")
      .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", args.importId))
      .take(CASCADE_BATCH_SIZE);
    const importArtifacts = args.importJobId
      ? await ctx.db
          .query("artifacts")
          .withIndex("by_jobId", (q) => q.eq("jobId", args.importJobId))
          .take(CASCADE_BATCH_SIZE)
      : [];

    for (const doc of repoChunks) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of repoFiles) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of importArtifacts) {
      await ctx.db.delete(doc._id);
    }

    const hasMore =
      repoFiles.length === CASCADE_BATCH_SIZE ||
      repoChunks.length === CASCADE_BATCH_SIZE ||
      importArtifacts.length === CASCADE_BATCH_SIZE;

    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, args);
    }
  },
});

export const markImportFailed = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const importRecord = await ctx.db.get(args.importId);
    if (!importRecord || importRecord.status === "completed" || importRecord.status === "cancelled") {
      return;
    }

    const repository = await ctx.db.get(importRecord.repositoryId);
    if (!repository || repository.deletionRequestedAt || repository.archivedAt) {
      await finalizeImportCancellation(ctx, {
        importId: args.importId,
        jobId: args.jobId,
        reason: reasonForRepositoryTombstone(repository),
      });
      return;
    }

    const now = Date.now();
    const failedJob = await failRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "import",
      completedAt: now,
      errorMessage: args.errorMessage,
    });
    if (!failedJob) {
      return;
    }

    await ctx.db.patch(args.importId, {
      status: "failed",
      completedAt: now,
      errorMessage: args.errorMessage,
    });
    if (repository.importStatus !== "completed") {
      await ctx.db.patch(importRecord.repositoryId, {
        importStatus: "failed",
      });
    }
    await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, {
      importId: args.importId,
      importJobId: args.jobId,
    });
  },
});

export const cancelImport = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    await finalizeImportCancellation(ctx, args);
  },
});
