import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";

/**
 * Per-viewer "I have seen this artifact" state.
 *
 * Powers the Library navigator's "changed since you last looked" dot.
 * State lives in Convex (not localStorage) so it follows the signed-in
 * viewer across devices and survives browser-storage clears. See the
 * `artifactViews` schema docstring for the data shape.
 */

/**
 * Record that the viewer activated an artifact tab. Idempotent — calling
 * with the same id repeatedly just refreshes `viewedAt` to the latest
 * wall-clock time, which is what we want for "I just re-read it".
 *
 * `repositoryId` is accepted as an argument (and validated against the
 * artifact's actual repo) so the optimistic update on the client can
 * target the per-repo `listViewStateByRepository` query without a
 * round-trip to discover which repo the artifact belongs to.
 */
export const markViewed = mutation({
  args: {
    artifactId: v.id("artifacts"),
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.ownerTokenIdentifier !== identity.tokenIdentifier) {
      // Silent no-op for unknown / unowned artifacts — the navigator can
      // race a delete and we'd rather skip than surface a user-visible
      // error for a state-only write.
      return null;
    }
    if (artifact.repositoryId !== args.repositoryId) {
      // The caller lied about which repo the artifact is in. Reject so
      // the optimistic update can't poison the wrong per-repo query.
      throw new Error("Artifact does not belong to the specified repository.");
    }

    const existing = await ctx.db
      .query("artifactViews")
      .withIndex("by_ownerTokenIdentifier_and_artifactId", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("artifactId", args.artifactId),
      )
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { viewedAt: now });
    } else {
      await ctx.db.insert("artifactViews", {
        ownerTokenIdentifier: identity.tokenIdentifier,
        repositoryId: args.repositoryId,
        artifactId: args.artifactId,
        viewedAt: now,
      });
    }
    return null;
  },
});

/**
 * Idempotent insert of the viewer's first-open anchor for a repository.
 *
 * Called by `useArtifactViewState` on first render when the query
 * reports `bootstrapPending: true`. Subsequent calls (across tabs,
 * concurrent mounts, reloads) all see the existing row and no-op, so
 * the anchor timestamp captures the moment the viewer *actually*
 * first saw the Library — not the moment of any later replay.
 */
export const ensureRepositoryBootstrap = mutation({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }
    const existing = await ctx.db
      .query("repositoryViewerBootstraps")
      .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("repositoryId", args.repositoryId),
      )
      .unique();
    if (existing) return null;
    await ctx.db.insert("repositoryViewerBootstraps", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: args.repositoryId,
      bootstrapAt: Date.now(),
    });
    return null;
  },
});

/**
 * Per-repository view state for the signed-in viewer.
 *
 * Returns:
 *   - `bootstrap` — floor below which artifacts are treated as
 *     "already seen". Sourced from the `repositoryViewerBootstraps`
 *     anchor when it exists; otherwise a conservative placeholder
 *     (`repository._creationTime`) paired with `bootstrapPending: true`
 *     so the client suppresses dots until it follows up with
 *     `ensureRepositoryBootstrap`.
 *   - `views` — map from `artifactId` → `viewedAt` ms epoch. Sparse:
 *     only artifacts the viewer has actually opened appear here.
 *   - `bootstrapPending` — true exactly when the anchor row has not been
 *     written yet. The navigator must suppress dots while this is true
 *     because the `bootstrap` field is a placeholder, not the truth.
 *
 * Returns the same shape for unowned or missing repositories so the
 * client doesn't need to special-case null. The auth check still
 * happens — `bootstrap: 0` and `bootstrapPending: false` means "never
 * show dots" because every artifact's `lastChangedAt` is greater than 0.
 */
export const listViewStateByRepository = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return { bootstrap: 0, views: {} as Record<string, number>, bootstrapPending: false };
    }

    const bootstrapRow = await ctx.db
      .query("repositoryViewerBootstraps")
      .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("repositoryId", args.repositoryId),
      )
      .unique();

    const records = await ctx.db
      .query("artifactViews")
      .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier).eq("repositoryId", args.repositoryId),
      )
      .collect();

    const views: Record<string, number> = {};
    for (const record of records) {
      views[record.artifactId] = record.viewedAt;
    }

    if (bootstrapRow) {
      return { bootstrap: bootstrapRow.bootstrapAt, views, bootstrapPending: false };
    }
    return { bootstrap: repository._creationTime, views, bootstrapPending: true };
  },
});
