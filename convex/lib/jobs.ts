import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type JobStatus = Doc<"jobs">["status"];
export type JobKind = Doc<"jobs">["kind"];
type JobCostCategory = Doc<"jobs">["costCategory"];
type JobTriggerSource = Doc<"jobs">["triggerSource"];
type JobSelections = NonNullable<Doc<"jobs">["selections"]>;

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

// ─── Enqueue ──────────────────────────────────────────────────────────────

/**
 * Required + optional fields for a freshly-queued job row.
 *
 * `kind` drives a per-kind scope-field invariant ({@link assertEnqueueScope}):
 *
 *   - `import` / `sandbox_activation` / `cleanup` — `repositoryId` required,
 *     `threadId` forbidden.
 *   - `system_design` / `artifact_draft` — `repositoryId` required; `threadId` is
 *     optional (allowed by {@link assertEnqueueScope} but not required).
 *   - `chat` — `threadId` required; `repositoryId` is denormalized from the
 *     thread when the thread is repository-attached.
 *   - `index` — currently unused; left permissive for future use.
 *
 * The invariants are not encoded in the Convex schema (every scope field is
 * `v.optional`) because the schema is shared across all kinds. Enforcing
 * them at the enqueue seam keeps the rule in one place and rejects bad
 * combinations at insert time rather than letting them ride to the consumer.
 */
export interface EnqueueJobArgs {
  kind: JobKind;
  ownerTokenIdentifier: string;
  costCategory: JobCostCategory;
  triggerSource: JobTriggerSource;
  repositoryId?: Id<"repositories">;
  threadId?: Id<"threads">;
  sandboxId?: Id<"sandboxes">;
  /** Overrides the default `"queued"` stage label. */
  stage?: string;
  /** Overrides the default `0` progress. */
  progress?: number;
  /**
   * When supplied, sets `leaseExpiresAt = now + leaseMs` so the stale-job
   * sweep can rescue the row if the dispatched Node action never marks it
   * running. `now` is captured by the helper so all timestamps in the
   * insert share the same instant.
   */
  leaseMs?: number;
  requestedCommand?: string;
  outputSummary?: string;
  selections?: JobSelections;
}

function assertEnqueueScope(args: EnqueueJobArgs): void {
  switch (args.kind) {
    case "import":
    case "sandbox_activation":
    case "cleanup":
      if (!args.repositoryId) {
        throw new Error(`Job kind "${args.kind}" requires a repositoryId.`);
      }
      if (args.threadId) {
        throw new Error(`Job kind "${args.kind}" cannot carry a threadId.`);
      }
      return;
    case "system_design":
    case "artifact_draft":
      if (!args.repositoryId) {
        throw new Error(`Job kind "${args.kind}" requires a repositoryId.`);
      }
      return;
    case "chat":
      if (!args.threadId) {
        throw new Error(`Job kind "chat" requires a threadId.`);
      }
      return;
    case "index":
      return;
  }
}

/**
 * Insert a new job row with `status: "queued"` and per-kind invariants
 * enforced. Returns the inserted job id so the caller can hand it to the
 * dispatched Node action (the helper does **not** call
 * `ctx.scheduler.runAfter` — each caller's action signature differs, and
 * threading a generic `FunctionReference` through here would buy nothing
 * over a one-line scheduler call at the call site).
 *
 * Cross-cutting concerns (metrics, audit, cost-cap pre-flight) should
 * land on this seam; new job kinds added to the schema only need to be
 * covered in {@link assertEnqueueScope} to inherit the same defaults.
 */
export async function enqueueJob(ctx: MutationCtx, args: EnqueueJobArgs): Promise<Id<"jobs">> {
  assertEnqueueScope(args);
  const now = Date.now();
  return await ctx.db.insert("jobs", {
    kind: args.kind,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    costCategory: args.costCategory,
    triggerSource: args.triggerSource,
    status: "queued",
    stage: args.stage ?? "queued",
    progress: args.progress ?? 0,
    ...(args.repositoryId !== undefined ? { repositoryId: args.repositoryId } : {}),
    ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
    ...(args.sandboxId !== undefined ? { sandboxId: args.sandboxId } : {}),
    ...(args.requestedCommand !== undefined ? { requestedCommand: args.requestedCommand } : {}),
    ...(args.outputSummary !== undefined ? { outputSummary: args.outputSummary } : {}),
    ...(args.selections !== undefined ? { selections: args.selections } : {}),
    ...(args.leaseMs !== undefined ? { leaseExpiresAt: now + args.leaseMs } : {}),
  });
}

// ─── Active-job scan ──────────────────────────────────────────────────────

/**
 * Scope key for {@link findActiveJob}. Tagged so the helper can pick the
 * matching index (`by_repositoryId_and_kind_and_status_and_leaseExpiresAt`
 * vs `by_threadId_and_kind_and_status_and_leaseExpiresAt`) without
 * accepting an ambiguous "either id" shape.
 */
export type ActiveJobScope = { type: "repository"; id: Id<"repositories"> } | { type: "thread"; id: Id<"threads"> };

export interface FindActiveJobArgs {
  kind: JobKind;
  scope: ActiveJobScope;
  /**
   * Wall-clock ms epoch supplied by the caller so the index lease guard
   * (`gte("leaseExpiresAt", now)`) and any caller-side downstream checks
   * agree on a single instant.
   */
  now: number;
  /**
   * Filters the bounded scan after the index read. Used by callers that
   * share a `kind` literal but need to discriminate further on a job
   * field the index does not cover.
   */
  predicate?: (job: Doc<"jobs">) => boolean;
  /**
   * Per-status overfetch cap. Defaults to 1 (sufficient when the caller
   * has no predicate); raise when the predicate may filter out the
   * first few rows.
   */
  limit?: number;
}

/**
 * Return the most-advanced active job (queued OR running) matching
 * `scope` + `kind`, with `leaseExpiresAt > now`, optionally filtered by
 * `predicate`. Running jobs are preferred over queued — when both exist
 * the running one is "further along" and is the natural surface for UI
 * progress.
 *
 * Returns `null` when no row matches. The scan is bounded by `limit`
 * (default 1) per status, paginating-by-status: callers that need a
 * different shape (a Map of all active jobs, ignore-lease semantics for
 * owner-initiated cancellation) build inline; this helper covers the
 * common "is there one already in flight?" case.
 */
export async function findActiveJob(ctx: QueryCtx | MutationCtx, args: FindActiveJobArgs): Promise<Doc<"jobs"> | null> {
  const limit = Math.max(1, args.limit ?? 1);
  const [queued, running] = await Promise.all([
    queryJobsByScope(ctx, args.scope, args.kind, "queued", args.now, limit),
    queryJobsByScope(ctx, args.scope, args.kind, "running", args.now, limit),
  ]);
  const predicate = args.predicate ?? (() => true);
  for (const job of [...running, ...queued]) {
    if (predicate(job)) {
      return job;
    }
  }
  return null;
}

function queryJobsByScope(
  ctx: QueryCtx | MutationCtx,
  scope: ActiveJobScope,
  kind: JobKind,
  status: "queued" | "running",
  now: number,
  limit: number,
): Promise<Doc<"jobs">[]> {
  if (scope.type === "repository") {
    return ctx.db
      .query("jobs")
      .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q.eq("repositoryId", scope.id).eq("kind", kind).eq("status", status).gte("leaseExpiresAt", now),
      )
      .take(limit);
  }
  return ctx.db
    .query("jobs")
    .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("threadId", scope.id).eq("kind", kind).eq("status", status).gte("leaseExpiresAt", now),
    )
    .take(limit);
}

// ─── State transitions ────────────────────────────────────────────────────

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

// ─── Stale recovery ───────────────────────────────────────────────────────

/**
 * Eligibility predicate for stale-job recovery. Returns `true` when the
 * job is currently:
 *
 *   - present (`!== null`),
 *   - of the expected kind,
 *   - in an active status (`queued` or `running`),
 *   - past its lease expiration (`leaseExpiresAt <= now`), and
 *   - matches any extra `predicate` (used to discriminate jobs that
 *     share a `kind` literal on a field the index does not cover).
 *
 * Pure — takes a pre-loaded job document so callers can decide
 * separately what to do with the same lookup result. The simple
 * recoveries hand straight off to {@link runStaleJobRecovery}; the chat
 * recovery checks eligibility here and then runs an extensive cleanup
 * ceremony (drain tool events, patch the assistant message, settle
 * stream state) before its own internal call to {@link failStaleActiveJob}.
 *
 * The TypeScript predicate narrows `job` to `Doc<"jobs">` so callers
 * using the result inside an `if` block can dereference `job.xxx`
 * without re-asserting non-null.
 */
export function isJobStaleAndRecoverable(
  job: Doc<"jobs"> | null,
  now: number,
  options: {
    expectedKind: JobKind;
    predicate?: (job: Doc<"jobs">) => boolean;
  },
): job is Doc<"jobs"> {
  if (
    !job ||
    job.kind !== options.expectedKind ||
    !isActiveJobStatus(job.status) ||
    typeof job.leaseExpiresAt !== "number" ||
    job.leaseExpiresAt > now
  ) {
    return false;
  }
  return options.predicate ? options.predicate(job) : true;
}

/**
 * Full stale-recovery mutation helper for the common case: load the
 * job, check eligibility via {@link isJobStaleAndRecoverable}, and call
 * {@link failStaleActiveJob} when the check passes.
 *
 * Returns `{ recovered: true }` when the helper actually transitioned
 * a stale job to `failed`, and `{ recovered: false }` when the job was
 * healthy, terminal, never existed, or lost the race to a concurrent
 * recovery (e.g. another scheduler tick). Most callers ignore the
 * result; cron-driven callers ({@link reconcileStaleInteractiveJobs})
 * use the boolean only when they need to count actual recoveries.
 *
 * Callers that need to do additional cleanup work alongside the
 * transition (chat: drain tool events, patch the assistant message)
 * should NOT use this helper. Load the job themselves, call
 * {@link isJobStaleAndRecoverable} for the same eligibility gate, then
 * run their own ceremony — that pattern keeps the eligibility logic in
 * one place without forcing this helper to grow callbacks.
 */
export async function runStaleJobRecovery(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    expectedKind: JobKind;
    errorMessage: string;
    predicate?: (job: Doc<"jobs">) => boolean;
  },
): Promise<{ recovered: boolean }> {
  const now = Date.now();
  const job = await ctx.db.get(args.jobId);
  if (!isJobStaleAndRecoverable(job, now, { expectedKind: args.expectedKind, predicate: args.predicate })) {
    return { recovered: false };
  }
  const failedJob = await failStaleActiveJob(ctx, {
    jobId: args.jobId,
    expectedKind: args.expectedKind,
    now,
    errorMessage: args.errorMessage,
  });
  return { recovered: failedJob !== null };
}
