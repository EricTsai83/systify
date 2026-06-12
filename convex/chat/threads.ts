import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import { chatModeValidator, getDefaultThreadMode } from "../lib/chatMode";
import { loadOwnedDoc, requireOwnedDoc } from "../lib/ownedDocs";
import { requireActiveRepositoryForViewer } from "../lib/repositoryAccess";
import { MAX_RENAME_TITLE_LENGTH, NEW_THREAD_DEFAULT_TITLE } from "../lib/threadDefaults";
import { MAX_STREAM_CHUNKS_PER_PASS } from "../lib/constants";
import { touchRepositoryLastAccessed } from "../lib/repositoryPalette";
import { deleteMessageStreamState } from "./streamStore";
import { drainMessageToolCallEvents } from "./toolCallEventStore";
import {
  drainThreadSharesByThreadId,
  patchThreadSharesRepositoryByThreadId,
  recordThreadCreatedInHistory,
  recordThreadMovedInHistory,
  recordThreadRemovedFromHistory,
} from "./historyState";
import { loadActiveOwnedThread, requireActiveOwnedThread } from "./threadAccess";
import { recordThreadArchivedInScope, recordThreadRemovedFromArchiveScope } from "./archiveState";

type ArchivedThreadRepositorySummary = {
  _id: Id<"repositories">;
  sourceRepoFullName: string;
} | null;

type ThreadShareRepositoryScopeUpdateArgs = {
  threadId: Id<"threads">;
  fromRepositoryId?: Id<"repositories">;
};

/**
 * Upper bound on the per-thread Ask scope filter. 20 ids keeps the filter
 * lookup small (the scope filter is applied during RAG retrieval, where
 * each candidate chunk is filtered by `artifactId IN scope`). A repository
 * with more than 20 artifacts the user wants to scope the question to
 * almost certainly wants the unbounded "whole repository" variant (empty
 * array) instead.
 */
const ASK_THREAD_MAX_ARTIFACT_CONTEXT = 20;
const ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE = 10;
const OWNER_THREAD_ID_PROBE_LIMIT = 200;
export const AGENT_ROLE_MAX_LENGTH = 120;
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 3000;
const SINGLE_TURN_RESET_MESSAGE_BATCH_SIZE = 200;
const SINGLE_TURN_RESET_STREAM_BATCH_SIZE = 200;

type ThreadMessageArtifactDrainResult = {
  messagesRemain: boolean;
  streamsRemain: boolean;
  streamBudgetExhausted: boolean;
};

function normalizeAgentProfileField(value: string | undefined, maxLength: number, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

export function normalizeAgentProfile(args: { agentRole?: string; agentInstructions?: string }): {
  agentRole?: string;
  agentInstructions?: string;
} {
  return {
    agentRole: normalizeAgentProfileField(args.agentRole, AGENT_ROLE_MAX_LENGTH, "Agent role"),
    agentInstructions: normalizeAgentProfileField(
      args.agentInstructions,
      AGENT_INSTRUCTIONS_MAX_LENGTH,
      "Agent instructions",
    ),
  };
}

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
    singleTurnEnabled: v.boolean(),
    agentRole: v.optional(v.string()),
    agentInstructions: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await requireActiveOwnedThread(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    if (thread.repositoryId !== undefined) {
      throw new Error("Agent Profile is only supported for repoless chat threads.");
    }

    const profile = normalizeAgentProfile(args);
    const enablingSingleTurn = thread.singleTurnEnabled !== true && args.singleTurnEnabled === true;
    let resetPending = thread.singleTurnResetPending;
    if (enablingSingleTurn) {
      const result = await drainThreadMessageArtifacts(ctx, {
        threadId: args.threadId,
        maxMessages: SINGLE_TURN_RESET_MESSAGE_BATCH_SIZE,
        maxStreams: SINGLE_TURN_RESET_STREAM_BATCH_SIZE,
      });
      resetPending = result.messagesRemain || result.streamsRemain || result.streamBudgetExhausted ? true : undefined;
    }

    await ctx.db.patch(args.threadId, {
      singleTurnEnabled: args.singleTurnEnabled,
      singleTurnResetPending: resetPending,
      agentRole: profile.agentRole,
      agentInstructions: profile.agentInstructions,
      agentUpdatedAt: Date.now(),
    });

    if (resetPending === true) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.continueRepolessSingleTurnReset, {
        threadId: args.threadId,
      });
    }
  },
});

export const continueRepolessSingleTurnReset = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.deletionRequestedAt !== undefined || thread.singleTurnResetPending !== true) {
      return;
    }
    if (thread.repositoryId !== undefined || thread.singleTurnEnabled !== true) {
      await ctx.db.patch(args.threadId, { singleTurnResetPending: undefined });
      return;
    }

    const result = await drainThreadMessageArtifacts(ctx, {
      threadId: args.threadId,
      maxMessages: SINGLE_TURN_RESET_MESSAGE_BATCH_SIZE,
      maxStreams: SINGLE_TURN_RESET_STREAM_BATCH_SIZE,
    });
    if (result.messagesRemain || result.streamsRemain || result.streamBudgetExhausted) {
      await ctx.scheduler.runAfter(0, internal.chat.threads.continueRepolessSingleTurnReset, {
        threadId: args.threadId,
      });
      return;
    }
    await ctx.db.patch(args.threadId, { singleTurnResetPending: undefined });
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
    if (repositoryId) {
      await requireActiveRepositoryForViewer(ctx, {
        repositoryId,
        notFoundMessage: "Repository not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
      });
    }

    const title = args.title ?? NEW_THREAD_DEFAULT_TITLE;

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title,
      mode,
      lastMessageAt: Date.now(),
    });
    const thread = (await ctx.db.get(threadId))!;
    await recordThreadCreatedInHistory(ctx, thread);
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
    const { identity } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
      notFoundMessage: "Repository not found.",
      archivedMessage: "This repository is archived. Restore it to continue chatting.",
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
      title: args.title ?? NEW_THREAD_DEFAULT_TITLE,
      mode: "library",
      lastMessageAt: Date.now(),
      artifactContext: artifactContext.length > 0 ? artifactContext : undefined,
    });
    const thread = (await ctx.db.get(threadId))!;
    await recordThreadCreatedInHistory(ctx, thread);
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
    const { doc: thread } = await requireActiveOwnedThread(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });

    if (args.repositoryId !== null) {
      await requireActiveRepositoryForViewer(ctx, {
        repositoryId: args.repositoryId,
        notFoundMessage: "Repository not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
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
        singleTurnEnabled: undefined,
        singleTurnResetPending: undefined,
        agentRole: undefined,
        agentInstructions: undefined,
        agentUpdatedAt: undefined,
        ...(swappedFromRepositoryId ? { artifactContext: undefined } : {}),
      });
      const updatedThread = (await ctx.db.get(args.threadId))!;
      await recordThreadMovedInHistory(ctx, {
        previousThread: thread,
        updatedThread,
      });
      const shareRowsRemain = await patchThreadSharesRepositoryByThreadId(ctx, {
        threadId: args.threadId,
        fromRepositoryId: previousRepositoryId,
        repositoryId: updatedThread.repositoryId,
      });
      if (shareRowsRemain) {
        await scheduleThreadShareRepositoryScopeUpdate(ctx, {
          threadId: args.threadId,
          fromRepositoryId: previousRepositoryId,
        });
      }
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
      artifactContext: undefined,
    });
    const updatedThread = (await ctx.db.get(args.threadId))!;
    await recordThreadMovedInHistory(ctx, {
      previousThread: thread,
      updatedThread,
    });
    const shareRowsRemain = await patchThreadSharesRepositoryByThreadId(ctx, {
      threadId: args.threadId,
      fromRepositoryId: thread.repositoryId,
      repositoryId: updatedThread.repositoryId,
    });
    if (shareRowsRemain) {
      await scheduleThreadShareRepositoryScopeUpdate(ctx, {
        threadId: args.threadId,
        fromRepositoryId: thread.repositoryId,
      });
    }
    return { repositoryId: null as null, mode: detachedMode };
  },
});

export const continueThreadShareRepositoryScopeUpdate = internalMutation({
  args: {
    threadId: v.id("threads"),
    fromRepositoryId: v.optional(v.id("repositories")),
  },
  handler: async (ctx, args) => {
    await continueThreadShareRepositoryScopeUpdateImpl(ctx, args);
  },
});

async function scheduleThreadShareRepositoryScopeUpdate(
  ctx: MutationCtx,
  args: ThreadShareRepositoryScopeUpdateArgs,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.chat.threads.continueThreadShareRepositoryScopeUpdate, {
    threadId: args.threadId,
    ...(args.fromRepositoryId !== undefined ? { fromRepositoryId: args.fromRepositoryId } : {}),
  });
}

async function continueThreadShareRepositoryScopeUpdateImpl(
  ctx: MutationCtx,
  args: ThreadShareRepositoryScopeUpdateArgs,
): Promise<void> {
  const thread = await ctx.db.get(args.threadId);
  if (!thread) {
    return;
  }
  if (thread.repositoryId === args.fromRepositoryId) {
    return;
  }
  const shareRowsRemain = await patchThreadSharesRepositoryByThreadId(ctx, {
    threadId: args.threadId,
    fromRepositoryId: args.fromRepositoryId,
    repositoryId: thread.repositoryId,
  });
  if (shareRowsRemain) {
    await scheduleThreadShareRepositoryScopeUpdate(ctx, args);
  }
}

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

async function loadArchivedThreadsForRepositoryScope(
  ctx: QueryCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | undefined;
    limit: number;
  },
) {
  return await ctx.db
    .query("threads")
    .withIndex("by_owner_repo_delete_archive_lastMsg", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .eq("repositoryId", args.repositoryId)
        .eq("deletionRequestedAt", undefined)
        .gt("archivedAt", 0),
    )
    .order("desc")
    .take(args.limit);
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
  const threads = await loadArchivedThreadsForRepositoryScope(ctx, {
    ...args,
    limit: ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE,
  });

  for (const thread of threads) {
    await recordThreadRemovedFromArchiveScope(ctx, thread);
    await ctx.db.patch(thread._id, { archivedAt: undefined });
    const restored = (await ctx.db.get(thread._id))!;
    await recordThreadCreatedInHistory(ctx, restored);
  }

  if (threads.length === ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.chat.threads.restoreArchivedThreadsForRepositoryContinuation, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId ?? null,
    });
  }
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
  const threads = await loadArchivedThreadsForRepositoryScope(ctx, {
    ...args,
    limit: ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE,
  });

  for (const thread of threads) {
    await deleteThreadImpl(ctx, { threadId: thread._id });
  }

  if (threads.length === ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.chat.threads.deleteArchivedThreadsForRepositoryContinuation, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId ?? null,
    });
  }
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
    if (thread.archivedAt !== undefined) {
      return null;
    }
    await ctx.db.patch(args.threadId, { archivedAt: Date.now(), pinnedAt: undefined });
    await recordThreadRemovedFromHistory(ctx, thread);
    const archived = (await ctx.db.get(args.threadId))!;
    await recordThreadArchivedInScope(ctx, archived);
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
    if (thread.archivedAt === undefined) {
      return null;
    }
    await recordThreadRemovedFromArchiveScope(ctx, thread);
    await ctx.db.patch(args.threadId, { archivedAt: undefined });
    const restored = (await ctx.db.get(args.threadId))!;
    await recordThreadCreatedInHistory(ctx, restored);
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
    if (thread.archivedAt === undefined && thread.deletionRequestedAt === undefined) {
      throw new Error("Archive the thread before permanently deleting it.");
    }
    if (thread.archivedAt !== undefined) {
      await recordThreadRemovedFromArchiveScope(ctx, thread);
    }
    await deleteThreadImpl(ctx, args);
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

export async function drainThreadMessageArtifacts(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    maxMessages: number;
    maxStreams: number;
  },
): Promise<ThreadMessageArtifactDrainResult> {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
    .take(args.maxMessages);
  for (const message of messages) {
    await drainMessageToolCallEvents(ctx, message._id);
    await ctx.db.delete(message._id);
  }

  if (messages.length === args.maxMessages) {
    return {
      messagesRemain: true,
      streamsRemain: true,
      streamBudgetExhausted: false,
    };
  }

  const streams = await ctx.db
    .query("messageStreams")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
    .take(args.maxStreams);

  let totalChunksProcessed = 0;
  let streamBudgetExhausted = false;
  for (const stream of streams) {
    if (totalChunksProcessed >= MAX_STREAM_CHUNKS_PER_PASS) {
      streamBudgetExhausted = true;
      break;
    }
    totalChunksProcessed += await deleteMessageStreamState(ctx, stream._id);
  }

  return {
    messagesRemain: false,
    streamsRemain: streams.length === args.maxStreams || streamBudgetExhausted,
    streamBudgetExhausted,
  };
}

async function deleteThreadImpl(ctx: MutationCtx, args: { threadId: Id<"threads"> }): Promise<void> {
  const thread = await ctx.db.get(args.threadId);
  if (!thread) {
    // Already deleted — either a concurrent caller finished the job or a
    // continuation tick fired after the row went away. Nothing to do.
    return;
  }

  if (thread.deletionRequestedAt === undefined) {
    await ctx.db.patch(args.threadId, { deletionRequestedAt: Date.now() });
    if (thread.archivedAt === undefined) {
      await recordThreadRemovedFromHistory(ctx, thread);
    } else {
      await recordThreadRemovedFromArchiveScope(ctx, thread);
    }
  }

  const sharesStillRemain = await drainThreadSharesByThreadId(ctx, args.threadId);
  if (sharesStillRemain) {
    await ctx.scheduler.runAfter(0, internal.chat.threads.deleteThreadContinuation, args);
    return;
  }

  const drainResult = await drainThreadMessageArtifacts(ctx, {
    threadId: args.threadId,
    maxMessages: 500,
    maxStreams: 500,
  });

  if (drainResult.messagesRemain) {
    // Each iteration above can issue up to MAX_TOOL_CALL_EVENTS_PER_MESSAGE
    // event-delete writes plus the message-row delete; 500 messages can
    // exceed Convex's per-mutation write budget. Mirror the
    // `cleanupOrphanedMessageStreams` checkpoint pattern: schedule a
    // continuation on a fresh transaction and return early so we don't
    // also try to delete streams + the thread row in this mutation.
    await ctx.scheduler.runAfter(0, internal.chat.threads.deleteThreadContinuation, args);
    return;
  }

  if (thread.repositoryId) {
    const repository = await ctx.db.get(thread.repositoryId);
    if (repository && repository.defaultThreadId === args.threadId) {
      await ctx.db.patch(thread.repositoryId, { defaultThreadId: undefined });
    }
  }

  await ctx.db.delete(args.threadId);

  if (drainResult.streamBudgetExhausted || drainResult.streamsRemain) {
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
