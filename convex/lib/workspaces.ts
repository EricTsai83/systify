import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { clearLastActiveWorkspaceIfMatches } from "./userPreferences";

export const HOME_WORKSPACE_NAME = "Home";

const WORKSPACE_COLOR_PALETTE = ["blue", "emerald", "amber", "violet", "rose", "cyan", "orange", "teal"] as const;

async function listOwnerWorkspaces(ctx: MutationCtx, ownerTokenIdentifier: string) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_ownerTokenIdentifier_and_lastAccessedAt", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
    .take(50);
}

function nextWorkspaceColor(workspaceCount: number) {
  return WORKSPACE_COLOR_PALETTE[workspaceCount % WORKSPACE_COLOR_PALETTE.length];
}

export async function ensureRepositoryWorkspace(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
    name: string;
  },
) {
  const existing = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("repositoryId", args.repositoryId),
    )
    .take(1);

  const now = Date.now();
  if (existing.length > 0) {
    await ctx.db.patch(existing[0]._id, {
      name: args.name,
      lastAccessedAt: now,
    });
    return existing[0]._id;
  }

  const ownerWorkspaces = await listOwnerWorkspaces(ctx, args.ownerTokenIdentifier);
  return await ctx.db.insert("workspaces", {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    name: args.name,
    color: nextWorkspaceColor(ownerWorkspaces.length),
    lastAccessedAt: now,
  });
}

export async function ensureHomeWorkspace(ctx: MutationCtx, ownerTokenIdentifier: string) {
  const ownerWorkspaces = await listOwnerWorkspaces(ctx, ownerTokenIdentifier);
  const homeCandidates = ownerWorkspaces.filter((workspace) => !workspace.repositoryId);
  const existingHome = homeCandidates.find((workspace) => workspace.name === HOME_WORKSPACE_NAME) ?? homeCandidates[0];

  const now = Date.now();
  const homeWorkspaceId =
    existingHome?._id ??
    (await ctx.db.insert("workspaces", {
      ownerTokenIdentifier,
      name: HOME_WORKSPACE_NAME,
      color: nextWorkspaceColor(ownerWorkspaces.length),
      lastAccessedAt: now,
    }));

  if (existingHome && existingHome.name !== HOME_WORKSPACE_NAME) {
    await ctx.db.patch(existingHome._id, { name: HOME_WORKSPACE_NAME });
  }

  for (const workspace of homeCandidates) {
    if (workspace._id === homeWorkspaceId) {
      continue;
    }
    await moveThreadsOutOfNoRepoWorkspace(ctx, {
      workspaceId: workspace._id,
      homeWorkspaceId,
      ownerTokenIdentifier,
    });
    await clearLastActiveWorkspaceIfMatches(ctx, {
      ownerTokenIdentifier,
      workspaceId: workspace._id,
    });
    await ctx.db.delete(workspace._id);
  }

  await moveRepositoryThreadsOutOfHome(ctx, { homeWorkspaceId, ownerTokenIdentifier });
  await assignOrphanThreads(ctx, { homeWorkspaceId, ownerTokenIdentifier });

  return {
    workspaceId: homeWorkspaceId,
    created: existingHome ? 0 : 1,
  };
}

export async function findHomeWorkspaceId(ctx: MutationCtx, ownerTokenIdentifier: string) {
  const ownerWorkspaces = await listOwnerWorkspaces(ctx, ownerTokenIdentifier);
  return ownerWorkspaces.find((workspace) => !workspace.repositoryId)?._id ?? null;
}

async function moveThreadsOutOfNoRepoWorkspace(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    homeWorkspaceId: Id<"workspaces">;
    ownerTokenIdentifier: string;
  },
) {
  const threads = await ctx.db
    .query("threads")
    .withIndex("by_workspaceId_and_lastMessageAt", (q) => q.eq("workspaceId", args.workspaceId))
    .take(200);

  for (const thread of threads) {
    if (thread.repositoryId) {
      const workspaceId = await workspaceIdForThreadRepository(ctx, {
        repositoryId: thread.repositoryId,
        ownerTokenIdentifier: args.ownerTokenIdentifier,
      });
      await ctx.db.patch(thread._id, { workspaceId });
      continue;
    }

    await ctx.db.patch(thread._id, { workspaceId: args.homeWorkspaceId });
  }
}

async function moveRepositoryThreadsOutOfHome(
  ctx: MutationCtx,
  args: {
    homeWorkspaceId: Id<"workspaces">;
    ownerTokenIdentifier: string;
  },
) {
  const threads = await ctx.db
    .query("threads")
    .withIndex("by_workspaceId_and_lastMessageAt", (q) => q.eq("workspaceId", args.homeWorkspaceId))
    .take(200);

  for (const thread of threads) {
    if (!thread.repositoryId) {
      continue;
    }
    const workspaceId = await workspaceIdForThreadRepository(ctx, {
      repositoryId: thread.repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
    });
    await ctx.db.patch(thread._id, { workspaceId });
  }
}

async function assignOrphanThreads(
  ctx: MutationCtx,
  args: {
    homeWorkspaceId: Id<"workspaces">;
    ownerTokenIdentifier: string;
  },
) {
  const threads = await ctx.db
    .query("threads")
    .withIndex("by_ownerTokenIdentifier_and_lastMessageAt", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier),
    )
    .take(200);

  for (const thread of threads) {
    if (thread.workspaceId) {
      continue;
    }
    if (thread.repositoryId) {
      const workspaceId = await workspaceIdForThreadRepository(ctx, {
        repositoryId: thread.repositoryId,
        ownerTokenIdentifier: args.ownerTokenIdentifier,
      });
      await ctx.db.patch(thread._id, { workspaceId });
      continue;
    }

    await ctx.db.patch(thread._id, { workspaceId: args.homeWorkspaceId });
  }
}

async function workspaceIdForThreadRepository(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
  },
) {
  const repository = await ctx.db.get(args.repositoryId);
  if (!repository || repository.ownerTokenIdentifier !== args.ownerTokenIdentifier) {
    throw new Error("Repository not found.");
  }
  return await ensureRepositoryWorkspace(ctx, {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    name: repository.sourceRepoFullName,
  });
}
