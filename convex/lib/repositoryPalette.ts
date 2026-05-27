import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const REPOSITORY_COLOR_PALETTE = ["blue", "emerald", "amber", "violet", "rose", "cyan", "orange", "teal"] as const;

export type RepositoryColor = Doc<"repositories">["color"];

/**
 * Pick the next palette entry for a freshly-imported repository so the
 * switcher row, top-bar avatar, and any future color-coded chrome share
 * one source. Round-robin over the eight-color palette by count.
 */
export async function pickNextRepositoryColor(
  ctx: QueryCtx | MutationCtx,
  ownerTokenIdentifier: string,
): Promise<RepositoryColor> {
  const rows = await ctx.db
    .query("repositories")
    .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", ownerTokenIdentifier))
    .take(50);
  return REPOSITORY_COLOR_PALETTE[rows.length % REPOSITORY_COLOR_PALETTE.length];
}

/**
 * Bump `lastAccessedAt` on a thread→repository attach so the switcher's
 * recency ordering reflects the touch. Used by `setThreadRepository` —
 * the import flow stamps the same field at insert time.
 */
export async function touchRepositoryLastAccessed(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<void> {
  await ctx.db.patch(args.repositoryId, { lastAccessedAt: Date.now() });
}
