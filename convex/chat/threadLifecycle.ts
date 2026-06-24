import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ChatMode } from "../lib/chatMode";
import { getDefaultThreadMode } from "../lib/chatMode";
import { MAX_STREAM_CHUNKS_PER_PASS } from "../lib/constants";
import { requireOwnedDoc } from "../lib/ownedDocs";
import { requireActiveRepositoryForViewer } from "../lib/repositoryAccess";
import { touchRepositoryLastAccessed } from "../lib/repositoryPalette";
import { isRepolessAgentThread } from "../lib/repolessThreadKind";
import { NEW_THREAD_DEFAULT_TITLE } from "../lib/threadDefaults";
import { recordThreadRemovedFromArchiveScope, recordThreadArchivedInScope } from "./archiveState";
import {
  drainThreadSharesByThreadId,
  patchThreadSharesRepositoryByThreadId,
  recordThreadCreatedInHistory,
  recordThreadMovedInHistory,
  recordThreadRemovedFromHistory,
} from "./historyState";
import { deleteMessageStreamState } from "./streamStore";
import { drainMessageToolCallEvents } from "./toolCallEventStore";

export const AGENT_ROLE_MAX_LENGTH = 120;
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 3000;
export const SINGLE_TURN_RESET_MESSAGE_BATCH_SIZE = 200;
export const SINGLE_TURN_RESET_STREAM_BATCH_SIZE = 200;
export const ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE = 10;
export const THREAD_DELETE_MESSAGE_BATCH_SIZE = 500;
export const THREAD_DELETE_STREAM_BATCH_SIZE = 500;
export const ASK_THREAD_MAX_ARTIFACT_CONTEXT = 20;

export type ThreadMessageArtifactDrainResult = {
  messagesRemain: boolean;
  streamsRemain: boolean;
  streamBudgetExhausted: boolean;
};

type ThreadShareRepositoryScopeUpdateArgs = {
  threadId: Id<"threads">;
  fromRepositoryId?: Id<"repositories">;
};

type CreateThreadLifecycleArgs = {
  ownerTokenIdentifier: string;
  repositoryId?: Id<"repositories">;
  title?: string;
  mode?: ChatMode;
};

type CreateLibraryAskThreadLifecycleArgs = {
  ownerTokenIdentifier: string;
  repositoryId: Id<"repositories">;
  artifactContext?: Id<"artifacts">[];
  title?: string;
};

type SetThreadRepositoryResult =
  | {
      repositoryId: Id<"repositories">;
      mode: ChatMode;
      swappedFromRepositoryId?: Id<"repositories">;
    }
  | {
      repositoryId: null;
      mode: ChatMode;
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
    agentRole: normalizeAgentProfileField(args.agentRole, AGENT_ROLE_MAX_LENGTH, "Agent name"),
    agentInstructions: normalizeAgentProfileField(
      args.agentInstructions,
      AGENT_INSTRUCTIONS_MAX_LENGTH,
      "Agent instructions",
    ),
  };
}

export function resolveRepolessAgentEnabled(args: {
  agentEnabled?: boolean;
  agentRole?: string;
  agentInstructions?: string;
}): boolean {
  return isRepolessAgentThread(args);
}

export async function createThreadLifecycle(
  ctx: MutationCtx,
  args: CreateThreadLifecycleArgs,
): Promise<{ _id: Id<"threads">; mode: ChatMode }> {
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

  const threadId = await ctx.db.insert("threads", {
    repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    title: args.title ?? NEW_THREAD_DEFAULT_TITLE,
    mode,
    lastMessageAt: Date.now(),
  });
  const thread = (await ctx.db.get(threadId))!;
  await recordThreadCreatedInHistory(ctx, thread);
  return { _id: threadId, mode };
}

export async function createLibraryAskThreadLifecycle(
  ctx: MutationCtx,
  args: CreateLibraryAskThreadLifecycleArgs,
): Promise<{ _id: Id<"threads">; mode: "library" }> {
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
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    title: args.title ?? NEW_THREAD_DEFAULT_TITLE,
    mode: "library",
    lastMessageAt: Date.now(),
    artifactContext: artifactContext.length > 0 ? artifactContext : undefined,
  });
  const thread = (await ctx.db.get(threadId))!;
  await recordThreadCreatedInHistory(ctx, thread);
  return { _id: threadId, mode: "library" };
}

export async function setThreadRepositoryLifecycle(
  ctx: MutationCtx,
  args: {
    thread: Doc<"threads">;
    repositoryId: Id<"repositories"> | null;
  },
): Promise<SetThreadRepositoryResult> {
  const thread = args.thread;
  if (args.repositoryId !== null) {
    await requireActiveRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
      notFoundMessage: "Repository not found.",
      archivedMessage: "This repository is archived. Restore it to continue chatting.",
    });
    await touchRepositoryLastAccessed(ctx, { repositoryId: args.repositoryId });
    const nextMode = thread.repositoryId ? thread.mode : getDefaultThreadMode(true);
    const previousRepositoryId = thread.repositoryId;
    const swappedFromRepositoryId =
      previousRepositoryId && previousRepositoryId !== args.repositoryId ? previousRepositoryId : undefined;
    await ctx.db.patch(thread._id, {
      repositoryId: args.repositoryId,
      mode: nextMode,
      singleTurnEnabled: undefined,
      singleTurnResetPending: undefined,
      agentEnabled: undefined,
      agentRole: undefined,
      agentInstructions: undefined,
      agentUpdatedAt: undefined,
      ...(swappedFromRepositoryId ? { artifactContext: undefined } : {}),
    });
    const updatedThread = (await ctx.db.get(thread._id))!;
    await recordThreadMovedInHistory(ctx, {
      previousThread: thread,
      updatedThread,
    });
    const shareRowsRemain = await patchThreadSharesRepositoryByThreadId(ctx, {
      threadId: thread._id,
      fromRepositoryId: previousRepositoryId,
      repositoryId: updatedThread.repositoryId,
    });
    if (shareRowsRemain) {
      await scheduleThreadShareRepositoryScopeUpdate(ctx, {
        threadId: thread._id,
        fromRepositoryId: previousRepositoryId,
      });
    }
    return {
      repositoryId: args.repositoryId,
      mode: nextMode,
      ...(swappedFromRepositoryId ? { swappedFromRepositoryId } : {}),
    };
  }

  const detachedMode = getDefaultThreadMode(false);
  await ctx.db.patch(thread._id, {
    repositoryId: undefined,
    mode: detachedMode,
    defaultGroundLibrary: false,
    defaultGroundSandbox: false,
    artifactContext: undefined,
  });
  const updatedThread = (await ctx.db.get(thread._id))!;
  await recordThreadMovedInHistory(ctx, {
    previousThread: thread,
    updatedThread,
  });
  const shareRowsRemain = await patchThreadSharesRepositoryByThreadId(ctx, {
    threadId: thread._id,
    fromRepositoryId: thread.repositoryId,
    repositoryId: updatedThread.repositoryId,
  });
  if (shareRowsRemain) {
    await scheduleThreadShareRepositoryScopeUpdate(ctx, {
      threadId: thread._id,
      fromRepositoryId: thread.repositoryId,
    });
  }
  return { repositoryId: null, mode: detachedMode };
}

export async function continueThreadShareRepositoryScopeUpdateLifecycle(
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

export async function updateRepolessThreadAgentProfileLifecycle(
  ctx: MutationCtx,
  args: {
    thread: Doc<"threads">;
    agentEnabled?: boolean;
    singleTurnEnabled: boolean;
    agentRole?: string;
    agentInstructions?: string;
  },
): Promise<void> {
  const thread = args.thread;
  if (thread.repositoryId !== undefined) {
    throw new Error("Agent Profile is only supported for repoless chat threads.");
  }

  const profile = normalizeAgentProfile(args);
  const nextAgentEnabled =
    args.agentEnabled ?? (profile.agentRole !== undefined || profile.agentInstructions !== undefined);
  const enablingSingleTurn = thread.singleTurnEnabled !== true && args.singleTurnEnabled === true;
  const agentNameChanged = (thread.agentRole ?? undefined) !== profile.agentRole;
  const agentModeChanged = resolveRepolessAgentEnabled(thread) !== nextAgentEnabled;
  let resetPending = thread.singleTurnResetPending;
  if (enablingSingleTurn) {
    const result = await drainThreadMessageArtifacts(ctx, {
      threadId: thread._id,
      maxMessages: SINGLE_TURN_RESET_MESSAGE_BATCH_SIZE,
      maxStreams: SINGLE_TURN_RESET_STREAM_BATCH_SIZE,
    });
    resetPending = result.messagesRemain || result.streamsRemain || result.streamBudgetExhausted ? true : undefined;
  }

  await ctx.db.patch(thread._id, {
    agentEnabled: nextAgentEnabled,
    singleTurnEnabled: args.singleTurnEnabled,
    singleTurnResetPending: resetPending,
    ...(enablingSingleTurn && resetPending !== true ? { lastAssistantMessageAt: undefined } : {}),
    agentRole: profile.agentRole,
    agentInstructions: profile.agentInstructions,
    agentUpdatedAt: Date.now(),
    ...(agentNameChanged || agentModeChanged
      ? {
          title: nextAgentEnabled ? (profile.agentRole ?? NEW_THREAD_DEFAULT_TITLE) : NEW_THREAD_DEFAULT_TITLE,
          userEditedTitle: undefined,
        }
      : {}),
  });

  if (resetPending === true) {
    await scheduleRepolessSingleTurnReset(ctx, { threadId: thread._id });
  }
}

export async function continueRepolessSingleTurnResetLifecycle(
  ctx: MutationCtx,
  args: { threadId: Id<"threads"> },
): Promise<void> {
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
    await scheduleRepolessSingleTurnReset(ctx, args);
    return;
  }
  await ctx.db.patch(args.threadId, { singleTurnResetPending: undefined, lastAssistantMessageAt: undefined });
}

export async function resetSingleTurnThreadForNextTurn(
  ctx: MutationCtx,
  args: { threadId: Id<"threads"> },
): Promise<{ resetPending: true } | { resetPending: false }> {
  const result = await drainThreadMessageArtifacts(ctx, {
    threadId: args.threadId,
    maxMessages: THREAD_DELETE_MESSAGE_BATCH_SIZE,
    maxStreams: THREAD_DELETE_STREAM_BATCH_SIZE,
  });
  if (result.messagesRemain || result.streamsRemain || result.streamBudgetExhausted) {
    await ctx.db.patch(args.threadId, { singleTurnResetPending: true });
    await scheduleRepolessSingleTurnReset(ctx, args);
    return { resetPending: true };
  }
  await ctx.db.patch(args.threadId, { lastAssistantMessageAt: undefined });
  return { resetPending: false };
}

export async function restoreArchivedThreadsForRepositoryScopeLifecycle(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | undefined;
  },
): Promise<void> {
  const threads = await loadArchivedThreadsForRepositoryScope(ctx, {
    ...args,
    limit: ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE,
  });

  for (const thread of threads) {
    await restoreArchivedThreadLifecycle(ctx, { thread });
  }

  if (threads.length === ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.chat.threads.restoreArchivedThreadsForRepositoryContinuation, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId ?? null,
    });
  }
}

export async function deleteArchivedThreadsForRepositoryScopeLifecycle(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | undefined;
  },
): Promise<void> {
  const threads = await loadArchivedThreadsForRepositoryScope(ctx, {
    ...args,
    limit: ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE,
  });

  for (const thread of threads) {
    await deleteThreadLifecycle(ctx, { threadId: thread._id });
  }

  if (threads.length === ARCHIVED_THREAD_BULK_MUTATION_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.chat.threads.deleteArchivedThreadsForRepositoryContinuation, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId ?? null,
    });
  }
}

export async function archiveThreadLifecycle(ctx: MutationCtx, args: { thread: Doc<"threads"> }): Promise<void> {
  if (args.thread.deletionRequestedAt !== undefined) {
    throw new Error("Thread not found.");
  }
  if (args.thread.archivedAt !== undefined) {
    return;
  }
  await ctx.db.patch(args.thread._id, { archivedAt: Date.now(), pinnedAt: undefined });
  await recordThreadRemovedFromHistory(ctx, args.thread);
  const archived = (await ctx.db.get(args.thread._id))!;
  await recordThreadArchivedInScope(ctx, archived);
}

export async function restoreArchivedThreadLifecycle(
  ctx: MutationCtx,
  args: { thread: Doc<"threads"> },
): Promise<void> {
  if (args.thread.deletionRequestedAt !== undefined) {
    throw new Error("Thread not found.");
  }
  if (args.thread.archivedAt === undefined) {
    return;
  }
  await recordThreadRemovedFromArchiveScope(ctx, args.thread);
  await ctx.db.patch(args.thread._id, { archivedAt: undefined });
  const restored = (await ctx.db.get(args.thread._id))!;
  await recordThreadCreatedInHistory(ctx, restored);
}

export async function deleteArchivedThreadLifecycle(ctx: MutationCtx, args: { thread: Doc<"threads"> }): Promise<void> {
  if (args.thread.archivedAt === undefined && args.thread.deletionRequestedAt === undefined) {
    throw new Error("Archive the thread before permanently deleting it.");
  }
  if (args.thread.archivedAt !== undefined) {
    await recordThreadRemovedFromArchiveScope(ctx, args.thread);
  }
  await deleteThreadLifecycle(ctx, {
    threadId: args.thread._id,
    archiveScopeAlreadyRemoved: args.thread.archivedAt !== undefined,
  });
}

export async function deleteThreadLifecycle(
  ctx: MutationCtx,
  args: { threadId: Id<"threads">; archiveScopeAlreadyRemoved?: boolean },
): Promise<void> {
  const thread = await ctx.db.get(args.threadId);
  if (!thread) {
    return;
  }

  if (thread.deletionRequestedAt === undefined) {
    await ctx.db.patch(args.threadId, { deletionRequestedAt: Date.now() });
    if (thread.archivedAt === undefined) {
      await recordThreadRemovedFromHistory(ctx, thread);
    } else if (args.archiveScopeAlreadyRemoved !== true) {
      await recordThreadRemovedFromArchiveScope(ctx, thread);
    }
  }

  const sharesStillRemain = await drainThreadSharesByThreadId(ctx, args.threadId);
  if (sharesStillRemain) {
    await scheduleThreadDelete(ctx, args);
    return;
  }

  const drainResult = await drainThreadMessageArtifacts(ctx, {
    threadId: args.threadId,
    maxMessages: THREAD_DELETE_MESSAGE_BATCH_SIZE,
    maxStreams: THREAD_DELETE_STREAM_BATCH_SIZE,
  });

  if (drainResult.messagesRemain) {
    await scheduleThreadDelete(ctx, args);
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

export async function cleanupOrphanedMessagesLifecycle(
  ctx: MutationCtx,
  args: { threadId: Id<"threads"> },
): Promise<void> {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
    .take(THREAD_DELETE_MESSAGE_BATCH_SIZE);
  for (const message of messages) {
    await drainMessageToolCallEvents(ctx, message._id);
    await ctx.db.delete(message._id);
  }
  if (messages.length === THREAD_DELETE_MESSAGE_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.chat.threads.cleanupOrphanedMessages, {
      threadId: args.threadId,
    });
  }
}

export async function cleanupOrphanedMessageStreamsLifecycle(
  ctx: MutationCtx,
  args: { threadId: Id<"threads"> },
): Promise<void> {
  const streams = await ctx.db
    .query("messageStreams")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
    .take(THREAD_DELETE_STREAM_BATCH_SIZE);

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

  if (streams.length === THREAD_DELETE_STREAM_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.chat.threads.cleanupOrphanedMessageStreams, {
      threadId: args.threadId,
    });
  }
}

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

async function loadArchivedThreadsForRepositoryScope(
  ctx: MutationCtx,
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

async function scheduleThreadShareRepositoryScopeUpdate(
  ctx: MutationCtx,
  args: ThreadShareRepositoryScopeUpdateArgs,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.chat.threads.continueThreadShareRepositoryScopeUpdate, {
    threadId: args.threadId,
    ...(args.fromRepositoryId !== undefined ? { fromRepositoryId: args.fromRepositoryId } : {}),
  });
}

async function scheduleRepolessSingleTurnReset(ctx: MutationCtx, args: { threadId: Id<"threads"> }): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.chat.threads.continueRepolessSingleTurnReset, args);
}

async function scheduleThreadDelete(ctx: MutationCtx, args: { threadId: Id<"threads"> }): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.chat.threads.deleteThreadContinuation, args);
}
