import type { Doc } from "../../convex/_generated/dataModel";

export type OperationTone = "neutral" | "active" | "success" | "warning" | "error";

export type PresentedOperation = {
  title: string;
  statusLabel: string;
  stageLabel: string;
  tone: OperationTone;
  isActive: boolean;
};

const JOB_TITLES: Record<Doc<"jobs">["kind"], string> = {
  import: "Repository sync",
  index: "Repository indexing",
  chat: "Assistant reply",
  deep_analysis: "Deep analysis",
  cleanup: "Repository cleanup",
};

const STAGE_LABELS: Record<string, string> = {
  queued: "Waiting for a worker",
  provisioning_sandbox: "Preparing a live sandbox",
  indexing_repository: "Indexing repository knowledge",
  persisting_files: "Persisting source files",
  persisting_chunks: "Writing searchable chunks",
  generating_reply: "Writing the assistant reply",
  focused_inspection: "Inspecting the live source tree",
  failure_mode_analysis: "Scanning subsystem risks",
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

export function isUserRelevantActiveJob(job: Doc<"jobs">) {
  if (job.status !== "queued" && job.status !== "running") {
    return false;
  }
  return job.kind === "import" || job.kind === "index" || job.kind === "chat" || job.kind === "deep_analysis";
}

export function formatArtifactKind(kind: Doc<"artifacts">["kind"]) {
  const labels: Partial<Record<Doc<"artifacts">["kind"], string>> = {
    manifest: "Repository manifest",
    deep_analysis: "Deep analysis",
    architecture_diagram: "Architecture diagram",
    adr: "ADR",
    failure_mode_analysis: "Failure mode",
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
