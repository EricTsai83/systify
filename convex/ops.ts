import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { CASCADE_BATCH_SIZE } from "./lib/constants";
import { completeRunningJob, failRunningJob, markQueuedJobRunning } from "./jobLifecycle";

const STALE_INTERACTIVE_JOBS_PER_KIND_LIMIT = 25;
const STALE_INTERACTIVE_JOBS_TOTAL_LIMIT = 50;

async function listActiveCleanupJobs(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
): Promise<Map<Id<"sandboxes">, Id<"jobs">>> {
  const queuedJobs = await ctx.db
    .query("jobs")
    .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("repositoryId", repositoryId).eq("kind", "cleanup").eq("status", "queued"),
    )
    .take(CASCADE_BATCH_SIZE);
  const runningJobs = await ctx.db
    .query("jobs")
    .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("repositoryId", repositoryId).eq("kind", "cleanup").eq("status", "running"),
    )
    .take(CASCADE_BATCH_SIZE);

  const activeCleanupJobs = new Map<Id<"sandboxes">, Id<"jobs">>();
  for (const job of [...queuedJobs, ...runningJobs]) {
    if (!job.sandboxId) {
      continue;
    }
    activeCleanupJobs.set(job.sandboxId, job._id);
  }

  return activeCleanupJobs;
}

async function queueSandboxCleanupJob(
  ctx: MutationCtx,
  sandbox: Doc<"sandboxes">,
  triggerSource: "user" | "system",
  activeCleanupJobs?: Map<Id<"sandboxes">, Id<"jobs">>,
): Promise<Id<"jobs"> | null> {
  if (sandbox.status === "archived") {
    return null;
  }

  const jobsBySandbox = activeCleanupJobs ?? (await listActiveCleanupJobs(ctx, sandbox.repositoryId));
  const existingJobId = jobsBySandbox.get(sandbox._id);
  if (existingJobId) {
    return existingJobId;
  }

  const jobId = await ctx.db.insert("jobs", {
    repositoryId: sandbox.repositoryId,
    ownerTokenIdentifier: sandbox.ownerTokenIdentifier,
    sandboxId: sandbox._id,
    kind: "cleanup",
    status: "queued",
    stage: "queued",
    progress: 0,
    costCategory: "ops",
    triggerSource,
  });

  await ctx.scheduler.runAfter(0, internal.opsNode.runSandboxCleanup, {
    sandboxId: sandbox._id,
    jobId,
  });
  jobsBySandbox.set(sandbox._id, jobId);

  return jobId;
}

export const requestSandboxCleanup = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Repository not found.");
    }

    if (!repository.latestSandboxId) {
      throw new Error("This repository does not have an active sandbox.");
    }

    const sandbox = await ctx.db.get(repository.latestSandboxId);
    if (!sandbox) {
      throw new Error("Sandbox not found.");
    }

    const activeCleanupJobs = await listActiveCleanupJobs(ctx, args.repositoryId);
    const jobId = await queueSandboxCleanupJob(ctx, sandbox, "user", activeCleanupJobs);
    if (!jobId) {
      throw new Error("Sandbox is already archived.");
    }

    return { jobId };
  },
});

export const scheduleRepositorySandboxCleanup = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const sandboxes = await ctx.db
      .query("sandboxes")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(CASCADE_BATCH_SIZE);
    const activeCleanupJobs = await listActiveCleanupJobs(ctx, args.repositoryId);

    let pendingCleanupCount = 0;
    for (const sandbox of sandboxes) {
      if (sandbox.status === "archived") {
        continue;
      }
      pendingCleanupCount += 1;
      await queueSandboxCleanupJob(ctx, sandbox, "system", activeCleanupJobs);
    }

    return { pendingCleanupCount };
  },
});

export const scheduleSandboxCleanup = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    triggerSource: v.optional(v.union(v.literal("user"), v.literal("system"))),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db.get(args.sandboxId);
    if (!sandbox) {
      return { jobId: null };
    }

    const jobId = await queueSandboxCleanupJob(ctx, sandbox, args.triggerSource ?? "system");
    return { jobId };
  },
});

export const markSandboxCleanupRunning = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db.get(args.sandboxId);
    if (!sandbox) {
      throw new Error("Sandbox not found.");
    }

    const runningJob = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "cleanup",
      stage: "deleting_remote_sandbox",
      progress: 0.3,
      startedAt: Date.now(),
    });
    if (!runningJob) {
      return { started: false as const };
    }

    return {
      started: true as const,
      remoteId: sandbox.remoteId,
    };
  },
});

export const completeSandboxCleanup = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const completedJob = await completeRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "cleanup",
      completedAt: Date.now(),
      outputSummary: "Sandbox deleted and archived.",
    });
    if (!completedJob) {
      return { completed: false as const };
    }

    await ctx.db.patch(args.sandboxId, {
      status: "archived",
      lastUsedAt: Date.now(),
    });
    return { completed: true as const };
  },
});

export const failSandboxCleanup = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const failedJob = await failRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "cleanup",
      completedAt: Date.now(),
      errorMessage: args.errorMessage,
    });
    if (!failedJob) {
      return { failed: false as const };
    }

    await ctx.db.patch(args.sandboxId, {
      status: "failed",
      lastErrorMessage: args.errorMessage,
    });
    return { failed: true as const };
  },
});

// ---------------------------------------------------------------------------
// Scheduled sweep: find sandboxes whose TTL has expired
// ---------------------------------------------------------------------------

export const getExpiredSandboxes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Sweep both expired ready sandboxes and expired stopped sandboxes.
    // A started sandbox may be transitioned to `stopped` first, then deleted
    // on a later sweep once Daytona confirms it is no longer running.
    const readyCandidates = await ctx.db
      .query("sandboxes")
      .withIndex("by_status_and_ttlExpiresAt", (q) => q.eq("status", "ready").lt("ttlExpiresAt", now))
      .take(20);
    const stoppedCandidates =
      readyCandidates.length < 20
        ? await ctx.db
            .query("sandboxes")
            .withIndex("by_status_and_ttlExpiresAt", (q) => q.eq("status", "stopped").lt("ttlExpiresAt", now))
            .take(20 - readyCandidates.length)
        : [];
    const candidates = [...readyCandidates, ...stoppedCandidates];

    return candidates.map((s) => ({
      sandboxId: s._id,
      remoteId: s.remoteId,
      repositoryId: s.repositoryId,
      ttlExpiresAt: s.ttlExpiresAt,
    }));
  },
});

export const getSandboxByRemoteId = internalQuery({
  args: {
    remoteId: v.string(),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db
      .query("sandboxes")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", args.remoteId))
      .unique();

    if (!sandbox) {
      return null;
    }

    return {
      sandboxId: sandbox._id,
      status: sandbox.status,
    };
  },
});

async function listStaleJobsByStatusAndKind(
  ctx: Pick<QueryCtx, "db">,
  args: {
    status: "queued" | "running";
    kind: "chat" | "system_design";
    now: number;
  },
) {
  return await ctx.db
    .query("jobs")
    .withIndex("by_status_and_kind_and_leaseExpiresAt", (q) =>
      q.eq("status", args.status).eq("kind", args.kind).lt("leaseExpiresAt", args.now),
    )
    .take(STALE_INTERACTIVE_JOBS_PER_KIND_LIMIT);
}

export const listStaleInteractiveJobs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const jobs = (
      await Promise.all([
        listStaleJobsByStatusAndKind(ctx, { status: "queued", kind: "chat", now }),
        listStaleJobsByStatusAndKind(ctx, { status: "queued", kind: "system_design", now }),
        listStaleJobsByStatusAndKind(ctx, { status: "running", kind: "chat", now }),
        listStaleJobsByStatusAndKind(ctx, { status: "running", kind: "system_design", now }),
      ])
    )
      .flat()
      .sort((left, right) => {
        const leaseDelta = (left.leaseExpiresAt ?? 0) - (right.leaseExpiresAt ?? 0);
        if (leaseDelta !== 0) {
          return leaseDelta;
        }
        return left._creationTime - right._creationTime;
      })
      .slice(0, STALE_INTERACTIVE_JOBS_TOTAL_LIMIT);

    return jobs.map((job) => ({
      jobId: job._id,
      kind: job.kind,
      requestedCommand: job.requestedCommand,
    }));
  },
});

export const markSandboxSwept = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    newStatus: v.union(v.literal("stopped"), v.literal("archived")),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db.get(args.sandboxId);
    if (!sandbox || sandbox.status === "archived") {
      return;
    }
    await ctx.db.patch(args.sandboxId, {
      status: args.newStatus,
      lastUsedAt: Date.now(),
    });
  },
});
