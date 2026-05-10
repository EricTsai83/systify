import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { replaceArtifactFolder } from "./lib/artifactWrites";

const ARTIFACTS_PER_THREAD_LIMIT = 40;
const ARTIFACTS_PER_FOLDER_LIMIT = 200;
const ARTIFACTS_PER_REPOSITORY_LIMIT = 200;

/**
 * Public, owner-scoped list of artifacts attached to a thread.
 *
 * Drives the right-rail ArtifactPanel (PRD #19, US 23 — "all artifacts
 * associated with a thread visible in a side panel"). The internal
 * `artifactStore.listByThread` is kept private because it skips ownership
 * checks; this query is the public-facing entry point.
 *
 * The repository-scoped artifact list still lives on
 * `repositories.getRepositoryDetail` and is used by the repository overview
 * tab; threads-vs-repositories is the primary axis the UI cares about.
 */
export const listByThread = query({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }

    return await ctx.db
      .query("artifacts")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(ARTIFACTS_PER_THREAD_LIMIT);
  },
});

/**
 * Owner-scoped fetch of a single artifact. Drives the standalone Reader
 * route (`/w/:wid/a/:aid`) which needs the artifact synchronously without
 * having to know its parent thread or repo up front. Returns `null` when
 * the artifact does not exist or the viewer does not own it — the caller
 * is expected to render a not-found state rather than throw, so a stale
 * URL doesn't surface as an error boundary.
 */
export const getById = query({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }
    return artifact;
  },
});

/**
 * Owner-scoped, repo-scoped artifact listing. Returns *all* artifacts
 * attached to a repository (across every thread + the repo-level rows the
 * pipeline writes) so the FolderNavigator can render the complete folder
 * tree, not just the small slice `getRepositoryDetail` carries for its
 * status surface. Bounded at 200 rows — beyond that the navigator
 * paginates by folder via {@link listByFolder}.
 */
export const listByRepository = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return [];
    }
    return await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(ARTIFACTS_PER_REPOSITORY_LIMIT);
  },
});

/**
 * Owner-scoped artifact listing inside a folder. Used by the folder
 * navigator's "expand folder" path and the FolderOverview's contents list.
 * Sorted ascending by `_creationTime` so artifact order matches creation
 * order (predictable for sibling navigation in the Reader).
 */
export const listByFolder = query({
  args: { folderId: v.id("artifactFolders") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const folder = await ctx.db.get(args.folderId);
    if (!folder || folder.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return [];
    }
    return await ctx.db
      .query("artifacts")
      .withIndex("by_folderId", (q) => q.eq("folderId", args.folderId))
      .order("asc")
      .take(ARTIFACTS_PER_FOLDER_LIMIT);
  },
});

/**
 * Owner-scoped listing of artifacts that have no folder, scoped to a
 * repository. Powers the navigator's virtual "Uncategorized" node — the
 * landing place for legacy (pre-folder) artifacts and any artifact whose
 * folder was deleted with `moveContentsToParent` while at root.
 *
 * Repo-level kinds (manifest, deep_analysis, …) are intentionally excluded
 * here because they have a dedicated "Repository" root section in the
 * navigator. The caller decides which kinds belong in "Uncategorized";
 * we surface the raw list and let the UI filter.
 */
export const listUncategorizedByRepository = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return [];
    }
    return await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId_and_folderId", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("folderId", undefined),
      )
      .order("desc")
      .take(ARTIFACTS_PER_FOLDER_LIMIT);
  },
});

/**
 * Move a single artifact into another folder, or to root when `folderId`
 * is null. The artifact's repository scope is enforced — moving across
 * repositories is rejected to keep the folder tree internally consistent.
 */
export const moveToFolder = mutation({
  args: {
    artifactId: v.id("artifacts"),
    folderId: v.union(v.id("artifactFolders"), v.null()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Artifact not found.");
    }

    let nextFolderId: Id<"artifactFolders"> | undefined;
    if (args.folderId !== null) {
      const folder = await ctx.db.get(args.folderId);
      if (!folder || folder.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Folder not found.");
      }
      if (artifact.repositoryId && folder.repositoryId !== artifact.repositoryId) {
        throw new Error("Cannot move an artifact across repositories.");
      }
      nextFolderId = folder._id;
    }

    if ((artifact.folderId ?? undefined) === nextFolderId) {
      return null;
    }

    await replaceArtifactFolder(ctx, artifact, nextFolderId);
    return null;
  },
});
