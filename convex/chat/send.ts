import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import type { ChatMode } from "../chatModeResolver";
import { assertWorkspaceModeEligible } from "../workspaceModeEligibility";
import { requireViewerIdentity } from "../lib/auth";
import { chatModeValidator } from "../lib/chatMode";
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

async function insertChatTurn(
  ctx: MutationCtx,
  args: {
    thread: Doc<"threads">;
    repository: Doc<"repositories"> | null;
    mode: ChatMode;
    trimmedContent: string;
    ownerTokenIdentifier: string;
    now: number;
    labSessionId?: Id<"labSessions">;
  },
): Promise<{ jobId: Id<"jobs">; userMessageId: Id<"messages">; assistantMessageId: Id<"messages"> }> {
  const jobId = await ctx.db.insert("jobs", {
    repositoryId: args.thread.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sandboxId: args.repository?.latestSandboxId,
    threadId: args.thread._id,
    kind: "chat",
    status: "queued",
    stage: "queued",
    progress: 0,
    costCategory: args.mode === "lab" ? "system_design" : "chat",
    triggerSource: "user",
    leaseExpiresAt: args.now + CHAT_JOB_LEASE_MS,
  });

  const userMessageId = await ctx.db.insert("messages", {
    repositoryId: args.thread.repositoryId,
    threadId: args.thread._id,
    jobId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    role: "user",
    status: "completed",
    mode: args.mode,
    content: args.trimmedContent,
  });

  const assistantMessageId = await ctx.db.insert("messages", {
    repositoryId: args.thread.repositoryId,
    threadId: args.thread._id,
    jobId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    role: "assistant",
    status: "pending",
    mode: args.mode,
    content: "",
  });

  await ctx.db.insert("messageStreams", {
    repositoryId: args.thread.repositoryId,
    threadId: args.thread._id,
    jobId,
    assistantMessageId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    compactedContent: "",
    compactedThroughSequence: -1,
    nextSequence: 0,
    startedAt: args.now,
    lastAppendedAt: args.now,
  });

  await ctx.db.patch(args.thread._id, {
    mode: args.mode,
    lastMessageAt: args.now,
    ...(args.labSessionId !== undefined && { labSessionId: args.labSessionId }),
  });

  await ctx.scheduler.runAfter(0, internal.chat.generation.generateAssistantReply, {
    threadId: args.thread._id,
    userMessageId,
    assistantMessageId,
    jobId,
  });

  return { jobId, userMessageId, assistantMessageId };
}

export const sendMessageStartingNewThread = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    content: v.string(),
    mode: chatModeValidator,
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);

    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Workspace not found.");
    }

    const repositoryId = workspace.repositoryId;

    if ((args.mode === "library" || args.mode === "lab") && !repositoryId) {
      throw new Error(`'${args.mode}' mode requires an attached repository.`);
    }

    const trimmedContent = args.content.trim();
    if (!trimmedContent) {
      throw new Error("Message content cannot be empty.");
    }

    let repository: Doc<"repositories"> | null = null;
    if (repositoryId) {
      repository = await requireActiveRepositoryForOwner(ctx, {
        repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        notFoundMessage: "Workspace repository not found.",
        archivedMessage: "The workspace repository is archived. Restore it to continue chatting.",
      });
    }

    await assertWorkspaceModeEligible(ctx, {
      repositoryId,
      workspaceId: args.workspaceId,
      mode: args.mode,
    });

    const now = Date.now();

    await consumeChatRateLimit(ctx, identity.tokenIdentifier);
    await consumeChatGlobalRateLimit(ctx);

    let title = args.title;
    if (repositoryId) {
      const repo = await ctx.db.get(repositoryId);
      title ??= repo ? `${repo.sourceRepoName} chat` : "New chat";
    } else {
      title ??= "New design conversation";
    }

    const threadId = await ctx.db.insert("threads", {
      workspaceId: args.workspaceId,
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title,
      mode: args.mode,
      lastMessageAt: now,
    });

    const thread = (await ctx.db.get(threadId))!;

    let labSessionId: Id<"labSessions"> | undefined;
    if (args.mode === "lab") {
      labSessionId = await ctx.runMutation(internal.labSessions.ensureLabSessionForThread, {
        threadId,
      });
    }

    const { jobId, userMessageId, assistantMessageId } = await insertChatTurn(ctx, {
      thread,
      repository,
      mode: args.mode,
      trimmedContent,
      ownerTokenIdentifier: identity.tokenIdentifier,
      now,
      labSessionId,
    });

    return {
      threadId,
      jobId,
      userMessageId,
      assistantMessageId,
      mode: args.mode,
    };
  },
});

export const sendMessage = mutation({
  args: {
    threadId: v.id("threads"),
    content: v.string(),
    mode: v.optional(chatModeValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ jobId: Id<"jobs">; userMessageId: Id<"messages">; assistantMessageId: Id<"messages"> }> => {
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }

    if (thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
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

    const mode = args.mode ?? thread.mode;

    await assertWorkspaceModeEligible(ctx, {
      repositoryId: thread.repositoryId,
      workspaceId: thread.workspaceId,
      mode,
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

    return await insertChatTurn(ctx, {
      thread,
      repository,
      mode,
      trimmedContent,
      ownerTokenIdentifier: identity.tokenIdentifier,
      now,
      labSessionId,
    });
  },
});
