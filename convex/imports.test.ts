/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const PERSIST_BATCH_SIZE = 200;

type PersistFlowArgs = {
  importId: Id<"imports">;
  jobId: Id<"jobs">;
  sandboxId: Id<"sandboxes">;
  commitSha: string;
  branch?: string;
  detectedLanguages: string[];
  packageManagers: string[];
  entrypoints: string[];
  summary: string;
  readmeSummary: string;
  architectureSummary: string;
  repoFiles: Array<{
    path: string;
    parentPath: string;
    fileType: "file" | "dir";
    extension?: string;
    language?: string;
    sizeBytes: number;
    isEntryPoint: boolean;
    isConfig: boolean;
    isImportant: boolean;
    summary?: string;
  }>;
  repoChunks: Array<{
    path: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    chunkKind: "code" | "summary" | "readme";
    symbolName?: string;
    symbolKind?: string;
    summary: string;
    content: string;
  }>;
};

async function runPersistFlow(t: ReturnType<typeof convexTest>, args: PersistFlowArgs) {
  const headerResult = await t.mutation(internal.imports.persistImportHeader, {
    importId: args.importId,
    jobId: args.jobId,
    commitSha: args.commitSha,
    branch: args.branch,
  });
  if (headerResult.kind !== "ready") {
    return headerResult;
  }

  for (const batch of toBatches(args.repoFiles, PERSIST_BATCH_SIZE)) {
    const fileBatchResult = await t.mutation(internal.imports.persistRepoFilesBatch, {
      importId: args.importId,
      jobId: args.jobId,
      files: batch,
    });
    if (fileBatchResult.kind !== "ready") {
      return fileBatchResult;
    }
  }

  for (const batch of toBatches(args.repoChunks, PERSIST_BATCH_SIZE)) {
    const chunkBatchResult = await t.mutation(internal.imports.persistRepoChunksBatch, {
      importId: args.importId,
      jobId: args.jobId,
      chunks: batch,
    });
    if (chunkBatchResult.kind !== "ready") {
      return chunkBatchResult;
    }
  }

  return await t.mutation(internal.imports.finalizeImportCompletion, {
    importId: args.importId,
    jobId: args.jobId,
    sandboxId: args.sandboxId,
    commitSha: args.commitSha,
    branch: args.branch,
    detectedLanguages: args.detectedLanguages,
    packageManagers: args.packageManagers,
    entrypoints: args.entrypoints,
    fileCount: args.repoFiles.length,
    summary: args.summary,
    readmeSummary: args.readmeSummary,
    architectureSummary: args.architectureSummary,
  });
}

function toBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

describe("import snapshot cleanup", () => {
  test("removes superseded files, chunks, and import-generated artifacts", async () => {
    const ownerTokenIdentifier = "user|import-cleanup";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/cleanup-repo",
        sourceRepoFullName: "acme/cleanup-repo",
        sourceRepoOwner: "acme",
        sourceRepoName: "cleanup-repo",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });

      const oldJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const oldImportId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/cleanup-repo",
        branch: "main",
        adapterKind: "git_clone",
        status: "completed",
        jobId: oldJobId,
      });
      const oldFileId = await ctx.db.insert("repoFiles", {
        repositoryId,
        ownerTokenIdentifier,
        importId: oldImportId,
        path: "src/old.ts",
        parentPath: "src",
        fileType: "file",
        extension: "ts",
        language: "typescript",
        sizeBytes: 100,
        isEntryPoint: false,
        isConfig: false,
        isImportant: false,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        ownerTokenIdentifier,
        importId: oldImportId,
        fileId: oldFileId,
        path: "src/old.ts",
        chunkIndex: 0,
        startLine: 1,
        endLine: 3,
        chunkKind: "code",
        summary: "Old chunk",
        content: "old",
      });
      await ctx.db.insert("artifacts", {
        repositoryId,
        jobId: oldJobId,
        ownerTokenIdentifier,
        kind: "manifest",
        title: "Old Manifest",
        summary: "Old summary",
        contentMarkdown: "old",
        source: "heuristic",
        version: 1,
      });

      const currentJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const currentImportId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/cleanup-repo",
        branch: "main",
        adapterKind: "git_clone",
        status: "completed",
        jobId: currentJobId,
      });
      const currentFileId = await ctx.db.insert("repoFiles", {
        repositoryId,
        ownerTokenIdentifier,
        importId: currentImportId,
        path: "src/current.ts",
        parentPath: "src",
        fileType: "file",
        extension: "ts",
        language: "typescript",
        sizeBytes: 120,
        isEntryPoint: true,
        isConfig: false,
        isImportant: true,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        ownerTokenIdentifier,
        importId: currentImportId,
        fileId: currentFileId,
        path: "src/current.ts",
        chunkIndex: 0,
        startLine: 1,
        endLine: 3,
        chunkKind: "code",
        summary: "Current chunk",
        content: "current",
      });
      await ctx.db.insert("artifacts", {
        repositoryId,
        jobId: currentJobId,
        ownerTokenIdentifier,
        kind: "manifest",
        title: "Current Manifest",
        summary: "Current summary",
        contentMarkdown: "current",
        source: "heuristic",
        version: 1,
      });

      return { oldImportId, oldJobId, currentImportId, currentJobId };
    });

    await t.mutation(internal.imports.cleanupSupersededImportSnapshot, {
      importId: ids.oldImportId,
      importJobId: ids.oldJobId,
    });

    const snapshot = await t.run(async (ctx) => ({
      files: await ctx.db
        .query("repoFiles")
        .withIndex("by_importId", (q) => q.eq("importId", ids.oldImportId))
        .take(10),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", ids.oldImportId))
        .take(10),
      artifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_jobId", (q) => q.eq("jobId", ids.oldJobId))
        .take(10),
      currentFiles: await ctx.db
        .query("repoFiles")
        .withIndex("by_importId", (q) => q.eq("importId", ids.currentImportId))
        .take(10),
      currentChunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", ids.currentImportId))
        .take(10),
      currentArtifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_jobId", (q) => q.eq("jobId", ids.currentJobId))
        .take(10),
    }));

    expect(snapshot.files).toHaveLength(0);
    expect(snapshot.chunks).toHaveLength(0);
    expect(snapshot.artifacts).toHaveLength(0);
    expect(snapshot.currentFiles).toHaveLength(1);
    expect(snapshot.currentChunks).toHaveLength(1);
    expect(snapshot.currentArtifacts).toHaveLength(1);
  });
});

describe("batched import persistence", () => {
  test("retries do not duplicate files, chunks, or artifacts", async () => {
    const ownerTokenIdentifier = "user|persist-idempotent";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/persist-idempotent",
        sourceRepoFullName: "acme/persist-idempotent",
        sourceRepoOwner: "acme",
        sourceRepoName: "persist-idempotent",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "running",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });

      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "running",
        stage: "indexing",
        progress: 0.6,
        costCategory: "indexing",
        triggerSource: "user",
        startedAt: Date.now() - 5_000,
      });

      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/persist-idempotent",
        branch: "main",
        adapterKind: "git_clone",
        status: "running",
        jobId,
        startedAt: Date.now() - 5_000,
      });

      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-persist-idempotent",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });

      await ctx.db.patch(importId, {
        sandboxId,
        remoteSandboxId: "remote-persist-idempotent",
      });

      return { repositoryId, jobId, importId, sandboxId };
    });

    const payload: PersistFlowArgs = {
      importId: ids.importId,
      jobId: ids.jobId,
      sandboxId: ids.sandboxId,
      commitSha: "abc123",
      branch: "main",
      detectedLanguages: ["typescript"],
      packageManagers: ["npm"],
      entrypoints: ["src/main.ts"],
      summary: "Import summary",
      readmeSummary: "README summary",
      architectureSummary: "Architecture summary",
      repoFiles: [
        {
          path: "src/main.ts",
          parentPath: "src",
          fileType: "file",
          extension: "ts",
          language: "typescript",
          sizeBytes: 128,
          isEntryPoint: true,
          isConfig: false,
          isImportant: true,
          summary: "Entry point",
        },
        {
          path: "src/lib/util.ts",
          parentPath: "src/lib",
          fileType: "file",
          extension: "ts",
          language: "typescript",
          sizeBytes: 96,
          isEntryPoint: false,
          isConfig: false,
          isImportant: false,
          summary: "Utility file",
        },
      ],
      repoChunks: [
        {
          path: "src/main.ts",
          chunkIndex: 0,
          startLine: 1,
          endLine: 3,
          chunkKind: "code",
          summary: "Main chunk",
          content: 'console.log("hello");',
        },
        {
          path: "src/main.ts",
          chunkIndex: 1,
          startLine: 4,
          endLine: 6,
          chunkKind: "summary",
          summary: "Main summary",
          content: "Exports the bootstrap logic.",
        },
        {
          path: "src/lib/util.ts",
          chunkIndex: 0,
          startLine: 1,
          endLine: 4,
          chunkKind: "code",
          summary: "Utility chunk",
          content: "export function util() { return 1; }",
        },
      ],
    };

    expect(await runPersistFlow(t, payload)).toEqual({ kind: "completed" });
    expect(await runPersistFlow(t, payload)).toEqual({ kind: "completed" });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(ids.repositoryId),
      importRecord: await ctx.db.get(ids.importId),
      job: await ctx.db.get(ids.jobId),
      files: await ctx.db
        .query("repoFiles")
        .withIndex("by_importId", (q) => q.eq("importId", ids.importId))
        .take(10),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", ids.importId))
        .take(10),
      artifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_jobId", (q) => q.eq("jobId", ids.jobId))
        .take(10),
      folders: await ctx.db
        .query("artifactFolders")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", ids.repositoryId))
        .take(20),
    }));

    expect(state.repository?.importStatus).toBe("completed");
    expect(state.repository?.latestImportId).toBe(ids.importId);
    expect(state.repository?.fileCount).toBe(2);
    expect(state.importRecord?.status).toBe("completed");
    expect(state.job?.status).toBe("completed");
    expect(state.files).toHaveLength(2);
    expect(state.chunks).toHaveLength(3);
    expect(state.artifacts).toHaveLength(0);
    expect(state.folders).toHaveLength(7);
  });

  test("cancellation after partial persistence cleans staged rows", async () => {
    const ownerTokenIdentifier = "user|delete-mid-import";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/delete-mid-import",
        sourceRepoFullName: "acme/delete-mid-import",
        sourceRepoOwner: "acme",
        sourceRepoName: "delete-mid-import",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "running",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });

      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "running",
        stage: "indexing",
        progress: 0.6,
        costCategory: "indexing",
        triggerSource: "user",
        startedAt: Date.now() - 5_000,
      });

      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/delete-mid-import",
        branch: "main",
        adapterKind: "git_clone",
        status: "running",
        jobId,
        startedAt: Date.now() - 5_000,
      });

      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-delete-mid-import",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });

      await ctx.db.patch(importId, {
        sandboxId,
        remoteSandboxId: "remote-delete-mid-import",
      });

      return { repositoryId, jobId, importId, sandboxId };
    });

    expect(
      await t.mutation(internal.imports.persistImportHeader, {
        importId: ids.importId,
        jobId: ids.jobId,
        commitSha: "abc123",
        branch: "main",
      }),
    ).toEqual({ kind: "ready" });

    expect(
      await t.mutation(internal.imports.persistRepoFilesBatch, {
        importId: ids.importId,
        jobId: ids.jobId,
        files: [
          {
            path: "src/main.ts",
            parentPath: "src",
            fileType: "file",
            extension: "ts",
            language: "typescript",
            sizeBytes: 128,
            isEntryPoint: true,
            isConfig: false,
            isImportant: true,
            summary: "Entry point",
          },
        ],
      }),
    ).toEqual({ kind: "ready" });

    await t.run(async (ctx) => {
      await ctx.db.patch(ids.repositoryId, {
        deletionRequestedAt: Date.now(),
      });
    });

    expect(
      await t.mutation(internal.imports.persistRepoFilesBatch, {
        importId: ids.importId,
        jobId: ids.jobId,
        files: [
          {
            path: "src/extra.ts",
            parentPath: "src",
            fileType: "file",
            extension: "ts",
            language: "typescript",
            sizeBytes: 64,
            isEntryPoint: false,
            isConfig: false,
            isImportant: false,
            summary: "Extra file",
          },
        ],
      }),
    ).toEqual({ kind: "cancelled" });

    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const state = await t.run(async (ctx) => ({
      importRecord: await ctx.db.get(ids.importId),
      job: await ctx.db.get(ids.jobId),
      files: await ctx.db
        .query("repoFiles")
        .withIndex("by_importId", (q) => q.eq("importId", ids.importId))
        .take(10),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", ids.importId))
        .take(10),
      artifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_jobId", (q) => q.eq("jobId", ids.jobId))
        .take(10),
    }));

    expect(state.importRecord?.status).toBe("cancelled");
    expect(state.job?.status).toBe("cancelled");
    expect(state.files).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
    expect(state.artifacts).toHaveLength(0);
  });
});

describe("repository deletion during import", () => {
  test("markImportFailed keeps the last completed snapshot active and cleans partial rows", async () => {
    const ownerTokenIdentifier = "user|completed-repo-stays-completed";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/completed-repo-stays-completed",
        sourceRepoFullName: "acme/completed-repo-stays-completed",
        sourceRepoOwner: "acme",
        sourceRepoName: "completed-repo-stays-completed",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: ["typescript"],
        packageManagers: ["npm"],
        entrypoints: ["src/current.ts"],
        fileCount: 1,
      });

      const completedJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const completedImportId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/completed-repo-stays-completed",
        branch: "main",
        adapterKind: "git_clone",
        status: "completed",
        jobId: completedJobId,
        commitSha: "old-sha",
      });
      const completedFileId = await ctx.db.insert("repoFiles", {
        repositoryId,
        ownerTokenIdentifier,
        importId: completedImportId,
        path: "src/current.ts",
        parentPath: "src",
        fileType: "file",
        extension: "ts",
        language: "typescript",
        sizeBytes: 120,
        isEntryPoint: true,
        isConfig: false,
        isImportant: true,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        ownerTokenIdentifier,
        importId: completedImportId,
        fileId: completedFileId,
        path: "src/current.ts",
        chunkIndex: 0,
        startLine: 1,
        endLine: 4,
        chunkKind: "code",
        summary: "Current chunk",
        content: "current",
      });
      await ctx.db.insert("artifacts", {
        repositoryId,
        jobId: completedJobId,
        ownerTokenIdentifier,
        kind: "manifest",
        title: "Current Manifest",
        summary: "Current summary",
        contentMarkdown: "current",
        source: "heuristic",
        version: 1,
      });

      const failedJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "running",
        stage: "persisting_files",
        progress: 0.5,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const failedImportId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/completed-repo-stays-completed",
        branch: "main",
        adapterKind: "git_clone",
        status: "running",
        jobId: failedJobId,
      });
      const completedSandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-completed-import",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-failed-import",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });

      await ctx.db.patch(repositoryId, {
        latestImportId: completedImportId,
        latestImportJobId: completedJobId,
        latestSandboxId: completedSandboxId,
      });
      await ctx.db.patch(failedImportId, {
        sandboxId,
        remoteSandboxId: "remote-failed-import",
      });

      return {
        repositoryId,
        completedImportId,
        completedJobId,
        completedSandboxId,
        failedImportId,
        failedJobId,
        sandboxId,
      };
    });

    expect(
      await t.mutation(internal.imports.persistImportHeader, {
        importId: ids.failedImportId,
        jobId: ids.failedJobId,
        commitSha: "new-sha",
        branch: "main",
      }),
    ).toEqual({ kind: "ready" });

    expect(
      await t.mutation(internal.imports.persistRepoFilesBatch, {
        importId: ids.failedImportId,
        jobId: ids.failedJobId,
        files: [
          {
            path: "src/new.ts",
            parentPath: "src",
            fileType: "file",
            extension: "ts",
            language: "typescript",
            sizeBytes: 110,
            isEntryPoint: false,
            isConfig: false,
            isImportant: true,
            summary: "New file",
          },
        ],
      }),
    ).toEqual({ kind: "ready" });

    expect(
      await t.mutation(internal.imports.persistRepoChunksBatch, {
        importId: ids.failedImportId,
        jobId: ids.failedJobId,
        chunks: [
          {
            path: "src/new.ts",
            chunkIndex: 0,
            startLine: 1,
            endLine: 3,
            chunkKind: "code",
            summary: "New chunk",
            content: "export const value = 1;",
          },
        ],
      }),
    ).toEqual({ kind: "ready" });

    vi.useFakeTimers();
    await t.mutation(internal.imports.markImportFailed, {
      importId: ids.failedImportId,
      jobId: ids.failedJobId,
      errorMessage: "Chunk persistence failed",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(ids.repositoryId),
      failedImport: await ctx.db.get(ids.failedImportId),
      failedJob: await ctx.db.get(ids.failedJobId),
      failedFiles: await ctx.db
        .query("repoFiles")
        .withIndex("by_importId", (q) => q.eq("importId", ids.failedImportId))
        .take(10),
      failedChunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", ids.failedImportId))
        .take(10),
      failedArtifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_jobId", (q) => q.eq("jobId", ids.failedJobId))
        .take(10),
      completedFiles: await ctx.db
        .query("repoFiles")
        .withIndex("by_importId", (q) => q.eq("importId", ids.completedImportId))
        .take(10),
      completedArtifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_jobId", (q) => q.eq("jobId", ids.completedJobId))
        .take(10),
    }));

    expect(state.repository?.importStatus).toBe("completed");
    expect(state.repository?.latestImportId).toBe(ids.completedImportId);
    expect(state.repository?.latestSandboxId).toBe(ids.completedSandboxId);
    expect(state.repository?.fileCount).toBe(1);
    expect(state.failedImport?.status).toBe("failed");
    expect(state.failedJob?.status).toBe("failed");
    expect(state.failedFiles).toHaveLength(0);
    expect(state.failedChunks).toHaveLength(0);
    expect(state.failedArtifacts).toHaveLength(0);
    expect(state.completedFiles).toHaveLength(1);
    expect(state.completedArtifacts).toHaveLength(1);
  });

  test("markImportFailed does not throw when the repository row is already gone", async () => {
    const ownerTokenIdentifier = "user|missing-repo-failure";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/missing-repo-failure",
        sourceRepoFullName: "acme/missing-repo-failure",
        sourceRepoOwner: "acme",
        sourceRepoName: "missing-repo-failure",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "running",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });

      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "running",
        stage: "indexing",
        progress: 0.4,
        costCategory: "indexing",
        triggerSource: "user",
      });

      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/missing-repo-failure",
        branch: "main",
        adapterKind: "git_clone",
        status: "running",
        jobId,
      });

      return { repositoryId, jobId, importId };
    });

    await t.run(async (ctx) => {
      await ctx.db.delete(ids.repositoryId);
    });

    await expect(
      t.mutation(internal.imports.markImportFailed, {
        importId: ids.importId,
        jobId: ids.jobId,
        errorMessage: "Clone failed",
      }),
    ).resolves.toBeNull();

    const state = await t.run(async (ctx) => ({
      importRecord: await ctx.db.get(ids.importId),
      job: await ctx.db.get(ids.jobId),
    }));

    expect(state.importRecord?.status).toBe("cancelled");
    expect(state.job?.status).toBe("cancelled");
  });
});

describe("sandbox reservation during import", () => {
  test("sync failure preserves the previously published sandbox", async () => {
    const ownerTokenIdentifier = "user|sync-failure-keeps-sandbox";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/sync-failure-keeps-sandbox",
        sourceRepoFullName: "acme/sync-failure-keeps-sandbox",
        sourceRepoOwner: "acme",
        sourceRepoName: "sync-failure-keeps-sandbox",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: ["typescript"],
        packageManagers: ["bun"],
        entrypoints: ["src/main.ts"],
        fileCount: 1,
      });
      const previousSandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-previous-sync-failure",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.patch(repositoryId, { latestSandboxId: previousSandboxId });
      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "running",
        stage: "provisioning_sandbox",
        progress: 0.2,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/sync-failure-keeps-sandbox",
        branch: "main",
        adapterKind: "git_clone",
        status: "running",
        jobId,
      });

      return { repositoryId, previousSandboxId, jobId, importId };
    });

    const newSandboxId = await t.mutation(internal.imports.reserveSandboxRow, {
      importId: ids.importId,
      repositoryId: ids.repositoryId,
      ownerTokenIdentifier,
      sourceAdapter: "git_clone",
    });
    await t.mutation(internal.imports.attachSandboxRemoteInfo, {
      importId: ids.importId,
      sandboxId: newSandboxId,
      remoteId: "remote-new-sync-failure",
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      autoStopIntervalMinutes: 30,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 120,
      networkBlockAll: false,
    });
    await t.mutation(internal.imports.markImportFailed, {
      importId: ids.importId,
      jobId: ids.jobId,
      errorMessage: "Clone failed",
    });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(ids.repositoryId),
      previousSandbox: await ctx.db.get(ids.previousSandboxId),
      newSandbox: await ctx.db.get(newSandboxId),
      cleanupJobs: await ctx.db
        .query("jobs")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", ids.repositoryId))
        .take(10),
    }));

    expect(state.repository?.latestSandboxId).toBe(ids.previousSandboxId);
    expect(state.repository?.importStatus).toBe("completed");
    expect(state.previousSandbox?.status).toBe("ready");
    expect(state.newSandbox?.status).toBe("failed");
    expect(state.cleanupJobs.some((job) => job.kind === "cleanup" && job.sandboxId === newSandboxId)).toBe(true);
  });

  test("successful sync publishes the new sandbox and queues old sandbox cleanup", async () => {
    const ownerTokenIdentifier = "user|sync-publishes-sandbox";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/sync-publishes-sandbox",
        sourceRepoFullName: "acme/sync-publishes-sandbox",
        sourceRepoOwner: "acme",
        sourceRepoName: "sync-publishes-sandbox",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "running",
        detectedLanguages: ["typescript"],
        packageManagers: ["bun"],
        entrypoints: ["src/old.ts"],
        fileCount: 1,
      });
      const previousSandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-previous-sync-success",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "running",
        stage: "persisting_files",
        progress: 0.5,
        costCategory: "indexing",
        triggerSource: "user",
      });
      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/sync-publishes-sandbox",
        branch: "main",
        adapterKind: "git_clone",
        status: "running",
        jobId,
      });
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-new-sync-success",
        status: "provisioning",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.patch(repositoryId, { latestSandboxId: previousSandboxId });
      await ctx.db.patch(importId, {
        sandboxId,
        remoteSandboxId: "remote-new-sync-success",
      });

      return { repositoryId, previousSandboxId, jobId, importId, sandboxId };
    });

    const result = await runPersistFlow(t, {
      importId: ids.importId,
      jobId: ids.jobId,
      sandboxId: ids.sandboxId,
      commitSha: "new-sha",
      branch: "main",
      detectedLanguages: ["typescript"],
      packageManagers: ["bun"],
      entrypoints: ["src/main.ts"],
      summary: "New summary",
      readmeSummary: "New README",
      architectureSummary: "New architecture",
      repoFiles: [
        {
          path: "src/main.ts",
          parentPath: "src",
          fileType: "file",
          extension: "ts",
          language: "typescript",
          sizeBytes: 128,
          isEntryPoint: true,
          isConfig: false,
          isImportant: true,
        },
      ],
      repoChunks: [
        {
          path: "src/main.ts",
          chunkIndex: 0,
          startLine: 1,
          endLine: 3,
          chunkKind: "code",
          summary: "Main chunk",
          content: "export const value = 1;",
        },
      ],
    });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(ids.repositoryId),
      previousSandbox: await ctx.db.get(ids.previousSandboxId),
      newSandbox: await ctx.db.get(ids.sandboxId),
      cleanupJobs: await ctx.db
        .query("jobs")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", ids.repositoryId))
        .take(10),
    }));

    expect(result).toEqual({ kind: "completed" });
    expect(state.repository?.latestSandboxId).toBe(ids.sandboxId);
    expect(state.newSandbox?.status).toBe("ready");
    expect(state.previousSandbox?.status).toBe("ready");
    expect(state.cleanupJobs.some((job) => job.kind === "cleanup" && job.sandboxId === ids.previousSandboxId)).toBe(
      true,
    );
  });

  test("reserveSandboxRow creates an import-scoped placeholder row and attachSandboxRemoteInfo updates it in place", async () => {
    const ownerTokenIdentifier = "user|reserve-sandbox";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/reserve-sandbox",
        sourceRepoFullName: "acme/reserve-sandbox",
        sourceRepoOwner: "acme",
        sourceRepoName: "reserve-sandbox",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "running",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });

      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "running",
        stage: "provisioning_sandbox",
        progress: 0.1,
        costCategory: "indexing",
        triggerSource: "user",
      });

      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/reserve-sandbox",
        branch: "main",
        adapterKind: "git_clone",
        status: "running",
        jobId,
      });

      return { repositoryId, importId };
    });

    const sandboxId = await t.mutation(internal.imports.reserveSandboxRow, {
      importId: ids.importId,
      repositoryId: ids.repositoryId,
      ownerTokenIdentifier,
      sourceAdapter: "git_clone",
    });

    await t.mutation(internal.imports.attachSandboxRemoteInfo, {
      importId: ids.importId,
      sandboxId,
      remoteId: "remote-reserved",
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      autoStopIntervalMinutes: 10,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 120,
      networkBlockAll: false,
    });

    const state = await t.run(async (ctx) => ({
      importRecord: await ctx.db.get(ids.importId),
      repository: await ctx.db.get(ids.repositoryId),
      sandboxes: await ctx.db
        .query("sandboxes")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", ids.repositoryId))
        .take(10),
    }));

    expect(state.importRecord?.sandboxId).toBe(sandboxId);
    expect(state.importRecord?.remoteSandboxId).toBe("remote-reserved");
    expect(state.repository?.latestSandboxId).toBeUndefined();
    expect(state.sandboxes).toHaveLength(1);
    expect(state.sandboxes[0]?.remoteId).toBe("remote-reserved");
    expect(state.sandboxes[0]?.workDir).toBe("/workspace");
  });

  test("scheduleRepositorySandboxCleanup picks up a failed placeholder sandbox", async () => {
    const ownerTokenIdentifier = "user|failed-placeholder";
    const t = convexTest(schema, modules);

    const ids = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/failed-placeholder",
        sourceRepoFullName: "acme/failed-placeholder",
        sourceRepoOwner: "acme",
        sourceRepoName: "failed-placeholder",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "running",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });

      const jobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "running",
        stage: "provisioning_sandbox",
        progress: 0.1,
        costCategory: "indexing",
        triggerSource: "user",
      });

      const importId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/failed-placeholder",
        branch: "main",
        adapterKind: "git_clone",
        status: "running",
        jobId,
      });

      return { repositoryId, jobId, importId };
    });

    const sandboxId = await t.mutation(internal.imports.reserveSandboxRow, {
      importId: ids.importId,
      repositoryId: ids.repositoryId,
      ownerTokenIdentifier,
      sourceAdapter: "git_clone",
    });

    await t.mutation(internal.imports.markImportFailed, {
      importId: ids.importId,
      jobId: ids.jobId,
      errorMessage: "Provisioning failed",
    });

    const cleanupState = await t.mutation(internal.ops.scheduleRepositorySandboxCleanup, {
      repositoryId: ids.repositoryId,
    });

    const jobs = await t.run(async (ctx) =>
      ctx.db
        .query("jobs")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", ids.repositoryId))
        .order("desc")
        .take(10),
    );

    expect(cleanupState).toEqual({ pendingCleanupCount: 1 });
    expect(jobs.some((job) => job.kind === "cleanup" && job.sandboxId === sandboxId)).toBe(true);
  });
});
