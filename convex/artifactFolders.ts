import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { requireActiveRepositoryForOwner } from "./lib/repositoryAccess";
import { replaceArtifactFolder } from "./lib/artifactWrites";

const FOLDERS_PER_REPO_LIMIT = 200;
const ARTIFACTS_PER_FOLDER_LIMIT = 200;
const FOLDER_NAME_MAX_LENGTH = 80;
const FOLDER_DESCRIPTION_MAX_LENGTH = 400;

function normalizeFolderName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Folder name cannot be empty.");
  }
  if (trimmed.length > FOLDER_NAME_MAX_LENGTH) {
    throw new Error(`Folder name must be at most ${FOLDER_NAME_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

function normalizeFolderDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > FOLDER_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`Folder description must be at most ${FOLDER_DESCRIPTION_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

async function loadFolderForOwner(
  ctx: QueryCtx | MutationCtx,
  args: { folderId: Id<"artifactFolders">; ownerTokenIdentifier: string },
): Promise<Doc<"artifactFolders">> {
  const folder = await ctx.db.get(args.folderId);
  if (!folder || folder.ownerTokenIdentifier !== args.ownerTokenIdentifier) {
    throw new Error("Folder not found.");
  }
  return folder;
}

/**
 * Walks `parentFolderId` ancestry and throws if `prospectiveAncestorId` ever
 * appears — i.e. moving `folder` under `prospectiveAncestorId` would create
 * a cycle. Bounded by the per-repo folder cap to keep the loop finite even
 * if the data ever drifts inconsistent.
 */
async function ensureNoCycle(
  ctx: QueryCtx | MutationCtx,
  args: {
    folderId: Id<"artifactFolders">;
    prospectiveParentId: Id<"artifactFolders"> | undefined;
  },
) {
  if (!args.prospectiveParentId) return;
  if (args.prospectiveParentId === args.folderId) {
    throw new Error("A folder cannot be its own parent.");
  }
  let cursor: Id<"artifactFolders"> | undefined = args.prospectiveParentId;
  let hops = 0;
  while (cursor && hops < FOLDERS_PER_REPO_LIMIT) {
    if (cursor === args.folderId) {
      throw new Error("Cannot move a folder into one of its descendants.");
    }
    const ancestor: Doc<"artifactFolders"> | null = await ctx.db.get(cursor);
    if (!ancestor) return;
    cursor = ancestor.parentFolderId ?? undefined;
    hops += 1;
  }
}

async function nextSortOrder(
  ctx: QueryCtx | MutationCtx,
  args: { repositoryId: Id<"repositories">; parentFolderId: Id<"artifactFolders"> | undefined },
): Promise<number> {
  const siblings = await ctx.db
    .query("artifactFolders")
    .withIndex("by_repositoryId_and_parentFolderId", (q) =>
      q.eq("repositoryId", args.repositoryId).eq("parentFolderId", args.parentFolderId),
    )
    .take(FOLDERS_PER_REPO_LIMIT);
  let max = 0;
  for (const sibling of siblings) {
    if (typeof sibling.sortOrder === "number" && sibling.sortOrder > max) {
      max = sibling.sortOrder;
    }
  }
  return max + 1;
}

/**
 * Public, owner-scoped listing of every folder in a repository. Returned
 * flat — the frontend builds the tree from `parentFolderId` and computes
 * visible child counts from the artifact metadata it already loaded. Keeping
 * this query folder-only avoids an N+1 artifact scan on every Library render.
 */
export const listByRepository = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const { identity } = await requireActiveRepositoryForOwnerOrNull(ctx, args.repositoryId);
    if (!identity) return [];

    const folders = await ctx.db
      .query("artifactFolders")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .take(FOLDERS_PER_REPO_LIMIT);

    return folders.map((folder) => ({
      _id: folder._id,
      _creationTime: folder._creationTime,
      repositoryId: folder.repositoryId,
      parentFolderId: folder.parentFolderId,
      name: folder.name,
      description: folder.description,
      sortOrder: folder.sortOrder,
      systemKey: folder.systemKey,
    }));
  },
});

/**
 * Owner-scoped fetch of a single folder. Used by the Reader's breadcrumb
 * resolution path (folderId → folder → parent chain).
 */
export const getById = query({
  args: { folderId: v.id("artifactFolders") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const folder = await ctx.db.get(args.folderId);
    if (!folder || folder.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }
    return folder;
  },
});

export const create = mutation({
  args: {
    repositoryId: v.id("repositories"),
    parentFolderId: v.optional(v.id("artifactFolders")),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    await requireActiveRepositoryForOwner(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    if (args.parentFolderId) {
      const parent = await loadFolderForOwner(ctx, {
        folderId: args.parentFolderId,
        ownerTokenIdentifier: identity.tokenIdentifier,
      });
      if (parent.repositoryId !== args.repositoryId) {
        throw new Error("Parent folder belongs to a different repository.");
      }
    }

    const sortOrder = await nextSortOrder(ctx, {
      repositoryId: args.repositoryId,
      parentFolderId: args.parentFolderId,
    });

    const folderId = await ctx.db.insert("artifactFolders", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: args.repositoryId,
      parentFolderId: args.parentFolderId,
      name: normalizeFolderName(args.name),
      description: normalizeFolderDescription(args.description),
      sortOrder,
    });

    return folderId;
  },
});

export const rename = mutation({
  args: {
    folderId: v.id("artifactFolders"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const folder = await loadFolderForOwner(ctx, {
      folderId: args.folderId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    const patch: { name?: string; description?: string | undefined } = {};
    if (args.name !== undefined) {
      patch.name = normalizeFolderName(args.name);
    }
    if (args.description !== undefined) {
      patch.description = normalizeFolderDescription(args.description);
    }
    if (Object.keys(patch).length === 0) return null;
    await ctx.db.patch(folder._id, patch);
    return null;
  },
});

export const move = mutation({
  args: {
    folderId: v.id("artifactFolders"),
    parentFolderId: v.optional(v.id("artifactFolders")),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const folder = await loadFolderForOwner(ctx, {
      folderId: args.folderId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    if (args.parentFolderId) {
      const parent = await loadFolderForOwner(ctx, {
        folderId: args.parentFolderId,
        ownerTokenIdentifier: identity.tokenIdentifier,
      });
      if (parent.repositoryId !== folder.repositoryId) {
        throw new Error("Cannot move a folder across repositories.");
      }
      await ensureNoCycle(ctx, { folderId: folder._id, prospectiveParentId: parent._id });
    }

    if (folder.parentFolderId === args.parentFolderId) return null;

    const sortOrder = await nextSortOrder(ctx, {
      repositoryId: folder.repositoryId,
      parentFolderId: args.parentFolderId,
    });

    await ctx.db.patch(folder._id, {
      parentFolderId: args.parentFolderId,
      sortOrder,
    });
    return null;
  },
});

const deleteStrategy = v.union(v.literal("moveContentsToParent"), v.literal("deleteContents"));

/**
 * Two delete modes:
 *   - `moveContentsToParent` — child folders adopt this folder's parent (or
 *     become root if there is none); artifacts have their `folderId` cleared
 *     when this folder is at root, otherwise re-pointed at the parent. Safe
 *     default for the navigator's "Delete folder" action.
 *   - `deleteContents` — recursively deletes child folders and unsets
 *     `folderId` on the artifacts. The artifacts themselves are NOT deleted
 *     — folders are organisational, the source of truth is the artifact row.
 *
 * Bounded by `FOLDERS_PER_REPO_LIMIT` and the artifact-per-folder cap so a
 * single mutation cannot blow the transaction budget. Larger trees can be
 * supported later by paginating over recursion.
 */
export const remove = mutation({
  args: {
    folderId: v.id("artifactFolders"),
    strategy: deleteStrategy,
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const folder = await loadFolderForOwner(ctx, {
      folderId: args.folderId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    if (args.strategy === "moveContentsToParent") {
      const newParentId = folder.parentFolderId;
      const childFolders = await ctx.db
        .query("artifactFolders")
        .withIndex("by_repositoryId_and_parentFolderId", (q) =>
          q.eq("repositoryId", folder.repositoryId).eq("parentFolderId", folder._id),
        )
        .take(FOLDERS_PER_REPO_LIMIT);
      for (const child of childFolders) {
        await ctx.db.patch(child._id, {
          parentFolderId: newParentId,
        });
      }
      const ownArtifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_folderId", (q) => q.eq("folderId", folder._id))
        .take(ARTIFACTS_PER_FOLDER_LIMIT);
      for (const artifact of ownArtifacts) {
        await replaceArtifactFolder(ctx, artifact, newParentId);
      }
    } else {
      // deleteContents — recurse. Bounded by `FOLDERS_PER_REPO_LIMIT`.
      const stack: Id<"artifactFolders">[] = [folder._id];
      const collected: Id<"artifactFolders">[] = [];
      while (stack.length > 0 && collected.length < FOLDERS_PER_REPO_LIMIT) {
        const current = stack.pop();
        if (!current) break;
        collected.push(current);
        const children = await ctx.db
          .query("artifactFolders")
          .withIndex("by_repositoryId_and_parentFolderId", (q) =>
            q.eq("repositoryId", folder.repositoryId).eq("parentFolderId", current),
          )
          .take(FOLDERS_PER_REPO_LIMIT);
        for (const child of children) {
          stack.push(child._id);
        }
      }
      // Detect overflow: if the DFS collected < limit but stack is non-empty,
      // or if we stopped due to reaching the limit, there are unprocessed
      // descendants. Abort before any writes to prevent partial deletes.
      if (stack.length > 0 || collected.length >= FOLDERS_PER_REPO_LIMIT) {
        throw new Error(
          "Folder subtree exceeds the per-repository limit; cannot delete all descendants in one operation.",
        );
      }
      // Unset `folderId` on every artifact in the deleted subtree, then
      // delete the folders themselves (deepest-first by virtue of the stack
      // being a DFS — but order doesn't matter for unset+delete).
      for (const id of collected) {
        const ownArtifacts = await ctx.db
          .query("artifacts")
          .withIndex("by_folderId", (q) => q.eq("folderId", id))
          .take(ARTIFACTS_PER_FOLDER_LIMIT);
        for (const artifact of ownArtifacts) {
          await replaceArtifactFolder(ctx, artifact, undefined);
        }
        // The root of `stack` is `folder._id`, which we still want to delete.
        if (id !== folder._id) {
          await ctx.db.delete(id);
        }
      }
    }

    await ctx.db.delete(folder._id);
    return null;
  },
});

/**
 * Internal helper: returns the viewer's identity *if* they own the
 * repository, else `null`. Avoids throwing on the read path so the
 * navigator's first paint can soft-fail to "no folders" instead of an
 * error boundary when the repo id in the URL went stale.
 */
async function requireActiveRepositoryForOwnerOrNull(
  ctx: QueryCtx,
  repositoryId: Id<"repositories">,
): Promise<{ identity: Awaited<ReturnType<typeof requireViewerIdentity>> | null }> {
  const identity = await requireViewerIdentity(ctx);
  const repository = await ctx.db.get(repositoryId);
  if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
    return { identity: null };
  }
  return { identity };
}
