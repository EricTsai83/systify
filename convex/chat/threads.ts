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

/**
 * Three-mode restructure — upper bound on the per-thread Ask scope filter.
 * 20 ids keeps the filter lookup small (the scope filter is applied during
 * RAG retrieval, where each candidate chunk is filtered by `artifactId IN
 * scope`). A workspace with more than 20 artifacts the user wants to scope
 * the question to almost certainly wants the unbounded "whole workspace"
 * variant (empty array) instead.
 */
const ASK_THREAD_MAX_ARTIFACT_CONTEXT = 20;

export const listThreads = query({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    workspaceId: v.optional(v.id("workspaces")),
    /**
     * Three-mode restructure — service-mode-scoped listing. Each service
     * mode (Discuss / Library Ask / Lab) owns its own thread slice, so
     * the sidebar query forwards the active mode and the backend serves
     * only the matching rows. Without this filter, a Library Ask thread
     * would surface in the Discuss sidebar (and the discuss-page
     * landing's most-recent-thread redirect would bounce the user into a
     * mode-mismatched chat). Only the workspace-scoped path honours the
     * filter; repo / owner listings are admin / debug paths and stay
     * mode-blind.
     */
    mode: v.optional(
      v.union(v.literal("discuss"), v.literal("docs"), v.literal("sandbox"), v.literal("ask"), v.literal("lab")),
    ),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);

    // Workspace-scoped listing takes priority over repo-scoped listing.
    if (args.workspaceId) {
      const workspace = await ctx.db.get(args.workspaceId);
      if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
        return [];
      }
      // Pinning preserves visibility independent of recency, so pinned rows
      // are fetched through a dedicated index range (`pinnedAt > 0` filters
      // out unpinned rows whose optional field is unset) instead of being
      // hoped to fall inside the top-N by lastMessageAt. The unpinned tail
      // is then truncated with the same 20-row cap as before; pinned rows
      // are capped separately so a pathological pin-all user can't blow
      // the query budget.
      const workspaceId = args.workspaceId;
      const mode = args.mode;
      const pinned = await ctx.db
        .query("threads")
        .withIndex("by_workspaceId_and_pinnedAt", (q) => q.eq("workspaceId", workspaceId).gt("pinnedAt", 0))
        .order("desc")
        .take(20);
      // Mode-scoped recent listing uses the compound (workspaceId, mode,
      // lastMessageAt) index so the equality filter on mode does not need
      // a `.filter()` clause; without that index Convex would either scan
      // the full workspace + mode set (no `.take(20)` short-circuit on a
      // sorted result) or rely on `.filter()` (forbidden by the project
      // guidelines). When no mode is supplied, fall back to the legacy
      // workspace-only index so existing callers stay on the same plan.
      const recent = mode
        ? await ctx.db
            .query("threads")
            .withIndex("by_workspaceId_mode_and_lastMessageAt", (q) =>
              q.eq("workspaceId", workspaceId).eq("mode", mode),
            )
            .order("desc")
            .take(20)
        : await ctx.db
            .query("threads")
            .withIndex("by_workspaceId_and_lastMessageAt", (q) => q.eq("workspaceId", workspaceId))
            .order("desc")
            .take(20);
      // Pinned rows are bounded at 20 and may include threads of any mode
      // (the user can pin across modes). Drop the off-mode pins post-query
      // so the sidebar in, say, Discuss never surfaces a pinned Ask thread
      // — pinning is a per-mode affordance from the user's point of view.
      const pinnedForMode = mode ? pinned.filter((thread) => thread.mode === mode) : pinned;
      const pinnedIds = new Set(pinnedForMode.map((thread) => thread._id));
      return [...pinnedForMode, ...recent.filter((thread) => !pinnedIds.has(thread._id))];
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
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }
    return thread;
  },
});

export const createThread = mutation({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    workspaceId: v.optional(v.id("workspaces")),
    title: v.optional(v.string()),
    mode: v.optional(
      v.union(v.literal("discuss"), v.literal("docs"), v.literal("sandbox"), v.literal("ask"), v.literal("lab")),
    ),
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

    // `docs`, `sandbox`, `ask`, and `lab` all require an attached repo; the
    // resolver's capability ladder already prevents the UI from offering
    // them in the no-repo case, but we re-check here so direct callers
    // (and racing UI states) can't bypass it. We do NOT enforce
    // sandbox-ready at thread creation; `sendMessage` re-validates at the
    // actual send moment.
    const requestedMode = args.mode ?? getDefaultThreadMode(!!repositoryId);
    const mode = requestedMode === "sandbox" ? "lab" : requestedMode === "docs" ? "ask" : requestedMode;

    if ((mode === "ask" || mode === "lab") && !repositoryId) {
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

    const threadId = await ctx.db.insert("threads", {
      workspaceId,
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title,
      mode,
      lastMessageAt: Date.now(),
    });
    // Return the resolved mode alongside the id so the client can route
    // straight to the canonical mode-aware URL without an extra `db.get`
    // or duplicating the `requestedMode → mode` normalisation rules
    // above. Callers that only need the id can ignore the field.
    return { _id: threadId, mode };
  },
});

/**
 * Three-mode restructure — create a Library Ask thread bound to a
 * workspace. Distinct from {@link createThread} because Ask carries a
 * scope-filter (`artifactContext`) and never accepts a `mode` other than
 * `"ask"`; routing it through `createThread` would smear that distinction
 * across the legacy mode validator.
 *
 * Phase 1 widens the schema and ships the mutation; the frontend does not
 * call it yet (Library Ask UI lands in Phase 2). Wiring the mutation early
 * lets contract tests (Phase 1.7 verification) assert that `mode === "ask"`
 * survives a round-trip through the validator and the persistence layer
 * before the read path goes live.
 */
export const createAskThread = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    artifactContext: v.optional(v.array(v.id("artifacts"))),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Workspace not found.");
    }
    if (!workspace.repositoryId) {
      throw new Error("Library Ask requires a workspace bound to a repository.");
    }

    const artifactContext = args.artifactContext ?? [];
    if (artifactContext.length > ASK_THREAD_MAX_ARTIFACT_CONTEXT) {
      // Validate up-front so callers get a single, actionable error
      // instead of a runtime fail later in the RAG retriever.
      throw new Error(
        `Library Ask scope filter accepts at most ${ASK_THREAD_MAX_ARTIFACT_CONTEXT} artifacts (got ${artifactContext.length}).`,
      );
    }

    // Validate every artifact id in the scope filter at thread-create time:
    //   - artifact must exist;
    //   - viewer must own it;
    //   - artifact must live in the same workspace's repo (cross-repo
    //     scoping would either return zero hits or — worse — leak chunks
    //     from another workspace through the vector index filter).
    for (const artifactId of artifactContext) {
      const artifact = await ctx.db.get(artifactId);
      if (!artifact || artifact.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Artifact not found.");
      }
      if (artifact.repositoryId !== workspace.repositoryId) {
        throw new Error("Artifact is not in this workspace's repository.");
      }
    }

    const threadId = await ctx.db.insert("threads", {
      workspaceId: args.workspaceId,
      repositoryId: workspace.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title: args.title ?? "Library Ask",
      mode: "ask",
      lastMessageAt: Date.now(),
      // Stored as `undefined` when empty so the "whole workspace" sentinel
      // and a deliberately-empty user filter both share one shape.
      artifactContext: artifactContext.length > 0 ? artifactContext : undefined,
    });
    // Mirror `createThread`'s return shape (`{ _id, mode }`) so callers can
    // route to the canonical mode-aware URL uniformly regardless of which
    // mutation created the thread.
    return { _id: threadId, mode: "ask" as const };
  },
});

/**
 * Attach, swap, or detach the repository bound to a thread.
 *
 * Two of the three transitions have a UI entry point, both from the TopBar:
 *   - **attach** (no-repo → repo) via `AttachRepoMenu`;
 *   - **swap** (repo-A → repo-B) via `SwapThreadRepositoryControl`, gated
 *     behind an explicit confirmation dialog.
 * **Detach** has no UI affordance — to drop a repo, users start a new thread.
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
      const defaultRepoMode = getDefaultThreadMode(true);
      const nextMode = thread.repositoryId
        ? thread.mode === "sandbox"
          ? "lab"
          : thread.mode === "docs"
            ? "ask"
            : thread.mode
        : defaultRepoMode === "docs"
          ? "ask"
          : defaultRepoMode;
      const previousRepositoryId = thread.repositoryId;
      const swappedFromRepositoryId =
        previousRepositoryId && previousRepositoryId !== args.repositoryId ? previousRepositoryId : undefined;
      await ctx.db.patch(args.threadId, {
        repositoryId: args.repositoryId,
        workspaceId,
        mode: nextMode,
      });
      return {
        repositoryId: args.repositoryId,
        workspaceId,
        mode: nextMode,
        ...(swappedFromRepositoryId ? { swappedFromRepositoryId } : {}),
      };
    }

    // Detach atomically: dropping the repository while resetting the persisted
    // mode keeps the thread in the same repo-less default state as
    // `createThread`, so a racing `sendMessage` call never sees a stale
    // repo-dependent mode like `docs` / `sandbox`.
    const detachedMode = getDefaultThreadMode(false);
    const workspaceId = await findHomeWorkspaceId(ctx, identity.tokenIdentifier);
    await ctx.db.patch(args.threadId, {
      workspaceId: workspaceId ?? undefined,
      repositoryId: undefined,
      mode: detachedMode,
    });
    return { repositoryId: null as null, workspaceId, mode: detachedMode };
  },
});

/**
 * Toggle a thread's pinned state. Pinning stamps `pinnedAt` with the
 * current wall-clock so `listThreads` can both detect the pinned state
 * (via the `by_workspaceId_and_pinnedAt` range filter) and order pinned
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
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }
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
