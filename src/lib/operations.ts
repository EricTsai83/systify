import type { Doc } from "../../convex/_generated/dataModel";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import type { SandboxModeStatus } from "./types";

export type OperationTone = "neutral" | "active" | "success" | "warning" | "error";

export type PresentedOperation = {
  title: string;
  statusLabel: string;
  stageLabel: string;
  tone: OperationTone;
  isActive: boolean;
};

/**
 * Surface descriptor used by the Repository Status Deck. Centralising the
 * (title, description, tone) computation keeps the three status cards aligned
 * with the same vocabulary used in the Activity Timeline and the Artifact
 * panel — see `presentOperation` for the per-job equivalent.
 */
export type SurfaceStatus = {
  title: string;
  description: string;
  tone: OperationTone;
};

const JOB_TITLES: Record<Doc<"jobs">["kind"], string> = {
  import: "Repository sync",
  index: "Repository indexing",
  chat: "Assistant reply",
  system_design: REPOSITORY_GUIDE_COPY.name,
  artifact_draft: "Artifact draft",
  cleanup: "Repository cleanup",
  sandbox_activation: "Live source setup",
};

/**
 * Stage → user-facing copy. The keys are the raw `jobs.stage` strings the
 * pipeline emits; values are written for a non-engineer reader so the timeline
 * and the deck never expose snake_case implementation tokens. Unknown stages
 * fall back to `humanizeToken` so a new pipeline stage shows readable copy
 * the same day it ships, even before the table below is updated.
 */
const STAGE_LABELS: Record<string, string> = {
  queued: "Waiting for a worker",
  fetching_repository: "Reading repository metadata",
  indexing_repository: "Indexing repository knowledge",
  persisting_files: "Persisting source files",
  persisting_chunks: "Writing searchable chunks",
  generating_reply: "Writing the assistant reply",
  completed: "Completed",
  failed: "Needs attention",
  cancelled: "Cancelled",
  deleting_remote_sandbox: "Cleaning up remote sandbox",
};

export function presentOperation(job: Doc<"jobs">): PresentedOperation {
  const isActive = job.status === "queued" || job.status === "running";
  const tone: OperationTone =
    job.status === "failed"
      ? "error"
      : isActive
        ? "active"
        : job.status === "completed"
          ? "success"
          : job.status === "cancelled"
            ? "warning"
            : "neutral";

  return {
    title: JOB_TITLES[job.kind],
    statusLabel: formatStatus(job.status),
    stageLabel: job.errorMessage ?? STAGE_LABELS[job.stage] ?? humanizeToken(job.stage),
    tone,
    isActive,
  };
}

/**
 * The single allowlist of job kinds that surface to end users. Anything not in
 * this set (e.g. `cleanup`, future webhook reconciliation kinds) is treated
 * as system maintenance and stays hidden from the Activity Timeline and the
 * active-job badge — see the design doc Surface 3 ("badge only counts
 * user-relevant active jobs, not system maintenance").
 */
const USER_RELEVANT_JOB_KINDS: ReadonlySet<Doc<"jobs">["kind"]> = new Set([
  "import",
  "index",
  "chat",
  "system_design",
  "artifact_draft",
  "sandbox_activation",
]);

/**
 * UX-rule-of-thumb gate: only background work the user explicitly cares about
 * appears in the Activity Timeline and contributes to the active-job badge.
 * `cleanup` and other system maintenance jobs run in the same `jobs` table but
 * are intentionally hidden.
 */
export function isUserRelevantActiveJob(job: Doc<"jobs">) {
  if (job.status !== "queued" && job.status !== "running") {
    return false;
  }
  return USER_RELEVANT_JOB_KINDS.has(job.kind);
}

/**
 * Same gate as `isUserRelevantActiveJob` but for any status — used by the
 * Activity Timeline so completed / failed user-initiated work shows up in
 * "recent" history while cleanup chatter stays hidden.
 */
export function isUserRelevantJob(job: Doc<"jobs">) {
  return USER_RELEVANT_JOB_KINDS.has(job.kind);
}

export function formatArtifactKind(kind: Doc<"artifacts">["kind"]) {
  const labels: Partial<Record<Doc<"artifacts">["kind"], string>> = {
    architecture_diagram: "Architecture diagram",
    custom_document: "Custom document",
  };
  return labels[kind] ?? humanizeToken(kind);
}

function formatStatus(status: Doc<"jobs">["status"]) {
  const labels: Record<Doc<"jobs">["status"], string> = {
    queued: "Queued",
    running: "Running",
    completed: "Complete",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[status];
}

function humanizeToken(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Surface descriptors for the Repository Status Deck.
// Each surface answers one of the three "can I use this repo right now?"
// questions — repository intelligence, live sandbox, system design. We keep
// the (title, description, tone) decision in one module so the StatusDeck,
// the chat empty-state, and any future status surfaces all read the same
// vocabulary. Pure functions, no React deps — easy to unit-test and to
// memoize at the call site.
// ---------------------------------------------------------------------------

export type RepositoryIntelligenceInput = {
  importStatus: Doc<"repositories">["importStatus"];
  isSyncing: boolean;
  hasRemoteUpdates: boolean;
};

export function presentRepositoryIntelligenceSurface(input: RepositoryIntelligenceInput): SurfaceStatus {
  const isBusy = input.isSyncing || input.importStatus === "queued" || input.importStatus === "running";
  const isFailed = input.importStatus === "failed";

  if (isFailed) {
    return {
      title: "Sync needs attention",
      description: "The last import failed. Retry to restore repo-aware features.",
      tone: "error",
    };
  }
  if (isBusy) {
    return {
      title: "Sync in progress",
      description: "Indexing files and refreshing repository context.",
      tone: "active",
    };
  }
  if (input.hasRemoteUpdates) {
    return {
      title: "Update available",
      description: "New commits are available on the remote.",
      tone: "warning",
    };
  }
  return {
    title: "Knowledge ready",
    description: `Indexed context is ready for chat and ${REPOSITORY_GUIDE_COPY.name} generation.`,
    tone: "success",
  };
}

export type SandboxSurfaceInput = {
  sandboxModeStatus: SandboxModeStatus;
  sandbox: { status: string; ttlExpiresAt: number; autoStopIntervalMinutes?: number } | null;
};

/**
 * Result of `presentSandboxSurface`. `ttlExpiresAt` is only populated on the
 * `available` branch — that is when "Auto-archives in X" is genuinely useful.
 * The other branches already carry the relevant urgency in their tone, and a
 * countdown for an expired/missing sandbox would be misleading.
 */
export type SandboxSurfaceStatus = SurfaceStatus & { ttlExpiresAt?: number };

export function presentSandboxSurface(input: SandboxSurfaceInput): SandboxSurfaceStatus {
  const reasonCode = input.sandboxModeStatus.reasonCode;
  if (reasonCode === "available") {
    return {
      title: "Live source ready",
      description: `Live source chat, artifact drafts, and ${REPOSITORY_GUIDE_COPY.name} generation can inspect the live filesystem.`,
      tone: "success",
      ttlExpiresAt: input.sandbox?.ttlExpiresAt,
    };
  }
  if (reasonCode === "sandbox_provisioning") {
    return {
      title: "Live source starting",
      description:
        input.sandboxModeStatus.message ?? "Live source access is starting. This usually takes under a minute.",
      tone: "active",
    };
  }
  if (reasonCode === "sandbox_expired") {
    return {
      title: "Live source expired",
      description: input.sandboxModeStatus.message ?? "Live source will be prepared when a task needs it.",
      tone: "warning",
    };
  }
  if (reasonCode === "sandbox_unavailable") {
    return {
      title: "Live source error",
      description:
        input.sandboxModeStatus.message ?? "Live source access failed to start. Try again from the chat composer.",
      tone: "error",
    };
  }
  // missing_sandbox
  return {
    title: "Live source not ready",
    description: input.sandboxModeStatus.message ?? "Live source will be prepared when a task needs it.",
    tone: "warning",
  };
}
