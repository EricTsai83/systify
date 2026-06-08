import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { DEFAULT_AUTO_ARCHIVE_MINUTES, DEFAULT_AUTO_DELETE_MINUTES, DEFAULT_AUTO_STOP_MINUTES } from "./lib/constants";
import { shouldReuseReservedLiveSource } from "./lib/liveSourceLifecycle";
import { isOwnedBy } from "./lib/ownedDocs";
import { isActiveRepository } from "./lib/repositoryAccess";

const PROVISIONING_SANDBOX_TTL_MS = 30 * 60_000;

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
 * Repository-scoped reservation for on-demand sandbox preparation (chat
 * activation, System Design retry after archive). Inserts a new
 * `provisioning` sandbox row and points the repository at it so the
 * standard liveness paths see the in-progress sandbox.
 *
 * Used by `ensureSandboxReady`. Idempotent in the sense that callers
 * dedup at the orchestrator layer: if the repository already has a usable
 * sandbox, callers should not reach this mutation.
 */
export const reserveOnDemandSandboxRow = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    sourceAdapter: v.union(v.literal("git_clone"), v.literal("source_service")),
    replaceSandboxId: v.optional(v.id("sandboxes")),
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

    if (repository.latestSandboxId && repository.latestSandboxId !== args.replaceSandboxId) {
      const existing = await ctx.db.get(repository.latestSandboxId);
      if (existing && shouldReuseReservedLiveSource(existing)) {
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
 * failure leaves the row with a valid `remoteId`, letting cleanup delete
 * the Daytona sandbox.
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
  handler: async (ctx, args): Promise<{ attached: boolean }> => {
    const sandbox = await ctx.db.get(args.sandboxId);
    if (!sandbox) {
      throw new Error("Sandbox provisioning row no longer exists.");
    }
    const repository = await ctx.db.get(sandbox.repositoryId);
    const canProgress =
      sandbox.status === "provisioning" &&
      !!repository &&
      isActiveRepository(repository) &&
      isOwnedBy(repository, sandbox.ownerTokenIdentifier) &&
      repository.latestSandboxId === sandbox._id;

    if (!canProgress) {
      if (sandbox.status === "provisioning") {
        await ctx.db.patch(args.sandboxId, {
          remoteId: args.remoteId,
          workDir: args.workDir,
          repoPath: args.repoPath,
          cpuLimit: args.cpuLimit,
          memoryLimitGiB: args.memoryLimitGiB,
          diskLimitGiB: args.diskLimitGiB,
          ttlExpiresAt: Date.now(),
          autoStopIntervalMinutes: args.autoStopIntervalMinutes,
          autoArchiveIntervalMinutes: args.autoArchiveIntervalMinutes,
          autoDeleteIntervalMinutes: args.autoDeleteIntervalMinutes,
          networkBlockAll: args.networkBlockAll,
          status: "failed",
          lastErrorMessage: "Sandbox provisioning was cancelled before remote attach completed.",
        });
      }
      return { attached: false };
    }

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
    return { attached: true };
  },
});

/**
 * Mark an on-demand provisioned sandbox row as `ready` once Daytona has
 * acknowledged the sandbox started and the repository tree is cloned on
 * disk. Updates `lastSyncedCommitSha` on the parent repository when a
 * fresh commit was cloned.
 */
export const markOnDemandSandboxReady = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    repositoryId: v.id("repositories"),
    commitSha: v.optional(v.string()),
    branch: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ready: boolean }> => {
    const sandbox = await ctx.db.get(args.sandboxId);
    if (!sandbox) {
      throw new Error("Sandbox provisioning row no longer exists.");
    }
    const repository = await ctx.db.get(args.repositoryId);
    const canProgress =
      sandbox.status === "provisioning" &&
      sandbox.repositoryId === args.repositoryId &&
      !!repository &&
      isActiveRepository(repository) &&
      isOwnedBy(repository, sandbox.ownerTokenIdentifier) &&
      repository.latestSandboxId === sandbox._id;

    if (!canProgress) {
      if (sandbox.status === "provisioning") {
        await ctx.db.patch(args.sandboxId, {
          status: "failed",
          lastErrorMessage: "Sandbox provisioning was cancelled before ready state completed.",
        });
      }
      return { ready: false };
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
    return { ready: true };
  },
});

/**
 * Mark an in-flight on-demand provisioning attempt as failed. The sandbox
 * row stays in the table so observers see "failed" rather than a phantom
 * missing record, and cleanup can still use the attached remote handle.
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
