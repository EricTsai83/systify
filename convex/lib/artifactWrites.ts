import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { LlmProvider } from "./llmProvider";
import { assertOwnedBy } from "./ownedDocs";

type ArtifactKind = Doc<"artifacts">["kind"];
type ChunkingFailureReason = NonNullable<Doc<"artifacts">["chunkingFailureReason"]>;
type ChunkingStatus = NonNullable<Doc<"artifacts">["chunkingStatus"]>;

export interface CreateArtifactWriteArgs {
  threadId?: Id<"threads">;
  repositoryId?: Id<"repositories">;
  ownerTokenIdentifier: string;
  jobId?: Id<"jobs">;
  kind: ArtifactKind;
  title: string;
  summary: string;
  contentMarkdown: string;
  alignedImportCommitSha?: string;
  folderId?: Id<"artifactFolders">;
  generatedByProvider?: LlmProvider;
  generatedByModel?: string;
  promptVersion?: number;
  kindRunId?: Id<"systemDesignKindRuns">;
}

export interface UpdateArtifactWriteArgs {
  artifactId: Id<"artifacts">;
  title?: string;
  summary?: string;
  contentMarkdown?: string;
  expectedVersion?: number;
  lastVerifiedAt?: number;
  alignedImportCommitSha?: string;
  generatedByProvider?: LlmProvider;
  generatedByModel?: string;
  promptVersion?: number;
}

export interface ReplaceArtifactInFolderWriteArgs extends CreateArtifactWriteArgs {
  repositoryId: Id<"repositories">;
  folderId: Id<"artifactFolders">;
}

export function validateParentPresence(
  threadId: Id<"threads"> | undefined,
  repositoryId: Id<"repositories"> | undefined,
) {
  if (!threadId && !repositoryId) {
    throw new Error("Artifact must have at least one parent: threadId or repositoryId");
  }
}

export async function createArtifactWrite(ctx: MutationCtx, args: CreateArtifactWriteArgs): Promise<Id<"artifacts">> {
  validateParentPresence(args.threadId, args.repositoryId);
  await validateArtifactFolder(ctx, {
    artifact: null,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    folderId: args.folderId,
  });

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
    version: 1,
    folderId: args.folderId,
    alignedImportCommitSha: args.alignedImportCommitSha,
    lastVerifiedAt: now,
    chunkingStatus: args.repositoryId ? "pending" : undefined,
    updatedAt: now,
    generatedByProvider: args.generatedByProvider,
    generatedByModel: args.generatedByModel,
    promptVersion: args.promptVersion,
    kindRunId: args.kindRunId,
  });
  await scheduleArtifactReindex(ctx, { artifactId, repositoryId: args.repositoryId });
  return artifactId;
}

export async function updateArtifactWrite(
  ctx: MutationCtx,
  args: UpdateArtifactWriteArgs,
): Promise<{ updated: boolean; reason?: "version_mismatch" }> {
  const artifact = await ctx.db.get(args.artifactId);
  if (!artifact) {
    throw new Error("Artifact not found");
  }
  if (args.expectedVersion !== undefined && artifact.version !== args.expectedVersion) {
    return { updated: false, reason: "version_mismatch" };
  }

  const patch: {
    title?: string;
    summary?: string;
    contentMarkdown?: string;
    version?: number;
    chunkingStatus?: "pending";
    chunkingFailureReason?: undefined;
    updatedAt?: number;
    lastVerifiedAt?: number;
    alignedImportCommitSha?: string;
    generatedByProvider?: LlmProvider;
    generatedByModel?: string;
    promptVersion?: number;
  } = {};
  let changed = false;
  if (args.title !== undefined) {
    patch.title = args.title;
    changed = true;
  }
  if (args.summary !== undefined) {
    patch.summary = args.summary;
    changed = true;
  }
  if (args.contentMarkdown !== undefined) {
    patch.contentMarkdown = args.contentMarkdown;
    if (artifact.repositoryId) {
      patch.chunkingStatus = "pending";
      patch.chunkingFailureReason = undefined;
    }
    changed = true;
  }
  if (args.lastVerifiedAt !== undefined) {
    patch.lastVerifiedAt = args.lastVerifiedAt;
    changed = true;
  }
  if (args.alignedImportCommitSha !== undefined) {
    patch.alignedImportCommitSha = args.alignedImportCommitSha;
    changed = true;
  }
  if (args.generatedByProvider !== undefined) {
    patch.generatedByProvider = args.generatedByProvider;
    changed = true;
  }
  if (args.generatedByModel !== undefined) {
    patch.generatedByModel = args.generatedByModel;
    changed = true;
  }
  if (args.promptVersion !== undefined) {
    patch.promptVersion = args.promptVersion;
    changed = true;
  }

  if (changed) {
    if (args.title !== undefined || args.summary !== undefined || args.contentMarkdown !== undefined) {
      patch.version = artifact.version + 1;
    }
    patch.updatedAt = Date.now();
    await ctx.db.patch(args.artifactId, patch);
    await scheduleArtifactReindex(ctx, {
      artifactId: args.artifactId,
      repositoryId: args.contentMarkdown !== undefined ? artifact.repositoryId : undefined,
    });
  }
  return { updated: changed };
}

export async function replaceArtifactInFolderWrite(
  ctx: MutationCtx,
  args: ReplaceArtifactInFolderWriteArgs,
): Promise<Id<"artifacts">> {
  await validateArtifactFolder(ctx, {
    artifact: null,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    folderId: args.folderId,
  });

  const stale = await findArtifactInFolderByKind(ctx, {
    repositoryId: args.repositoryId,
    folderId: args.folderId,
    kind: args.kind,
  });
  if (stale) {
    await deleteArtifactWrite(ctx, stale._id);
  }

  return await createArtifactWrite(ctx, args);
}

export async function replaceArtifactFolder(
  ctx: MutationCtx,
  artifact: Doc<"artifacts">,
  folderId: Id<"artifactFolders"> | undefined,
) {
  await validateArtifactFolder(ctx, {
    artifact,
    ownerTokenIdentifier: artifact.ownerTokenIdentifier,
    repositoryId: artifact.repositoryId,
    folderId,
  });
  await ctx.db.patch(artifact._id, { folderId });
}

export async function deleteArtifactWrite(ctx: MutationCtx, artifactId: Id<"artifacts">): Promise<void> {
  const PAGE_SIZE = 100;
  let hasMoreChunks = true;
  while (hasMoreChunks) {
    const chunks = await ctx.db
      .query("artifactChunks")
      .withIndex("by_artifactId_and_chunkIndex", (q) => q.eq("artifactId", artifactId))
      .take(PAGE_SIZE);
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }
    hasMoreChunks = chunks.length === PAGE_SIZE;
  }
  let hasMoreViews = true;
  while (hasMoreViews) {
    const views = await ctx.db
      .query("artifactViews")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
      .take(PAGE_SIZE);
    for (const view of views) {
      await ctx.db.delete(view._id);
    }
    hasMoreViews = views.length === PAGE_SIZE;
  }
  await ctx.db.delete(artifactId);
}

export async function markArtifactChunkingStatusWrite(
  ctx: MutationCtx,
  args: {
    artifactId: Id<"artifacts">;
    status: ChunkingStatus;
    version: number;
    failureReason?: ChunkingFailureReason;
  },
): Promise<{ patched: boolean }> {
  const artifact = await ctx.db.get(args.artifactId);
  if (!artifact || artifact.version !== args.version) {
    return { patched: false };
  }
  await ctx.db.patch(args.artifactId, {
    chunkingStatus: args.status,
    chunkingFailureReason: args.status === "failed" ? args.failureReason : undefined,
    lastChunkedAt: Date.now(),
    lastChunkedVersion: args.version,
  });
  return { patched: true };
}

async function findArtifactInFolderByKind(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    folderId: Id<"artifactFolders">;
    kind: ArtifactKind;
  },
): Promise<Doc<"artifacts"> | null> {
  const existing = await ctx.db
    .query("artifacts")
    .withIndex("by_repositoryId_and_folderId", (q) =>
      q.eq("repositoryId", args.repositoryId).eq("folderId", args.folderId),
    )
    .collect();
  return existing.find((row) => row.kind === args.kind) ?? null;
}

async function validateArtifactFolder(
  ctx: MutationCtx,
  args: {
    artifact: Doc<"artifacts"> | null;
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | undefined;
    folderId: Id<"artifactFolders"> | undefined;
  },
) {
  if (!args.folderId) {
    return;
  }
  const folder = await ctx.db.get(args.folderId);
  assertOwnedBy(folder, args.ownerTokenIdentifier, "Folder not found.");
  if (!args.repositoryId) {
    throw new Error("Cannot place a repo-less artifact in a repository folder.");
  }
  if (folder.repositoryId !== args.repositoryId) {
    throw new Error("Cannot place an artifact in a folder from a different repository.");
  }
  if (args.artifact && args.artifact.repositoryId && folder.repositoryId !== args.artifact.repositoryId) {
    throw new Error("Cannot move an artifact to a folder from a different repository.");
  }
}

async function scheduleArtifactReindex(
  ctx: MutationCtx,
  args: {
    artifactId: Id<"artifacts">;
    repositoryId: Id<"repositories"> | undefined;
  },
) {
  if (!args.repositoryId) {
    return;
  }
  await ctx.scheduler.runAfter(0, internal.artifactIndexing.reindexArtifact, {
    artifactId: args.artifactId,
  });
}
