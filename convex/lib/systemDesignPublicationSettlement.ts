import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceArtifactInFolderWrite } from "./artifactWrites";
import type { SystemDesignKindPublicationFinalizationResult } from "./functionResultSchemas";
import type { LlmProvider, NormalizedUsage } from "./llmProvider";
import { logWarn } from "./observability";
import { isOwnedBy } from "./ownedDocs";
import { isLeaseActive } from "./rateLimit";
import { isActiveRepository } from "./repositoryAccess";
import { settleSandboxLibraryGenerationUsage } from "./sandboxLibraryGenerationAccounting";
import { SYSTEM_DESIGN_KIND_TO_FOLDER, type SystemDesignKind } from "./systemDesign";
import { systemDesignFailureReasonValidator, type SystemDesignFailureReason } from "./systemDesignFailures";
import { buildUsageSourceId } from "./usageAccounting";

const normalizedUsageValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  cacheWriteTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
});

export const systemDesignKindPublicationOutcomeValidator = v.union(
  v.object({
    kind: v.literal("cached_hit"),
    cachedArtifactId: v.id("artifacts"),
    outputCharLength: v.number(),
  }),
  v.object({
    kind: v.literal("generated"),
    title: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
    outputCharLength: v.number(),
    usage: normalizedUsageValidator,
    totalCostUsd: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("quality_rejected"),
    failureReason: v.literal("output_quality"),
    missingSections: v.array(v.string()),
    outputCharLength: v.number(),
    usage: normalizedUsageValidator,
    totalCostUsd: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("failed"),
    failureReason: systemDesignFailureReasonValidator,
    failureLog: v.optional(
      v.object({
        errorId: v.string(),
        message: v.string(),
      }),
    ),
    outputCharLength: v.optional(v.number()),
    usage: normalizedUsageValidator,
    totalCostUsd: v.optional(v.number()),
  }),
);

export type SystemDesignKindPublicationOutcome = Infer<typeof systemDesignKindPublicationOutcomeValidator>;

type PaidPublicationOutcome = Exclude<SystemDesignKindPublicationOutcome, { kind: "cached_hit" }>;

export interface FinalizeSystemDesignKindPublicationArgs {
  ownerTokenIdentifier: string;
  repositoryId: Id<"repositories">;
  jobId: Id<"jobs">;
  kind: SystemDesignKind;
  provider: LlmProvider;
  modelName: string;
  promptVersion: number;
  alignedImportCommitSha?: string;
  stepCap: number;
  actualSteps: number;
  durationMs: number;
  startedAt: number;
  outcome: SystemDesignKindPublicationOutcome;
}

type ActiveSystemDesignWriteTarget = {
  repository: Doc<"repositories">;
  job: Doc<"jobs">;
};

type KindRunStatus = Doc<"systemDesignKindRuns">["status"];

interface InsertKindRunArgs {
  status: KindRunStatus;
  artifactId?: Id<"artifacts">;
  usage: NormalizedUsage;
  totalCostUsd?: number;
  failureReason?: SystemDesignFailureReason;
  outputCharLength?: number;
  missingSections?: string[];
}

export async function finalizeSystemDesignKindPublication(
  ctx: MutationCtx,
  args: FinalizeSystemDesignKindPublicationArgs,
): Promise<SystemDesignKindPublicationFinalizationResult> {
  const activeTarget = await loadActiveSystemDesignWriteTarget(ctx, args);
  if (!activeTarget) {
    if (args.outcome.kind === "cached_hit") {
      return abortedResult(args.outcome, "inactive_target", false);
    }
    await settlePublicationUsage(ctx, args, args.outcome);
    return abortedResult(args.outcome, "inactive_target", true);
  }

  if (args.outcome.kind === "cached_hit") {
    const cachedArtifact = await loadValidCachedArtifact(ctx, args, args.outcome.cachedArtifactId);
    if (!cachedArtifact) {
      return abortedResult(args.outcome, "invalid_cached_artifact", false);
    }
    const kindRunId = await insertKindRun(ctx, args, {
      status: "cached_hit",
      artifactId: cachedArtifact._id,
      usage: {},
      actualSteps: undefined,
      outputCharLength: args.outcome.outputCharLength,
    });
    return {
      finalized: true,
      status: "cached_hit",
      kindRunId,
      artifactId: cachedArtifact._id,
      countsAsSucceeded: true,
      aborted: false,
    };
  }

  if (args.outcome.kind === "generated") {
    const folderId = await resolveDestinationFolder(ctx, {
      repositoryId: args.repositoryId,
      kind: args.kind,
    });
    const artifactId = await replaceArtifactInFolderWrite(ctx, {
      repositoryId: args.repositoryId,
      jobId: args.jobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: args.kind,
      title: args.outcome.title,
      summary: args.outcome.summary,
      contentMarkdown: args.outcome.contentMarkdown,
      folderId,
      alignedImportCommitSha: args.alignedImportCommitSha,
      generatedByProvider: args.provider,
      generatedByModel: args.modelName,
      promptVersion: args.promptVersion,
    });
    const kindRunId = await insertKindRun(ctx, args, {
      status: "succeeded",
      artifactId,
      usage: args.outcome.usage,
      totalCostUsd: args.outcome.totalCostUsd,
      outputCharLength: args.outcome.outputCharLength,
    });
    await settlePublicationUsage(ctx, args, args.outcome);
    await ctx.db.patch(artifactId, { kindRunId });
    return {
      finalized: true,
      status: "succeeded",
      kindRunId,
      artifactId,
      countsAsSucceeded: true,
      aborted: false,
    };
  }

  if (args.outcome.kind === "quality_rejected") {
    const kindRunId = await insertKindRun(ctx, args, {
      status: "quality_rejected",
      usage: args.outcome.usage,
      totalCostUsd: args.outcome.totalCostUsd,
      failureReason: args.outcome.failureReason,
      outputCharLength: args.outcome.outputCharLength,
      missingSections: args.outcome.missingSections,
    });
    await settlePublicationUsage(ctx, args, args.outcome);
    return {
      finalized: true,
      status: "quality_rejected",
      kindRunId,
      countsAsSucceeded: false,
      aborted: false,
    };
  }

  if (args.outcome.failureLog) {
    await appendKindFailure(ctx, activeTarget.job, {
      kind: args.kind,
      failureReason: args.outcome.failureReason,
      failureLog: args.outcome.failureLog,
    });
  }
  const kindRunId = await insertKindRun(ctx, args, {
    status: "failed",
    usage: args.outcome.usage,
    totalCostUsd: args.outcome.totalCostUsd,
    failureReason: args.outcome.failureReason,
    outputCharLength: args.outcome.outputCharLength,
  });
  await settlePublicationUsage(ctx, args, args.outcome);
  return {
    finalized: true,
    status: "failed",
    kindRunId,
    countsAsSucceeded: false,
    aborted: false,
  };
}

async function loadActiveSystemDesignWriteTarget(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    jobId: Id<"jobs">;
  },
): Promise<ActiveSystemDesignWriteTarget | null> {
  const [repository, job] = await Promise.all([ctx.db.get(args.repositoryId), ctx.db.get(args.jobId)]);
  if (!isOwnedBy(repository, args.ownerTokenIdentifier) || !isActiveRepository(repository)) {
    return null;
  }
  if (
    !job ||
    job.kind !== "system_design" ||
    job.status !== "running" ||
    job.repositoryId !== args.repositoryId ||
    job.ownerTokenIdentifier !== args.ownerTokenIdentifier ||
    !isLeaseActive(job.leaseExpiresAt)
  ) {
    return null;
  }
  return { repository, job };
}

async function loadValidCachedArtifact(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    kind: SystemDesignKind;
  },
  artifactId: Id<"artifacts">,
): Promise<Doc<"artifacts"> | null> {
  const artifact = await ctx.db.get(artifactId);
  if (
    !isOwnedBy(artifact, args.ownerTokenIdentifier) ||
    artifact.repositoryId !== args.repositoryId ||
    artifact.kind !== args.kind
  ) {
    return null;
  }
  return artifact;
}

async function resolveDestinationFolder(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    kind: SystemDesignKind;
  },
): Promise<Id<"artifactFolders">> {
  const folderKey = SYSTEM_DESIGN_KIND_TO_FOLDER[args.kind];
  const candidates = await ctx.db
    .query("artifactFolders")
    .withIndex("by_repositoryId_and_systemKey", (q) =>
      q.eq("repositoryId", args.repositoryId).eq("systemKey", folderKey),
    )
    .take(2);

  const targetFolder = candidates[0] ?? null;
  if (targetFolder === null) {
    throw new Error(`Destination folder for ${args.kind} (systemKey=${folderKey}) is missing.`);
  }
  if (candidates.length > 1) {
    logWarn("system_design", "duplicate_seeded_folder", {
      repositoryId: args.repositoryId,
      systemKey: folderKey,
      chosenFolderId: targetFolder._id,
    });
  }
  return targetFolder._id;
}

async function appendKindFailure(
  ctx: MutationCtx,
  job: Doc<"jobs">,
  args: {
    kind: SystemDesignKind;
    failureReason: SystemDesignFailureReason;
    failureLog: { errorId: string; message: string };
  },
): Promise<void> {
  const previous = job.kindFailures ?? [];
  await ctx.db.patch(job._id, {
    kindFailures: [
      ...previous,
      {
        kind: args.kind,
        errorId: args.failureLog.errorId,
        message: args.failureLog.message.slice(0, 200),
        reason: args.failureReason,
      },
    ],
  });
}

async function insertKindRun(
  ctx: MutationCtx,
  args: FinalizeSystemDesignKindPublicationArgs,
  insert: InsertKindRunArgs & { actualSteps?: number },
): Promise<Id<"systemDesignKindRuns">> {
  return await ctx.db.insert("systemDesignKindRuns", {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    jobId: args.jobId,
    kind: args.kind,
    artifactId: insert.artifactId,
    provider: args.provider,
    modelName: args.modelName,
    promptVersion: args.promptVersion,
    alignedImportCommitSha: args.alignedImportCommitSha,
    stepCap: args.stepCap,
    actualSteps: insert.actualSteps ?? args.actualSteps,
    inputTokens: insert.usage.inputTokens,
    outputTokens: insert.usage.outputTokens,
    cachedInputTokens: insert.usage.cachedInputTokens,
    cacheWriteTokens: insert.usage.cacheWriteTokens,
    reasoningTokens: insert.usage.reasoningTokens,
    totalCostUsd: insert.totalCostUsd,
    durationMs: args.durationMs,
    status: insert.status,
    failureReason: insert.failureReason,
    outputCharLength: insert.outputCharLength,
    missingSections: insert.missingSections,
    startedAt: args.startedAt,
  });
}

async function settlePublicationUsage(
  ctx: MutationCtx,
  args: FinalizeSystemDesignKindPublicationArgs,
  outcome: PaidPublicationOutcome,
): Promise<void> {
  await settleSandboxLibraryGenerationUsage(ctx, {
    sourceId: systemDesignSettlementSourceId(args),
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    occurredAtMs: args.startedAt,
    totalCostUsd: outcome.totalCostUsd,
    usage: outcome.usage,
  });
}

function abortedResult(
  outcome: SystemDesignKindPublicationOutcome,
  reason: "inactive_target" | "invalid_cached_artifact",
  settledUsage: boolean,
): SystemDesignKindPublicationFinalizationResult {
  return {
    finalized: false,
    status: statusForOutcome(outcome),
    countsAsSucceeded: false,
    aborted: true,
    reason,
    settledUsage,
  };
}

function statusForOutcome(outcome: SystemDesignKindPublicationOutcome): KindRunStatus {
  switch (outcome.kind) {
    case "cached_hit":
      return "cached_hit";
    case "generated":
      return "succeeded";
    case "quality_rejected":
      return "quality_rejected";
    case "failed":
      return "failed";
  }
}

function systemDesignSettlementSourceId(args: {
  jobId: Id<"jobs">;
  kind: SystemDesignKind;
  startedAt: number;
}): string {
  return buildUsageSourceId.systemDesign(args.jobId, args.kind, args.startedAt);
}
