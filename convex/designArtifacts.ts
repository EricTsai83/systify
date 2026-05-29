import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireActiveRepositoryForViewer } from "./lib/repositoryAccess";
import { requireOwnedDoc } from "./lib/ownedDocs";
import {
  consumeDaytonaGlobalRateLimit,
  consumeSystemDesignRateLimit,
  SYSTEM_DESIGN_JOB_LEASE_MS,
  getLeaseRetryAfterMs,
  isLeaseActive,
  throwOperationAlreadyInProgress,
} from "./lib/rateLimit";
import { requireRepositorySandbox } from "./lib/repositorySandbox";
import { createOpaqueErrorId } from "./lib/observability";
import {
  completeRunningJob,
  enqueueJob,
  failRunningJob,
  failStaleActiveJob,
  findActiveJob,
  markQueuedJobRunning,
} from "./lib/jobs";

const ACTIVE_FAILURE_MODE_JOB_SCAN_LIMIT = 10;

export const requestFailureModeAnalysis = mutation({
  args: {
    threadId: v.id("threads"),
    subsystem: v.string(),
    /**
     * Optional folder placement. Threaded through the scheduler →
     * `runFailureModeAnalysis` action → `completeFailureModeAnalysis`
     * mutation chain so the artifact lands in the right folder when the
     * sandbox-backed job finishes (which can be many seconds later).
     */
    folderId: v.optional(v.id("artifactFolders")),
  },
  handler: async (ctx, args) => {
    const { identity, doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    if (!thread.repositoryId) {
      throw new Error("Failure mode analysis requires an attached repository.");
    }

    const { repository } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: thread.repositoryId,
      archivedMessage: "This repository is archived. Restore it to run failure-mode analysis.",
    });

    if (args.folderId) {
      const { doc: folder } = await requireOwnedDoc(ctx, args.folderId, {
        notFoundMessage: "Folder not found.",
      });
      if (folder.repositoryId !== repository._id) {
        throw new Error("Cannot place an artifact in a folder from a different repository.");
      }
    }

    const { sandbox } = await requireRepositorySandbox(ctx, repository);

    const now = Date.now();
    const activeJob = await getActiveFailureModeJob(ctx, args.threadId, now);
    if (activeJob) {
      throwOperationAlreadyInProgress(
        "repositorySystemDesignInFlight",
        "A failure mode analysis is already in progress for this thread.",
        getLeaseRetryAfterMs(activeJob.leaseExpiresAt, now),
      );
    }

    const trimmedSubsystem = args.subsystem.trim();
    if (!trimmedSubsystem) {
      throw new Error("Please provide a subsystem to analyze.");
    }

    await consumeSystemDesignRateLimit(ctx, identity.tokenIdentifier);
    await consumeDaytonaGlobalRateLimit(ctx);

    const jobId = await enqueueJob(ctx, {
      kind: "system_design",
      repositoryId: repository._id,
      threadId: args.threadId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId: sandbox._id,
      costCategory: "system_design",
      triggerSource: "user",
      requestedCommand: `failure_mode_analysis:${trimmedSubsystem}`,
      leaseMs: SYSTEM_DESIGN_JOB_LEASE_MS,
    });

    await ctx.scheduler.runAfter(0, internal.designArtifactsNode.runFailureModeAnalysis, {
      threadId: args.threadId,
      subsystem: trimmedSubsystem,
      jobId,
      folderId: args.folderId,
    });

    return { jobId };
  },
});

export const getFailureModeContext = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || !thread.repositoryId) {
      throw new Error("Thread is missing its attached repository.");
    }
    const repository = await ctx.db.get(thread.repositoryId);
    if (!repository) {
      throw new Error("Repository not found.");
    }
    const { sandbox } = await requireRepositorySandbox(ctx, repository);

    return {
      threadId: thread._id,
      repositoryId: repository._id,
      ownerTokenIdentifier: thread.ownerTokenIdentifier,
      sourceRepoFullName: repository.sourceRepoFullName,
      remoteSandboxId: sandbox.remoteId,
      repoPath: sandbox.repoPath,
    };
  },
});

export const markFailureModeRunning = internalMutation({
  args: {
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const runningJob = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      stage: "failure_mode_analysis",
      progress: 0.25,
      startedAt: now,
      leaseExpiresAt: now + SYSTEM_DESIGN_JOB_LEASE_MS,
    });
    return { started: runningJob !== null };
  },
});

export const completeFailureModeAnalysis = internalMutation({
  args: {
    jobId: v.id("jobs"),
    threadId: v.id("threads"),
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    subsystem: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
    /**
     * Optional folder placement carried through from the original
     * `requestFailureModeAnalysis` mutation. Re-validated here because
     * folders can be deleted between the request and the completion of
     * the long-running sandbox job.
     */
    folderId: v.optional(v.id("artifactFolders")),
  },
  handler: async (ctx, args) => {
    const completedJob = await completeRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      completedAt: Date.now(),
      outputSummary: args.summary,
    });
    if (!completedJob) {
      return { completed: false as const };
    }

    let resolvedFolderId: Id<"artifactFolders"> | undefined = args.folderId ?? undefined;
    if (resolvedFolderId) {
      const folder = await ctx.db.get(resolvedFolderId);
      if (!folder || folder.repositoryId !== args.repositoryId) {
        // Folder was deleted or moved between request and completion.
        // Fall back to the repository root; the artifact still lands
        // somewhere visible to the user via the navigator's
        // "Uncategorized" virtual node.
        resolvedFolderId = undefined;
      }
    }

    await ctx.runMutation(internal.artifactStore.createArtifact, {
      threadId: args.threadId,
      repositoryId: args.repositoryId,
      jobId: args.jobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: "failure_mode_analysis",
      title: `Failure mode analysis: ${args.subsystem}`,
      summary: args.summary,
      contentMarkdown: args.contentMarkdown,
      folderId: resolvedFolderId,
    });

    return { completed: true as const };
  },
});

export const failFailureModeAnalysis = internalMutation({
  args: {
    jobId: v.id("jobs"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const failedJob = await failRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      completedAt: Date.now(),
      errorMessage: args.errorMessage,
    });
    return { failed: failedJob !== null };
  },
});

const STALE_FAILURE_MODE_JOB_ERROR_MESSAGE =
  "The failure mode analysis stalled and was automatically marked as failed.";

export const recoverStaleFailureModeJob = internalMutation({
  args: {
    jobId: v.id("jobs"),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (
      !job ||
      job.kind !== "system_design" ||
      (job.status !== "queued" && job.status !== "running") ||
      !job.requestedCommand?.startsWith("failure_mode_analysis:") ||
      typeof job.leaseExpiresAt !== "number" ||
      job.leaseExpiresAt > now
    ) {
      return;
    }

    const errorId = createOpaqueErrorId("design_artifacts");
    const message = `${args.errorMessage ?? STALE_FAILURE_MODE_JOB_ERROR_MESSAGE}\n\nReference: ${errorId}`;
    await failStaleActiveJob(ctx, {
      jobId: args.jobId,
      expectedKind: "system_design",
      now,
      errorMessage: message,
    });
  },
});

/**
 * FMA shares `kind: "system_design"` with Library System Design; the
 * `failure_mode_analysis:` `requestedCommand` prefix discriminates the
 * two. Scoped to the thread because FMA dedup is per-thread (Library
 * System Design dedups per-repository).
 */
async function getActiveFailureModeJob(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  now: number,
): Promise<Doc<"jobs"> | null> {
  return await findActiveJob(ctx, {
    kind: "system_design",
    scope: { type: "thread", id: threadId },
    now,
    predicate: (job) =>
      job.requestedCommand?.startsWith("failure_mode_analysis:") === true && isLeaseActive(job.leaseExpiresAt, now),
    limit: ACTIVE_FAILURE_MODE_JOB_SCAN_LIMIT,
  });
}
