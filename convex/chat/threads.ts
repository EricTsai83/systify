import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import { getDefaultThreadMode } from "../chatModeResolver";
import { requireViewerIdentity } from "../lib/auth";
import { MAX_STREAM_CHUNKS_PER_PASS, MAX_VISIBLE_MESSAGES } from "../lib/constants";
import { ensureRepositoryWorkspace, findHomeWorkspaceId } from "../lib/workspaces";
import { loadRecentMessages } from "./context";
import { deleteMessageStreamState } from "./streamStore";
import { drainMessageToolCallEvents } from "./toolCallEventStore";

export const listThreads = query({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    workspaceId: v.optional(v.id("workspaces")),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);

    // Workspace-scoped listing takes priority over repo-scoped listing.
    if (args.workspaceId) {
      const workspace = await ctx.db.get(args.workspaceId);
      if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
        return [];
      }
      return await ctx.db
        .query("threads")
        .withIndex("by_workspaceId_and_lastMessageAt", (q) => q.eq("workspaceId", args.workspaceId))
        .order("desc")
        .take(20);
    }

    const filterRepositoryId = args.repositoryId;
    if (filterRepositoryId) {
      const repository = await ctx.db.get(filterRepositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Repository not found.");
      }

      return await ctx.db
        .query("threads")
        .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", filterRepositoryId))
        .order("desc")
        .take(20);
    }

    return await ctx.db
      .query("threads")
      .withIndex("by_ownerTokenIdentifier_and_lastMessageAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .take(20);
  },
});

export const listMessages = query({
  args: {
    threadId: v.id("threads"),
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

    if (thread.repositoryId) {
      const repository = await ctx.db.get(thread.repositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Thread not found.");
      }
    }

    return await loadRecentMessages(ctx, args.threadId, MAX_VISIBLE_MESSAGES);
  },
});

export const createThread = mutation({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    workspaceId: v.optional(v.id("workspaces")),
    title: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("discuss"), v.literal("docs"), v.literal("sandbox"))),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);

    // When a workspaceId is provided, inherit its repositoryId unless the
    // caller explicitly supplies one. This means threads created inside a
    // workspace automatically attach to the workspace's repo.
    let repositoryId = args.repositoryId;
    const workspaceId = args.workspaceId;
    if (workspaceId) {
      const workspace = await ctx.db.get(workspaceId);
      if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Workspace not found.");
      }
      if (repositoryId !== undefined && workspace.repositoryId !== repositoryId) {
        throw new Error("Thread repository must match the workspace repository.");
      }
      if (repositoryId === undefined && workspace.repositoryId) {
        repositoryId = workspace.repositoryId;
      }
    }

    // `docs` and `sandbox` both require an attached repo; the resolver's
    // capability ladder already prevents the UI from offering them in the
    // no-repo case, but we re-check here so direct callers (and racing UI
    // states) can't bypass it. We do NOT enforce sandbox-ready at thread
    // creation; `sendMessage` re-validates at the actual send moment.
    if ((args.mode === "docs" || args.mode === "sandbox") && !repositoryId) {
      throw new Error(`'${args.mode}' mode requires an attached repository.`);
    }

    let title = args.title;
    if (repositoryId) {
      const repository = await ctx.db.get(repositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Repository not found.");
      }
      title ??= `${repository.sourceRepoName} chat`;
    } else {
      title ??= "New design conversation";
    }

    // Default mode picks `docs` when a repo is in play (matches resolver's
    // `defaultMode` for repo-attached threads with non-ready sandboxes), and
    // `discuss` when there is no repo. Keeping this in lockstep with the
    // resolver means the persisted mode and the UI's preselected mode agree
    // on day one.
    const defaultMode = getDefaultThreadMode(!!repositoryId);

    return await ctx.db.insert("threads", {
      workspaceId,
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title,
      mode: args.mode ?? defaultMode,
      lastMessageAt: Date.now(),
    });
  },
});

/**
 * Attach, swap, or detach the repository bound to a thread.
 *
 * Powers the in-thread `AttachRepoMenu` per PRD #19 user stories 2 and 3:
 * users can move from abstract discussion to grounded analysis (or back) on
 * the same thread without losing context. Passing `repositoryId: null`
 * clears the optional `threads.repositoryId` field; Convex `patch` accepts
 * `undefined` to drop optional fields, which is what we forward.
 *
 * Note that historical messages on the thread are not re-grounded. New
 * messages issued after the swap pick up the new repository's context via
 * `getReplyContext`, but prior assistant replies stay as-is.
 */
export const setThreadRepository = mutation({
  args: {
    threadId: v.id("threads"),
    repositoryId: v.union(v.id("repositories"), v.null()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }

    if (args.repositoryId !== null) {
      const repository = await ctx.db.get(args.repositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Repository not found.");
      }
      const workspaceId = await ensureRepositoryWorkspace(ctx, {
        repositoryId: args.repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        name: repository.sourceRepoFullName,
      });
      // Two transitions land in this branch:
      //   1. no-repo  → has-repo:  the thread is in `discuss` (the only mode
      //      a repo-less thread can hold per createThread + the detach path
      //      below). Spec says discuss is "no repo, no sandbox", so leaving
      //      it in `discuss` after attaching a repo would create the exact
      //      stale-mode state the resolver is supposed to forbid. Lift the
      //      thread into the repo default (`docs`) to mirror createThread.
      //   2. repo-A   → repo-B:    the thread already has a repo and the user
      //      may have explicitly chosen `docs` or `sandbox`. Preserve their
      //      choice; only `repositoryId`/`workspaceId` need to change.
      const nextMode = thread.repositoryId ? thread.mode : getDefaultThreadMode(true);
      await ctx.db.patch(args.threadId, {
        repositoryId: args.repositoryId,
        workspaceId,
        mode: nextMode,
      });
      return { repositoryId: args.repositoryId, workspaceId };
    }

    // Detach atomically: dropping the repository while resetting the persisted
    // mode keeps the thread in the same repo-less default state as
    // `createThread`, so a racing `sendMessage` call never sees a stale
    // repo-dependent mode like `docs` / `sandbox`.
    const workspaceId = await findHomeWorkspaceId(ctx, identity.tokenIdentifier);
    await ctx.db.patch(args.threadId, {
      workspaceId: workspaceId ?? undefined,
      repositoryId: undefined,
      mode: getDefaultThreadMode(false),
    });
    return { repositoryId: null as null, workspaceId };
  },
});

export const deleteThread = mutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }
    // Delegate the heavy lifting to the shared helper. The same helper
    // backs `deleteThreadContinuation` (an internal mutation) so we can
    // reschedule across mutations when a single transaction can't fit
    // the full message + stream + tool-event delete budget.
    await deleteThreadImpl(ctx, args);
  },
});

/**
 * Continuation hook for `deleteThread`. The public mutation does the
 * ownership check up front and then calls the same helper this mutation
 * runs; if the work spilled past the per-mutation write budget, we
 * reschedule ourselves (not the public `deleteThread`, which can't be
 * referenced via `internal.*` and would re-run the auth check without an
 * identity context).
 */
export const deleteThreadContinuation = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await deleteThreadImpl(ctx, args);
  },
});

async function deleteThreadImpl(ctx: MutationCtx, args: { threadId: Id<"threads"> }): Promise<void> {
  const thread = await ctx.db.get(args.threadId);
  if (!thread) {
    // Already deleted — either a concurrent caller finished the job or a
    // continuation tick fired after the row went away. Nothing to do.
    return;
  }

  const messages = await ctx.db
    .query("messages")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
    .take(500);
  for (const message of messages) {
    // Plan 06 — drain orphan tool-call events ahead of deleting the
    // message, otherwise the live `getMessageToolCallEvents` subscription
    // would hold rows referencing a now-missing parent. Bounded
    // per-message (≤ MAX_TOOL_CALL_EVENTS_PER_MESSAGE by construction).
    await drainMessageToolCallEvents(ctx, message._id);
    await ctx.db.delete(message._id);
  }

  if (messages.length === 500) {
    // Each iteration above can issue up to MAX_TOOL_CALL_EVENTS_PER_MESSAGE
    // event-delete writes plus the message-row delete; 500 messages can
    // exceed Convex's per-mutation write budget. Mirror the
    // `cleanupOrphanedMessageStreams` checkpoint pattern: schedule a
    // continuation on a fresh transaction and return early so we don't
    // also try to delete streams + the thread row in this mutation.
    await ctx.scheduler.runAfter(0, internal.chat.threads.deleteThreadContinuation, args);
    return;
  }

  // Drain message streams in this thread, but cap total chunk-row deletions
  // per invocation. Without a budget, one mutation could try to delete every
  // chunk across every stream in the thread (e.g. 500 streams * a long
  // uncompacted tail), which can blow past Convex's per-mutation
  // read/write limits. Streams we don't get to are picked up by
  // cleanupOrphanedMessageStreams on the follow-up scheduler tick.
  const streams = await ctx.db
    .query("messageStreams")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
    .take(500);

  let totalChunksProcessed = 0;
  let streamBudgetExhausted = false;
  for (const stream of streams) {
    if (totalChunksProcessed >= MAX_STREAM_CHUNKS_PER_PASS) {
      streamBudgetExhausted = true;
      break;
    }
    totalChunksProcessed += await deleteMessageStreamState(ctx, stream._id);
  }

  if (thread.repositoryId) {
    const repository = await ctx.db.get(thread.repositoryId);
    if (repository && repository.defaultThreadId === args.threadId) {
      await ctx.db.patch(thread.repositoryId, { defaultThreadId: undefined });
    }
  }

  await ctx.db.delete(args.threadId);

  if (streamBudgetExhausted || streams.length === 500) {
    await ctx.scheduler.runAfter(0, internal.chat.threads.cleanupOrphanedMessageStreams, {
      threadId: args.threadId,
    });
  }
}

export const cleanupOrphanedMessages = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .take(500);
    for (const message of messages) {
      // Plan 06 — same drain-then-delete order as `deleteThread` so the
      // re-scheduled cleanup pass doesn't outlive the events table.
      await drainMessageToolCallEvents(ctx, message._id);
      await ctx.db.delete(message._id);
    }
    if (messages.length === 500) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.cleanupOrphanedMessages, {
        threadId: args.threadId,
      });
    }
  },
});

export const cleanupOrphanedMessageStreams = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const streams = await ctx.db
      .query("messageStreams")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .take(500);

    let totalChunksProcessed = 0;
    let streamBudgetExhausted = false;
    for (const stream of streams) {
      if (totalChunksProcessed >= MAX_STREAM_CHUNKS_PER_PASS) {
        streamBudgetExhausted = true;
        break;
      }
      totalChunksProcessed += await deleteMessageStreamState(ctx, stream._id);
    }

    if (streamBudgetExhausted || streams.length === 500) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.cleanupOrphanedMessageStreams, {
        threadId: args.threadId,
      });
    }
  },
});
