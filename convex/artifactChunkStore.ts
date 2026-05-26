import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { MAX_ARTIFACT_CHUNKS_PER_ARTIFACT } from "./lib/artifactChunking";

const chunkValidator = v.object({
  headingPath: v.array(v.string()),
  startOffset: v.number(),
  endOffset: v.number(),
  content: v.string(),
  summary: v.optional(v.string()),
});

const embeddingValidator = v.object({
  chunkIndex: v.number(),
  embedding: v.array(v.float64()),
});

export type ArtifactChunkSearchHit = {
  chunkId: Id<"artifactChunks">;
  artifactId: Id<"artifacts">;
  artifactVersion: number;
  chunkIndex: number;
  headingPath: string[];
  content: string;
  summary?: string;
  artifactTitle: string;
  artifactKind: Doc<"artifacts">["kind"];
  lexicalScore: number;
};

export type ArtifactChunkRecord = Omit<ArtifactChunkSearchHit, "lexicalScore">;

async function loadArtifactWorkspace(
  ctx: QueryCtx | MutationCtx,
  artifact: Doc<"artifacts">,
): Promise<{ workspaceId: Id<"workspaces">; repositoryId: Id<"repositories"> } | null> {
  const repositoryId = artifact.repositoryId;
  if (!repositoryId) {
    return null;
  }
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
      q.eq("ownerTokenIdentifier", artifact.ownerTokenIdentifier).eq("repositoryId", repositoryId),
    )
    .first();
  if (!workspace) {
    return null;
  }
  return { workspaceId: workspace._id, repositoryId };
}

async function buildChunkRecord(
  ctx: QueryCtx,
  chunk: Doc<"artifactChunks">,
  lexicalScore: number,
): Promise<ArtifactChunkSearchHit | null> {
  const artifact = await ctx.db.get(chunk.artifactId);
  if (!artifact) {
    return null;
  }
  return {
    chunkId: chunk._id,
    artifactId: chunk.artifactId,
    artifactVersion: chunk.artifactVersion,
    chunkIndex: chunk.chunkIndex,
    headingPath: chunk.headingPath,
    content: chunk.content,
    summary: chunk.summary,
    artifactTitle: artifact.title,
    artifactKind: artifact.kind,
    lexicalScore,
  };
}

export const replaceChunksForArtifact = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    artifactVersion: v.number(),
    chunks: v.array(chunkValidator),
  },
  handler: async (ctx, args) => {
    if (args.chunks.length > MAX_ARTIFACT_CHUNKS_PER_ARTIFACT) {
      throw new Error(`Artifact chunk count exceeds ${MAX_ARTIFACT_CHUNKS_PER_ARTIFACT}.`);
    }

    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.version !== args.artifactVersion) {
      return { replaced: false, reason: "stale_artifact" as const };
    }
    const workspace = await loadArtifactWorkspace(ctx, artifact);
    if (!workspace) {
      await ctx.db.patch(args.artifactId, {
        chunkingStatus: "failed",
        lastChunkedAt: Date.now(),
        lastChunkedVersion: args.artifactVersion,
      });
      return { replaced: false, reason: "missing_workspace" as const };
    }

    const existing = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifactId_and_chunkIndex", (q) => q.eq("artifactId", args.artifactId))
      .take(MAX_ARTIFACT_CHUNKS_PER_ARTIFACT + 1);
    for (const chunk of existing) {
      await ctx.db.delete(chunk._id);
    }

    for (const [index, chunk] of args.chunks.entries()) {
      await ctx.db.insert("artifactChunks", {
        ownerTokenIdentifier: artifact.ownerTokenIdentifier,
        workspaceId: workspace.workspaceId,
        repositoryId: workspace.repositoryId,
        artifactId: args.artifactId,
        artifactVersion: args.artifactVersion,
        chunkIndex: index,
        headingPath: chunk.headingPath,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        content: chunk.content,
        summary: chunk.summary,
      });
    }

    await ctx.db.patch(args.artifactId, {
      lastChunkedAt: Date.now(),
      lastChunkedVersion: args.artifactVersion,
    });
    return { replaced: true, count: args.chunks.length };
  },
});

export const batchSetEmbeddings = internalMutation({
  args: {
    artifactId: v.id("artifacts"),
    artifactVersion: v.number(),
    embeddings: v.array(embeddingValidator),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.version !== args.artifactVersion) {
      return { patched: 0, skipped: true };
    }

    let patched = 0;
    for (const item of args.embeddings) {
      const chunk = await ctx.db
        .query("artifactChunks")
        .withIndex("by_artifactId_and_chunkIndex", (q) =>
          q.eq("artifactId", args.artifactId).eq("chunkIndex", item.chunkIndex),
        )
        .unique();
      if (chunk && chunk.artifactVersion === args.artifactVersion) {
        await ctx.db.patch(chunk._id, { embedding: item.embedding });
        patched += 1;
      }
    }
    return { patched, skipped: false };
  },
});

export const deleteChunksForArtifact = internalMutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifactId_and_chunkIndex", (q) => q.eq("artifactId", args.artifactId))
      .take(MAX_ARTIFACT_CHUNKS_PER_ARTIFACT + 1);
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }
    return { deleted: chunks.length };
  },
});

export const searchContent = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    query: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("artifactChunks")
      .withSearchIndex("search_content", (q) => q.search("content", args.query).eq("repositoryId", args.repositoryId))
      .take(args.limit);
    const hits = await Promise.all(rows.map((row, index) => buildChunkRecord(ctx, row, 1 / (index + 1))));
    return hits.filter((hit): hit is ArtifactChunkSearchHit => hit !== null);
  },
});

export const searchSummary = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    query: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("artifactChunks")
      .withSearchIndex("search_summary", (q) => q.search("summary", args.query).eq("repositoryId", args.repositoryId))
      .take(args.limit);
    const hits = await Promise.all(rows.map((row, index) => buildChunkRecord(ctx, row, 1 / (index + 1))));
    return hits.filter((hit): hit is ArtifactChunkSearchHit => hit !== null);
  },
});

export const getChunksByIds = internalQuery({
  args: { chunkIds: v.array(v.id("artifactChunks")) },
  handler: async (ctx, args) => {
    const rows = await Promise.all(args.chunkIds.map((chunkId) => ctx.db.get(chunkId)));
    const hits = await Promise.all(
      rows.filter((row): row is Doc<"artifactChunks"> => row !== null).map((row) => buildChunkRecord(ctx, row, 0)),
    );
    return hits.filter((hit): hit is ArtifactChunkSearchHit => hit !== null);
  },
});

export const getChunksByArtifact = internalQuery({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifactId_and_chunkIndex", (q) => q.eq("artifactId", args.artifactId))
      .take(MAX_ARTIFACT_CHUNKS_PER_ARTIFACT);
  },
});
