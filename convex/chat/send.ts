import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { assertRepositoryModeEligible } from "../repositoryModeEligibility";
import { requireViewerIdentity } from "../lib/auth";
import { chatModeValidator, type ChatMode } from "../lib/chatMode";
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
    /**
     * Discuss-mode grounding flags persisted on both the user and
     * assistant messages so the generation action can read them off
     * the queued user message. Unset on Library-mode turns.
     */
    groundLibrary?: boolean;
    groundSandbox?: boolean;
    trimmedContent: string;
    ownerTokenIdentifier: string;
    now: number;
    sandboxSessionId?: Id<"sandboxSessions">;
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
    // Sandbox-grounded Discuss replies cost the same as the old Lab mode
    // (tool use + larger model) — keep them on the `system_design` budget
    // line so the daily cost cap still gates correctly.
    costCategory: args.groundSandbox ? "system_design" : "chat",
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
    // Persist grounding flags only when truthy; an unset field reads as
    // "false" on the generation path, so storing `false` would just waste
    // doc bytes on every legacy-equivalent turn.
    ...(args.groundLibrary === true ? { groundLibrary: true } : {}),
    ...(args.groundSandbox === true ? { groundSandbox: true } : {}),
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
    ...(args.groundLibrary === true ? { groundLibrary: true } : {}),
    ...(args.groundSandbox === true ? { groundSandbox: true } : {}),
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

  // Update thread defaults so the composer pre-fills the toggles with the
  // user's most recent preference on the next visit. Library-mode turns
  // skip this — the thread's grounding defaults are a Discuss-only concept.
  const threadPatch: {
    mode: ChatMode;
    lastMessageAt: number;
    sandboxSessionId?: Id<"sandboxSessions">;
    defaultGroundLibrary?: boolean;
    defaultGroundSandbox?: boolean;
  } = {
    mode: args.mode,
    lastMessageAt: args.now,
    ...(args.sandboxSessionId !== undefined && { sandboxSessionId: args.sandboxSessionId }),
  };
  if (args.mode === "discuss") {
    threadPatch.defaultGroundLibrary = args.groundLibrary === true;
    threadPatch.defaultGroundSandbox = args.groundSandbox === true;
  }
  await ctx.db.patch(args.thread._id, threadPatch);

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
    /**
     * Repository this thread is bound to, or `undefined` for a repoless
     * thread (lives at `/chat/:threadId`). Library mode requires an
     * attached repository; Discuss is the only mode legal for a repoless
     * thread.
     */
    repositoryId: v.optional(v.id("repositories")),
    content: v.string(),
    mode: chatModeValidator,
    title: v.optional(v.string()),
    /**
     * Discuss-only grounding flags. Ignored for `library` mode. Either
     * may be omitted; both default to `false`.
     */
    groundLibrary: v.optional(v.boolean()),
    groundSandbox: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repositoryId = args.repositoryId;

    const trimmedContent = args.content.trim();
    if (!trimmedContent) {
      throw new Error("Message content cannot be empty.");
    }

    let repository: Doc<"repositories"> | null = null;
    if (repositoryId) {
      repository = await requireActiveRepositoryForOwner(ctx, {
        repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        notFoundMessage: "Repository not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
      });
    }

    await assertRepositoryModeEligible(ctx, {
      repositoryId,
      mode: args.mode,
      groundLibrary: args.groundLibrary === true,
      groundSandbox: args.groundSandbox === true,
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
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title,
      mode: args.mode,
      lastMessageAt: now,
      ...(args.mode === "discuss"
        ? {
            defaultGroundLibrary: args.groundLibrary === true,
            defaultGroundSandbox: args.groundSandbox === true,
          }
        : {}),
    });

    const thread = (await ctx.db.get(threadId))!;

    let sandboxSessionId: Id<"sandboxSessions"> | undefined;
    if (args.groundSandbox === true) {
      sandboxSessionId = await ctx.runMutation(internal.sandboxSessions.ensureSandboxSessionForThread, {
        threadId,
      });
    }

    const { jobId, userMessageId, assistantMessageId } = await insertChatTurn(ctx, {
      thread,
      repository,
      mode: args.mode,
      groundLibrary: args.groundLibrary,
      groundSandbox: args.groundSandbox,
      trimmedContent,
      ownerTokenIdentifier: identity.tokenIdentifier,
      now,
      sandboxSessionId,
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
    /**
     * Discuss-only grounding flags (see `sendMessageStartingNewThread`).
     * Both default to `false` when omitted.
     */
    groundLibrary: v.optional(v.boolean()),
    groundSandbox: v.optional(v.boolean()),
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
    // Library grounding makes no sense in Library Mode (it's the same
    // thing); Sandbox grounding only applies in Discuss. Coerce both to
    // false on Library-mode turns so a stale composer toggle does not
    // accidentally tag a Library reply with grounding metadata.
    const groundLibrary = mode === "discuss" && args.groundLibrary === true;
    const groundSandbox = mode === "discuss" && args.groundSandbox === true;

    // `assertRepositoryModeEligible` covers the unsatisfiable-grounding case
    // (`no_repository_attached`) with the same structured ConvexError it
    // uses for the read path, so we don't need a separate plain-Error
    // pre-check here.
    await assertRepositoryModeEligible(ctx, {
      repositoryId: thread.repositoryId,
      mode,
      groundLibrary,
      groundSandbox,
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

    let sandboxSessionId: Id<"sandboxSessions"> | undefined;
    if (groundSandbox) {
      sandboxSessionId = await ctx.runMutation(internal.sandboxSessions.ensureSandboxSessionForThread, {
        threadId: args.threadId,
      });
    }

    return await insertChatTurn(ctx, {
      thread,
      repository,
      mode,
      groundLibrary,
      groundSandbox,
      trimmedContent,
      ownerTokenIdentifier: identity.tokenIdentifier,
      now,
      sandboxSessionId,
    });
  },
});
