import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireViewerIdentity } from "../lib/auth";
import { isOwnedBy, loadOwnedDoc } from "../lib/ownedDocs";
import { NO_REPOSITORY_HISTORY_GROUP_KEY, repairThreadHistoryMembership } from "./historyState";

const HISTORY_REPAIR_BATCH_SIZE = 100;
const HISTORY_GROUP_PAGE_SCAN_LIMIT = 4;

type HistoryRepositorySummary = {
  _id: Id<"repositories">;
  sourceRepoFullName: string;
  visibility: Doc<"repositories">["visibility"];
  archivedAt?: number;
};

type ActiveThreadShareSummary = {
  _id: Id<"threadShares">;
  token: string;
  expiresAt: number;
  createdAt: number;
};

async function summarizeRepository(
  ctx: QueryCtx,
  args: { repositoryId: Id<"repositories"> | undefined; ownerTokenIdentifier: string },
): Promise<HistoryRepositorySummary | null> {
  if (!args.repositoryId) {
    return null;
  }
  const repository = await ctx.db.get(args.repositoryId);
  if (!isOwnedBy(repository, args.ownerTokenIdentifier)) {
    return null;
  }
  return {
    _id: repository._id,
    sourceRepoFullName: repository.sourceRepoFullName,
    visibility: repository.visibility,
    archivedAt: repository.archivedAt,
  };
}

async function findActiveShareForThread(
  ctx: QueryCtx,
  args: { ownerTokenIdentifier: string; threadId: Id<"threads">; now: number },
): Promise<ActiveThreadShareSummary | null> {
  const shares = await ctx.db
    .query("threadShares")
    .withIndex("by_ownerTokenIdentifier_threadId_revokedAt_and_expiresAt", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .eq("threadId", args.threadId)
        .eq("revokedAt", undefined)
        .gt("expiresAt", args.now),
    )
    .order("desc")
    .take(1);
  const share = shares[0] ?? null;
  return share
    ? {
        _id: share._id,
        token: share.token,
        expiresAt: share.expiresAt,
        createdAt: share.createdAt,
      }
    : null;
}

async function loadNoRepositoryHistoryGroup(
  ctx: QueryCtx,
  ownerTokenIdentifier: string,
): Promise<Doc<"chatHistoryGroups"> | null> {
  const rows = await ctx.db
    .query("chatHistoryGroups")
    .withIndex("by_ownerTokenIdentifier_and_groupKey", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("groupKey", NO_REPOSITORY_HISTORY_GROUP_KEY),
    )
    .take(1);
  return rows[0] ?? null;
}

async function paginateHistoryGroupsExcludingNoRepository(
  ctx: QueryCtx,
  args: {
    ownerTokenIdentifier: string;
    paginationOpts: { numItems: number; cursor: string | null };
    maxItems: number;
  },
) {
  const page: Doc<"chatHistoryGroups">[] = [];
  let cursor = args.paginationOpts.cursor;
  let continueCursor = cursor ?? "";
  let isDone = false;
  let pagesScanned = 0;

  if (args.maxItems <= 0) {
    return {
      page,
      continueCursor,
      isDone,
    };
  }

  while (page.length < args.maxItems && !isDone && pagesScanned < HISTORY_GROUP_PAGE_SCAN_LIMIT) {
    const remaining = Math.max(1, args.maxItems - page.length);
    const result = await ctx.db
      .query("chatHistoryGroups")
      .withIndex("by_ownerTokenIdentifier_and_lastThreadAt", (q) =>
        q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier),
      )
      .order("desc")
      .paginate({ numItems: remaining, cursor });
    pagesScanned += 1;
    cursor = result.continueCursor;
    continueCursor = result.continueCursor;
    isDone = result.isDone;

    for (const group of result.page) {
      if (group.groupKey !== NO_REPOSITORY_HISTORY_GROUP_KEY) {
        page.push(group);
      }
    }
  }

  return {
    page,
    continueCursor,
    isDone,
  };
}

export const listThreadHistoryGroups = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const shouldPinNoRepositoryGroup = args.paginationOpts.cursor === null;
    const noRepositoryGroup = shouldPinNoRepositoryGroup
      ? await loadNoRepositoryHistoryGroup(ctx, identity.tokenIdentifier)
      : null;
    const repositoryGroupLimit = Math.max(0, args.paginationOpts.numItems - (noRepositoryGroup ? 1 : 0));
    const result = await paginateHistoryGroupsExcludingNoRepository(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      paginationOpts: args.paginationOpts,
      maxItems: repositoryGroupLimit,
    });
    const groups = noRepositoryGroup ? [noRepositoryGroup, ...result.page] : result.page;

    const page = await Promise.all(
      groups.map(async (group) => ({
        _id: group._id,
        groupKey: group.groupKey,
        repositoryId: group.repositoryId,
        lastThreadAt: group.lastThreadAt,
        lastThreadId: group.lastThreadId,
        threadCount: group.threadCount,
        repository: await summarizeRepository(ctx, {
          repositoryId: group.repositoryId,
          ownerTokenIdentifier: identity.tokenIdentifier,
        }),
      })),
    );

    return {
      ...result,
      page,
    };
  },
});

export const listThreadsForHistoryGroup = query({
  args: {
    repositoryId: v.union(v.id("repositories"), v.null()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repositoryId = args.repositoryId ?? undefined;
    if (repositoryId) {
      const { doc: repository } = await loadOwnedDoc(ctx, repositoryId);
      if (!repository) {
        throw new Error("Repository not found.");
      }
    }

    const result = await ctx.db
      .query("threads")
      .withIndex("by_owner_repo_delete_archive_lastMsg", (q) =>
        q
          .eq("ownerTokenIdentifier", identity.tokenIdentifier)
          .eq("repositoryId", repositoryId)
          .eq("deletionRequestedAt", undefined)
          .eq("archivedAt", undefined),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const now = Date.now();

    const page = await Promise.all(
      result.page.map(async (thread) => ({
        _id: thread._id,
        repositoryId: thread.repositoryId,
        title: thread.title,
        mode: thread.mode,
        lastMessageAt: thread.lastMessageAt,
        pinnedAt: thread.pinnedAt,
        activeShare: await findActiveShareForThread(ctx, {
          ownerTokenIdentifier: identity.tokenIdentifier,
          threadId: thread._id,
          now,
        }),
      })),
    );

    return {
      ...result,
      page,
    };
  },
});

export const backfillChatHistoryGroups = internalMutation({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("threads").paginate(args.paginationOpts);
    let threadsRepaired = 0;
    for (const thread of result.page) {
      await repairThreadHistoryMembership(ctx, thread);
      threadsRepaired += 1;
    }

    return {
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      threadsRepaired,
      threadsScanned: result.page.length,
    };
  },
});

export const repairChatHistoryGroups = internalMutation({
  args: {},
  handler: async (ctx) => {
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_historyBackfilledAt", (q) => q.eq("historyBackfilledAt", undefined))
      .take(HISTORY_REPAIR_BATCH_SIZE);

    for (const thread of threads) {
      await repairThreadHistoryMembership(ctx, thread);
    }

    const shouldContinue = threads.length === HISTORY_REPAIR_BATCH_SIZE;
    if (shouldContinue) {
      await ctx.scheduler.runAfter(0, internal.chat.history.repairChatHistoryGroups, {});
    }

    return {
      threadsRepaired: threads.length,
      shouldContinue,
    };
  },
});
