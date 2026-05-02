import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Per-viewer preferences live in their own table so they can be loaded with a
 * single owner-keyed lookup and extended without reshaping the workspace
 * model. All access funnels through these helpers so the upsert / cascade
 * semantics stay consistent across `workspaces.ts` and the public
 * `userPreferences.ts` module.
 */

async function findUserPreferences(ctx: QueryCtx | MutationCtx, ownerTokenIdentifier: string) {
  return await ctx.db
    .query("userPreferences")
    .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
    .unique();
}

/**
 * Read the viewer's preferences row, validating the stored
 * `lastActiveWorkspaceId` still exists and still belongs to the viewer.
 *
 * A stale id would normally appear if a workspace got deleted on another
 * device after the preference was written. Returning `null` for the field in
 * that case lets the frontend fall through to the "most recently accessed
 * workspace" fallback, which is the behavior we want.
 */
export async function loadViewerPreferences(ctx: QueryCtx | MutationCtx, ownerTokenIdentifier: string) {
  const pref = await findUserPreferences(ctx, ownerTokenIdentifier);
  if (!pref) {
    return null;
  }

  let lastActiveWorkspaceId: Id<"workspaces"> | null = null;
  if (pref.lastActiveWorkspaceId) {
    const workspace = await ctx.db.get(pref.lastActiveWorkspaceId);
    if (workspace && workspace.ownerTokenIdentifier === ownerTokenIdentifier) {
      lastActiveWorkspaceId = workspace._id;
    }
  }

  return {
    lastActiveWorkspaceId,
    lastActiveWorkspaceUpdatedAt: pref.lastActiveWorkspaceUpdatedAt ?? null,
  };
}

/**
 * Idempotently set the viewer's last active workspace. Skips the write when
 * the value already matches so subscriptions on `getViewerPreferences` stay
 * stable across redundant calls (e.g. the auto-select fallback re-running on
 * every workspaces query revalidation).
 */
export async function upsertLastActiveWorkspace(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    workspaceId: Id<"workspaces">;
  },
) {
  const existing = await findUserPreferences(ctx, args.ownerTokenIdentifier);
  const now = Date.now();

  if (!existing) {
    await ctx.db.insert("userPreferences", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      lastActiveWorkspaceId: args.workspaceId,
      lastActiveWorkspaceUpdatedAt: now,
    });
    return;
  }

  if (existing.lastActiveWorkspaceId === args.workspaceId) {
    return;
  }

  await ctx.db.patch(existing._id, {
    lastActiveWorkspaceId: args.workspaceId,
    lastActiveWorkspaceUpdatedAt: now,
  });
}

/**
 * Cascade hook for `deleteWorkspace`: clear the pointer if the deleted
 * workspace was the viewer's stored "last active". Without this, the next
 * `getViewerPreferences` call would have to silently drop a dangling id.
 */
export async function clearLastActiveWorkspaceIfMatches(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    workspaceId: Id<"workspaces">;
  },
) {
  const existing = await findUserPreferences(ctx, args.ownerTokenIdentifier);
  if (!existing || existing.lastActiveWorkspaceId !== args.workspaceId) {
    return;
  }
  await ctx.db.patch(existing._id, {
    lastActiveWorkspaceId: undefined,
    lastActiveWorkspaceUpdatedAt: Date.now(),
  });
}
