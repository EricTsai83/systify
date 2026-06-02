import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { DEFAULT_AUTO_ARCHIVE_MINUTES, DEFAULT_AUTO_DELETE_MINUTES, DEFAULT_AUTO_STOP_MINUTES } from "./lib/constants";
import { isOwnedBy } from "./lib/ownedDocs";
import { importRunningStateValidator, nullableImportContextValidator } from "./lib/functionResultSchemas";
import {
  finalizeImportCancellation,
  loadImportContext,
  markImportFailedForMutation,
  markImportRunningForMutation,
} from "./lib/importLifecycle";
import {
  cleanupSupersededImportSnapshotInMutation,
  finalizeImportCompletionInMutation,
  persistImportHeaderInMutation,
  persistRepoChunksBatchInMutation,
  persistRepoFilesBatchInMutation,
  persistStageResultValidator,
  repoChunkRecordValidator,
  repoFileRecordValidator,
} from "./lib/importSnapshotPersistence";

const PROVISIONING_SANDBOX_TTL_MS = 30 * 60_000;
export const getImportContext = internalQuery({
  args: {
    importId: v.id("imports"),
  },
  returns: nullableImportContextValidator,
  handler: async (ctx, args) => {
    return await loadImportContext(ctx, args.importId);
  },
});

export const markImportRunning = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
  },
  returns: importRunningStateValidator,
  handler: async (ctx, args) => {
    return await markImportRunningForMutation(ctx, args);
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
  returns: persistStageResultValidator,
  handler: async (ctx, args) => {
    return await persistImportHeaderInMutation(ctx, args);
  },
});

export const persistRepoFilesBatch = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    files: v.array(repoFileRecordValidator),
  },
  returns: persistStageResultValidator,
  handler: async (ctx, args) => {
    return await persistRepoFilesBatchInMutation(ctx, args);
  },
});

export const persistRepoChunksBatch = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    chunks: v.array(repoChunkRecordValidator),
  },
  returns: persistStageResultValidator,
  handler: async (ctx, args) => {
    return await persistRepoChunksBatchInMutation(ctx, args);
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
    return await finalizeImportCompletionInMutation(ctx, args);
  },
});

export const cleanupSupersededImportSnapshot = internalMutation({
  args: {
    importId: v.id("imports"),
    importJobId: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
    await cleanupSupersededImportSnapshotInMutation(ctx, args);
  },
});

export const markImportFailed = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await markImportFailedForMutation(ctx, args);
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
