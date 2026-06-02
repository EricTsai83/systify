import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { CASCADE_BATCH_SIZE } from "./constants";
import { persistStageResultValidator, type PersistStageResult } from "./functionResultSchemas";
import { applyImportCompletionState, guardPersistStage } from "./importLifecycle";
import { updateRunningJobProgress } from "./jobs";
import { ensureSystemDesignFolders } from "./systemDesign";

export const repoFileRecordValidator = v.object({
  path: v.string(),
  parentPath: v.string(),
  fileType: v.union(v.literal("file"), v.literal("dir")),
  extension: v.optional(v.string()),
  language: v.optional(v.string()),
  sizeBytes: v.number(),
  isEntryPoint: v.boolean(),
  isConfig: v.boolean(),
  isImportant: v.boolean(),
  summary: v.optional(v.string()),
});

export const repoChunkRecordValidator = v.object({
  path: v.string(),
  chunkIndex: v.number(),
  startLine: v.number(),
  endLine: v.number(),
  chunkKind: v.union(v.literal("code"), v.literal("summary"), v.literal("readme")),
  symbolName: v.optional(v.string()),
  symbolKind: v.optional(v.string()),
  summary: v.string(),
  content: v.string(),
});

type RepoFileRecord = Infer<typeof repoFileRecordValidator>;
type RepoChunkRecord = Infer<typeof repoChunkRecordValidator>;

export { persistStageResultValidator };

export async function persistImportHeaderInMutation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
    commitSha: string;
    branch?: string;
  },
): Promise<PersistStageResult> {
  const state = await guardPersistStage(ctx, {
    importId: args.importId,
    jobId: args.jobId,
  });

  if (state.kind !== "ready") {
    return state;
  }

  const progressedJob = await updateRunningJobProgress(ctx, {
    jobId: args.jobId,
    expectedKind: "import",
    stage: "persisting_files",
    progress: 0.5,
  });
  if (!progressedJob) {
    return {
      kind: "cancelled" as const,
    };
  }

  await ensureSystemDesignFolders(ctx, {
    repositoryId: state.repository._id,
    ownerTokenIdentifier: state.repository.ownerTokenIdentifier,
  });

  await ctx.db.patch(args.importId, {
    commitSha: args.commitSha,
    branch: args.branch,
  });

  return {
    kind: "ready" as const,
  };
}

export async function persistRepoFilesBatchInMutation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
    files: RepoFileRecord[];
  },
): Promise<PersistStageResult> {
  const state = await guardPersistStage(ctx, {
    importId: args.importId,
    jobId: args.jobId,
  });

  if (state.kind !== "ready") {
    return state;
  }

  for (const file of args.files) {
    const existingFile = await ctx.db
      .query("repoFiles")
      .withIndex("by_importId_and_path", (q) => q.eq("importId", args.importId).eq("path", file.path))
      .unique();

    if (existingFile) {
      continue;
    }

    await ctx.db.insert("repoFiles", {
      repositoryId: state.repository._id,
      ownerTokenIdentifier: state.repository.ownerTokenIdentifier,
      importId: args.importId,
      ...file,
    });
  }

  return {
    kind: "ready" as const,
  };
}

export async function persistRepoChunksBatchInMutation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
    chunks: RepoChunkRecord[];
  },
): Promise<PersistStageResult> {
  const state = await guardPersistStage(ctx, {
    importId: args.importId,
    jobId: args.jobId,
  });

  if (state.kind !== "ready") {
    return state;
  }

  const progressedJob = await updateRunningJobProgress(ctx, {
    jobId: args.jobId,
    expectedKind: "import",
    stage: "persisting_chunks",
    progress: 0.75,
  });
  if (!progressedJob) {
    return {
      kind: "cancelled" as const,
    };
  }

  const fileIdsByPath = new Map<string, Id<"repoFiles">>();
  for (const chunk of args.chunks) {
    let fileId = fileIdsByPath.get(chunk.path);
    if (!fileId) {
      const file = await ctx.db
        .query("repoFiles")
        .withIndex("by_importId_and_path", (q) => q.eq("importId", args.importId).eq("path", chunk.path))
        .unique();
      if (!file) {
        continue;
      }
      fileId = file._id;
      fileIdsByPath.set(chunk.path, fileId);
    }

    const existingChunk = await ctx.db
      .query("repoChunks")
      .withIndex("by_importId_and_path_and_chunkIndex", (q) =>
        q.eq("importId", args.importId).eq("path", chunk.path).eq("chunkIndex", chunk.chunkIndex),
      )
      .unique();

    if (existingChunk) {
      continue;
    }

    await ctx.db.insert("repoChunks", {
      repositoryId: state.repository._id,
      ownerTokenIdentifier: state.repository.ownerTokenIdentifier,
      importId: args.importId,
      fileId,
      ...chunk,
    });
  }

  return {
    kind: "ready" as const,
  };
}

export async function finalizeImportCompletionInMutation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
    commitSha: string;
    branch?: string;
    detectedLanguages: string[];
    packageManagers: string[];
    entrypoints: string[];
    fileCount: number;
    summary: string;
    readmeSummary: string;
    architectureSummary: string;
  },
): Promise<{ kind: "completed" } | { kind: "cancelled" }> {
  const state = await guardPersistStage(ctx, {
    importId: args.importId,
    jobId: args.jobId,
  });

  if (state.kind !== "ready") {
    return {
      kind: state.kind,
    };
  }

  const previousCompletedImportId = state.repository.latestImportId;
  const previousCompletedImportJobId = state.repository.latestImportJobId;

  const completed = await applyImportCompletionState(ctx, {
    importId: args.importId,
    repositoryId: state.repository._id,
    jobId: args.jobId,
    commitSha: args.commitSha,
    branch: args.branch,
    detectedLanguages: args.detectedLanguages,
    packageManagers: args.packageManagers,
    entrypoints: args.entrypoints,
    fileCount: args.fileCount,
    summary: args.summary,
    readmeSummary: args.readmeSummary,
    architectureSummary: args.architectureSummary,
    repositoryDefaultBranch: state.repository.defaultBranch,
  });
  if (!completed.completed) {
    return {
      kind: "cancelled" as const,
    };
  }

  if (
    previousCompletedImportId &&
    (previousCompletedImportId !== args.importId || previousCompletedImportJobId !== args.jobId)
  ) {
    await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, {
      importId: previousCompletedImportId,
      importJobId: previousCompletedImportJobId,
    });
  }
  // Import no longer publishes a new sandbox, so there is nothing to retire
  // here. The repository's `latestSandboxId` (if any) keeps pointing at the
  // last sandbox provisioned by Sandbox Mode / System Design; that path
  // owns its own lifecycle and cleanup.

  return {
    kind: "completed" as const,
  };
}

export async function cleanupSupersededImportSnapshotInMutation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    importJobId?: Id<"jobs">;
  },
): Promise<void> {
  const repoFiles = await ctx.db
    .query("repoFiles")
    .withIndex("by_importId", (q) => q.eq("importId", args.importId))
    .take(CASCADE_BATCH_SIZE);
  const repoChunks = await ctx.db
    .query("repoChunks")
    .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", args.importId))
    .take(CASCADE_BATCH_SIZE);
  const importArtifacts = args.importJobId
    ? await ctx.db
        .query("artifacts")
        .withIndex("by_jobId", (q) => q.eq("jobId", args.importJobId as Id<"jobs">))
        .take(CASCADE_BATCH_SIZE)
    : [];

  for (const doc of repoChunks) {
    await ctx.db.delete(doc._id);
  }
  for (const doc of repoFiles) {
    await ctx.db.delete(doc._id);
  }
  for (const doc of importArtifacts) {
    await ctx.db.delete(doc._id);
  }

  const hasMore =
    repoFiles.length === CASCADE_BATCH_SIZE ||
    repoChunks.length === CASCADE_BATCH_SIZE ||
    importArtifacts.length === CASCADE_BATCH_SIZE;

  if (hasMore) {
    await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, args);
  }
}
