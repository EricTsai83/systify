"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { fetchRepositorySnapshot } from "./githubRepoFetcher";
import { buildRepositoryManifest, createChunkRecords } from "./lib/repoAnalysis";
import { logErrorWithId } from "./lib/observability";

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

/**
 * Repository import pipeline — GitHub-API-only.
 *
 * Tier 1 of the lazy-sandbox architecture: import never provisions a Daytona
 * sandbox. The pipeline fetches metadata, the recursive tree, README, and
 * package manifest contents directly from the GitHub API using the user's
 * GitHub App installation token. Sandbox-backed features (Sandbox Mode chat,
 * Generate System Design) own their own sandbox lifecycle through
 * `ensureSandboxReady` and run on demand.
 *
 * Failure modes:
 *   - Missing / expired installation → fail-fast with a user-facing message
 *     pointing at GitHub Settings.
 *   - Repository not included in the App's repo selection → caught by the
 *     early `checkRepoAccess` probe and surfaced verbatim.
 *   - GitHub API outage / rate-limit storm → `fetchRepositorySnapshot`
 *     retries 5xx + 429 internally; persistent failure surfaces the wrapped
 *     GitHub error with a Reference ID.
 *
 * No sandbox cleanup is needed in the error path because no sandbox was
 * created.
 */
export const runImportPipeline = internalAction({
  args: {
    importId: v.id("imports"),
  },
  handler: async (ctx, args) => {
    let importContext: ImportContext | null = null;

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

      const installationId: number | null = await ctx.runQuery(internal.github.getInstallationIdForOwner, {
        ownerTokenIdentifier: importContext.ownerTokenIdentifier,
      });

      if (!installationId) {
        throw new Error("No active GitHub App installation found. Please connect your GitHub account first.");
      }

      const [repoOwner, repoName] = importContext.sourceRepoFullName.split("/");
      if (!repoOwner || !repoName) {
        throw new Error(`Invalid repository name: ${importContext.sourceRepoFullName}`);
      }

      // Early permission check via GitHub API. Cheaper than letting the snapshot
      // fetcher's `/repos/...` call fail later, and produces a user-friendly
      // "go fix your repo selection" message before any other work runs.
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

      const detectedVisibility = accessCheck.isPrivate ? ("private" as const) : ("public" as const);
      await ctx.runMutation(internal.repositories.updateRepoVisibility, {
        repositoryId: importContext.repositoryId,
        visibility: detectedVisibility,
      });

      // Tier 1 snapshot — single API-driven fetch produces the
      // `RepositorySnapshot` shape `buildRepositoryManifest` /
      // `createChunkRecords` consume.
      const fetched = await fetchRepositorySnapshot({
        installationId,
        owner: repoOwner,
        repo: repoName,
        preferredBranch: importContext.branch,
      });

      const snapshot = fetched.snapshot;
      const fileRecords = snapshot.files;
      const manifest = buildRepositoryManifest(snapshot);
      const chunkRecords = createChunkRecords(snapshot);

      const headerResult = (await ctx.runMutation(internal.imports.persistImportHeader, {
        importId: args.importId,
        jobId: importContext.jobId,
        commitSha: fetched.commitSha,
        branch: fetched.branch,
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

      await ctx.runMutation(internal.imports.finalizeImportCompletion, {
        importId: args.importId,
        jobId: importContext.jobId,
        commitSha: fetched.commitSha,
        branch: fetched.branch,
        detectedLanguages: manifest.detectedLanguages,
        packageManagers: manifest.packageManagers,
        entrypoints: manifest.entrypoints,
        fileCount: fileRecords.length,
        summary: manifest.summary,
        readmeSummary: summarizeReadme(snapshot.readmeContent),
        architectureSummary: "Repository imported and indexed for architecture review.",
      });
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : "Unknown import error";

      const lowerMsg = errorMessage.toLowerCase();
      const isAuthFailure =
        lowerMsg.includes("not found") ||
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
