import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { deleteArtifactInternal } from "./artifactStore";
import { loadOwnedDoc, requireOwnedDoc } from "./lib/ownedDocs";
import { MAX_ARTIFACT_TITLE_LENGTH } from "./lib/artifactDefaults";
import { replaceArtifactFolder } from "./lib/artifactWrites";
import { resolveLatestImportSha, toArtifactMetadataView, toArtifactView } from "./lib/artifactView";

const ARTIFACTS_PER_THREAD_LIMIT = 40;
const ARTIFACTS_PER_FOLDER_LIMIT = 200;
const ARTIFACTS_PER_REPOSITORY_LIMIT = 200;

/**
 * Public, owner-scoped list of artifacts attached to a thread.
 *
 * Drives the right-rail ArtifactPanel. The internal
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
    await requireOwnedDoc(ctx, args.threadId, { notFoundMessage: "Thread not found." });

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
 *
 * Includes computed `freshness` so the Reader can surface verification
 * status inline with the artifact metadata. The value is a snapshot at
 * query-evaluation time, not a live subscription to wall-clock time —
 * if the user keeps a tab open for days, freshness may drift; navigating
 * away and back re-evaluates.
 */
export const getById = query({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const { doc: artifact } = await loadOwnedDoc(ctx, args.artifactId);
    if (!artifact) {
      return null;
    }
    const now = Date.now();
    let latestImportSha: string | undefined;
    if (artifact.repositoryId) {
      const repository = await ctx.db.get(artifact.repositoryId);
      if (repository) {
        latestImportSha = await resolveLatestImportSha(ctx, repository);
      }
    }
    return toArtifactView(artifact, { now, latestImportSha });
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
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
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
 * Repository artifact listing with freshness metadata.
 *
 * Freshness is derived from sandbox-grounded verification only: artifacts produced
 * outside a sandbox-grounded reply are deliberately `unverified` even when they were
 * recently created, because Library must not imply that snapshots match
 * live code.
 */
export const listByRepositoryWithFreshness = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return [];
    }

    const now = Date.now();
    const latestImportSha = await resolveLatestImportSha(ctx, repository);
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(ARTIFACTS_PER_REPOSITORY_LIMIT);

    return artifacts.map((artifact) => toArtifactView(artifact, { now, latestImportSha }));
  },
});

/**
 * Metadata-only Library listing. Tree, tabs, and quick-open do not need the
 * markdown body; keeping `contentMarkdown` out of this subscription avoids
 * large read payloads and unnecessary invalidation when artifact bodies change.
 */
export const listMetadataByRepositoryWithFreshness = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
      return [];
    }

    const now = Date.now();
    const latestImportSha = await resolveLatestImportSha(ctx, repository);
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .order("desc")
      .take(ARTIFACTS_PER_REPOSITORY_LIMIT);

    return artifacts.map((artifact) => toArtifactMetadataView(artifact, { now, latestImportSha }));
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
    const { doc: folder } = await loadOwnedDoc(ctx, args.folderId);
    if (!folder) {
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
 * Repo-level kinds (manifest, architecture_overview, …) are intentionally excluded
 * here because they have a dedicated "Repository" root section in the
 * navigator. The caller decides which kinds belong in "Uncategorized";
 * we surface the raw list and let the UI filter.
 */
export const listUncategorizedByRepository = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const { doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
    if (!repository) {
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
    const { doc: artifact } = await requireOwnedDoc(ctx, args.artifactId, {
      notFoundMessage: "Artifact not found.",
    });

    let nextFolderId: Id<"artifactFolders"> | undefined;
    if (args.folderId !== null) {
      const { doc: folder } = await requireOwnedDoc(ctx, args.folderId, {
        notFoundMessage: "Folder not found.",
      });
      if (!artifact.repositoryId && folder.repositoryId) {
        throw new Error("Cannot move a repo-less artifact into a repository-scoped folder.");
      }
      if (artifact.repositoryId && folder.repositoryId !== artifact.repositoryId) {
        throw new Error("Cannot move an artifact to a folder from a different repository.");
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

/**
 * Manual artifact rename, driven by the FolderNavigator's right-click
 * context menu in Library Mode (inline edit, Enter / blur to commit, Esc to
 * cancel). Mirrors the thread-rename surface — the user-edit signal lives
 * on the title field itself, so renaming bumps `version` + `updatedAt` so
 * downstream readers (the Reader's freshness pill, RAG callers that pull
 * `artifact.title` at read time) see the new value immediately.
 *
 * Chunks store the title by reference (`buildChunkRecord` reads it live
 * from the artifact), so no chunk rewrite is necessary on rename — the
 * next search hit picks up the new title automatically.
 *
 * Errors use the structured `ConvexError({ code, message })` shape so
 * `toUserErrorMessage` on the client extracts a clean toast from
 * `error.data.message` rather than the transport-wrapped `error.message`.
 */
export const rename = mutation({
  args: {
    artifactId: v.id("artifacts"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const { doc: artifact } = await requireOwnedDoc(ctx, args.artifactId, {
      notFoundMessage: "Artifact not found.",
    });
    const trimmed = args.title.trim();
    if (trimmed.length === 0) {
      throw new ConvexError({
        code: "INVALID_TITLE",
        message: "Title cannot be empty.",
      });
    }
    if (trimmed.length > MAX_ARTIFACT_TITLE_LENGTH) {
      throw new ConvexError({
        code: "INVALID_TITLE",
        message: `Title must be at most ${MAX_ARTIFACT_TITLE_LENGTH} characters.`,
      });
    }
    if (artifact.title === trimmed) {
      return null;
    }
    await ctx.db.patch(artifact._id, {
      title: trimmed,
      version: artifact.version + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Permanent artifact delete. Drives the FolderNavigator's right-click
 * "Delete" affordance. Cascades through `deleteArtifactInternal` so the
 * artifact's chunks (`artifactChunks`) and per-viewer view rows
 * (`artifactViews`) are removed in the same transaction — leaving them
 * behind would surface as ghost hits in RAG search and stale unread dots
 * in the navigator.
 */
export const remove = mutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    await requireOwnedDoc(ctx, args.artifactId, {
      notFoundMessage: "Artifact not found.",
    });
    await deleteArtifactInternal(ctx, args.artifactId);
    return null;
  },
});
