import { useQuery } from "convex/react";
import { SparkleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/**
 * Inline banner for System Design generation status. Subscribes to
 * `getLatestSystemDesignJob`, which surfaces the latest job for the repo
 * while it is active or for ~10 minutes after a terminal state. Render
 * branches:
 *
 *   - `queued` / `running` — stage label + progress bar + spinning sparkle.
 *   - `completed` with `kindFailures` — failure summary + expandable details.
 *   - `failed` — top-level `errorMessage` as a destructive alert.
 *   - `completed` clean — hidden; the generated artifact already appears in
 *     the navigator, so a success banner would be noise.
 *
 * Mounted in `library-shell` so both desktop and mobile see it above the
 * tab strip.
 */
export function SystemDesignStatusBanner({ repositoryId }: { repositoryId: Id<"repositories"> }) {
  const job = useQuery(api.systemDesign.getLatestSystemDesignJob, { repositoryId });

  if (job === undefined || job === null) {
    return null;
  }

  if (job.status === "queued" || job.status === "running") {
    return <ActiveBanner stage={job.stage} progress={job.progress} status={job.status} />;
  }

  const kindFailures = job.kindFailures ?? [];
  if (job.status === "completed" && kindFailures.length > 0) {
    return (
      <FailureBanner
        title={job.outputSummary ?? "System Design generation completed with errors"}
        kindFailures={kindFailures}
      />
    );
  }

  if (job.status === "failed") {
    return (
      <FailureBanner
        title={job.errorMessage ?? job.outputSummary ?? "System Design generation failed"}
        kindFailures={kindFailures}
      />
    );
  }

  return null;
}

function ActiveBanner({
  stage,
  progress,
  status,
}: {
  stage: string | undefined;
  progress: number | undefined;
  status: "queued" | "running";
}) {
  const label = status === "queued" ? "Queued…" : (stage ?? "Generating…");
  const progressValue = progress ?? 0;
  const hasRealProgress = status === "running" && progressValue > 0;
  const renderedValue = hasRealProgress ? Math.round(progressValue * 100) : 25;

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-2 px-4 py-1.5 md:px-6">
        <SparkleIcon size={14} weight="bold" className="shrink-0 animate-spin text-blue-500" />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</p>
        {hasRealProgress ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{renderedValue}%</span>
        ) : null}
      </div>

      <Progress
        value={renderedValue}
        aria-valuenow={hasRealProgress ? renderedValue : undefined}
        className={cn(
          "h-0.5 bg-border/30",
          !hasRealProgress && "[&_[data-slot=progress-indicator]]:animate-indeterminate",
        )}
      />
    </div>
  );
}

function FailureBanner({
  title,
  kindFailures,
}: {
  title: string;
  kindFailures: ReadonlyArray<{ kind: string; errorId: string; message: string }>;
}) {
  return (
    <div className="space-y-0 border-b border-border/50">
      <Alert
        variant="destructive"
        className="grid-cols-[auto_1fr] items-start gap-x-2 border-x-0 border-t-0 border-destructive/20 bg-destructive/5 px-4 py-1.5 pr-24 md:px-6"
      >
        <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-destructive" />
        <AlertDescription className="min-w-0 text-xs text-destructive">{title}</AlertDescription>
      </Alert>

      {kindFailures.length > 0 ? (
        <details className="cursor-pointer border-t border-destructive/20 bg-destructive/5">
          <summary className="px-4 py-1.5 text-[11px] font-medium text-destructive md:px-6">
            {kindFailures.length} failed kind{kindFailures.length === 1 ? "" : "s"} — click for details
          </summary>
          <div className="space-y-1 border-t border-destructive/20 px-4 py-2 md:px-6">
            {kindFailures.map((failure) => (
              <div key={failure.errorId} className="text-[10px] text-destructive/80">
                <div className="font-medium">{failure.kind}</div>
                <div className="mt-0.5 line-clamp-2">{failure.message}</div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
