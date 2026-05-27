import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { assertRepositoryModeEligible } from "../repositoryModeEligibility";
import { requireViewerIdentity } from "../lib/auth";
import { chatModeValidator, resolveDiscussGrounding, type ChatMode } from "../lib/chatMode";
import { enqueueJob, findActiveJob } from "../lib/jobs";
import { requireActiveRepositoryForViewer } from "../lib/repositoryAccess";
import { requireOwnedDoc } from "../lib/ownedDocs";
import {
  CHAT_JOB_LEASE_MS,
  consumeChatGlobalRateLimit,
  consumeChatRateLimit,
  getLeaseRetryAfterMs,
  throwOperationAlreadyInProgress,
} from "../lib/rateLimit";

async function getActiveChatJobForThread(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  return await findActiveJob(ctx, {
    kind: "chat",
    scope: { type: "thread", id: threadId },
    now,
  });
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
  // Sandbox-grounded Discuss replies use tool calls and the heavier model
  // tier, so they bill against the `system_design` budget line and the
  // daily sandbox cost cap rather than the chat budget.
  const jobId = await enqueueJob(ctx, {
    kind: "chat",
    threadId: args.thread._id,
    repositoryId: args.thread.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sandboxId: args.repository?.latestSandboxId,
    costCategory: args.groundSandbox ? "system_design" : "chat",
    triggerSource: "user",
    leaseMs: CHAT_JOB_LEASE_MS,
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
      const result = await requireActiveRepositoryForViewer(ctx, {
        repositoryId,
        notFoundMessage: "Repository not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
      });
      repository = result.repository;
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
    const { identity, doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });

    let repository: Doc<"repositories"> | null = null;
    if (thread.repositoryId) {
      const result = await requireActiveRepositoryForViewer(ctx, {
        repositoryId: thread.repositoryId,
        notFoundMessage: "Thread not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
      });
      repository = result.repository;
    }

    const mode = args.mode ?? thread.mode;
    // Library grounding makes no sense in Library Mode (it's the same
    // thing); Sandbox grounding only applies in Discuss. The resolver
    // coerces both to false on Library-mode turns so a stale composer
    // toggle does not accidentally tag a Library reply with grounding
    // metadata. Same rule used by `getReplyContext` on the read path.
    const { groundLibrary, groundSandbox } = resolveDiscussGrounding(mode, args);

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
