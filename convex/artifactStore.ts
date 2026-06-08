import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import {
  createArtifactWrite,
  deleteArtifactWrite,
  markArtifactChunkingStatusWrite,
  updateArtifactWrite,
} from "./lib/artifactWrites";
import { llmProviderValidator } from "./lib/llmProvider";

type ArtifactKind = Doc<"artifacts">["kind"];

async function getArtifactInternal(ctx: QueryCtx, artifactId: Id<"artifacts">): Promise<Doc<"artifacts"> | null> {
  return await ctx.db.get(artifactId);
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
  v.literal("readme_summary"),
  v.literal("architecture_overview"),
  v.literal("architecture_diagram"),
  v.literal("entrypoints"),
  v.literal("dependency_overview"),
  v.literal("trade_off_matrix"),
  v.literal("migration_plan"),
  v.literal("capacity_estimate"),
  v.literal("design_review"),
  v.literal("data_model_overview"),
  v.literal("api_surface_overview"),
  v.literal("deployment_overview"),
  v.literal("security_overview"),
  v.literal("operations_overview"),
  v.literal("custom_document"),
);

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
    folderId: v.optional(v.id("artifactFolders")),
    generatedByProvider: v.optional(llmProviderValidator),
    generatedByModel: v.optional(v.string()),
    promptVersion: v.optional(v.number()),
    kindRunId: v.optional(v.id("systemDesignKindRuns")),
  },
  handler: (ctx, args) => createArtifactWrite(ctx, args),
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
    expectedVersion: v.optional(v.number()),
    lastVerifiedAt: v.optional(v.number()),
    alignedImportCommitSha: v.optional(v.string()),
    generatedByProvider: v.optional(llmProviderValidator),
    generatedByModel: v.optional(v.string()),
    promptVersion: v.optional(v.number()),
  },
  handler: (ctx, args) => updateArtifactWrite(ctx, args),
});

export const deleteArtifact = internalMutation({
  args: { artifactId: v.id("artifacts") },
  handler: (ctx, args) => deleteArtifactWrite(ctx, args.artifactId),
});

export const markChunkingStatus = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    status: v.union(v.literal("pending"), v.literal("indexed"), v.literal("failed")),
    version: v.number(),
    failureReason: v.optional(
      v.union(v.literal("embedding_failed"), v.literal("usage_budget_exceeded"), v.literal("feature_not_included")),
    ),
  },
  handler: (ctx, args) => markArtifactChunkingStatusWrite(ctx, args),
});

export const markVerified = internalMutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) {
      return { patched: false };
    }
    await ctx.db.patch(args.artifactId, {
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
      .filter(
        (artifact) =>
          (artifact.lastChunkedAt ?? 0) < args.cutoff &&
          artifact.repositoryId &&
          artifact.chunkingFailureReason !== "feature_not_included",
      )
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
