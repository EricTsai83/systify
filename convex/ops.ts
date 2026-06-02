import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireOwnedDoc } from "./lib/ownedDocs";
import { CASCADE_BATCH_SIZE } from "./lib/constants";
import { completeRunningJob, enqueueJob, failRunningJob, markQueuedJobRunning } from "./lib/jobs";
import {
  expiredSandboxesValidator,
  sandboxCleanupScheduleResultValidator,
  sandboxCleanupStartValidator,
  sandboxLookupResultValidator,
  staleInteractiveJobsValidator,
} from "./lib/functionResultSchemas";

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

  const jobId = await enqueueJob(ctx, {
    kind: "cleanup",
    repositoryId: sandbox.repositoryId,
    ownerTokenIdentifier: sandbox.ownerTokenIdentifier,
    sandboxId: sandbox._id,
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
    const { doc: repository } = await requireOwnedDoc(ctx, args.repositoryId, {
      notFoundMessage: "Repository not found.",
    });

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
  returns: sandboxCleanupScheduleResultValidator,
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
  returns: sandboxCleanupStartValidator,
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
    const sandbox = await ctx.db.get(args.sandboxId);
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
    if (sandbox) {
      const repository = await ctx.db.get(sandbox.repositoryId);
      if (repository?.deletionRequestedAt) {
        await ctx.scheduler.runAfter(0, internal.repositories.cascadeDeleteRepository, {
          repositoryId: sandbox.repositoryId,
        });
      }
    }
    return { completed: true as const };
  },
});

/**
 * Mirror an authoritative Daytona state back into the local `sandboxes`
 * row. Called by `convex/lib/sandboxLiveness.ts` after a verify-on-use
 * probe so the cache stays consistent with reality even when the webhook
 * never fired (manual deletion in the Daytona dashboard, dead-letter
 * after retries, Daytona-side GC).
 *
 * The state mapping mirrors `convex/daytonaWebhooks.ts:217-232` so the
 * write-through and reactive paths produce the same outcome. The
 * `archived` terminal guard is also mirrored — once a sandbox is locally
 * archived, we don't let a subsequent probe drag it back to `ready` or
 * `stopped`, which would only re-open the same staleness window we just
 * closed.
 */
export const syncSandboxStatusFromRemote = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    remoteState: v.union(
      v.literal("started"),
      v.literal("stopped"),
      v.literal("archived"),
      v.literal("destroyed"),
      v.literal("error"),
      v.literal("unknown"),
    ),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db.get(args.sandboxId);
    if (!sandbox) {
      return { patched: false as const };
    }
    if (sandbox.status === "archived") {
      // Terminal locally — don't fight it. Same invariant the webhook
      // handler protects.
      return { patched: false as const };
    }

    const now = Date.now();
    const patch: Partial<Doc<"sandboxes">> = {};
    if (args.remoteState === "started") {
      patch.status = "ready";
      patch.lastUsedAt = now;
    } else if (args.remoteState === "stopped") {
      patch.status = "stopped";
      patch.lastUsedAt = now;
    } else if (args.remoteState === "archived" || args.remoteState === "destroyed") {
      patch.status = "archived";
      patch.lastUsedAt = now;
    } else if (args.remoteState === "error") {
      patch.status = "failed";
      patch.lastErrorMessage = "Daytona reported the sandbox as errored during a live verification.";
    }
    // `unknown` → no-op: don't overwrite a known cache state with a guess.

    if (Object.keys(patch).length === 0) {
      return { patched: false as const };
    }
    await ctx.db.patch(args.sandboxId, patch);
    return { patched: true as const };
  },
});

export const failSandboxCleanup = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db.get(args.sandboxId);
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
    if (sandbox) {
      const repository = await ctx.db.get(sandbox.repositoryId);
      if (repository?.deletionRequestedAt) {
        await ctx.db.patch(sandbox.repositoryId, {
          repositoryDeleteSandboxCleanupAttempts: (repository.repositoryDeleteSandboxCleanupAttempts ?? 0) + 1,
        });
        await ctx.scheduler.runAfter(0, internal.repositories.cascadeDeleteRepository, {
          repositoryId: sandbox.repositoryId,
        });
      }
    }
    return { failed: true as const };
  },
});

// ---------------------------------------------------------------------------
// Scheduled sweep: find sandboxes whose TTL has expired
// ---------------------------------------------------------------------------

export const getExpiredSandboxes = internalQuery({
  args: {},
  returns: expiredSandboxesValidator,
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

/**
 * Read a single sandbox row by id. Exported for `ensureSandboxReady`'s
 * polling loop — actions can't call `ctx.db.get` directly so this
 * internal query is the cheapest way to re-read the row state between
 * polls without joining any other table.
 */
export const getSandboxRow = internalQuery({
  args: { sandboxId: v.id("sandboxes") },
  handler: async (ctx, args): Promise<Doc<"sandboxes"> | null> => {
    return await ctx.db.get(args.sandboxId);
  },
});

export const getSandboxByRemoteId = internalQuery({
  args: {
    remoteId: v.string(),
  },
  returns: sandboxLookupResultValidator,
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
    kind: "chat" | "system_design" | "sandbox_activation";
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
  returns: staleInteractiveJobsValidator,
  handler: async (ctx) => {
    const now = Date.now();
    const jobs = (
      await Promise.all([
        listStaleJobsByStatusAndKind(ctx, { status: "queued", kind: "chat", now }),
        listStaleJobsByStatusAndKind(ctx, { status: "queued", kind: "system_design", now }),
        listStaleJobsByStatusAndKind(ctx, { status: "queued", kind: "sandbox_activation", now }),
        listStaleJobsByStatusAndKind(ctx, { status: "running", kind: "chat", now }),
        listStaleJobsByStatusAndKind(ctx, { status: "running", kind: "system_design", now }),
        listStaleJobsByStatusAndKind(ctx, { status: "running", kind: "sandbox_activation", now }),
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

    return jobs.map((job) => {
      if (job.kind !== "chat" && job.kind !== "system_design" && job.kind !== "sandbox_activation") {
        throw new Error(`Unexpected stale interactive job kind: ${job.kind}`);
      }
      return {
        jobId: job._id,
        kind: job.kind,
      };
    });
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
