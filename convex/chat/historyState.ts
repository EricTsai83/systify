import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { CASCADE_BATCH_SIZE } from "../lib/constants";

export const NO_REPOSITORY_HISTORY_GROUP_KEY = "no_repository";
const HISTORY_GROUP_DUPLICATE_REPAIR_LIMIT = 10;

type HistoryRepositoryId = Id<"repositories"> | undefined;

export function getHistoryGroupKey(repositoryId: HistoryRepositoryId): string {
  return repositoryId ? `repository:${repositoryId}` : NO_REPOSITORY_HISTORY_GROUP_KEY;
}

function getVisibleThreadHistoryGroupKey(thread: Doc<"threads">): string | undefined {
  if (thread.deletionRequestedAt !== undefined || thread.archivedAt !== undefined) {
    return undefined;
  }
  return getHistoryGroupKey(thread.repositoryId);
}

async function loadHistoryGroupRows(ctx: MutationCtx, args: { ownerTokenIdentifier: string; groupKey: string }) {
  return await ctx.db
    .query("chatHistoryGroups")
    .withIndex("by_ownerTokenIdentifier_and_groupKey", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("groupKey", args.groupKey),
    )
    .take(HISTORY_GROUP_DUPLICATE_REPAIR_LIMIT);
}

async function normalizeGroupRows(
  ctx: MutationCtx,
  rows: Doc<"chatHistoryGroups">[],
): Promise<Doc<"chatHistoryGroups"> | null> {
  const [primary, ...duplicates] = rows;
  for (const duplicate of duplicates) {
    await ctx.db.delete(duplicate._id);
  }
  return primary ?? null;
}

async function loadLatestVisibleThreadInGroup(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    groupKey: string;
    excludeThreadId?: Id<"threads">;
  },
): Promise<Doc<"threads"> | null> {
  const candidates = await ctx.db
    .query("threads")
    .withIndex("by_ownerTokenIdentifier_and_historyGroupKey_and_lastMessageAt", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("historyGroupKey", args.groupKey),
    )
    .order("desc")
    .take(args.excludeThreadId ? 2 : 1);

  return (
    candidates.find(
      (thread) => thread._id !== args.excludeThreadId && getVisibleThreadHistoryGroupKey(thread) === args.groupKey,
    ) ?? null
  );
}

async function loadHistoryGroup(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; groupKey: string },
): Promise<Doc<"chatHistoryGroups"> | null> {
  const rows = await loadHistoryGroupRows(ctx, args);
  return await normalizeGroupRows(ctx, rows);
}

async function incrementHistoryGroupForThread(
  ctx: MutationCtx,
  thread: Doc<"threads">,
  groupKey: string,
): Promise<void> {
  const group = await loadHistoryGroup(ctx, {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    groupKey,
  });
  const patch = {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    groupKey,
    repositoryId: thread.repositoryId,
    lastThreadAt: thread.lastMessageAt,
    lastThreadId: thread._id,
    threadCount: 1,
  };

  if (group) {
    await ctx.db.patch(group._id, {
      threadCount: group.threadCount + 1,
      ...(thread.lastMessageAt >= group.lastThreadAt
        ? {
            lastThreadAt: thread.lastMessageAt,
            lastThreadId: thread._id,
          }
        : {}),
    });
  } else {
    await ctx.db.insert("chatHistoryGroups", patch);
  }
}

async function decrementHistoryGroupForThread(
  ctx: MutationCtx,
  thread: Doc<"threads">,
  groupKey: string,
): Promise<void> {
  const group = await loadHistoryGroup(ctx, {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    groupKey,
  });
  if (!group) {
    return;
  }

  const latestThread =
    group.lastThreadId === thread._id || group.threadCount <= 1
      ? await loadLatestVisibleThreadInGroup(ctx, {
          ownerTokenIdentifier: thread.ownerTokenIdentifier,
          groupKey,
          excludeThreadId: thread._id,
        })
      : null;
  const nextThreadCount = Math.max(0, group.threadCount - 1);

  if (!latestThread && nextThreadCount === 0) {
    await ctx.db.delete(group._id);
    return;
  }

  if (latestThread) {
    await ctx.db.patch(group._id, {
      lastThreadAt: latestThread.lastMessageAt,
      lastThreadId: latestThread._id,
      threadCount: Math.max(1, nextThreadCount),
    });
    return;
  }

  await ctx.db.patch(group._id, {
    threadCount: nextThreadCount,
  });
}

async function markThreadHistoryMembership(
  ctx: MutationCtx,
  args: { threadId: Id<"threads">; groupKey: string | undefined; now: number },
): Promise<void> {
  await ctx.db.patch(args.threadId, {
    historyGroupKey: args.groupKey,
    historyBackfilledAt: args.now,
  });
}

export async function recordThreadCreatedInHistory(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const nextGroupKey = getVisibleThreadHistoryGroupKey(thread);
  const now = Date.now();
  if (nextGroupKey === undefined) {
    if (thread.historyGroupKey !== undefined) {
      await recordThreadRemovedFromHistory(ctx, thread);
      return;
    }
    await markThreadHistoryMembership(ctx, { threadId: thread._id, groupKey: undefined, now });
    return;
  }

  if (thread.historyGroupKey === nextGroupKey) {
    if (thread.historyBackfilledAt === undefined) {
      await markThreadHistoryMembership(ctx, { threadId: thread._id, groupKey: nextGroupKey, now });
    }
    return;
  }

  if (thread.historyGroupKey !== undefined) {
    await decrementHistoryGroupForThread(ctx, thread, thread.historyGroupKey);
  }
  await incrementHistoryGroupForThread(ctx, thread, nextGroupKey);
  await markThreadHistoryMembership(ctx, { threadId: thread._id, groupKey: nextGroupKey, now });
}

export async function recordThreadActivityInHistory(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const nextGroupKey = getVisibleThreadHistoryGroupKey(thread);
  if (nextGroupKey === undefined) {
    if (thread.historyGroupKey !== undefined || thread.historyBackfilledAt === undefined) {
      await recordThreadRemovedFromHistory(ctx, thread);
    }
    return;
  }

  if (thread.historyGroupKey !== nextGroupKey) {
    await recordThreadCreatedInHistory(ctx, thread);
    return;
  }

  const group = await loadHistoryGroup(ctx, {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    groupKey: nextGroupKey,
  });
  if (!group || group.threadCount <= 0) {
    await incrementHistoryGroupForThread(ctx, thread, nextGroupKey);
    await markThreadHistoryMembership(ctx, {
      threadId: thread._id,
      groupKey: nextGroupKey,
      now: Date.now(),
    });
    return;
  }

  if (thread.lastMessageAt >= group.lastThreadAt || group.lastThreadId === thread._id) {
    await ctx.db.patch(group._id, {
      lastThreadAt: thread.lastMessageAt,
      lastThreadId: thread._id,
    });
  }
  if (thread.historyBackfilledAt === undefined) {
    await markThreadHistoryMembership(ctx, {
      threadId: thread._id,
      groupKey: nextGroupKey,
      now: Date.now(),
    });
  }
}

export async function recordThreadRemovedFromHistory(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const now = Date.now();
  if (thread.historyGroupKey === undefined) {
    if (thread.historyBackfilledAt === undefined) {
      await markThreadHistoryMembership(ctx, { threadId: thread._id, groupKey: undefined, now });
    }
    return;
  }

  await decrementHistoryGroupForThread(ctx, thread, thread.historyGroupKey);
  await markThreadHistoryMembership(ctx, { threadId: thread._id, groupKey: undefined, now });
}

export async function recordThreadMovedInHistory(
  ctx: MutationCtx,
  args: { previousThread: Doc<"threads">; updatedThread: Doc<"threads"> },
): Promise<void> {
  const previousGroupKey = args.previousThread.historyGroupKey;
  const nextGroupKey = getVisibleThreadHistoryGroupKey(args.updatedThread);
  const now = Date.now();

  if (previousGroupKey === nextGroupKey) {
    if (nextGroupKey !== undefined) {
      await recordThreadActivityInHistory(ctx, args.updatedThread);
    } else if (args.updatedThread.historyBackfilledAt === undefined) {
      await markThreadHistoryMembership(ctx, {
        threadId: args.updatedThread._id,
        groupKey: undefined,
        now,
      });
    }
    return;
  }

  if (previousGroupKey !== undefined) {
    await decrementHistoryGroupForThread(ctx, args.previousThread, previousGroupKey);
  }
  if (nextGroupKey !== undefined) {
    await incrementHistoryGroupForThread(ctx, args.updatedThread, nextGroupKey);
  }
  await markThreadHistoryMembership(ctx, {
    threadId: args.updatedThread._id,
    groupKey: nextGroupKey,
    now,
  });
}

export async function repairThreadHistoryMembership(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const nextGroupKey = getVisibleThreadHistoryGroupKey(thread);
  if (nextGroupKey === thread.historyGroupKey) {
    if (nextGroupKey !== undefined) {
      await recordThreadActivityInHistory(ctx, thread);
      return;
    }
    if (thread.historyBackfilledAt === undefined) {
      await markThreadHistoryMembership(ctx, {
        threadId: thread._id,
        groupKey: undefined,
        now: Date.now(),
      });
    }
    return;
  }

  if (nextGroupKey === undefined) {
    await recordThreadRemovedFromHistory(ctx, thread);
    return;
  }

  await recordThreadCreatedInHistory(ctx, thread);
}

export async function refreshHistoryGroup(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: HistoryRepositoryId;
  },
): Promise<void> {
  const groupKey = getHistoryGroupKey(args.repositoryId);
  const latestThread = await loadLatestVisibleThreadInGroup(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    groupKey,
  });
  const group = await loadHistoryGroup(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    groupKey,
  });

  if (!latestThread) {
    if (group) {
      await ctx.db.delete(group._id);
    }
    return;
  }

  if (!group) {
    await ctx.db.insert("chatHistoryGroups", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      groupKey,
      repositoryId: args.repositoryId,
      lastThreadAt: latestThread.lastMessageAt,
      lastThreadId: latestThread._id,
      threadCount: 1,
    });
    return;
  }

  await ctx.db.patch(group._id, {
    lastThreadAt: latestThread.lastMessageAt,
    lastThreadId: latestThread._id,
    threadCount: Math.max(1, group.threadCount),
  });
}

export async function drainThreadSharesByThreadId(ctx: MutationCtx, threadId: Id<"threads">): Promise<boolean> {
  const shares = await ctx.db
    .query("threadShares")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .take(CASCADE_BATCH_SIZE);
  for (const share of shares) {
    await ctx.db.delete(share._id);
  }
  return shares.length === CASCADE_BATCH_SIZE;
}

export async function drainThreadSharesByRepositoryId(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
): Promise<boolean> {
  const shares = await ctx.db
    .query("threadShares")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const share of shares) {
    await ctx.db.delete(share._id);
  }
  return shares.length === CASCADE_BATCH_SIZE;
}

export async function patchThreadSharesRepositoryByThreadId(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    fromRepositoryId: Id<"repositories"> | undefined;
    repositoryId: Id<"repositories"> | undefined;
  },
): Promise<boolean> {
  if (args.fromRepositoryId === args.repositoryId) {
    return false;
  }
  const shares = await ctx.db
    .query("threadShares")
    .withIndex("by_threadId_and_repositoryId", (q) =>
      q.eq("threadId", args.threadId).eq("repositoryId", args.fromRepositoryId),
    )
    .take(CASCADE_BATCH_SIZE);
  for (const share of shares) {
    await ctx.db.patch(share._id, { repositoryId: args.repositoryId });
  }
  return shares.length === CASCADE_BATCH_SIZE;
}

export async function drainHistoryGroupsByRepositoryId(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
): Promise<boolean> {
  const groups = await ctx.db
    .query("chatHistoryGroups")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const group of groups) {
    await ctx.db.delete(group._id);
  }
  return groups.length === CASCADE_BATCH_SIZE;
}
