import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { fetchRepositorySnapshot } from "../githubRepoFetcher";
import type { FetchedRepositorySnapshot } from "../githubRepoFetcher";
import { buildRepositoryManifest, createChunkRecords, type RepositoryManifest } from "./repoAnalysis";
import { logErrorWithId } from "./observability";
import type { ImportContext } from "./functionResultSchemas";

const PERSIST_BATCH_SIZE = 200;

type ReadyImportContext = Extract<ImportContext, { kind: "ready" }>;
type StartedImportRun = { kind: "ready"; context: ReadyImportContext } | { kind: "stopped" };

type RepoFileRecord = FetchedRepositorySnapshot["snapshot"]["files"][number];
type RepoChunkRecord = ReturnType<typeof createChunkRecords>[number];

type AnalyzedImportSnapshot = {
  fetched: FetchedRepositorySnapshot;
  fileRecords: RepoFileRecord[];
  manifest: RepositoryManifest;
  chunkRecords: RepoChunkRecord[];
};

/**
 * Repository import pipeline — GitHub-API-only.
 *
 * This is the implementation module behind the Convex action adapter in
 * `importsNode.ts`. It owns the lifecycle ordering for fetching, analysing,
 * persisting, and finalising an import; the registered action stays a thin
 * adapter so the import lifecycle has one seam.
 */
export async function runRepositoryImportPipeline(ctx: ActionCtx, args: { importId: Id<"imports"> }): Promise<void> {
  let importContext: ImportContext | null = null;

  try {
    const started = await startImportRun(ctx, args.importId);
    if (started.kind === "stopped") {
      return;
    }

    importContext = started.context;
    const analyzed = await fetchAccessibleSnapshot(ctx, importContext);
    await persistAnalyzedSnapshot(ctx, args.importId, importContext, analyzed);
  } catch (error) {
    await handleImportFailure(ctx, args.importId, importContext, error);
  }
}

async function startImportRun(ctx: ActionCtx, importId: Id<"imports">): Promise<StartedImportRun> {
  const importContext = await ctx.runQuery(internal.imports.getImportContext, {
    importId,
  });

  if (!importContext) {
    return { kind: "stopped" };
  }

  if (importContext.kind === "completed") {
    return { kind: "stopped" };
  }

  if (importContext.kind === "cancelled") {
    await cancelImport(ctx, importId, importContext.jobId, importContext.reason);
    return { kind: "stopped" };
  }

  const runningState = await ctx.runMutation(internal.imports.markImportRunning, {
    importId,
    jobId: importContext.jobId,
  });

  if (runningState.kind === "completed") {
    return { kind: "stopped" };
  }

  if (runningState.kind === "cancelled") {
    await cancelImport(ctx, importId, importContext.jobId, runningState.reason);
    return { kind: "stopped" };
  }

  return { kind: "ready", context: importContext };
}

async function fetchAccessibleSnapshot(
  ctx: ActionCtx,
  importContext: ReadyImportContext,
): Promise<AnalyzedImportSnapshot> {
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

  const accessCheck = await ctx.runAction(internal.githubAppNode.checkRepoAccess, {
    installationId,
    owner: repoOwner,
    repo: repoName,
  });

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

  const fetched = await fetchRepositorySnapshot({
    installationId,
    owner: repoOwner,
    repo: repoName,
    preferredBranch: importContext.branch,
  });

  const snapshot = fetched.snapshot;
  return {
    fetched,
    fileRecords: snapshot.files,
    manifest: buildRepositoryManifest(snapshot),
    chunkRecords: createChunkRecords(snapshot),
  };
}

async function persistAnalyzedSnapshot(
  ctx: ActionCtx,
  importId: Id<"imports">,
  importContext: ReadyImportContext,
  analyzed: AnalyzedImportSnapshot,
): Promise<void> {
  const { fetched, fileRecords, manifest, chunkRecords } = analyzed;
  const headerResult = await ctx.runMutation(internal.imports.persistImportHeader, {
    importId,
    jobId: importContext.jobId,
    commitSha: fetched.commitSha,
    branch: fetched.branch,
  });

  if (headerResult.kind !== "ready") {
    return;
  }

  for (const batch of toBatches(fileRecords, PERSIST_BATCH_SIZE)) {
    const fileBatchResult = await ctx.runMutation(internal.imports.persistRepoFilesBatch, {
      importId,
      jobId: importContext.jobId,
      files: batch,
    });

    if (fileBatchResult.kind !== "ready") {
      return;
    }
  }

  for (const batch of toBatches(chunkRecords, PERSIST_BATCH_SIZE)) {
    const chunkBatchResult = await ctx.runMutation(internal.imports.persistRepoChunksBatch, {
      importId,
      jobId: importContext.jobId,
      chunks: batch,
    });

    if (chunkBatchResult.kind !== "ready") {
      return;
    }
  }

  await ctx.runMutation(internal.imports.finalizeImportCompletion, {
    importId,
    jobId: importContext.jobId,
    commitSha: fetched.commitSha,
    branch: fetched.branch,
    detectedLanguages: manifest.detectedLanguages,
    packageManagers: manifest.packageManagers,
    entrypoints: manifest.entrypoints,
    fileCount: fileRecords.length,
    summary: manifest.summary,
    readmeSummary: summarizeReadme(fetched.snapshot.readmeContent),
    architectureSummary: "Repository imported and indexed for architecture review.",
  });
}

async function cancelImport(ctx: ActionCtx, importId: Id<"imports">, jobId: Id<"jobs">, reason: string): Promise<void> {
  await ctx.runMutation(internal.imports.cancelImport, {
    importId,
    jobId,
    reason,
  });
}

async function handleImportFailure(
  ctx: ActionCtx,
  importId: Id<"imports">,
  importContext: ImportContext | null,
  error: unknown,
): Promise<void> {
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
    importId,
    repositoryId: importContext.repositoryId,
    jobId: importContext.jobId,
  });

  await ctx.runMutation(internal.imports.markImportFailed, {
    importId,
    jobId: importContext.jobId,
    errorMessage: `${errorMessage}\n\nReference: ${errorId}`,
  });
}

function summarizeReadme(readme?: string): string {
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
