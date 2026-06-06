import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { CASCADE_BATCH_SIZE } from "../lib/constants";

export const NO_REPOSITORY_HISTORY_GROUP_KEY = "no_repository";
const HISTORY_GROUP_DUPLICATE_REPAIR_LIMIT = 10;

type HistoryRepositoryId = Id<"repositories"> | undefined;

export function getHistoryGroupKey(repositoryId: HistoryRepositoryId): string {
  return repositoryId ? `repository:${repositoryId}` : NO_REPOSITORY_HISTORY_GROUP_KEY;
}

async function loadHistoryGroupRows(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; repositoryId: HistoryRepositoryId },
) {
  return await ctx.db
    .query("chatHistoryGroups")
    .withIndex("by_ownerTokenIdentifier_and_groupKey", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("groupKey", getHistoryGroupKey(args.repositoryId)),
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
    repositoryId: HistoryRepositoryId;
    excludeThreadId?: Id<"threads">;
  },
): Promise<Doc<"threads"> | null> {
  const candidates = await ctx.db
    .query("threads")
    .withIndex("by_ownerTokenIdentifier_repositoryId_deletionRequestedAt_and_lastMessageAt", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .eq("repositoryId", args.repositoryId)
        .eq("deletionRequestedAt", undefined),
    )
    .order("desc")
    .take(args.excludeThreadId ? 2 : 1);

  return candidates.find((thread) => thread._id !== args.excludeThreadId) ?? null;
}

export async function refreshHistoryGroup(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: HistoryRepositoryId;
    excludeThreadId?: Id<"threads">;
  },
): Promise<void> {
  const rows = await loadHistoryGroupRows(ctx, args);
  const group = await normalizeGroupRows(ctx, rows);
  const latestThread = await loadLatestVisibleThreadInGroup(ctx, args);

  if (!latestThread) {
    if (group) {
      await ctx.db.delete(group._id);
    }
    return;
  }

  const threadCount = group && args.excludeThreadId ? Math.max(1, group.threadCount - 1) : (group?.threadCount ?? 1);
  const patch = {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    groupKey: getHistoryGroupKey(args.repositoryId),
    repositoryId: args.repositoryId,
    lastThreadAt: latestThread.lastMessageAt,
    lastThreadId: latestThread._id,
    threadCount,
  };

  if (group) {
    await ctx.db.patch(group._id, patch);
  } else {
    await ctx.db.insert("chatHistoryGroups", patch);
  }
}

export async function recordThreadCreatedInHistory(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  if (thread.deletionRequestedAt !== undefined) {
    return;
  }

  const rows = await loadHistoryGroupRows(ctx, {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    repositoryId: thread.repositoryId,
  });
  const group = await normalizeGroupRows(ctx, rows);
  if (!group) {
    await refreshHistoryGroup(ctx, {
      ownerTokenIdentifier: thread.ownerTokenIdentifier,
      repositoryId: thread.repositoryId,
    });
    return;
  }

  await ctx.db.patch(group._id, {
    threadCount: group.threadCount + 1,
    ...(thread.lastMessageAt >= group.lastThreadAt
      ? {
          lastThreadAt: thread.lastMessageAt,
          lastThreadId: thread._id,
        }
      : {}),
  });
}

export async function recordThreadActivityInHistory(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  if (thread.deletionRequestedAt !== undefined) {
    return;
  }

  const rows = await loadHistoryGroupRows(ctx, {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    repositoryId: thread.repositoryId,
  });
  const group = await normalizeGroupRows(ctx, rows);
  if (!group || group.threadCount <= 0) {
    await refreshHistoryGroup(ctx, {
      ownerTokenIdentifier: thread.ownerTokenIdentifier,
      repositoryId: thread.repositoryId,
    });
    return;
  }

  if (thread.lastMessageAt >= group.lastThreadAt || group.lastThreadId === thread._id) {
    await ctx.db.patch(group._id, {
      lastThreadAt: thread.lastMessageAt,
      lastThreadId: thread._id,
    });
  }
}

export async function recordThreadRemovedFromHistory(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const rows = await loadHistoryGroupRows(ctx, {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    repositoryId: thread.repositoryId,
  });
  const group = await normalizeGroupRows(ctx, rows);
  if (!group) {
    return;
  }

  const nextThreadCount = Math.max(0, group.threadCount - 1);
  if (nextThreadCount === 0) {
    await ctx.db.delete(group._id);
    return;
  }

  if (group.lastThreadId === thread._id) {
    const latestThread = await loadLatestVisibleThreadInGroup(ctx, {
      ownerTokenIdentifier: thread.ownerTokenIdentifier,
      repositoryId: thread.repositoryId,
      excludeThreadId: thread._id,
    });
    if (!latestThread) {
      await ctx.db.delete(group._id);
      return;
    }
    await ctx.db.patch(group._id, {
      lastThreadAt: latestThread.lastMessageAt,
      lastThreadId: latestThread._id,
      threadCount: nextThreadCount,
    });
    return;
  }

  await ctx.db.patch(group._id, {
    threadCount: nextThreadCount,
  });
}

export async function recordThreadMovedInHistory(
  ctx: MutationCtx,
  args: { previousThread: Doc<"threads">; updatedThread: Doc<"threads"> },
): Promise<void> {
  if (getHistoryGroupKey(args.previousThread.repositoryId) === getHistoryGroupKey(args.updatedThread.repositoryId)) {
    await recordThreadActivityInHistory(ctx, args.updatedThread);
    return;
  }
  await recordThreadRemovedFromHistory(ctx, args.previousThread);
  await recordThreadCreatedInHistory(ctx, args.updatedThread);
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
  args: { threadId: Id<"threads">; repositoryId: Id<"repositories"> | undefined },
): Promise<boolean> {
  const shares = await ctx.db
    .query("threadShares")
    .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
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
