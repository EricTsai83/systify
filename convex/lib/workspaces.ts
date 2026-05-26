import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

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
