import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import { chatModeValidator, getDefaultThreadMode } from "../lib/chatMode";
import { loadOwnedDoc, requireOwnedDoc } from "../lib/ownedDocs";
import { MAX_STREAM_CHUNKS_PER_PASS, MAX_VISIBLE_MESSAGES } from "../lib/constants";
import { touchRepositoryLastAccessed } from "../lib/repositoryPalette";
import { loadRecentMessages } from "./context";
import { deleteMessageStreamState } from "./streamStore";
import { drainMessageToolCallEvents } from "./toolCallEventStore";

/**
 * Upper bound on the per-thread Ask scope filter. 20 ids keeps the filter
 * lookup small (the scope filter is applied during RAG retrieval, where
 * each candidate chunk is filtered by `artifactId IN scope`). A repository
 * with more than 20 artifacts the user wants to scope the question to
 * almost certainly wants the unbounded "whole repository" variant (empty
 * array) instead.
 */
const ASK_THREAD_MAX_ARTIFACT_CONTEXT = 20;

export const listThreads = query({
  args: {
    repositoryId: v.id("repositories"),
    /**
     * Service-mode-scoped listing. Each chat mode (Discuss / Library) owns
     * its own thread slice, so the sidebar query forwards the active mode
     * and the backend serves only the matching rows. Without this filter,
     * threads of a non-matching mode would surface in the wrong sidebar
     * (and the most-recent-thread redirect would bounce the user into a
     * mode-mismatched chat).
     */
    mode: v.optional(chatModeValidator),
  },
  handler: async (ctx, args) => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return [];
    }
    const repositoryId = args.repositoryId;
    const mode = args.mode;
    const pinned = mode
      ? await ctx.db
          .query("threads")
          .withIndex("by_repositoryId_mode_and_pinnedAt", (q) =>
            q.eq("repositoryId", repositoryId).eq("mode", mode).gt("pinnedAt", 0),
          )
          .order("desc")
          .take(20)
      : await ctx.db
          .query("threads")
          .withIndex("by_repositoryId_and_pinnedAt", (q) => q.eq("repositoryId", repositoryId).gt("pinnedAt", 0))
          .order("desc")
          .take(20);
    const recent = mode
      ? await ctx.db
          .query("threads")
          .withIndex("by_repositoryId_mode_and_lastMessageAt", (q) =>
            q.eq("repositoryId", repositoryId).eq("mode", mode),
          )
          .order("desc")
          .take(20)
      : await ctx.db
          .query("threads")
          .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", repositoryId))
          .order("desc")
          .take(20);
    const pinnedIds = new Set(pinned.map((thread) => thread._id));
    return [...pinned, ...recent.filter((thread) => !pinnedIds.has(thread._id))];
  },
});

/**
 * Repoless threads — chats not bound to any repository, surfaced in the
 * repoless shell's "Chats" sidebar section. Always Discuss mode by
 * construction (Library requires an attached repository). The
 * `by_ownerTokenIdentifier_repoless_and_lastMessageAt` index pins
 * `repositoryId === undefined` so the range read scans only the repoless
 * slice instead of filtering the whole owner table.
 */
export const listRepolessThreads = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return await ctx.db
      .query("threads")
      .withIndex("by_ownerTokenIdentifier_repoless_and_lastMessageAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("repositoryId", undefined),
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
    const { doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });

    if (thread.repositoryId) {
      await requireOwnedDoc(ctx, thread.repositoryId, {
        notFoundMessage: "Thread not found.",
      });
    }

    return await loadRecentMessages(ctx, args.threadId, MAX_VISIBLE_MESSAGES);
  },
});

/**
 * All thread ids the viewer owns, capped at 1000. Used by the frontend
 * `useStorageGC` thread-scoped sweep to drop composer-draft localStorage
 * entries (`systify.composer.draft.thread.{tid}`) whose owning thread has
 * been deleted. The cap is intentional — beyond 1000 threads a power user
 * may see drafts on extremely old threads collected as orphans, which is
 * an acceptable trade-off versus paginating the whole table on every
 * subscription tick.
 *
 * The query walks the `by_ownerTokenIdentifier_and_lastMessageAt` index
 * (already present in the schema) so no schema work is needed; descending
 * order means the freshest 1000 threads always survive the cap.
 */
export const listAllOwnerThreadIds = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_ownerTokenIdentifier_and_lastMessageAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .take(1000);
    return rows.map((row) => row._id);
  },
});

/**
 * Lightweight thread-existence probe. Unlike {@link listMessages} (which
 * throws "Thread not found." so a broken thread surfaces as an error
 * boundary), this returns `null` when the thread is missing or owned by
 * another viewer. The Library page uses it to validate the
 * `?ask=:threadId` URL param — a stale bookmark or a since-deleted thread
 * is cleared gracefully instead of crashing the page. Mirrors the
 * artifact-id guard pattern (`artifacts.getById`).
 */
export const getThreadSummary = query({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await loadOwnedDoc(ctx, args.threadId);
    return thread;
  },
});

export const createThread = mutation({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    title: v.optional(v.string()),
    mode: v.optional(chatModeValidator),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);

    const repositoryId = args.repositoryId;
    const mode = args.mode ?? getDefaultThreadMode(!!repositoryId);

    if (mode === "library" && !repositoryId) {
      throw new Error(`'${mode}' mode requires an attached repository.`);
    }

    let title = args.title;
    if (repositoryId) {
      const { doc: repository } = await requireOwnedDoc(ctx, repositoryId, {
        notFoundMessage: "Repository not found.",
      });
      title ??= `${repository.sourceRepoName} chat`;
    } else {
      title ??= "New design conversation";
    }

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title,
      mode,
      lastMessageAt: Date.now(),
    });
    return { _id: threadId, mode };
  },
});

/**
 * Create a Library Ask thread bound to a repository. Distinct from
 * {@link createThread} because Ask carries a scope-filter
 * (`artifactContext`) the plain thread mutation has no place for. The
 * thread is persisted with `mode: "library"` — "Ask" is the user-facing
 * label for an artifact-scoped chat within Library mode.
 */
export const createLibraryAskThread = mutation({
  args: {
    repositoryId: v.id("repositories"),
    artifactContext: v.optional(v.array(v.id("artifacts"))),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireOwnedDoc(ctx, args.repositoryId, {
      notFoundMessage: "Repository not found.",
    });

    const artifactContext = args.artifactContext ?? [];
    if (artifactContext.length > ASK_THREAD_MAX_ARTIFACT_CONTEXT) {
      throw new Error(
        `Library Ask scope filter accepts at most ${ASK_THREAD_MAX_ARTIFACT_CONTEXT} artifacts (got ${artifactContext.length}).`,
      );
    }

    for (const artifactId of artifactContext) {
      const { doc: artifact } = await requireOwnedDoc(ctx, artifactId, {
        notFoundMessage: "Artifact not found.",
      });
      if (artifact.repositoryId !== args.repositoryId) {
        throw new Error("Artifact is not in this repository.");
      }
    }

    const threadId = await ctx.db.insert("threads", {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title: args.title ?? "Library Ask",
      mode: "library",
      lastMessageAt: Date.now(),
      artifactContext: artifactContext.length > 0 ? artifactContext : undefined,
    });
    return { _id: threadId, mode: "library" as const };
  },
});

/**
 * Attach, swap, or detach the repository bound to a thread.
 *
 * Only **swap** (repo-A → repo-B) has a UI entry point, via
 * `SwapThreadRepositoryControl` in the TopBar, gated behind an explicit
 * confirmation dialog. **Attach** (no-repo → repo) and **detach** have no UI
 * affordance — to bind a previously repoless thread or drop a repo, users
 * start a new thread in the desired context.
 *
 * This mutation does not re-ground historical messages: only new messages
 * pick up the new repo's context via `getReplyContext`. A swap therefore
 * leaves the scrollback referencing repo A while new replies reference repo
 * B — the "Frankenstein scrollback" the swap dialog warns about. The
 * confirmation step is the guardrail; the backend stays permissive (accepts
 * `null` and any repo id) so a future "Fork thread to repo X" feature —
 * which would copy the thread before re-pointing the binding, sidestepping
 * the problem entirely — can reuse this mutation without a backend change.
 *
 * On a swap, the return value carries `swappedFromRepositoryId` so the caller
 * can surface the scrollback warning; attach and detach omit it. Passing
 * `repositoryId: null` clears the optional `threads.repositoryId` field;
 * Convex `patch` accepts `undefined` to drop optional fields, which is what
 * we forward.
 */
export const setThreadRepository = mutation({
  args: {
    threadId: v.id("threads"),
    repositoryId: v.union(v.id("repositories"), v.null()),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });

    if (args.repositoryId !== null) {
      await requireOwnedDoc(ctx, args.repositoryId, {
        notFoundMessage: "Repository not found.",
      });
      await touchRepositoryLastAccessed(ctx, { repositoryId: args.repositoryId });
      // Two transitions land in this branch:
      //   1. no-repo  → has-repo: the thread is in `discuss`. Attaching a
      //      repo lifts the thread into the repo default (`library`).
      //   2. repo-A   → repo-B: preserve the user's chosen mode.
      const nextMode = thread.repositoryId ? thread.mode : getDefaultThreadMode(true);
      const previousRepositoryId = thread.repositoryId;
      const swappedFromRepositoryId =
        previousRepositoryId && previousRepositoryId !== args.repositoryId ? previousRepositoryId : undefined;
      await ctx.db.patch(args.threadId, {
        repositoryId: args.repositoryId,
        mode: nextMode,
      });
      return {
        repositoryId: args.repositoryId,
        mode: nextMode,
        ...(swappedFromRepositoryId ? { swappedFromRepositoryId } : {}),
      };
    }

    // Detach atomically: dropping the repository while resetting the
    // persisted mode keeps the thread in the same repo-less default state
    // as `createThread`. A detached thread lives under the repoless
    // `/chat/:threadId` surface. Also clear the grounding defaults — a
    // no-repo thread cannot satisfy Library or Sandbox grounding.
    const detachedMode = getDefaultThreadMode(false);
    await ctx.db.patch(args.threadId, {
      repositoryId: undefined,
      mode: detachedMode,
      defaultGroundLibrary: false,
      defaultGroundSandbox: false,
    });
    return { repositoryId: null as null, mode: detachedMode };
  },
});

/**
 * Toggle a thread's pinned state. Pinning stamps `pinnedAt` with the
 * current wall-clock so `listThreads` can both detect the pinned state
 * (via the `by_repositoryId_and_pinnedAt` range filter) and order pinned
 * rows by recency-of-pin. Unpinning drops the field (patch with
 * `pinnedAt: undefined`) so the row falls out of the pinned-range query
 * and back into the regular recency tail.
 */
export const setThreadPinned = mutation({
  args: {
    threadId: v.id("threads"),
    pinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    await ctx.db.patch(args.threadId, {
      pinnedAt: args.pinned ? Date.now() : undefined,
    });
  },
});

export const deleteThread = mutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
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
    // Drain orphan tool-call events ahead of deleting the message,
    // otherwise the live `getMessageToolCallEvents` subscription would
    // hold rows referencing a now-missing parent. Bounded per-message
    // (≤ MAX_TOOL_CALL_EVENTS_PER_MESSAGE by construction).
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
      // Same drain-then-delete order as `deleteThread` so the
      // re-scheduled cleanup pass doesn't outlive the events table. Reversing
      // this would leave orphaned `messageToolCallEvents` rows once the
      // parent message is gone, which then can't be reached by the
      // by_messageId drain on the next pass.
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
    for (const stream of streams) {
      if (totalChunksProcessed >= MAX_STREAM_CHUNKS_PER_PASS) {
        await ctx.scheduler.runAfter(0, internal.chat.threads.cleanupOrphanedMessageStreams, {
          threadId: args.threadId,
        });
        return;
      }
      totalChunksProcessed += await deleteMessageStreamState(ctx, stream._id);
    }

    if (streams.length === 500) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.cleanupOrphanedMessageStreams, {
        threadId: args.threadId,
      });
    }
  },
});
