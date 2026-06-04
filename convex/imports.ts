import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { importRunningStateValidator, nullableImportContextValidator } from "./lib/functionResultSchemas";
import {
  finalizeImportCancellation,
  loadImportContext,
  markImportFailedForMutation,
  markImportRunningForMutation,
} from "./lib/importLifecycle";
import { failStaleActiveJob } from "./lib/jobs";
import {
  cleanupSupersededImportSnapshotInMutation,
  finalizeImportCompletionInMutation,
  persistImportHeaderInMutation,
  persistRepoChunksBatchInMutation,
  persistRepoFilesBatchInMutation,
  persistStageResultValidator,
  repoChunkRecordValidator,
  repoFileRecordValidator,
} from "./lib/importSnapshotPersistence";

export const getImportContext = internalQuery({
  args: {
    importId: v.id("imports"),
  },
  returns: nullableImportContextValidator,
  handler: async (ctx, args) => {
    return await loadImportContext(ctx, args.importId);
  },
});

export const markImportRunning = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
  },
  returns: importRunningStateValidator,
  handler: async (ctx, args) => {
    return await markImportRunningForMutation(ctx, args);
  },
});

export const persistImportHeader = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    commitSha: v.string(),
    branch: v.optional(v.string()),
  },
  returns: persistStageResultValidator,
  handler: async (ctx, args) => {
    return await persistImportHeaderInMutation(ctx, args);
  },
});

export const persistRepoFilesBatch = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    files: v.array(repoFileRecordValidator),
  },
  returns: persistStageResultValidator,
  handler: async (ctx, args) => {
    return await persistRepoFilesBatchInMutation(ctx, args);
  },
});

export const persistRepoChunksBatch = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    chunks: v.array(repoChunkRecordValidator),
  },
  returns: persistStageResultValidator,
  handler: async (ctx, args) => {
    return await persistRepoChunksBatchInMutation(ctx, args);
  },
});

export const finalizeImportCompletion = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    commitSha: v.string(),
    branch: v.optional(v.string()),
    detectedLanguages: v.array(v.string()),
    packageManagers: v.array(v.string()),
    entrypoints: v.array(v.string()),
    fileCount: v.number(),
    summary: v.string(),
    readmeSummary: v.string(),
    architectureSummary: v.string(),
  },
  handler: async (ctx, args) => {
    return await finalizeImportCompletionInMutation(ctx, args);
  },
});

export const cleanupSupersededImportSnapshot = internalMutation({
  args: {
    importId: v.id("imports"),
    importJobId: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
    await cleanupSupersededImportSnapshotInMutation(ctx, args);
  },
});

export const markImportFailed = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await markImportFailedForMutation(ctx, args);
  },
});

export const recoverStaleImportJob = internalMutation({
  args: {
    jobId: v.id("jobs"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const importRecord = await ctx.db
      .query("imports")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
    const failedJob = await failStaleActiveJob(ctx, {
      jobId: args.jobId,
      expectedKind: "import",
      now,
      errorMessage: args.errorMessage,
    });
    if (!failedJob || !importRecord) {
      return { recovered: false as const };
    }

    if (
      importRecord.status !== "completed" &&
      importRecord.status !== "cancelled" &&
      importRecord.status !== "failed"
    ) {
      await ctx.db.patch(importRecord._id, {
        status: "failed",
        completedAt: now,
        errorMessage: args.errorMessage,
      });
    }

    const repository = await ctx.db.get(importRecord.repositoryId);
    if (repository && repository.importStatus !== "completed") {
      await ctx.db.patch(importRecord.repositoryId, {
        importStatus: "failed",
      });
    }

    await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, {
      importId: importRecord._id,
      importJobId: args.jobId,
    });
    return { recovered: true as const };
  },
});

export const cancelImport = internalMutation({
  args: {
    importId: v.id("imports"),
    jobId: v.id("jobs"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    await finalizeImportCancellation(ctx, args);
  },
});
