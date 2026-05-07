import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, query, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { requireActiveRepositoryForOwner } from "./lib/repositoryAccess";
import { validateParentPresence } from "./artifactStore";
import {
  consumeDaytonaGlobalRateLimit,
  consumeDeepAnalysisRateLimit,
  DEEP_ANALYSIS_JOB_LEASE_MS,
  getLeaseRetryAfterMs,
  isLeaseActive,
  throwOperationAlreadyInProgress,
} from "./lib/rateLimit";
import { getSandboxAvailability } from "./lib/sandboxAvailability";
import { completeRunningJob, failRunningJob, failStaleActiveJob, markQueuedJobRunning } from "./jobLifecycle";

const DEEP_ANALYSIS_SANDBOX_TTL_EXTENSION_MS = 30 * 60_000;

async function getActiveDeepAnalysisJob(ctx: MutationCtx, repositoryId: Id<"repositories">, now: number) {
  const queuedJob = await ctx.db
    .query("jobs")
    .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("repositoryId", repositoryId).eq("kind", "deep_analysis").eq("status", "queued").gte("leaseExpiresAt", now),
    )
    .first();
  if (queuedJob && isLeaseActive(queuedJob.leaseExpiresAt, now)) {
    return queuedJob;
  }

  const runningJob = await ctx.db
    .query("jobs")
    .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("repositoryId", repositoryId).eq("kind", "deep_analysis").eq("status", "running").gte("leaseExpiresAt", now),
    )
    .first();
  if (runningJob && isLeaseActive(runningJob.leaseExpiresAt, now)) {
    return runningJob;
  }

  return null;
}

async function extendSandboxTtlForDeepAnalysis(
  ctx: MutationCtx,
  sandboxId: Id<"sandboxes">,
  currentTtlExpiresAt: number,
  now: number,
) {
  await ctx.db.patch(sandboxId, {
    ttlExpiresAt: Math.max(currentTtlExpiresAt, now + DEEP_ANALYSIS_SANDBOX_TTL_EXTENSION_MS),
    lastUsedAt: now,
  });
}

export const listArtifacts = query({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Repository not found.");
    }

    return await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(40);
  },
});

export const requestDeepAnalysis = mutation({
  args: {
    repositoryId: v.id("repositories"),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await requireActiveRepositoryForOwner(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
    const sandboxAvailability = getSandboxAvailability(sandbox);
    if (!sandboxAvailability.available) {
      throw new Error(sandboxAvailability.message ?? "Deep analysis is unavailable.");
    }
    if (!sandbox) {
      throw new Error("Deep analysis is unavailable.");
    }

    const now = Date.now();
    const activeJob = await getActiveDeepAnalysisJob(ctx, args.repositoryId, now);
    if (activeJob) {
      throwOperationAlreadyInProgress(
        "repositoryDeepAnalysisInFlight",
        "A deep analysis is already in progress for this repository.",
        getLeaseRetryAfterMs(activeJob.leaseExpiresAt, now),
      );
    }

    await consumeDeepAnalysisRateLimit(ctx, identity.tokenIdentifier);
    await consumeDaytonaGlobalRateLimit(ctx);
    await extendSandboxTtlForDeepAnalysis(ctx, sandbox._id, sandbox.ttlExpiresAt, now);

    const jobId = await ctx.db.insert("jobs", {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId: sandbox._id,
      kind: "deep_analysis",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "deep_analysis",
      triggerSource: "user",
      leaseExpiresAt: now + DEEP_ANALYSIS_JOB_LEASE_MS,
    });

    await ctx.db.patch(args.repositoryId, {
      latestAnalysisJobId: jobId,
    });

    await ctx.scheduler.runAfter(0, internal.analysisNode.runDeepAnalysis, {
      repositoryId: args.repositoryId,
      jobId,
      prompt: args.prompt,
    });

    return { jobId };
  },
});

export const getDeepAnalysisContext = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository) {
      throw new Error("Repository not found.");
    }

    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;

    return {
      repositoryId: repository._id,
      ownerTokenIdentifier: repository.ownerTokenIdentifier,
      latestSandboxId: sandbox?._id,
      sandboxStatus: sandbox?.status,
      ttlExpiresAt: sandbox?.ttlExpiresAt,
      remoteSandboxId: sandbox?.remoteId,
      repoPath: sandbox?.repoPath,
      sourceRepoFullName: repository.sourceRepoFullName,
    };
  },
});

export const markDeepAnalysisRunning = internalMutation({
  args: {
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const runningJob = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "deep_analysis",
      stage: "focused_inspection",
      progress: 0.2,
      startedAt: now,
      leaseExpiresAt: now + DEEP_ANALYSIS_JOB_LEASE_MS,
    });
    return { started: runningJob !== null };
  },
});

export const completeDeepAnalysis = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    jobId: v.id("jobs"),
    ownerTokenIdentifier: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
  },
  handler: async (ctx, args) => {
    const completedJob = await completeRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "deep_analysis",
      completedAt: Date.now(),
      outputSummary: args.summary,
    });
    if (!completedJob) {
      return { completed: false as const };
    }

    // completeDeepAnalysis inserts directly into `artifacts` rather than
    // routing through createArtifactInternal, so enforce the artifact
    // parent invariant here so the rule stays centralized.
    validateParentPresence(undefined, args.repositoryId);

    await ctx.db.insert("artifacts", {
      repositoryId: args.repositoryId,
      jobId: args.jobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: "deep_analysis",
      title: "Focused Deep Analysis",
      summary: args.summary,
      contentMarkdown: args.contentMarkdown,
      source: "sandbox",
      version: 1,
    });

    return { completed: true as const };
  },
});

export const failDeepAnalysis = internalMutation({
  args: {
    jobId: v.id("jobs"),
    errorMessage: v.string(),
    onlyIfStale: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      return;
    }

    const now = Date.now();
    if (args.onlyIfStale) {
      const failedJob = await failStaleActiveJob(ctx, {
        jobId: args.jobId,
        expectedKind: "deep_analysis",
        now,
        errorMessage: args.errorMessage,
      });
      return { failed: failedJob !== null };
    }

    const failedJob = await failRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "deep_analysis",
      completedAt: now,
      errorMessage: args.errorMessage,
    });
    return { failed: failedJob !== null };
  },
});
