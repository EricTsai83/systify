import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireViewerIdentity } from "../lib/auth";
import { isOwnedBy, loadOwnedDoc } from "../lib/ownedDocs";
import { refreshHistoryGroup } from "./historyState";

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

export const listThreadHistoryGroups = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const result = await ctx.db
      .query("chatHistoryGroups")
      .withIndex("by_ownerTokenIdentifier_and_lastThreadAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    const page = await Promise.all(
      result.page.map(async (group) => ({
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
      .withIndex("by_owner_repo_del_arch_last", (q) =>
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
    const seenGroupKeys = new Set<string>();
    let groupsTouched = 0;
    for (const thread of result.page) {
      const key = `${thread.ownerTokenIdentifier}:${thread.repositoryId ?? "no_repository"}`;
      if (seenGroupKeys.has(key)) {
        continue;
      }
      seenGroupKeys.add(key);
      groupsTouched += 1;
      await refreshHistoryGroup(ctx, {
        ownerTokenIdentifier: thread.ownerTokenIdentifier,
        repositoryId: thread.repositoryId,
      });
    }

    return {
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      groupsTouched,
      threadsScanned: result.page.length,
    };
  },
});
