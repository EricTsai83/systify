import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export type JobStatus = Doc<"jobs">["status"];
export type JobKind = Doc<"jobs">["kind"];

export const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const satisfies readonly JobStatus[];

type JobPatch = Partial<
  Pick<
    Doc<"jobs">,
    | "status"
    | "stage"
    | "progress"
    | "outputSummary"
    | "errorMessage"
    | "estimatedInputTokens"
    | "estimatedOutputTokens"
    | "estimatedCostUsd"
    | "startedAt"
    | "completedAt"
    | "leaseExpiresAt"
  >
>;

type JobTransitionOptions = {
  expectedKind?: JobKind;
};

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isActiveJobStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

function matchesExpectedJob(job: Doc<"jobs">, options: JobTransitionOptions | undefined): boolean {
  return options?.expectedKind === undefined || job.kind === options.expectedKind;
}

async function patchJobIfCurrent(
  ctx: MutationCtx,
  jobId: Id<"jobs">,
  predicate: (job: Doc<"jobs">) => boolean,
  patch: JobPatch,
): Promise<Doc<"jobs"> | null> {
  const job = await ctx.db.get(jobId);
  if (!job || !predicate(job)) {
    return null;
  }
  await ctx.db.patch(jobId, patch);
  return { ...job, ...patch };
}

export async function markQueuedJobRunning(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    stage: string;
    progress: number;
    startedAt: number;
    leaseExpiresAt?: number;
  } & JobTransitionOptions,
): Promise<Doc<"jobs"> | null> {
  return await patchJobIfCurrent(ctx, args.jobId, (job) => matchesExpectedJob(job, args) && job.status === "queued", {
    status: "running",
    stage: args.stage,
    progress: args.progress,
    startedAt: args.startedAt,
    leaseExpiresAt: args.leaseExpiresAt,
  });
}

export async function refreshRunningJobLease(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    leaseExpiresAt: number;
  } & JobTransitionOptions,
): Promise<Doc<"jobs"> | null> {
  return await patchJobIfCurrent(ctx, args.jobId, (job) => matchesExpectedJob(job, args) && job.status === "running", {
    leaseExpiresAt: args.leaseExpiresAt,
  });
}

export async function updateRunningJobProgress(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    stage: string;
    progress: number;
  } & JobTransitionOptions,
): Promise<Doc<"jobs"> | null> {
  return await patchJobIfCurrent(ctx, args.jobId, (job) => matchesExpectedJob(job, args) && job.status === "running", {
    stage: args.stage,
    progress: args.progress,
  });
}

export async function completeRunningJob(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    completedAt: number;
    stage?: string;
    progress?: number;
    outputSummary?: string;
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
    estimatedCostUsd?: number;
  } & JobTransitionOptions,
): Promise<Doc<"jobs"> | null> {
  return await patchJobIfCurrent(ctx, args.jobId, (job) => matchesExpectedJob(job, args) && job.status === "running", {
    status: "completed",
    stage: args.stage ?? "completed",
    progress: args.progress ?? 1,
    completedAt: args.completedAt,
    outputSummary: args.outputSummary,
    estimatedInputTokens: args.estimatedInputTokens,
    estimatedOutputTokens: args.estimatedOutputTokens,
    estimatedCostUsd: args.estimatedCostUsd,
    leaseExpiresAt: undefined,
  });
}

export async function failRunningJob(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    completedAt: number;
    errorMessage: string;
    stage?: string;
    progress?: number;
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
    estimatedCostUsd?: number;
  } & JobTransitionOptions,
): Promise<Doc<"jobs"> | null> {
  return await patchJobIfCurrent(ctx, args.jobId, (job) => matchesExpectedJob(job, args) && job.status === "running", {
    status: "failed",
    stage: args.stage ?? "failed",
    progress: args.progress ?? 1,
    completedAt: args.completedAt,
    errorMessage: args.errorMessage,
    estimatedInputTokens: args.estimatedInputTokens,
    estimatedOutputTokens: args.estimatedOutputTokens,
    estimatedCostUsd: args.estimatedCostUsd,
    leaseExpiresAt: undefined,
  });
}

export async function cancelActiveJob(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    completedAt: number;
    errorMessage: string;
    progress?: number;
    outputSummary?: string;
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
    estimatedCostUsd?: number;
  } & JobTransitionOptions,
): Promise<Doc<"jobs"> | null> {
  return await patchJobIfCurrent(
    ctx,
    args.jobId,
    (job) => matchesExpectedJob(job, args) && (isActiveJobStatus(job.status) || job.status === "cancelled"),
    {
      status: "cancelled",
      stage: "cancelled",
      progress: args.progress ?? 1,
      completedAt: args.completedAt,
      outputSummary: args.outputSummary,
      errorMessage: args.errorMessage,
      estimatedInputTokens: args.estimatedInputTokens,
      estimatedOutputTokens: args.estimatedOutputTokens,
      estimatedCostUsd: args.estimatedCostUsd,
      leaseExpiresAt: undefined,
    },
  );
}

export async function failStaleActiveJob(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    now: number;
    errorMessage: string;
  } & JobTransitionOptions,
): Promise<Doc<"jobs"> | null> {
  return await patchJobIfCurrent(
    ctx,
    args.jobId,
    (job) =>
      matchesExpectedJob(job, args) &&
      isActiveJobStatus(job.status) &&
      typeof job.leaseExpiresAt === "number" &&
      job.leaseExpiresAt <= args.now,
    {
      status: "failed",
      stage: "failed",
      progress: 1,
      completedAt: args.now,
      errorMessage: args.errorMessage,
      leaseExpiresAt: undefined,
    },
  );
}
