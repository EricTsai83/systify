import { ArrowsClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

const STAGE_LABELS: Record<string, string> = {
  queued: "Preparing…",
  fetching_repository: "Reading repository from GitHub…",
  persisting_files: "Indexing files…",
  persisting_chunks: "Indexing code chunks…",
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? "Processing…";
}

/**
 * Inline banner shown on the repository page when an import is in progress or
 * has failed. Replaces the old Jobs popover with contextual, actionable
 * feedback right where the user is looking.
 *
 * - Active imports show a slim progress bar with a stage label.
 * - Failed imports show a compact error with a "Retry" button.
 * - Completed / idle states render nothing.
 */
export function ImportStatusBanner({
  importStatus,
  latestImportJobId,
  jobs,
  isSyncing,
  onRetry,
}: {
  importStatus: string;
  latestImportJobId?: Id<"jobs">;
  jobs?: Doc<"jobs">[];
  isSyncing: boolean;
  onRetry: () => void;
}) {
  const isActive = importStatus === "queued" || importStatus === "running";
  const isFailed = importStatus === "failed";

  if (!isActive && !isFailed) {
    return null;
  }

  // Find the latest import job for stage/progress/error details.
  const importJob = latestImportJobId ? jobs?.find((j) => j._id === latestImportJobId) : undefined;

  if (isFailed) {
    return (
      <Alert
        variant="destructive"
        className="grid-cols-[auto_1fr] items-center gap-x-2 border-x-0 border-t-0 border-destructive/20 bg-destructive/5 px-4 py-1.5 pr-24 md:px-6"
      >
        <WarningCircleIcon size={14} weight="fill" className="shrink-0 text-destructive" />
        <AlertDescription className="min-w-0 truncate text-xs text-destructive">
          Import failed{importJob?.errorMessage ? ` — ${importJob.errorMessage}` : ""}
        </AlertDescription>
        <AlertAction className="right-4 top-1/2 -translate-y-1/2 md:right-6">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-2 text-[11px] text-destructive hover:text-destructive"
            disabled={isSyncing}
            onClick={onRetry}
          >
            <ArrowsClockwiseIcon weight="bold" className={cn("size-3", isSyncing && "animate-spin")} />
            {isSyncing ? "Retrying…" : "Retry"}
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  // Active import — slim inline progress
  const stage = importJob?.stage ?? "queued";
  const progress = importJob?.progress ?? 0;
  const hasRealProgress = progress >= 0.5;
  const progressValue = hasRealProgress ? Math.round(progress * 100) : 25;

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-2 px-4 py-1.5 md:px-6">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{stageLabel(stage)}</p>
        {hasRealProgress ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{Math.round(progress * 100)}%</span>
        ) : null}
      </div>

      <Progress
        value={progressValue}
        aria-valuenow={hasRealProgress ? progressValue : undefined}
        className={cn(
          "h-0.5 bg-border/30",
          !hasRealProgress && "[&_[data-slot=progress-indicator]]:animate-indeterminate",
        )}
      />
    </div>
  );
}
