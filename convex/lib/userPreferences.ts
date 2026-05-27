import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Per-viewer preferences live in their own table so they can be loaded with a
 * single owner-keyed lookup and extended without reshaping the repository
 * model. All access funnels through these helpers so the upsert / cascade
 * semantics stay consistent across `repositoryPreferences.ts`,
 * `userPreferences.ts`, and the repository cascade in `repositories.ts`.
 */

async function findUserPreferences(ctx: QueryCtx | MutationCtx, ownerTokenIdentifier: string) {
  return await ctx.db
    .query("userPreferences")
    .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
    .unique();
}

/**
 * Read the viewer's preferences row, validating the stored
 * `lastActiveRepositoryId` still exists and still belongs to the viewer.
 *
 * A stale id would normally appear if a repository got deleted on another
 * device after the preference was written. Returning `null` for the field
 * in that case lets the frontend fall through to the "most recently
 * accessed repository" fallback, which is the behavior we want.
 */
export async function loadViewerPreferences(ctx: QueryCtx | MutationCtx, ownerTokenIdentifier: string) {
  const pref = await findUserPreferences(ctx, ownerTokenIdentifier);
  if (!pref) {
    return null;
  }

  let lastActiveRepositoryId: Id<"repositories"> | null = null;
  if (pref.lastActiveRepositoryId) {
    const repository = await ctx.db.get(pref.lastActiveRepositoryId);
    if (repository && repository.ownerTokenIdentifier === ownerTokenIdentifier) {
      lastActiveRepositoryId = repository._id;
    }
  }

  return {
    lastActiveRepositoryId,
    lastActiveRepositoryUpdatedAt: pref.lastActiveRepositoryUpdatedAt ?? null,
  };
}

/**
 * Idempotently set the viewer's last active repository. Skips the write when
 * the value already matches so subscriptions on `getViewerPreferences` stay
 * stable across redundant calls (e.g. the auto-select fallback re-running
 * on every repositories query revalidation).
 */
export async function upsertLastActiveRepository(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
  },
) {
  const existing = await findUserPreferences(ctx, args.ownerTokenIdentifier);
  const now = Date.now();

  if (!existing) {
    await ctx.db.insert("userPreferences", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      lastActiveRepositoryId: args.repositoryId,
      lastActiveRepositoryUpdatedAt: now,
    });
    return;
  }

  if (existing.lastActiveRepositoryId === args.repositoryId) {
    return;
  }

  await ctx.db.patch(existing._id, {
    lastActiveRepositoryId: args.repositoryId,
    lastActiveRepositoryUpdatedAt: now,
  });
}

/**
 * Cascade hook for repository deletion: clear the pointer if the deleted
 * repository was the viewer's stored "last active". Without this, the next
 * `getViewerPreferences` call would have to silently drop a dangling id.
 */
export async function clearLastActiveRepositoryIfMatches(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
  },
) {
  const existing = await findUserPreferences(ctx, args.ownerTokenIdentifier);
  if (!existing || existing.lastActiveRepositoryId !== args.repositoryId) {
    return;
  }
  await ctx.db.patch(existing._id, {
    lastActiveRepositoryId: undefined,
    lastActiveRepositoryUpdatedAt: Date.now(),
  });
}
