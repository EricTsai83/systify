import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { CASCADE_BATCH_SIZE } from "../lib/constants";

export const NO_REPOSITORY_ARCHIVE_SCOPE_KEY = "no_repository";
const ARCHIVE_SCOPE_DUPLICATE_REPAIR_LIMIT = 10;
const ARCHIVE_SCOPE_REPAIR_BATCH_SIZE = 100;

type ArchiveRepositoryId = Id<"repositories"> | undefined;

export function getArchiveScopeKey(repositoryId: ArchiveRepositoryId): string {
  return repositoryId ? `repository:${repositoryId}` : NO_REPOSITORY_ARCHIVE_SCOPE_KEY;
}

function getArchivedThreadScopeKey(thread: Doc<"threads">): string | undefined {
  if (thread.archivedAt === undefined || thread.deletionRequestedAt !== undefined) {
    return undefined;
  }
  return getArchiveScopeKey(thread.repositoryId);
}

async function loadArchiveScopeRows(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; scopeKey: string },
): Promise<Doc<"archivedThreadScopes">[]> {
  return await ctx.db
    .query("archivedThreadScopes")
    .withIndex("by_ownerTokenIdentifier_and_scopeKey", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("scopeKey", args.scopeKey),
    )
    .take(ARCHIVE_SCOPE_DUPLICATE_REPAIR_LIMIT);
}

async function normalizeScopeRows(
  ctx: MutationCtx,
  rows: Doc<"archivedThreadScopes">[],
): Promise<Doc<"archivedThreadScopes"> | null> {
  const [primary, ...duplicates] = rows;
  if (!primary) {
    return null;
  }

  const scopedThreads = await ctx.db
    .query("threads")
    .withIndex("by_ownerTokenIdentifier_and_archiveScopeKey_and_archivedAt", (q) =>
      q.eq("ownerTokenIdentifier", primary.ownerTokenIdentifier).eq("archiveScopeKey", primary.scopeKey),
    )
    .order("desc")
    .collect();
  const activeArchivedThreads = scopedThreads.filter(
    (thread) =>
      thread.archivedAt !== undefined &&
      thread.deletionRequestedAt === undefined &&
      thread.archiveScopeKey === primary.scopeKey,
  );

  if (activeArchivedThreads.length === 0) {
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return null;
  }

  const latestThread = activeArchivedThreads[0]!;
  const primaryPatch = {
    repositoryId: latestThread.repositoryId,
    lastArchivedAt: latestThread.archivedAt!,
    lastThreadId: latestThread._id,
    threadCount: activeArchivedThreads.length,
  };
  await ctx.db.patch(primary._id, primaryPatch);
  for (const duplicate of duplicates) {
    await ctx.db.delete(duplicate._id);
  }
  return { ...primary, ...primaryPatch };
}

async function loadArchiveScope(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; scopeKey: string },
): Promise<Doc<"archivedThreadScopes"> | null> {
  const rows = await loadArchiveScopeRows(ctx, args);
  return await normalizeScopeRows(ctx, rows);
}

async function loadLatestArchivedThreadInScope(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    scopeKey: string;
    excludeThreadId?: Id<"threads">;
  },
): Promise<Doc<"threads"> | null> {
  const candidates = await ctx.db
    .query("threads")
    .withIndex("by_ownerTokenIdentifier_and_archiveScopeKey_and_archivedAt", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("archiveScopeKey", args.scopeKey),
    )
    .order("desc")
    .take(args.excludeThreadId ? 2 : 1);

  return (
    candidates.find(
      (thread) =>
        thread._id !== args.excludeThreadId &&
        thread.archivedAt !== undefined &&
        thread.deletionRequestedAt === undefined &&
        thread.archiveScopeKey === args.scopeKey,
    ) ?? null
  );
}

async function incrementArchiveScopeForThread(
  ctx: MutationCtx,
  thread: Doc<"threads">,
  scopeKey: string,
): Promise<void> {
  const archivedAt = thread.archivedAt;
  if (archivedAt === undefined) {
    return;
  }
  const scope = await loadArchiveScope(ctx, {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    scopeKey,
  });

  if (scope) {
    await ctx.db.patch(scope._id, {
      threadCount: scope.threadCount + 1,
      ...(archivedAt >= scope.lastArchivedAt
        ? {
            lastArchivedAt: archivedAt,
            lastThreadId: thread._id,
          }
        : {}),
    });
    return;
  }

  await ctx.db.insert("archivedThreadScopes", {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    scopeKey,
    repositoryId: thread.repositoryId,
    lastArchivedAt: archivedAt,
    lastThreadId: thread._id,
    threadCount: 1,
  });
}

async function decrementArchiveScopeForThread(
  ctx: MutationCtx,
  thread: Doc<"threads">,
  scopeKey: string,
): Promise<void> {
  const scope = await loadArchiveScope(ctx, {
    ownerTokenIdentifier: thread.ownerTokenIdentifier,
    scopeKey,
  });
  if (!scope) {
    return;
  }

  const latestThread =
    scope.lastThreadId === thread._id || scope.threadCount <= 1
      ? await loadLatestArchivedThreadInScope(ctx, {
          ownerTokenIdentifier: thread.ownerTokenIdentifier,
          scopeKey,
          excludeThreadId: thread._id,
        })
      : null;
  const nextThreadCount = Math.max(0, scope.threadCount - 1);

  if (!latestThread && nextThreadCount === 0) {
    await ctx.db.delete(scope._id);
    return;
  }

  if (latestThread) {
    await ctx.db.patch(scope._id, {
      lastArchivedAt: latestThread.archivedAt!,
      lastThreadId: latestThread._id,
      threadCount: Math.max(1, nextThreadCount),
    });
    return;
  }

  await ctx.db.patch(scope._id, {
    threadCount: nextThreadCount,
  });
}

async function markThreadArchiveMembership(
  ctx: MutationCtx,
  args: { threadId: Id<"threads">; scopeKey: string | undefined; now: number },
): Promise<void> {
  await ctx.db.patch(args.threadId, {
    archiveScopeKey: args.scopeKey,
    archiveBackfilledAt: args.now,
  });
}

export async function recordThreadArchivedInScope(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const nextScopeKey = getArchivedThreadScopeKey(thread);
  const now = Date.now();
  if (nextScopeKey === undefined) {
    if (thread.archiveScopeKey !== undefined) {
      await recordThreadRemovedFromArchiveScope(ctx, thread);
      return;
    }
    await markThreadArchiveMembership(ctx, { threadId: thread._id, scopeKey: undefined, now });
    return;
  }

  if (thread.archiveScopeKey === nextScopeKey) {
    if (thread.archiveBackfilledAt === undefined) {
      await markThreadArchiveMembership(ctx, { threadId: thread._id, scopeKey: nextScopeKey, now });
    }
    return;
  }

  if (thread.archiveScopeKey !== undefined) {
    await decrementArchiveScopeForThread(ctx, thread, thread.archiveScopeKey);
  }
  await incrementArchiveScopeForThread(ctx, thread, nextScopeKey);
  await markThreadArchiveMembership(ctx, { threadId: thread._id, scopeKey: nextScopeKey, now });
}

export async function recordThreadRemovedFromArchiveScope(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const now = Date.now();
  if (thread.archiveScopeKey === undefined) {
    if (thread.archiveBackfilledAt === undefined) {
      await markThreadArchiveMembership(ctx, { threadId: thread._id, scopeKey: undefined, now });
    }
    return;
  }

  await decrementArchiveScopeForThread(ctx, thread, thread.archiveScopeKey);
  await markThreadArchiveMembership(ctx, { threadId: thread._id, scopeKey: undefined, now });
}

export async function repairThreadArchiveScopeMembership(ctx: MutationCtx, thread: Doc<"threads">): Promise<void> {
  const nextScopeKey = getArchivedThreadScopeKey(thread);
  if (nextScopeKey === thread.archiveScopeKey) {
    if (nextScopeKey !== undefined) {
      await recordThreadArchivedInScope(ctx, thread);
      return;
    }
    if (thread.archiveBackfilledAt === undefined) {
      await markThreadArchiveMembership(ctx, {
        threadId: thread._id,
        scopeKey: undefined,
        now: Date.now(),
      });
    }
    return;
  }

  if (nextScopeKey === undefined) {
    await recordThreadRemovedFromArchiveScope(ctx, thread);
    return;
  }

  await recordThreadArchivedInScope(ctx, thread);
}

export async function drainArchivedThreadScopesByRepositoryId(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
): Promise<boolean> {
  const docs = await ctx.db
    .query("archivedThreadScopes")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return docs.length === CASCADE_BATCH_SIZE;
}

export const repairArchivedThreadScopes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_archiveBackfilledAt", (q) => q.eq("archiveBackfilledAt", undefined))
      .take(ARCHIVE_SCOPE_REPAIR_BATCH_SIZE);

    for (const thread of threads) {
      await repairThreadArchiveScopeMembership(ctx, thread);
    }

    const shouldContinue = threads.length === ARCHIVE_SCOPE_REPAIR_BATCH_SIZE;
    if (shouldContinue) {
      await ctx.scheduler.runAfter(0, internal.chat.archiveState.repairArchivedThreadScopes, {});
    }

    return {
      threadsRepaired: threads.length,
      shouldContinue,
    };
  },
});
