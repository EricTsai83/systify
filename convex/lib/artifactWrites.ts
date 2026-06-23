import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { LlmProvider } from "./llmProvider";
import { assertOwnedBy } from "./ownedDocs";

type ArtifactKind = Doc<"artifacts">["kind"];
type ChunkingFailureReason = NonNullable<Doc<"artifacts">["chunkingFailureReason"]>;
type ChunkingStatus = NonNullable<Doc<"artifacts">["chunkingStatus"]>;
type ArtifactRenderFormat = "markdown" | "html";
type ArtifactSourceReference = {
  artifactId: Id<"artifacts">;
  version: number;
  title: string;
};

export interface CreateArtifactWriteArgs {
  threadId?: Id<"threads">;
  repositoryId?: Id<"repositories">;
  ownerTokenIdentifier: string;
  jobId?: Id<"jobs">;
  kind: ArtifactKind;
  title: string;
  summary: string;
  contentMarkdown: string;
  renderFormat?: ArtifactRenderFormat;
  htmlStorageId?: Id<"_storage">;
  htmlHash?: string;
  htmlByteLength?: number;
  htmlValidationErrors?: string[];
  sourceArtifacts?: ArtifactSourceReference[];
  sourceChunkIds?: Id<"artifactChunks">[];
  alignedImportCommitSha?: string;
  folderId?: Id<"artifactFolders">;
  lastVerifiedAt?: number | null;
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
  renderFormat?: ArtifactRenderFormat;
  htmlStorageId?: Id<"_storage">;
  htmlHash?: string;
  htmlByteLength?: number;
  htmlValidationErrors?: string[];
  sourceArtifacts?: ArtifactSourceReference[];
  sourceChunkIds?: Id<"artifactChunks">[];
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
  const renderFormat = args.renderFormat ?? "markdown";
  const artifactId = await ctx.db.insert("artifacts", {
    threadId: args.threadId,
    repositoryId: args.repositoryId,
    jobId: args.jobId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    kind: args.kind,
    title: args.title,
    summary: args.summary,
    contentMarkdown: args.contentMarkdown,
    renderFormat,
    version: 1,
    folderId: args.folderId,
    alignedImportCommitSha: args.alignedImportCommitSha,
    lastVerifiedAt: args.lastVerifiedAt === null ? undefined : (args.lastVerifiedAt ?? now),
    chunkingStatus: args.repositoryId ? "pending" : undefined,
    updatedAt: now,
    generatedByProvider: args.generatedByProvider,
    generatedByModel: args.generatedByModel,
    promptVersion: args.promptVersion,
    kindRunId: args.kindRunId,
  });
  const versionId = await createArtifactVersionWrite(ctx, {
    artifactId,
    version: 1,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    title: args.title,
    summary: args.summary,
    contentMarkdown: args.contentMarkdown,
    renderFormat,
    htmlStorageId: args.htmlStorageId,
    htmlHash: args.htmlHash,
    htmlByteLength: args.htmlByteLength,
    htmlValidationErrors: args.htmlValidationErrors,
    sourceArtifacts: args.sourceArtifacts,
    sourceChunkIds: args.sourceChunkIds,
    createdAt: now,
    jobId: args.jobId,
  });
  await ctx.db.patch(artifactId, { currentVersionId: versionId });
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
    renderFormat?: ArtifactRenderFormat;
    version?: number;
    chunkingStatus?: "pending";
    chunkingFailureReason?: undefined;
    updatedAt?: number;
    lastVerifiedAt?: number;
    alignedImportCommitSha?: string;
    generatedByProvider?: LlmProvider;
    generatedByModel?: string;
    promptVersion?: number;
    currentVersionId?: Id<"artifactVersions">;
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
  if (args.renderFormat !== undefined) {
    patch.renderFormat = args.renderFormat;
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
  const versionMetadataChanged =
    args.htmlStorageId !== undefined ||
    args.htmlHash !== undefined ||
    args.htmlByteLength !== undefined ||
    args.htmlValidationErrors !== undefined ||
    args.sourceArtifacts !== undefined ||
    args.sourceChunkIds !== undefined;
  if (versionMetadataChanged) {
    changed = true;
  }

  if (changed) {
    if (
      args.title !== undefined ||
      args.summary !== undefined ||
      args.contentMarkdown !== undefined ||
      args.renderFormat !== undefined ||
      versionMetadataChanged
    ) {
      const nextVersion = artifact.version + 1;
      const renderFormat = args.renderFormat ?? artifact.renderFormat ?? "markdown";
      const previousHtml = renderFormat === "html" ? await getCurrentVersionHtmlFields(ctx, artifact) : {};
      const versionId = await createArtifactVersionWrite(ctx, {
        artifactId: artifact._id,
        version: nextVersion,
        ownerTokenIdentifier: artifact.ownerTokenIdentifier,
        repositoryId: artifact.repositoryId,
        title: args.title ?? artifact.title,
        summary: args.summary ?? artifact.summary,
        contentMarkdown: args.contentMarkdown ?? artifact.contentMarkdown,
        renderFormat,
        htmlStorageId: args.htmlStorageId ?? previousHtml.htmlStorageId,
        htmlHash: args.htmlHash ?? previousHtml.htmlHash,
        htmlByteLength: args.htmlByteLength ?? previousHtml.htmlByteLength,
        htmlValidationErrors: args.htmlValidationErrors ?? previousHtml.htmlValidationErrors,
        sourceArtifacts: args.sourceArtifacts ?? previousHtml.sourceArtifacts,
        sourceChunkIds: args.sourceChunkIds ?? previousHtml.sourceChunkIds,
        createdAt: Date.now(),
        jobId: artifact.jobId,
      });
      patch.version = nextVersion;
      patch.currentVersionId = versionId;
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

export async function createArtifactVersionWrite(
  ctx: MutationCtx,
  args: {
    artifactId: Id<"artifacts">;
    version: number;
    ownerTokenIdentifier: string;
    repositoryId?: Id<"repositories">;
    title: string;
    summary: string;
    contentMarkdown: string;
    renderFormat: ArtifactRenderFormat;
    htmlStorageId?: Id<"_storage">;
    htmlHash?: string;
    htmlByteLength?: number;
    htmlValidationErrors?: string[];
    sourceArtifacts?: ArtifactSourceReference[];
    sourceChunkIds?: Id<"artifactChunks">[];
    createdAt: number;
    jobId?: Id<"jobs">;
  },
): Promise<Id<"artifactVersions">> {
  return await ctx.db.insert("artifactVersions", {
    artifactId: args.artifactId,
    version: args.version,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    title: args.title,
    summary: args.summary,
    contentMarkdown: args.contentMarkdown,
    renderFormat: args.renderFormat,
    htmlStorageId: args.renderFormat === "html" ? args.htmlStorageId : undefined,
    htmlHash: args.renderFormat === "html" ? args.htmlHash : undefined,
    htmlByteLength: args.renderFormat === "html" ? args.htmlByteLength : undefined,
    htmlValidationStatus: args.renderFormat === "html" ? "valid" : undefined,
    htmlValidationErrors: args.htmlValidationErrors,
    sourceArtifacts: args.sourceArtifacts,
    sourceChunkIds: args.sourceChunkIds,
    createdAt: args.createdAt,
    jobId: args.jobId,
  });
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
  await deleteArtifactVersionsAndHtmlStorage(ctx, artifactId, PAGE_SIZE);
  await ctx.db.delete(artifactId);
}

async function deleteArtifactVersionsAndHtmlStorage(
  ctx: MutationCtx,
  artifactId: Id<"artifacts">,
  pageSize: number,
): Promise<void> {
  const deletedStorageIds = new Set<Id<"_storage">>();
  let hasMoreVersions = true;
  while (hasMoreVersions) {
    const versions = await ctx.db
      .query("artifactVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
      .take(pageSize);
    for (const version of versions) {
      if (version.htmlStorageId && !deletedStorageIds.has(version.htmlStorageId)) {
        await ctx.storage.delete(version.htmlStorageId);
        deletedStorageIds.add(version.htmlStorageId);
      }
      await ctx.db.delete(version._id);
    }
    hasMoreVersions = versions.length === pageSize;
  }
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

async function getCurrentVersionHtmlFields(
  ctx: MutationCtx,
  artifact: Doc<"artifacts">,
): Promise<{
  htmlStorageId?: Id<"_storage">;
  htmlHash?: string;
  htmlByteLength?: number;
  htmlValidationErrors?: string[];
  sourceArtifacts?: ArtifactSourceReference[];
  sourceChunkIds?: Id<"artifactChunks">[];
}> {
  if (!artifact.currentVersionId) {
    return {};
  }
  const currentVersion = await ctx.db.get(artifact.currentVersionId);
  if (!currentVersion || currentVersion.artifactId !== artifact._id || currentVersion.renderFormat !== "html") {
    return {};
  }
  return {
    htmlStorageId: currentVersion.htmlStorageId,
    htmlHash: currentVersion.htmlHash,
    htmlByteLength: currentVersion.htmlByteLength,
    htmlValidationErrors: currentVersion.htmlValidationErrors,
    sourceArtifacts: currentVersion.sourceArtifacts,
    sourceChunkIds: currentVersion.sourceChunkIds,
  };
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
