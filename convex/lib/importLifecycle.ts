import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { ImportContext, ImportRunningState } from "./functionResultSchemas";
import { cancelActiveJob, completeRunningJob, failRunningJob, markQueuedJobRunning } from "./jobs";

const REPOSITORY_DELETION_CANCEL_REASON =
  "Repository deletion is in progress. The import was cancelled before it could finish.";
const REPOSITORY_ARCHIVED_CANCEL_REASON = "Repository was archived. The import was cancelled before it could finish.";

export type PersistGuardResult =
  | {
      kind: "ready";
      importRecord: Doc<"imports">;
      repository: Doc<"repositories">;
    }
  | { kind: "completed" }
  | { kind: "cancelled"; reason?: string };

function reasonForRepositoryTombstone(repository: Doc<"repositories"> | null | undefined): string {
  if (!repository) {
    return REPOSITORY_DELETION_CANCEL_REASON;
  }
  if (repository.deletionRequestedAt) {
    return REPOSITORY_DELETION_CANCEL_REASON;
  }
  if (repository.archivedAt) {
    return REPOSITORY_ARCHIVED_CANCEL_REASON;
  }
  return REPOSITORY_DELETION_CANCEL_REASON;
}

export async function loadImportContext(
  ctx: QueryCtx | MutationCtx,
  importId: Id<"imports">,
): Promise<ImportContext | null> {
  const importRecord = await ctx.db.get(importId);
  if (!importRecord) {
    return null;
  }

  if (importRecord.status === "completed") {
    return {
      kind: "completed" as const,
    };
  }

  if (importRecord.status === "cancelled") {
    return {
      kind: "cancelled" as const,
      jobId: importRecord.jobId,
      reason: importRecord.errorMessage ?? "Import is already in a terminal state.",
    };
  }

  if (importRecord.status === "failed") {
    return {
      kind: "cancelled" as const,
      jobId: importRecord.jobId,
      reason: importRecord.errorMessage ?? "Import failed previously.",
    };
  }

  const repository = await ctx.db.get(importRecord.repositoryId);
  if (!repository || repository.deletionRequestedAt || repository.archivedAt) {
    return {
      kind: "cancelled" as const,
      jobId: importRecord.jobId,
      reason: reasonForRepositoryTombstone(repository),
    };
  }

  return {
    kind: "ready" as const,
    repositoryId: repository._id,
    jobId: importRecord.jobId,
    branch: importRecord.branch,
    sourceUrl: importRecord.sourceUrl,
    ownerTokenIdentifier: importRecord.ownerTokenIdentifier,
    accessMode: repository.accessMode,
    sourceRepoFullName: repository.sourceRepoFullName,
  };
}

export async function markImportRunningForMutation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
  },
): Promise<ImportRunningState> {
  const importRecord = await ctx.db.get(args.importId);
  const job = await ctx.db.get(args.jobId);
  const repository = importRecord ? await ctx.db.get(importRecord.repositoryId) : null;

  if (importRecord?.status === "completed") {
    return {
      kind: "completed" as const,
    };
  }

  if (importRecord?.status === "cancelled") {
    return {
      kind: "cancelled" as const,
      reason: importRecord.errorMessage ?? "Import is already in a terminal state.",
    };
  }

  if (importRecord?.status === "failed") {
    return {
      kind: "cancelled" as const,
      reason: importRecord.errorMessage ?? "Import failed previously.",
    };
  }

  if (!importRecord || !job || !repository || repository.deletionRequestedAt || repository.archivedAt) {
    return {
      kind: "cancelled" as const,
      reason: reasonForRepositoryTombstone(repository),
    };
  }

  const running = await applyImportRunningState(ctx, args);
  if (!running.started) {
    return {
      kind: "cancelled" as const,
      reason: "Import job is already in a terminal state.",
    };
  }

  return {
    kind: "running" as const,
  };
}

export async function finalizeImportCancellation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
    reason: string;
  },
) {
  const importRecord = await ctx.db.get(args.importId);
  const job = await ctx.db.get(args.jobId);

  if (importRecord?.status === "completed") {
    return { kind: "completed" as const };
  }

  if (importRecord?.status === "cancelled") {
    return { kind: "cancelled" as const };
  }

  if (importRecord?.status === "failed") {
    return {
      kind: "cancelled" as const,
      reason: importRecord.errorMessage,
    };
  }

  const now = Date.now();

  if (importRecord) {
    await ctx.db.patch(args.importId, {
      status: "cancelled",
      completedAt: now,
      errorMessage: args.reason,
    });
  }

  if (job) {
    await cancelActiveJob(ctx, {
      jobId: args.jobId,
      expectedKind: "import",
      completedAt: now,
      outputSummary: args.reason,
      errorMessage: args.reason,
    });
  }

  await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, {
    importId: args.importId,
    importJobId: args.jobId,
  });

  return {
    kind: "cancelled" as const,
  };
}

export async function guardPersistStage(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
  },
): Promise<PersistGuardResult> {
  const importRecord = await ctx.db.get(args.importId);
  if (!importRecord) {
    return { kind: "cancelled" };
  }

  if (importRecord.status === "completed") {
    return { kind: "completed" };
  }

  if (importRecord.status === "cancelled") {
    return { kind: "cancelled", reason: importRecord.errorMessage };
  }

  if (importRecord.status === "failed") {
    return { kind: "cancelled", reason: importRecord.errorMessage };
  }

  const repository = await ctx.db.get(importRecord.repositoryId);
  if (!repository || repository.deletionRequestedAt || repository.archivedAt) {
    await finalizeImportCancellation(ctx, {
      importId: args.importId,
      jobId: args.jobId,
      reason: reasonForRepositoryTombstone(repository),
    });
    return { kind: "cancelled" };
  }

  return {
    kind: "ready",
    importRecord,
    repository,
  };
}

export async function applyImportCompletionState(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    repositoryId: Id<"repositories">;
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
    repositoryDefaultBranch?: string;
  },
) {
  const completedAt = Date.now();
  const completedJob = await completeRunningJob(ctx, {
    jobId: args.jobId,
    expectedKind: "import",
    completedAt,
    outputSummary: args.summary,
  });
  if (!completedJob) {
    return { completed: false as const };
  }

  await ctx.db.patch(args.importId, {
    status: "completed",
    commitSha: args.commitSha,
    branch: args.branch,
    completedAt,
  });
  // Import does not touch `latestSandboxId` — sandbox provisioning is
  // owned by sandbox-grounded Discuss / System Design via
  // `ensureSandboxReady`. Any sandbox the repository already points at
  // stays as the live source until something explicitly re-provisions it.
  await ctx.db.patch(args.repositoryId, {
    importStatus: "completed",
    latestImportId: args.importId,
    latestImportJobId: args.jobId,
    defaultBranch: args.branch ?? args.repositoryDefaultBranch,
    summary: args.summary,
    readmeSummary: args.readmeSummary,
    architectureSummary: args.architectureSummary,
    detectedLanguages: args.detectedLanguages,
    packageManagers: args.packageManagers,
    entrypoints: args.entrypoints,
    fileCount: args.fileCount,
    lastImportedAt: completedAt,
    lastIndexedAt: completedAt,
    lastSyncedCommitSha: args.commitSha,
  });
  return { completed: true as const };
}

export async function markImportFailedForMutation(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
    errorMessage: string;
  },
): Promise<void> {
  const importRecord = await ctx.db.get(args.importId);
  if (
    !importRecord ||
    importRecord.status === "completed" ||
    importRecord.status === "cancelled" ||
    importRecord.status === "failed"
  ) {
    return;
  }

  const repository = await ctx.db.get(importRecord.repositoryId);
  if (!repository || repository.deletionRequestedAt || repository.archivedAt) {
    await finalizeImportCancellation(ctx, {
      importId: args.importId,
      jobId: args.jobId,
      reason: reasonForRepositoryTombstone(repository),
    });
    return;
  }

  const now = Date.now();
  const failedJob = await failRunningJob(ctx, {
    jobId: args.jobId,
    expectedKind: "import",
    completedAt: now,
    errorMessage: args.errorMessage,
  });
  if (!failedJob) {
    return;
  }

  await ctx.db.patch(args.importId, {
    status: "failed",
    completedAt: now,
    errorMessage: args.errorMessage,
  });
  if (repository.importStatus !== "completed") {
    await ctx.db.patch(importRecord.repositoryId, {
      importStatus: "failed",
    });
  }
  await ctx.scheduler.runAfter(0, internal.imports.cleanupSupersededImportSnapshot, {
    importId: args.importId,
    importJobId: args.jobId,
  });
}

async function applyImportRunningState(
  ctx: MutationCtx,
  args: {
    importId: Id<"imports">;
    jobId: Id<"jobs">;
  },
) {
  const now = Date.now();
  const runningJob = await markQueuedJobRunning(ctx, {
    jobId: args.jobId,
    expectedKind: "import",
    stage: "fetching_repository",
    progress: 0.1,
    startedAt: now,
  });
  if (!runningJob) {
    return { started: false as const };
  }

  await ctx.db.patch(args.importId, {
    status: "running",
    startedAt: now,
  });
  return { started: true as const };
}
