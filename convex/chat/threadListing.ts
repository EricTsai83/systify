import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

const THREAD_LIST_LIMIT = 20;

type ThreadListingScope = { type: "repository"; repositoryId: Id<"repositories"> } | { type: "repoless" };

export async function listActiveThreadsForScope(
  ctx: QueryCtx,
  args: {
    ownerTokenIdentifier: string;
    scope: ThreadListingScope;
    mode?: Doc<"threads">["mode"];
  },
): Promise<Doc<"threads">[]> {
  const pinned = await listPinnedThreadsForScope(ctx, args);
  const recent = await listRecentThreadsForScope(ctx, args);
  const pinnedIds = new Set(pinned.map((thread) => thread._id));

  return [...pinned, ...recent.filter((thread) => !pinnedIds.has(thread._id))];
}

async function listPinnedThreadsForScope(
  ctx: QueryCtx,
  args: {
    ownerTokenIdentifier: string;
    scope: ThreadListingScope;
    mode?: Doc<"threads">["mode"];
  },
): Promise<Doc<"threads">[]> {
  const repositoryId = scopeRepositoryId(args.scope);
  const mode = args.mode;

  if (mode !== undefined) {
    return await ctx.db
      .query("threads")
      .withIndex("by_owner_repo_mode_delete_archive_pinned", (q) =>
        q
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .eq("repositoryId", repositoryId)
          .eq("mode", mode)
          .eq("deletionRequestedAt", undefined)
          .eq("archivedAt", undefined)
          .gt("pinnedAt", 0),
      )
      .order("desc")
      .take(THREAD_LIST_LIMIT);
  }

  return await ctx.db
    .query("threads")
    .withIndex("by_owner_repo_delete_archive_pinned", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .eq("repositoryId", repositoryId)
        .eq("deletionRequestedAt", undefined)
        .eq("archivedAt", undefined)
        .gt("pinnedAt", 0),
    )
    .order("desc")
    .take(THREAD_LIST_LIMIT);
}

async function listRecentThreadsForScope(
  ctx: QueryCtx,
  args: {
    ownerTokenIdentifier: string;
    scope: ThreadListingScope;
    mode?: Doc<"threads">["mode"];
  },
): Promise<Doc<"threads">[]> {
  const repositoryId = scopeRepositoryId(args.scope);
  const mode = args.mode;

  if (mode !== undefined) {
    return await ctx.db
      .query("threads")
      .withIndex("by_owner_repo_mode_delete_archive_lastMsg", (q) =>
        q
          .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
          .eq("repositoryId", repositoryId)
          .eq("mode", mode)
          .eq("deletionRequestedAt", undefined)
          .eq("archivedAt", undefined),
      )
      .order("desc")
      .take(THREAD_LIST_LIMIT);
  }

  return await ctx.db
    .query("threads")
    .withIndex("by_owner_repo_delete_archive_lastMsg", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .eq("repositoryId", repositoryId)
        .eq("deletionRequestedAt", undefined)
        .eq("archivedAt", undefined),
    )
    .order("desc")
    .take(THREAD_LIST_LIMIT);
}

function scopeRepositoryId(scope: ThreadListingScope): Id<"repositories"> | undefined {
  return scope.type === "repository" ? scope.repositoryId : undefined;
}
