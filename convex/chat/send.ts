import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { serviceModeForThreadMode } from "../chatModeResolver";
import { assertServiceModeEligible } from "../serviceModeEligibility";
import { requireViewerIdentity } from "../lib/auth";
import { requireActiveRepositoryForOwner } from "../lib/repositoryAccess";
import {
  CHAT_JOB_LEASE_MS,
  consumeChatGlobalRateLimit,
  consumeChatRateLimit,
  getLeaseRetryAfterMs,
  isLeaseActive,
  throwOperationAlreadyInProgress,
} from "../lib/rateLimit";

async function getActiveChatJobForThread(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  const queuedJob = await ctx.db
    .query("jobs")
    .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("threadId", threadId).eq("kind", "chat").eq("status", "queued").gte("leaseExpiresAt", now),
    )
    .first();
  if (queuedJob && isLeaseActive(queuedJob.leaseExpiresAt, now)) {
    return queuedJob;
  }

  const runningJob = await ctx.db
    .query("jobs")
    .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("threadId", threadId).eq("kind", "chat").eq("status", "running").gte("leaseExpiresAt", now),
    )
    .first();
  if (runningJob && isLeaseActive(runningJob.leaseExpiresAt, now)) {
    return runningJob;
  }

  return null;
}

export const sendMessage = mutation({
  args: {
    threadId: v.id("threads"),
    content: v.string(),
    mode: v.optional(
      v.union(v.literal("discuss"), v.literal("docs"), v.literal("sandbox"), v.literal("ask"), v.literal("lab")),
    ),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }

    if (thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }

    if (thread.lockedAt !== undefined) {
      throw new ConvexError({
        code: "ThreadLocked",
        message: "This legacy Design Docs thread is archived. Open Library Ask or Lab to continue.",
      });
    }

    let repository: Doc<"repositories"> | null = null;
    if (thread.repositoryId) {
      repository = await requireActiveRepositoryForOwner(ctx, {
        repositoryId: thread.repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        notFoundMessage: "Thread not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
      });
    }

    const requestedMode = args.mode ?? thread.mode;
    const mode = requestedMode === "sandbox" ? "lab" : requestedMode === "docs" ? "ask" : requestedMode;

    // Single source of truth for "can this viewer use mode X for this
    // workspace right now?" — composes sandbox availability + daily cost
    // cap + (for Library) artifact existence and throws a structured
    // ConvexError with a stable code on disabled. The reactive
    // service-mode-switcher query subscribes to the same evaluator; the
    // write-path check here keeps a stale UI / direct mutation caller / UI
    // race (mode picked then sandbox expired) from slipping through.
    await assertServiceModeEligible(ctx, {
      repositoryId: thread.repositoryId,
      workspaceId: thread.workspaceId,
      mode: serviceModeForThreadMode(mode),
    });

    const trimmedContent = args.content.trim();
    if (!trimmedContent) {
      throw new Error("Message content cannot be empty.");
    }

    const now = Date.now();
    const activeJob = await getActiveChatJobForThread(ctx, args.threadId, now);

    if (activeJob) {
      throwOperationAlreadyInProgress(
        "threadChatInFlight",
        "An assistant reply is already in progress for this thread.",
        getLeaseRetryAfterMs(activeJob.leaseExpiresAt, now),
      );
    }

    await consumeChatRateLimit(ctx, identity.tokenIdentifier);
    await consumeChatGlobalRateLimit(ctx);

    let labSessionId: Id<"labSessions"> | undefined;
    if (mode === "lab") {
      labSessionId = await ctx.runMutation(internal.labSessions.ensureLabSessionForThread, {
        threadId: args.threadId,
      });
    }

    const jobId = await ctx.db.insert("jobs", {
      repositoryId: thread.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId: repository?.latestSandboxId,
      threadId: args.threadId,
      kind: "chat",
      status: "queued",
      stage: "queued",
      progress: 0,
      // Sandbox / Lab modes are the only ones that consume Daytona
      // compute, so they bill against the `system_design` cost category
      // (shared with System Design generation + Failure Mode Analysis).
      // `discuss`, `docs`, and `ask` all stay on the standard `chat`
      // category — Ask runs entirely on chunk retrieval + LLM, no
      // sandbox.
      costCategory: mode === "lab" ? "system_design" : "chat",
      triggerSource: "user",
      leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
    });

    const userMessageId = await ctx.db.insert("messages", {
      repositoryId: thread.repositoryId,
      threadId: args.threadId,
      jobId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      role: "user",
      status: "completed",
      mode,
      content: trimmedContent,
    });

    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId: thread.repositoryId,
      threadId: args.threadId,
      jobId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      role: "assistant",
      status: "pending",
      mode,
      content: "",
    });

    await ctx.db.insert("messageStreams", {
      repositoryId: thread.repositoryId,
      threadId: args.threadId,
      jobId,
      assistantMessageId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      compactedContent: "",
      compactedThroughSequence: -1,
      nextSequence: 0,
      startedAt: now,
      lastAppendedAt: now,
    });

    await ctx.db.patch(args.threadId, {
      mode,
      lastMessageAt: now,
      labSessionId,
    });

    await ctx.scheduler.runAfter(0, internal.chat.generation.generateAssistantReply, {
      threadId: args.threadId,
      userMessageId,
      assistantMessageId,
      jobId,
    });

    return {
      jobId,
      userMessageId,
      assistantMessageId,
    };
  },
});
