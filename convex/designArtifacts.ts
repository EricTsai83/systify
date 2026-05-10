import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { requireActiveRepositoryForOwner } from "./lib/repositoryAccess";
import {
  consumeDaytonaGlobalRateLimit,
  consumeDeepAnalysisRateLimit,
  DEEP_ANALYSIS_JOB_LEASE_MS,
  getLeaseRetryAfterMs,
  isLeaseActive,
  throwOperationAlreadyInProgress,
} from "./lib/rateLimit";
import { createOpaqueErrorId } from "./lib/observability";
import { completeRunningJob, failRunningJob, failStaleActiveJob, markQueuedJobRunning } from "./jobLifecycle";

const MAX_ADR_SOURCE_MESSAGES = 10;
const ACTIVE_FAILURE_MODE_JOB_SCAN_LIMIT = 10;

export const captureAdr = mutation({
  args: {
    threadId: v.id("threads"),
    title: v.optional(v.string()),
    /**
     * Optional folder placement. Surfaced by the panel's "+ Generate / ADR"
     * tab so a captured decision can land directly in its feature folder
     * (or stay at Repository root with `null`/undefined). Server validates
     * the folder belongs to the same repository as the thread's repo.
     */
    folderId: v.optional(v.id("artifactFolders")),
  },
  handler: async (ctx, args): Promise<{ artifactId: Id<"artifacts"> }> => {
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }
    if (thread.repositoryId) {
      await requireActiveRepositoryForOwner(ctx, {
        repositoryId: thread.repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        notFoundMessage: "Thread not found.",
        archivedMessage: "This repository is archived. Restore it to capture artifacts.",
      });
    }

    if (args.folderId) {
      const folder = await ctx.db.get(args.folderId);
      if (!folder || folder.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Folder not found.");
      }
      if (thread.repositoryId && folder.repositoryId !== thread.repositoryId) {
        throw new Error("Cannot place an artifact in a folder from a different repository.");
      }
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_threadId_and_status", (q) => q.eq("threadId", args.threadId).eq("status", "completed"))
      .order("desc")
      .take(MAX_ADR_SOURCE_MESSAGES);

    const adr = synthesizeAdrFromThreadMessages([...messages].reverse());
    const title = args.title?.trim() || adr.title;
    const artifactId: Id<"artifacts"> = await ctx.runMutation(internal.artifactStore.createArtifact, {
      threadId: args.threadId,
      repositoryId: thread.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      kind: "adr",
      title,
      summary: adr.summary,
      contentMarkdown: adr.contentMarkdown,
      source: "heuristic",
      folderId: args.folderId,
    });

    return { artifactId };
  },
});

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
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }
    if (!thread.repositoryId) {
      throw new Error("Failure mode analysis requires an attached repository.");
    }

    const repository = await requireActiveRepositoryForOwner(ctx, {
      repositoryId: thread.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      archivedMessage: "This repository is archived. Restore it to run failure-mode analysis.",
    });

    if (args.folderId) {
      const folder = await ctx.db.get(args.folderId);
      if (!folder || folder.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Folder not found.");
      }
      if (folder.repositoryId !== repository._id) {
        throw new Error("Cannot place an artifact in a folder from a different repository.");
      }
    }

    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
    if (!sandbox || sandbox.status !== "ready") {
      throw new Error("Failure mode analysis requires the repository's sandbox to be in 'ready' state.");
    }

    const now = Date.now();
    const activeJob = await getActiveFailureModeJob(ctx, args.threadId, now);
    if (activeJob) {
      throwOperationAlreadyInProgress(
        "repositoryDeepAnalysisInFlight",
        "A failure mode analysis is already in progress for this thread.",
        getLeaseRetryAfterMs(activeJob.leaseExpiresAt, now),
      );
    }

    const trimmedSubsystem = args.subsystem.trim();
    if (!trimmedSubsystem) {
      throw new Error("Please provide a subsystem to analyze.");
    }

    await consumeDeepAnalysisRateLimit(ctx, identity.tokenIdentifier);
    await consumeDaytonaGlobalRateLimit(ctx);

    const jobId = await ctx.db.insert("jobs", {
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId: sandbox._id,
      threadId: args.threadId,
      kind: "deep_analysis",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "deep_analysis",
      triggerSource: "user",
      requestedCommand: `failure_mode_analysis:${trimmedSubsystem}`,
      leaseExpiresAt: now + DEEP_ANALYSIS_JOB_LEASE_MS,
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
    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
    if (!sandbox || sandbox.status !== "ready") {
      throw new Error("Failure mode analysis requires a sandbox in 'ready' state.");
    }

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
      expectedKind: "deep_analysis",
      stage: "failure_mode_analysis",
      progress: 0.25,
      startedAt: now,
      leaseExpiresAt: now + DEEP_ANALYSIS_JOB_LEASE_MS,
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
      expectedKind: "deep_analysis",
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
      source: "sandbox",
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
      expectedKind: "deep_analysis",
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
      job.kind !== "deep_analysis" ||
      (job.status !== "queued" && job.status !== "running") ||
      !job.requestedCommand?.startsWith("failure_mode_analysis:") ||
      typeof job.leaseExpiresAt !== "number" ||
      job.leaseExpiresAt > now
    ) {
      return;
    }

    const errorId = createOpaqueErrorId("design_artifacts");
    const message = `${args.errorMessage ?? STALE_FAILURE_MODE_JOB_ERROR_MESSAGE}\n\nReference: ${errorId}`;
    const failedJob = await failStaleActiveJob(ctx, {
      jobId: args.jobId,
      expectedKind: "deep_analysis",
      now,
      errorMessage: message,
    });
    if (!failedJob) {
      return;
    }
  },
});

function synthesizeAdrFromThreadMessages(messages: Doc<"messages">[]) {
  const userPoints = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const assistantPoints = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.trim())
    .filter(Boolean);

  const contextLine =
    userPoints[0] ??
    "This ADR is captured from an in-progress thread where the team discussed architectural direction.";
  const decisionLine =
    assistantPoints[assistantPoints.length - 1] ??
    userPoints[userPoints.length - 1] ??
    "Adopt the latest thread recommendation as the current design direction.";

  const title = deriveAdrTitle(decisionLine);
  const summary = `${title} captured from thread context with explicit decision and follow-up implications.`;
  const consequences = buildConsequences(decisionLine);
  const alternatives = buildAlternatives(userPoints);

  const contentMarkdown = [
    "# ADR",
    "",
    "## Context",
    contextLine,
    "",
    "## Decision",
    decisionLine,
    "",
    "## Consequences",
    ...consequences.map((line) => `- ${line}`),
    "",
    "## Alternatives",
    ...alternatives.map((line) => `- ${line}`),
  ].join("\n");

  return { title, summary, contentMarkdown };
}

function deriveAdrTitle(decisionLine: string) {
  const plain = decisionLine.replace(/\s+/g, " ").trim();
  if (!plain) {
    return "ADR: captured decision";
  }
  const normalized = plain.length > 72 ? `${plain.slice(0, 72).trimEnd()}…` : plain;
  return `ADR: ${normalized}`;
}

function buildConsequences(decisionLine: string) {
  return [
    "The selected direction becomes the default implementation path for the current thread.",
    "Follow-up work should validate this decision against runtime constraints and team ownership.",
    `The team should monitor regressions related to: "${decisionLine.slice(0, 80)}${decisionLine.length > 80 ? "…" : ""}"`,
  ];
}

function buildAlternatives(userPoints: string[]) {
  if (userPoints.length === 0) {
    return [
      "Keep current architecture unchanged and revisit after collecting more operational evidence.",
      "Split the problem into smaller ADRs per subsystem before deciding globally.",
    ];
  }

  const lastPrompt = userPoints[userPoints.length - 1]!;
  return [
    `Preserve the status quo and defer this decision ("${lastPrompt.slice(0, 60)}${lastPrompt.length > 60 ? "…" : ""}").`,
    "Implement a narrower incremental change to reduce migration risk.",
  ];
}

async function getActiveFailureModeJob(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  const [queuedJobs, runningJobs] = await Promise.all([
    ctx.db
      .query("jobs")
      .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q.eq("threadId", threadId).eq("kind", "deep_analysis").eq("status", "queued").gte("leaseExpiresAt", now),
      )
      .take(ACTIVE_FAILURE_MODE_JOB_SCAN_LIMIT),
    ctx.db
      .query("jobs")
      .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q.eq("threadId", threadId).eq("kind", "deep_analysis").eq("status", "running").gte("leaseExpiresAt", now),
      )
      .take(ACTIVE_FAILURE_MODE_JOB_SCAN_LIMIT),
  ]);

  return [...runningJobs, ...queuedJobs].find(
    (job) => job.requestedCommand?.startsWith("failure_mode_analysis:") && isLeaseActive(job.leaseExpiresAt, now),
  );
}
