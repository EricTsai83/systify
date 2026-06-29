import type { Doc } from "../../convex/_generated/dataModel";
import type { SandboxModeStatus } from "@/lib/types";
import { isUserRelevantActiveJob, presentRepositoryIntelligenceSurface, presentSandboxSurface } from "@/lib/operations";

export type RepositoryStatusTone = "idle" | "active" | "warning" | "error";

export type RepositoryStatusPresentation = {
  tone: RepositoryStatusTone;
  label: string;
  icon: "spinner" | "alert" | "sparkle" | "sync" | null;
  /** Optional secondary copy used in the tooltip; main label stays compact. */
  detail?: string;
};

export function getRepositoryStatusPresentation(input: {
  repository: Doc<"repositories">;
  sandboxModeStatus: SandboxModeStatus;
  jobs: Doc<"jobs">[];
  hasRemoteUpdates: boolean;
  isSyncing: boolean;
}): RepositoryStatusPresentation {
  const intelligence = presentRepositoryIntelligenceSurface({
    importStatus: input.repository.importStatus,
    isSyncing: input.isSyncing,
    hasRemoteUpdates: input.hasRemoteUpdates,
  });
  const sandbox = presentSandboxSurface({
    sandboxModeStatus: input.sandboxModeStatus,
    sandbox: null,
  });

  const intelligenceFailed = intelligence.tone === "error";
  const sandboxFailed = sandbox.tone === "error";
  if (intelligenceFailed || sandboxFailed) {
    return {
      tone: "error",
      label: intelligenceFailed ? "Sync failed" : "Live source error",
      icon: "alert",
      detail: intelligenceFailed
        ? "Repository import failed. Open the panel to retry."
        : (input.sandboxModeStatus.message ?? "Live source access is unavailable. Open the panel for details."),
    };
  }

  // Active beats warning — when something is running, the user wants progress
  // visibility more than they want a "consider syncing" nudge.
  if (input.jobs.some(isUserRelevantActiveJob) || input.isSyncing) {
    return {
      tone: "active",
      label: "Working…",
      icon: "spinner",
      detail: "Background work is running for this repository.",
    };
  }

  if (input.hasRemoteUpdates) {
    return {
      tone: "warning",
      label: "Needs update",
      icon: "sync",
      detail: "New commits are available on the remote. Sync the repository to import them.",
    };
  }

  if (sandbox.tone === "warning") {
    return {
      tone: "warning",
      label: "Live source idle",
      icon: "alert",
      detail: input.sandboxModeStatus.message ?? "Live source needs a refresh before live analysis.",
    };
  }

  return {
    tone: "idle",
    label: "Ready",
    icon: null,
    detail: "Repository is up to date. Open the panel for details.",
  };
}
