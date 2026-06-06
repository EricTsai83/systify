import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { nanoid } from "nanoid";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import { isOwnedBy, requireOwnedDoc } from "../lib/ownedDocs";

const THREAD_SHARE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const SHARE_TOKEN_LENGTH = 40;
const SHARE_TOKEN_PREFIX_LENGTH = 10;

type PublicShareMetadata = {
  _id: Id<"threadShares">;
  token: string;
  threadId: Id<"threads">;
  repositoryId?: Id<"repositories">;
  title: string;
  repositoryLabel: string;
  createdAt: number;
  expiresAt: number;
};

function isActiveShare(share: Doc<"threadShares">, now: number): boolean {
  return share.revokedAt === undefined && share.expiresAt > now;
}

async function activeShareForToken(
  ctx: QueryCtx,
  args: { token: string; now: number },
): Promise<Doc<"threadShares"> | null> {
  const share = await ctx.db
    .query("threadShares")
    .withIndex("by_token", (q) => q.eq("token", args.token))
    .unique();
  return share && isActiveShare(share, args.now) ? share : null;
}

async function repositoryLabelForThread(
  ctx: QueryCtx,
  args: { thread: Doc<"threads">; ownerTokenIdentifier: string },
): Promise<string> {
  if (!args.thread.repositoryId) {
    return "No repository";
  }
  const repository = await ctx.db.get(args.thread.repositoryId);
  return isOwnedBy(repository, args.ownerTokenIdentifier) ? repository.sourceRepoFullName : "Repository unavailable";
}

async function publicShareMetadata(ctx: QueryCtx, share: Doc<"threadShares">): Promise<PublicShareMetadata | null> {
  const thread = await ctx.db.get(share.threadId);
  if (!isOwnedBy(thread, share.ownerTokenIdentifier)) {
    return null;
  }

  return {
    _id: share._id,
    token: share.token,
    threadId: share.threadId,
    repositoryId: share.repositoryId,
    title: thread.title,
    repositoryLabel: await repositoryLabelForThread(ctx, {
      thread,
      ownerTokenIdentifier: share.ownerTokenIdentifier,
    }),
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
  };
}

export const createOrGetThreadShare = mutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const { identity, doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });
    const now = Date.now();
    const existingShares = await ctx.db
      .query("threadShares")
      .withIndex("by_ownerTokenIdentifier_and_threadId", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("threadId", args.threadId),
      )
      .collect();
    const activeShare = existingShares.find((share) => isActiveShare(share, now));
    if (activeShare) {
      return {
        _id: activeShare._id,
        token: activeShare.token,
        tokenPrefix: activeShare.tokenPrefix,
        threadId: activeShare.threadId,
        repositoryId: activeShare.repositoryId,
        createdAt: activeShare.createdAt,
        expiresAt: activeShare.expiresAt,
      };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = nanoid(SHARE_TOKEN_LENGTH);
      const collision = await ctx.db
        .query("threadShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      if (collision) {
        continue;
      }
      const createdAt = now;
      const expiresAt = now + THREAD_SHARE_EXPIRY_MS;
      const shareId = await ctx.db.insert("threadShares", {
        ownerTokenIdentifier: identity.tokenIdentifier,
        threadId: args.threadId,
        repositoryId: thread.repositoryId,
        token,
        tokenPrefix: token.slice(0, SHARE_TOKEN_PREFIX_LENGTH),
        createdAt,
        expiresAt,
      });
      return {
        _id: shareId,
        token,
        tokenPrefix: token.slice(0, SHARE_TOKEN_PREFIX_LENGTH),
        threadId: args.threadId,
        repositoryId: thread.repositoryId,
        createdAt,
        expiresAt,
      };
    }

    throw new Error("Failed to create share link.");
  },
});

export const listActiveThreadShares = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const result = await ctx.db
      .query("threadShares")
      .withIndex("by_ownerTokenIdentifier_and_createdAt", (q) => q.eq("ownerTokenIdentifier", identity.tokenIdentifier))
      .order("desc")
      .paginate(args.paginationOpts);
    const now = Date.now();
    const page = (
      await Promise.all(
        result.page
          .filter((share) => isActiveShare(share, now))
          .map(async (share) => await publicShareMetadata(ctx, share)),
      )
    ).filter((share): share is PublicShareMetadata => share !== null);

    return {
      ...result,
      page,
    };
  },
});

export const revokeThreadShare = mutation({
  args: {
    shareId: v.id("threadShares"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const share = await ctx.db.get(args.shareId);
    if (!share || share.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Share link not found.");
    }
    if (share.revokedAt !== undefined) {
      return null;
    }
    await ctx.db.patch(args.shareId, { revokedAt: Date.now() });
    return null;
  },
});

export const getPublicThreadShare = query({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const share = await activeShareForToken(ctx, { token: args.token, now: Date.now() });
    if (!share) {
      return null;
    }
    return await publicShareMetadata(ctx, share);
  },
});

export const listPublicThreadShareMessages = query({
  args: {
    token: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const share = await activeShareForToken(ctx, { token: args.token, now: Date.now() });
    if (!share) {
      throw new Error("Share link not found.");
    }
    const thread = await ctx.db.get(share.threadId);
    if (!isOwnedBy(thread, share.ownerTokenIdentifier)) {
      throw new Error("Share link not found.");
    }
    const result = await ctx.db
      .query("messages")
      .withIndex("by_threadId", (q) => q.eq("threadId", share.threadId))
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          _id: message._id,
          role: message.role,
          content: message.content,
          status: message.status,
          createdAt: message._creationTime,
        })),
    };
  },
});
