"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import {
  assertSandboxProvisioningConfigured,
  cloneRepositoryInSandbox,
  collectRepositorySnapshot,
  provisionSandbox,
  stopSandbox,
} from "./daytona";
import { getInstallationAccessToken } from "./githubAppNode";
import { buildRepositoryManifest, createChunkRecords, createRepoFileRecords } from "./lib/repoAnalysis";
import { logErrorWithId, logInfo, logWarn } from "./lib/observability";

const PERSIST_BATCH_SIZE = 200;

type ReadyImportContext = {
  kind: "ready";
  repositoryId: Id<"repositories">;
  jobId: Id<"jobs">;
  branch?: string;
  sourceUrl: string;
  ownerTokenIdentifier: string;
  accessMode: "public" | "private";
  sourceRepoFullName: string;
};

type CancelledImportContext = {
  kind: "cancelled";
  jobId: Id<"jobs">;
  reason: string;
};

type CompletedImportContext = {
  kind: "completed";
};

type ImportContext = ReadyImportContext | CancelledImportContext | CompletedImportContext;

export const runImportPipeline = internalAction({
  args: {
    importId: v.id("imports"),
  },
  handler: async (ctx, args) => {
    let importContext: ImportContext | null = null;
    let sandboxId: Id<"sandboxes"> | null = null;

    try {
      importContext = (await ctx.runQuery(internal.imports.getImportContext, {
        importId: args.importId,
      })) as ImportContext | null;

      if (!importContext) {
        return;
      }

      if (importContext.kind === "completed") {
        return;
      }

      if (importContext.kind === "cancelled") {
        await ctx.runMutation(internal.imports.cancelImport, {
          importId: args.importId,
          jobId: importContext.jobId,
          reason: importContext.reason,
        });
        return;
      }

      const runningState = (await ctx.runMutation(internal.imports.markImportRunning, {
        importId: args.importId,
        jobId: importContext.jobId,
      })) as { kind: "running" } | { kind: "completed" } | { kind: "cancelled"; reason: string };

      if (runningState.kind === "completed") {
        return;
      }

      if (runningState.kind === "cancelled") {
        await ctx.runMutation(internal.imports.cancelImport, {
          importId: args.importId,
          jobId: importContext.jobId,
          reason: runningState.reason,
        });
        return;
      }

      // Fail-fast: validate every Daytona env var before any side effects
      // (sandbox row reservation, GitHub access probe). This surfaces a
      // single actionable error to the operator instead of failing midway
      // through provisioning.
      assertSandboxProvisioningConfigured();

      // -----------------------------------------------------------------------
      // Early permission check: verify the GitHub App installation can access
      // this repo BEFORE provisioning a sandbox. This avoids wasting resources
      // when the repo is not included in the installation's repo selection.
      // -----------------------------------------------------------------------
      const installationId: number | null = await ctx.runQuery(internal.github.getInstallationIdForOwner, {
        ownerTokenIdentifier: importContext.ownerTokenIdentifier,
      });

      if (!installationId) {
        throw new Error("No active GitHub App installation found. Please connect your GitHub account first.");
      }

      // Parse owner/repo from sourceRepoFullName (format: "owner/repo")
      const [repoOwner, repoName] = importContext.sourceRepoFullName.split("/");
      if (!repoOwner || !repoName) {
        throw new Error(`Invalid repository name: ${importContext.sourceRepoFullName}`);
      }

      const accessCheck = (await ctx.runAction(internal.githubAppNode.checkRepoAccess, {
        installationId,
        owner: repoOwner,
        repo: repoName,
      })) as { accessible: boolean; isPrivate?: boolean; message?: string };

      if (!accessCheck.accessible) {
        throw new Error(
          accessCheck.message ??
            `Repository "${importContext.sourceRepoFullName}" is not accessible with your current GitHub App permissions.`,
        );
      }

      // Update the repository's visibility now that we know the actual value
      const detectedVisibility = accessCheck.isPrivate ? ("private" as const) : ("public" as const);
      await ctx.runMutation(internal.repositories.updateRepoVisibility, {
        repositoryId: importContext.repositoryId,
        visibility: detectedVisibility,
      });

      // -----------------------------------------------------------------------
      // Repo is accessible — proceed with import-scoped sandbox provisioning.
      // The repository keeps pointing at the last published sandbox until the
      // new snapshot finalizes successfully.
      // -----------------------------------------------------------------------
      sandboxId = await ctx.runMutation(internal.imports.reserveSandboxRow, {
        importId: args.importId,
        repositoryId: importContext.repositoryId,
        ownerTokenIdentifier: importContext.ownerTokenIdentifier,
        sourceAdapter: "git_clone",
      });

      const sandbox = await provisionSandbox({
        repositoryKey: importContext.sourceRepoFullName,
        repositoryId: importContext.repositoryId,
        sandboxId,
        accessMode: importContext.accessMode,
        sourceAdapter: "git_clone",
      });

      await ctx.runMutation(internal.imports.attachSandboxRemoteInfo, {
        importId: args.importId,
        sandboxId,
        remoteId: sandbox.remoteId,
        workDir: sandbox.workDir,
        repoPath: sandbox.repoPath,
        cpuLimit: sandbox.cpuLimit,
        memoryLimitGiB: sandbox.memoryLimitGiB,
        diskLimitGiB: sandbox.diskLimitGiB,
        autoStopIntervalMinutes: sandbox.autoStopIntervalMinutes,
        autoArchiveIntervalMinutes: sandbox.autoArchiveIntervalMinutes,
        autoDeleteIntervalMinutes: sandbox.autoDeleteIntervalMinutes,
        networkBlockAll: sandbox.networkBlockAll,
      });

      // Retrieve GitHub access token — required for private repos
      let githubToken: string | undefined;
      if (detectedVisibility === "private") {
        githubToken = await getInstallationAccessToken(installationId);
      } else {
        try {
          githubToken = await getInstallationAccessToken(installationId);
        } catch (error) {
          console.warn(
            "[import] GitHub token unavailable, falling back to unauthenticated:",
            error instanceof Error ? error.message : error,
          );
        }
      }

      const cloneResult = await cloneRepositoryInSandbox({
        remoteId: sandbox.remoteId,
        url: importContext.sourceUrl,
        branch: importContext.branch,
        token: githubToken,
      });

      const snapshot = await collectRepositorySnapshot(sandbox.remoteId, sandbox.repoPath);
      const fileRecords = createRepoFileRecords(
        snapshot.files.map((file) => ({
          path: file.path,
          fileType: file.fileType,
          sizeBytes: file.sizeBytes,
        })),
      );
      const manifest = buildRepositoryManifest({
        ...snapshot,
        files: fileRecords,
      });
      const chunkRecords = createChunkRecords({
        ...snapshot,
        files: fileRecords,
      });

      const headerResult = (await ctx.runMutation(internal.imports.persistImportHeader, {
        importId: args.importId,
        jobId: importContext.jobId,
        commitSha: cloneResult.commitSha,
        branch: cloneResult.branch,
      })) as { kind: "ready" } | { kind: "completed" } | { kind: "cancelled" };

      if (headerResult.kind !== "ready") {
        return;
      }

      for (const batch of toBatches(fileRecords, PERSIST_BATCH_SIZE)) {
        const fileBatchResult = (await ctx.runMutation(internal.imports.persistRepoFilesBatch, {
          importId: args.importId,
          jobId: importContext.jobId,
          files: batch,
        })) as { kind: "ready" } | { kind: "completed" } | { kind: "cancelled" };

        if (fileBatchResult.kind !== "ready") {
          return;
        }
      }

      for (const batch of toBatches(chunkRecords, PERSIST_BATCH_SIZE)) {
        const chunkBatchResult = (await ctx.runMutation(internal.imports.persistRepoChunksBatch, {
          importId: args.importId,
          jobId: importContext.jobId,
          chunks: batch,
        })) as { kind: "ready" } | { kind: "completed" } | { kind: "cancelled" };

        if (chunkBatchResult.kind !== "ready") {
          return;
        }
      }

      const persistResult = (await ctx.runMutation(internal.imports.finalizeImportCompletion, {
        importId: args.importId,
        jobId: importContext.jobId,
        sandboxId,
        commitSha: cloneResult.commitSha,
        branch: cloneResult.branch,
        detectedLanguages: manifest.detectedLanguages,
        packageManagers: manifest.packageManagers,
        entrypoints: manifest.entrypoints,
        fileCount: fileRecords.length,
        summary: manifest.summary,
        readmeSummary: summarizeReadme(snapshot.readmeContent),
        architectureSummary: "Repository imported and indexed for architecture review.",
      })) as { kind: "completed" } | { kind: "cancelled" };

      if (persistResult.kind === "cancelled") {
        return;
      }

      // Immediately stop the sandbox to release CPU and memory.
      // All indexed data is now persisted in Convex. The sandbox stays on disk
      // and will auto-wake if Deep Path needs it later.
      try {
        await stopSandbox(sandbox.remoteId);
        logInfo("import", "sandbox_stopped_after_import", {
          repositoryId: importContext.repositoryId,
          sandboxRemoteId: sandbox.remoteId,
        });
      } catch (stopError) {
        // Non-fatal: sandbox will auto-stop after the idle interval anyway.
        logWarn("import", "sandbox_stop_failed_after_import", {
          repositoryId: importContext.repositoryId,
          sandboxRemoteId: sandbox.remoteId,
          error: stopError instanceof Error ? stopError.message : String(stopError),
        });
      }
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : "Unknown import error";

      // Provide helpful error message for auth/access failures.
      // When a repo is not included in the GitHub App installation,
      // clone failures typically surface as "not found" (404) or permission denied.
      const lowerMsg = errorMessage.toLowerCase();
      const isAuthFailure =
        lowerMsg.includes("not found") ||
        lowerMsg.includes("authentication failed") ||
        lowerMsg.includes("could not read from remote") ||
        lowerMsg.includes("private") ||
        lowerMsg.includes("401") ||
        lowerMsg.includes("403") ||
        lowerMsg.includes("404") ||
        lowerMsg.includes("permission denied");

      if (isAuthFailure) {
        errorMessage +=
          "\n\nThis repository may not be accessible. Make sure it is included in your GitHub App installation. You can update your repo selection in GitHub Settings > Applications.";
      }

      if (!importContext || importContext.kind !== "ready") {
        return;
      }

      const errorId = logErrorWithId("import", "run_import_pipeline_failed", error, {
        importId: args.importId,
        repositoryId: importContext.repositoryId,
        jobId: importContext.jobId,
      });

      await ctx.runMutation(internal.imports.markImportFailed, {
        importId: args.importId,
        jobId: importContext.jobId,
        errorMessage: `${errorMessage}\n\nReference: ${errorId}`,
      });

      if (sandboxId) {
        await ctx.runMutation(internal.ops.scheduleSandboxCleanup, {
          sandboxId,
        });
      }
    }
  },
});

function summarizeReadme(readme?: string) {
  if (!readme) {
    return "No README was detected during import.";
  }

  return readme
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 4)
    .join(" ")
    .slice(0, 240);
}

function toBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}
