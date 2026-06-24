import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import { chatModeValidator } from "../lib/chatMode";
import { loadOwnedDoc, requireOwnedDoc } from "../lib/ownedDocs";
import { requireActiveRepositoryForViewer } from "../lib/repositoryAccess";
import { MAX_RENAME_TITLE_LENGTH } from "../lib/threadDefaults";
import {
  archiveThreadLifecycle,
  cleanupOrphanedMessagesLifecycle,
  cleanupOrphanedMessageStreamsLifecycle,
  continueRepolessSingleTurnResetLifecycle,
  continueThreadShareRepositoryScopeUpdateLifecycle,
  createLibraryAskThreadLifecycle,
  createThreadLifecycle,
  deleteArchivedThreadLifecycle,
  deleteArchivedThreadsForRepositoryScopeLifecycle,
  deleteThreadLifecycle,
  restoreArchivedThreadLifecycle,
  restoreArchivedThreadsForRepositoryScopeLifecycle,
  setThreadRepositoryLifecycle,
  updateRepolessThreadAgentProfileLifecycle,
} from "./threadLifecycle";
import { loadActiveOwnedThread, requireActiveOwnedThread } from "./threadAccess";

type ArchivedThreadRepositorySummary = {
  _id: Id<"repositories">;
  sourceRepoFullName: string;
} | null;

const OWNER_THREAD_ID_PROBE_LIMIT = 200;

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
    const { identity, doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return [];
    }
    const repositoryId = args.repositoryId;
    const ownerTokenIdentifier = identity.tokenIdentifier;
    const mode = args.mode;
    const pinned = mode
      ? await ctx.db
          .query("threads")
          .withIndex("by_owner_repo_mode_delete_archive_pinned", (q) =>
            q
              .eq("ownerTokenIdentifier", ownerTokenIdentifier)
              .eq("repositoryId", repositoryId)
              .eq("mode", mode)
              .eq("deletionRequestedAt", undefined)
              .eq("archivedAt", undefined)
              .gt("pinnedAt", 0),
          )
          .order("desc")
          .take(20)
      : await ctx.db
          .query("threads")
          .withIndex("by_owner_repo_delete_archive_pinned", (q) =>
            q
              .eq("ownerTokenIdentifier", ownerTokenIdentifier)
              .eq("repositoryId", repositoryId)
              .eq("deletionRequestedAt", undefined)
              .eq("archivedAt", undefined)
              .gt("pinnedAt", 0),
          )
          .order("desc")
          .take(20);
    const recent = mode
      ? await ctx.db
          .query("threads")
          .withIndex("by_owner_repo_mode_delete_archive_lastMsg", (q) =>
            q
              .eq("ownerTokenIdentifier", ownerTokenIdentifier)
              .eq("repositoryId", repositoryId)
              .eq("mode", mode)
              .eq("deletionRequestedAt", undefined)
              .eq("archivedAt", undefined),
          )
          .order("desc")
          .take(20)
      : await ctx.db
          .query("threads")
          .withIndex("by_owner_repo_delete_archive_lastMsg", (q) =>
            q
              .eq("ownerTokenIdentifier", ownerTokenIdentifier)
              .eq("repositoryId", repositoryId)
              .eq("deletionRequestedAt", undefined)
              .eq("archivedAt", undefined),
          )
          .order("desc")
          .take(20);
    const pinnedIds = new Set(pinned.map((thread) => thread._id));
    return [...pinned, ...recent.filter((thread) => !pinnedIds.has(thread._id))];
  },
});

/**
 * Repoless threads — chats not bound to any repository, surfaced in the
 * repoless shell's "Chats" sidebar section. Always Discuss mode by
 * construction (Library requires an attached repository).
 *
 * Two range reads merged: pinned-first via the active repoless pin index
 * (ordered by pin recency), then the rest via the active repoless
 * last-message index.
 * Pinned rows survive even when 20+ more recent unpinned threads exist —
 * matches `listThreads`' repo-bound merge behavior.
 *
 * Both reads pin `repositoryId === undefined` so the range scans only the
 * repoless slice instead of filtering the whole owner table.
 */
export const listRepolessThreads = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    const pinned = await ctx.db
      .query("threads")
      .withIndex("by_owner_repo_delete_archive_pinned", (q) =>
        q
          .eq("ownerTokenIdentifier", identity.tokenIdentifier)
          .eq("repositoryId", undefined)
          .eq("deletionRequestedAt", undefined)
          .eq("archivedAt", undefined)
          .gt("pinnedAt", 0),
      )
      .order("desc")
      .take(20);
    const recent = await ctx.db
      .query("threads")
      .withIndex("by_owner_repo_delete_archive_lastMsg", (q) =>
        q
          .eq("ownerTokenIdentifier", identity.tokenIdentifier)
          .eq("repositoryId", undefined)
          .eq("deletionRequestedAt", undefined)
          .eq("archivedAt", undefined),
      )
      .order("desc")
      .take(20);
    const pinnedIds = new Set(pinned.map((thread) => thread._id));
    return [...pinned, ...recent.filter((thread) => !pinnedIds.has(thread._id))];
  },
});

/**
 * Paginated thread messages, newest page first. The chat UI consumes this
 * via `usePaginatedQuery` so arbitrarily long threads can be browsed
 * end-to-end.
 *
 * The page returned by the server is in **descending** creation-time
 * order (newest first). The client reverses the flattened result set to
 * ascending order before rendering, so a freshly-attached subscription
 * paints the most recent page without any prepend, and "load older"
 * calls extend the rendered list at the top.
 *
 * Stale or unauthorized thread ids return an empty completed page rather
 * than throwing, since this query is used by long-lived subscriptions that
 * can outlive a delete/archive transition.
 */
export const listMessagesPaginated = query({
  args: {
    threadId: v.id("threads"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await loadActiveOwnedThread(ctx, args.threadId);
    if (!thread) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    if (thread.repositoryId) {
      const { doc: repository } = await loadOwnedDoc(ctx, thread.repositoryId);
      if (!repository) {
        return { page: [], isDone: true, continueCursor: "" };
      }
    }

    return await ctx.db
      .query("messages")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

/**
 * Bounded ownership probe for thread-scoped client caches. The caller supplies
 * only ids already present in localStorage, so the read set stays tied to local
 * cache size rather than total thread history.
 */
export const listOwnedThreadIdsById = query({
  args: {
    threadIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"threads">[]> => {
    if (args.threadIds.length > OWNER_THREAD_ID_PROBE_LIMIT) {
      throw new Error(`Too many thread ids to validate. Keep at most ${OWNER_THREAD_ID_PROBE_LIMIT}.`);
    }

    const identity = await requireViewerIdentity(ctx);
    const uniqueIds = new Set<Id<"threads">>();
    for (const rawId of args.threadIds) {
      const threadId = ctx.db.normalizeId("threads", rawId);
      if (!threadId || uniqueIds.has(threadId)) {
        continue;
      }
      const thread = await ctx.db.get(threadId);
      if (thread?.ownerTokenIdentifier === identity.tokenIdentifier && thread.deletionRequestedAt === undefined) {
        uniqueIds.add(threadId);
      }
    }
    return [...uniqueIds];
  },
});

/**
 * Lightweight thread-existence probe. Returns `null` when the thread is
 * missing, archived, deleted, or owned by another viewer so callers can clear
 * stale route state before attaching message subscriptions. The Library page
 * uses it to validate the `?ask=:threadId` URL param; a stale bookmark or a
 * since-deleted thread degrades gracefully instead of crashing the page.
 * Mirrors the artifact-id guard pattern (`artifacts.getById`).
 */
export const getThreadSummary = query({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await loadActiveOwnedThread(ctx, args.threadId);
    return thread;
  },
});

export const updateRepolessThreadAgentProfile = mutation({
  args: {
    threadId: v.id("threads"),
    agentEnabled: v.optional(v.boolean()),
    singleTurnEnabled: v.boolean(),
    agentRole: v.optional(v.string()),
    agentInstructions: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await requireActiveOwnedThread(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    await updateRepolessThreadAgentProfileLifecycle(ctx, { thread, ...args });
  },
});

export const continueRepolessSingleTurnReset = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await continueRepolessSingleTurnResetLifecycle(ctx, args);
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
    return await createThreadLifecycle(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title: args.title,
      mode: args.mode,
    });
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
    const { identity } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
      notFoundMessage: "Repository not found.",
      archivedMessage: "This repository is archived. Restore it to continue chatting.",
    });
    return await createLibraryAskThreadLifecycle(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      artifactContext: args.artifactContext,
      title: args.title,
    });
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
    const { doc: thread } = await requireActiveOwnedThread(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    return await setThreadRepositoryLifecycle(ctx, { thread, repositoryId: args.repositoryId });
  },
});

export const continueThreadShareRepositoryScopeUpdate = internalMutation({
  args: {
    threadId: v.id("threads"),
    fromRepositoryId: v.optional(v.id("repositories")),
  },
  handler: async (ctx, args) => {
    await continueThreadShareRepositoryScopeUpdateLifecycle(ctx, args);
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
    await requireActiveOwnedThread(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    await ctx.db.patch(args.threadId, {
      pinnedAt: args.pinned ? Date.now() : undefined,
    });
  },
});

async function summarizeArchivedThreadRepository(
  ctx: QueryCtx,
  repositoryId: Id<"repositories"> | undefined,
): Promise<ArchivedThreadRepositorySummary> {
  if (!repositoryId) {
    return null;
  }
  const repository = await ctx.db.get(repositoryId);
  return repository
    ? {
        _id: repository._id,
        sourceRepoFullName: repository.sourceRepoFullName,
      }
    : null;
}

async function requireArchivedThreadRepositoryScope(
  ctx: MutationCtx | QueryCtx,
  args: { repositoryId: Id<"repositories"> | null; ownerTokenIdentifier?: string },
): Promise<Id<"repositories"> | undefined> {
  if (!args.repositoryId) {
    return undefined;
  }
  const repository = await ctx.db.get(args.repositoryId);
  const ownerTokenIdentifier = args.ownerTokenIdentifier;
  if (!repository || (ownerTokenIdentifier && repository.ownerTokenIdentifier !== ownerTokenIdentifier)) {
    throw new Error("Repository not found.");
  }
  return repository._id;
}

export const listArchivedThreads = query({
  args: {
    repositoryId: v.optional(v.union(v.id("repositories"), v.null())),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repositoryId = await requireArchivedThreadRepositoryScope(ctx, {
      repositoryId: args.repositoryId ?? null,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });
    const result =
      args.repositoryId === undefined
        ? await ctx.db
            .query("threads")
            .withIndex("by_ownerTokenIdentifier_and_deletionRequestedAt_and_archivedAt", (q) =>
              q
                .eq("ownerTokenIdentifier", identity.tokenIdentifier)
                .eq("deletionRequestedAt", undefined)
                .gt("archivedAt", 0),
            )
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("threads")
            .withIndex("by_owner_repo_delete_archive_lastMsg", (q) =>
              q
                .eq("ownerTokenIdentifier", identity.tokenIdentifier)
                .eq("repositoryId", repositoryId)
                .eq("deletionRequestedAt", undefined)
                .gt("archivedAt", 0),
            )
            .order("desc")
            .paginate(args.paginationOpts);

    const page = await Promise.all(
      result.page.map(async (thread) => ({
        _id: thread._id,
        repositoryId: thread.repositoryId,
        title: thread.title,
        mode: thread.mode,
        archivedAt: thread.archivedAt!,
        repository: await summarizeArchivedThreadRepository(ctx, thread.repositoryId),
      })),
    );

    return {
      ...result,
      page,
    };
  },
});

export const listArchivedThreadRepositoryScopes = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    const scopes = await ctx.db
      .query("archivedThreadScopes")
      .withIndex("by_ownerTokenIdentifier_and_lastArchivedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .collect();

    const scopeSummaries = await Promise.all(
      scopes.map(async (scope) => {
        if (!scope.repositoryId) {
          return {
            repositoryId: null,
            label: "No repository",
          };
        }
        const repository = await summarizeArchivedThreadRepository(ctx, scope.repositoryId);
        return repository
          ? {
              repositoryId: repository._id,
              label: repository.sourceRepoFullName,
            }
          : null;
      }),
    );

    return scopeSummaries.filter((scope): scope is NonNullable<(typeof scopeSummaries)[number]> => scope !== null);
  },
});

export const restoreArchivedThreadsForRepository = mutation({
  args: {
    repositoryId: v.union(v.id("repositories"), v.null()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repositoryId = await requireArchivedThreadRepositoryScope(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });
    await restoreArchivedThreadsForRepositoryScope(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId,
    });
  },
});

export const restoreArchivedThreadsForRepositoryContinuation = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    repositoryId: v.union(v.id("repositories"), v.null()),
  },
  handler: async (ctx, args) => {
    const repositoryId = await requireArchivedThreadRepositoryScope(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
    });
    await restoreArchivedThreadsForRepositoryScope(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
    });
  },
});

async function restoreArchivedThreadsForRepositoryScope(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | undefined;
  },
) {
  await restoreArchivedThreadsForRepositoryScopeLifecycle(ctx, args);
}

export const deleteArchivedThreadsForRepository = mutation({
  args: {
    repositoryId: v.union(v.id("repositories"), v.null()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repositoryId = await requireArchivedThreadRepositoryScope(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });
    await deleteArchivedThreadsForRepositoryScope(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId,
    });
  },
});

export const deleteArchivedThreadsForRepositoryContinuation = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    repositoryId: v.union(v.id("repositories"), v.null()),
  },
  handler: async (ctx, args) => {
    const repositoryId = await requireArchivedThreadRepositoryScope(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
    });
    await deleteArchivedThreadsForRepositoryScope(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
    });
  },
});

async function deleteArchivedThreadsForRepositoryScope(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | undefined;
  },
) {
  await deleteArchivedThreadsForRepositoryScopeLifecycle(ctx, args);
}

export const archiveThread = mutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    if (thread.deletionRequestedAt !== undefined) {
      throw new Error("Thread not found.");
    }
    await archiveThreadLifecycle(ctx, { thread });
    return null;
  },
});

export const restoreThread = mutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    if (thread.deletionRequestedAt !== undefined) {
      throw new Error("Thread not found.");
    }
    await restoreArchivedThreadLifecycle(ctx, { thread });
    return null;
  },
});

export const deleteArchivedThread = mutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    await deleteArchivedThreadLifecycle(ctx, { thread });
  },
});

export const deleteThread = mutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await requireActiveOwnedThread(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    // Delegate the heavy lifting to the shared helper. The same helper
    // backs `deleteThreadContinuation` (an internal mutation) so we can
    // reschedule across mutations when a single transaction can't fit
    // the full message + stream + tool-event delete budget.
    await deleteThreadLifecycle(ctx, args);
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
    await deleteThreadLifecycle(ctx, args);
  },
});

export const cleanupOrphanedMessages = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await cleanupOrphanedMessagesLifecycle(ctx, args);
  },
});

export const cleanupOrphanedMessageStreams = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await cleanupOrphanedMessageStreamsLifecycle(ctx, args);
  },
});

/**
 * Manual thread rename, driven by the sidebar's inline-edit affordance
 * (double-click the title text, Enter / blur to commit, Esc to cancel).
 *
 * Errors use the structured `ConvexError({ code, message })` shape so
 * `toUserErrorMessage` on the client extracts a clean message from
 * `error.data.message`. A plain `ConvexError(string)` would force the
 * client to fall back to `error.message`, which Convex wraps with
 * transport noise (`[CONVEX M(chat/threads:renameThread)] [Request ID:
 * ...]`) — a poor toast.
 *
 * The autogen path (`generateThreadTitle`) guards against overwriting a
 * renamed thread via `isDefaultTitle` — any non-default title (including a
 * manual rename that happens to equal the autogen output) wins over a
 * late-arriving LLM patch.
 */
export const renameThread = mutation({
  args: {
    threadId: v.id("threads"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveOwnedThread(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    const trimmed = args.title.trim();
    if (trimmed.length === 0) {
      throw new ConvexError({
        code: "INVALID_TITLE",
        message: "Title cannot be empty.",
      });
    }
    if (trimmed.length > MAX_RENAME_TITLE_LENGTH) {
      throw new ConvexError({
        code: "INVALID_TITLE",
        message: `Title must be at most ${MAX_RENAME_TITLE_LENGTH} characters.`,
      });
    }
    await ctx.db.patch(args.threadId, { title: trimmed, userEditedTitle: true });
  },
});
