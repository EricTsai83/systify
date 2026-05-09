import { CircleNotchIcon, DatabaseIcon, SparkleIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";

type WorkspaceSetupBannerProps = {
  repository: Doc<"repositories">;
  activeDeepAnalysisJob: Doc<"jobs"> | null | undefined;
  hasDeepAnalysisArtifact: boolean;
  className?: string;
};

/**
 * Persistent strip below the TopBar that surfaces "we're still preparing
 * your workspace" as a single coherent state. Replaces the older flow
 * where the user had to discover and click a "Start analysis" button —
 * the first deep analysis is now scheduled automatically right after the
 * import finishes ({@link convex/imports.ts:finalizeImportCompletion}),
 * so this banner is the user's one source of truth for "is the workspace
 * ready yet?"
 *
 * Two-phase progression — only the active phase is shown so the strip
 * stays a single row on both desktop and mobile:
 *   1. Indexing repository — `repository.importStatus` is queued/running
 *   2. Generating first analysis — no `deep_analysis` artifact yet AND
 *      a deep analysis job is queued/running
 *
 * Hides itself once a `deep_analysis` artifact exists (the user is now
 * fully operational) or when import has terminated in failed/cancelled
 * (a separate import-failed banner takes over above the chat).
 */
export function WorkspaceSetupBanner({
  repository,
  activeDeepAnalysisJob,
  hasDeepAnalysisArtifact,
  className,
}: WorkspaceSetupBannerProps) {
  // Once a deep_analysis artifact exists, the workspace is operational
  // and re-syncs/re-runs are surfaced by the StatusPill instead. The
  // setup banner is reserved for the *first* trip through the lifecycle.
  if (hasDeepAnalysisArtifact) {
    return null;
  }

  const isImporting = repository.importStatus === "queued" || repository.importStatus === "running";
  const isGeneratingAnalysis = Boolean(activeDeepAnalysisJob);

  if (!isImporting && !isGeneratingAnalysis) {
    return null;
  }

  // Import precedes analysis in the lifecycle, so when both are
  // somehow active we surface import — the analysis can't make
  // meaningful progress until the import completes anyway.
  const phase: "import" | "analysis" = isImporting ? "import" : "analysis";

  const title = phase === "import" ? "Indexing your repository" : "Generating first analysis";
  const detail =
    phase === "import"
      ? "Pulling source files and building the search index."
      : "Building a reusable analysis your conversations will cite. Usually 2–3 minutes.";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="workspace-setup-banner"
      className={cn(
        "flex shrink-0 items-center gap-3 border-b border-border bg-muted/40 px-4 py-2.5 md:px-6",
        className,
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        {phase === "import" ? <DatabaseIcon size={14} weight="bold" /> : <SparkleIcon size={14} weight="bold" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold leading-tight">
          <span className="text-muted-foreground">Preparing your workspace · </span>
          {title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>
      </div>
      <CircleNotchIcon
        size={14}
        weight="bold"
        className="shrink-0 animate-spin text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}
