import { v, type Infer } from "convex/values";

export const startedResultValidator = v.object({
  started: v.boolean(),
});
export type StartedResult = Infer<typeof startedResultValidator>;

export const jobCancellationStatusValidator = v.object({
  cancelled: v.boolean(),
  jobMissing: v.boolean(),
});
export type JobCancellationStatus = Infer<typeof jobCancellationStatusValidator>;

export const repoAccessCheckResultValidator = v.union(
  v.object({
    accessible: v.literal(true),
    isPrivate: v.boolean(),
    fullName: v.string(),
    defaultBranch: v.string(),
  }),
  v.object({
    accessible: v.literal(false),
    message: v.string(),
  }),
);
export type RepoAccessCheckResult = Infer<typeof repoAccessCheckResultValidator>;

export const importContextValidator = v.union(
  v.object({
    kind: v.literal("ready"),
    repositoryId: v.id("repositories"),
    jobId: v.id("jobs"),
    branch: v.optional(v.string()),
    sourceUrl: v.string(),
    ownerTokenIdentifier: v.string(),
    accessMode: v.union(v.literal("public"), v.literal("private")),
    sourceRepoFullName: v.string(),
  }),
  v.object({
    kind: v.literal("cancelled"),
    jobId: v.id("jobs"),
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("completed"),
  }),
);
export type ImportContext = Infer<typeof importContextValidator>;

export const nullableImportContextValidator = v.union(importContextValidator, v.null());
export type NullableImportContext = Infer<typeof nullableImportContextValidator>;

export const importRunningStateValidator = v.union(
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("completed") }),
  v.object({ kind: v.literal("cancelled"), reason: v.string() }),
);
export type ImportRunningState = Infer<typeof importRunningStateValidator>;

export const persistStageResultValidator = v.union(
  v.object({ kind: v.literal("ready") }),
  v.object({ kind: v.literal("completed") }),
  v.object({ kind: v.literal("cancelled") }),
);
export type PersistStageResult = Infer<typeof persistStageResultValidator>;

export const sandboxCleanupStartValidator = v.union(
  v.object({ started: v.literal(true), remoteId: v.string() }),
  v.object({ started: v.literal(false) }),
);
export type SandboxCleanupStart = Infer<typeof sandboxCleanupStartValidator>;

export const sandboxCleanupScheduleResultValidator = v.object({
  pendingCleanupCount: v.number(),
});
export type SandboxCleanupScheduleResult = Infer<typeof sandboxCleanupScheduleResultValidator>;

export const expiredSandboxValidator = v.object({
  sandboxId: v.id("sandboxes"),
  remoteId: v.string(),
  repositoryId: v.id("repositories"),
  ttlExpiresAt: v.number(),
});
export const expiredSandboxesValidator = v.array(expiredSandboxValidator);
export type ExpiredSandbox = Infer<typeof expiredSandboxValidator>;

export const staleInteractiveJobValidator = v.object({
  jobId: v.id("jobs"),
  kind: v.union(
    v.literal("chat"),
    v.literal("system_design"),
    v.literal("sandbox_activation"),
    v.literal("artifact_draft"),
  ),
});
export const staleInteractiveJobsValidator = v.array(staleInteractiveJobValidator);
export type StaleInteractiveJob = Infer<typeof staleInteractiveJobValidator>;

export const staleImportJobValidator = v.object({
  jobId: v.id("jobs"),
});
export const staleImportJobsValidator = v.array(staleImportJobValidator);
export type StaleImportJob = Infer<typeof staleImportJobValidator>;

export const sandboxLookupResultValidator = v.union(
  v.object({
    sandboxId: v.id("sandboxes"),
    status: v.union(
      v.literal("provisioning"),
      v.literal("ready"),
      v.literal("stopped"),
      v.literal("archived"),
      v.literal("failed"),
    ),
  }),
  v.null(),
);
export type SandboxLookupResult = Infer<typeof sandboxLookupResultValidator>;

export const persistedArtifactResultValidator = v.object({
  artifactId: v.id("artifacts"),
});
export type PersistedArtifactResult = Infer<typeof persistedArtifactResultValidator>;

export const recordedKindRunResultValidator = v.object({
  kindRunId: v.id("systemDesignKindRuns"),
});
export type RecordedKindRunResult = Infer<typeof recordedKindRunResultValidator>;
