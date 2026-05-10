import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type ArtifactKind = Doc<"artifacts">["kind"];
type ArtifactSource = Doc<"artifacts">["source"];

interface CreateArtifactArgs {
  threadId?: Id<"threads">;
  repositoryId?: Id<"repositories">;
  ownerTokenIdentifier: string;
  jobId?: Id<"jobs">;
  kind: ArtifactKind;
  title: string;
  summary: string;
  contentMarkdown: string;
  source: ArtifactSource;
  /**
   * Optional folder placement (Phase A folder model). The store re-reads
   * the folder before insert so callers can pass the id while this module
   * enforces folder existence, owner, and repository scope.
   */
  folderId?: Id<"artifactFolders">;
}

/**
 * Enforces the polymorphic-parent invariant from the PRD: every artifact must
 * belong to at least one of `thread` or `repository`. The schema makes both
 * fields `v.optional`, so this is the only place the rule is enforced.
 *
 * Exported so direct `ctx.db.insert('artifacts', …)` call sites that bypass
 * `createArtifactInternal` can still enforce the invariant in one place.
 */
export function validateParentPresence(
  threadId: Id<"threads"> | undefined,
  repositoryId: Id<"repositories"> | undefined,
) {
  if (!threadId && !repositoryId) {
    throw new Error("Artifact must have at least one parent: threadId or repositoryId");
  }
}

async function createArtifactInternal(ctx: MutationCtx, args: CreateArtifactArgs): Promise<Id<"artifacts">> {
  validateParentPresence(args.threadId, args.repositoryId);

  if (args.folderId) {
    const folder = await ctx.db.get(args.folderId);
    if (!folder || folder.ownerTokenIdentifier !== args.ownerTokenIdentifier) {
      throw new Error("Folder not found.");
    }
    if (!args.repositoryId) {
      throw new Error("Cannot place a repo-less artifact in a repository folder.");
    }
    if (folder.repositoryId !== args.repositoryId) {
      throw new Error("Cannot place an artifact in a folder from a different repository.");
    }
  }

  const now = Date.now();
  const artifactId = await ctx.db.insert("artifacts", {
    threadId: args.threadId,
    repositoryId: args.repositoryId,
    jobId: args.jobId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    kind: args.kind,
    title: args.title,
    summary: args.summary,
    contentMarkdown: args.contentMarkdown,
    source: args.source,
    version: 1,
    folderId: args.folderId,
    producedIn: args.source === "sandbox" ? "lab" : args.repositoryId ? "legacy" : "discuss",
    lastVerifiedAt: args.source === "sandbox" ? now : undefined,
    chunkingStatus: args.repositoryId ? "pending" : undefined,
  });
  if (args.repositoryId) {
    await ctx.scheduler.runAfter(0, internal.artifactIndexing.reindexArtifact, { artifactId });
  }
  return artifactId;
}

async function getArtifactInternal(ctx: QueryCtx, artifactId: Id<"artifacts">): Promise<Doc<"artifacts"> | null> {
  return await ctx.db.get(artifactId);
}

async function updateArtifactInternal(
  ctx: MutationCtx,
  artifactId: Id<"artifacts">,
  updates: { title?: string; summary?: string; contentMarkdown?: string },
): Promise<void> {
  const artifact = await ctx.db.get(artifactId);
  if (!artifact) {
    throw new Error("Artifact not found");
  }

  // Convex `patch` treats explicit `undefined` as "set field to undefined",
  // which fails validation for required string fields. Build the patch with
  // only the keys the caller actually provided.
  const patch: {
    title?: string;
    summary?: string;
    contentMarkdown?: string;
    version: number;
    chunkingStatus?: "pending";
  } = { version: artifact.version + 1 };
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.summary !== undefined) patch.summary = updates.summary;
  if (updates.contentMarkdown !== undefined) {
    patch.contentMarkdown = updates.contentMarkdown;
    if (artifact.repositoryId) {
      patch.chunkingStatus = "pending";
    }
  }

  await ctx.db.patch(artifactId, patch);
  if (artifact.repositoryId && updates.contentMarkdown !== undefined) {
    await ctx.scheduler.runAfter(0, internal.artifactIndexing.reindexArtifact, { artifactId });
  }
}

async function deleteArtifactInternal(ctx: MutationCtx, artifactId: Id<"artifacts">): Promise<void> {
  const PAGE_SIZE = 100;
  let hasMore = true;
  while (hasMore) {
    const chunks = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifactId_and_chunkIndex", (q) => q.eq("artifactId", artifactId))
      .take(PAGE_SIZE);
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }
    hasMore = chunks.length === PAGE_SIZE;
  }
  await ctx.db.delete(artifactId);
}

async function listByThreadInternal(
  ctx: QueryCtx,
  threadId: Id<"threads">,
  limit?: number,
): Promise<Doc<"artifacts">[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit ?? 100));
  return await ctx.db
    .query("artifacts")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(normalizedLimit);
}

async function listByThreadAndKindInternal(
  ctx: QueryCtx,
  threadId: Id<"threads">,
  kind: ArtifactKind,
  limit?: number,
): Promise<Doc<"artifacts">[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit ?? 100));
  return await ctx.db
    .query("artifacts")
    .withIndex("by_threadId_and_kind", (q) => q.eq("threadId", threadId).eq("kind", kind))
    .order("desc")
    .take(normalizedLimit);
}

async function listByRepositoryInternal(
  ctx: QueryCtx,
  repositoryId: Id<"repositories">,
  limit?: number,
): Promise<Doc<"artifacts">[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit ?? 100));
  return await ctx.db
    .query("artifacts")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .order("desc")
    .take(normalizedLimit);
}

async function listByRepositoryAndKindInternal(
  ctx: QueryCtx,
  repositoryId: Id<"repositories">,
  kind: ArtifactKind,
  limit?: number,
): Promise<Doc<"artifacts">[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit ?? 100));
  return await ctx.db
    .query("artifacts")
    .withIndex("by_repositoryId_and_kind", (q) => q.eq("repositoryId", repositoryId).eq("kind", kind))
    .order("desc")
    .take(normalizedLimit);
}

const artifactKindValidator = v.union(
  v.literal("manifest"),
  v.literal("readme_summary"),
  v.literal("architecture_overview"),
  v.literal("architecture_diagram"),
  v.literal("entrypoints"),
  v.literal("dependency_overview"),
  v.literal("deep_analysis"),
  v.literal("risk_report"),
  v.literal("adr"),
  v.literal("failure_mode_analysis"),
  v.literal("trade_off_matrix"),
  v.literal("migration_plan"),
  v.literal("capacity_estimate"),
  v.literal("design_review"),
);

const artifactSourceValidator = v.union(v.literal("heuristic"), v.literal("llm"), v.literal("sandbox"));

export const createArtifact = internalMutation({
  args: {
    threadId: v.optional(v.id("threads")),
    repositoryId: v.optional(v.id("repositories")),
    ownerTokenIdentifier: v.string(),
    jobId: v.optional(v.id("jobs")),
    kind: artifactKindValidator,
    title: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
    source: artifactSourceValidator,
    folderId: v.optional(v.id("artifactFolders")),
  },
  handler: (ctx, args) => createArtifactInternal(ctx, args),
});

export const getArtifact = internalQuery({
  args: { artifactId: v.id("artifacts") },
  handler: (ctx, args) => getArtifactInternal(ctx, args.artifactId),
});

export const updateArtifact = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    contentMarkdown: v.optional(v.string()),
  },
  handler: (ctx, args) =>
    updateArtifactInternal(ctx, args.artifactId, {
      title: args.title,
      summary: args.summary,
      contentMarkdown: args.contentMarkdown,
    }),
});

export const deleteArtifact = internalMutation({
  args: { artifactId: v.id("artifacts") },
  handler: (ctx, args) => deleteArtifactInternal(ctx, args.artifactId),
});

export const markChunkingStatus = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    status: v.union(v.literal("pending"), v.literal("indexed"), v.literal("failed")),
    version: v.number(),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.version !== args.version) {
      return { patched: false };
    }
    await ctx.db.patch(args.artifactId, {
      chunkingStatus: args.status,
      lastChunkedAt: Date.now(),
      lastChunkedVersion: args.version,
    });
    return { patched: true };
  },
});

export const markVerified = internalMutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) {
      return { patched: false };
    }
    await ctx.db.patch(args.artifactId, {
      producedIn: "lab",
      lastVerifiedAt: Date.now(),
    });
    return { patched: true };
  },
});

export const listByThread = internalQuery({
  args: { threadId: v.id("threads"), limit: v.optional(v.number()) },
  handler: (ctx, args) => listByThreadInternal(ctx, args.threadId, args.limit),
});

export const listByThreadAndKind = internalQuery({
  args: { threadId: v.id("threads"), kind: artifactKindValidator, limit: v.optional(v.number()) },
  handler: (ctx, args) => listByThreadAndKindInternal(ctx, args.threadId, args.kind, args.limit),
});

export const listByRepository = internalQuery({
  args: { repositoryId: v.id("repositories"), limit: v.optional(v.number()) },
  handler: (ctx, args) => listByRepositoryInternal(ctx, args.repositoryId, args.limit),
});

export const listByRepositoryAndKind = internalQuery({
  args: { repositoryId: v.id("repositories"), kind: artifactKindValidator, limit: v.optional(v.number()) },
  handler: (ctx, args) => listByRepositoryAndKindInternal(ctx, args.repositoryId, args.kind, args.limit),
});

export const listFailedArtifactsForReindex = internalQuery({
  args: { cutoff: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.floor(args.limit));
    const overfetchLimit = Math.min(Math.max(1, Math.floor(limit * 5)), 1000);
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_chunkingStatus", (q) => q.eq("chunkingStatus", "failed"))
      .take(overfetchLimit);
    return rows
      .filter((artifact) => (artifact.lastChunkedAt ?? 0) < args.cutoff && artifact.repositoryId)
      .slice(0, limit);
  },
});

export const listPendingArtifactsForReindex = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_chunkingStatus", (q) => q.eq("chunkingStatus", "pending"))
      .take(Math.max(1, Math.floor(args.limit)));
    return rows.filter((artifact) => artifact.repositoryId);
  },
});
