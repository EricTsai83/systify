import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowRightIcon, SparkleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { describeRepositoryGuideFailure, getRepositoryGuideKindTitle } from "@/lib/repository-guide-failures";

/**
 * Inline banner for System Design generation status. Subscribes to
 * `getLatestSystemDesignJob`, which surfaces the latest job for the repo
 * while it is active or for ~10 minutes after a terminal state.
 *
 * Render branches:
 *   - queued / running — stage label + progress bar (preparing stages
 *     collapse to "Preparing environment for your request…")
 *   - completed with kindFailures — failure banner with action-named
 *     retry button (e.g. "Generate README Summary") + expandable details
 *   - failed — top-level failure banner with the same action-named retry
 *   - completed clean — hidden
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
    return <FailureBanner repositoryId={repositoryId} job={job} />;
  }

  if (job.status === "failed") {
    return <FailureBanner repositoryId={repositoryId} job={job} />;
  }

  return null;
}

function isPreparingStage(stage: string | undefined): boolean {
  if (!stage) return false;
  return /^(preparing|waking|cloning|setting up)/i.test(stage);
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
  const label =
    status === "queued"
      ? "Queued…"
      : isPreparingStage(stage)
        ? "Preparing environment for your request…"
        : (stage ?? "Generating…");
  const progressValue = progress ?? 0;
  const hasRealProgress = status === "running" && progressValue > 0;
  const renderedValue = hasRealProgress ? Math.round(progressValue * 100) : 0;

  return (
    <div className="border-b border-border/50">
      <div className="flex items-center gap-2 px-4 py-1.5 md:px-6">
        <SparkleIcon size={14} weight="bold" className="shrink-0 motion-safe:animate-spin text-blue-500" />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</p>
        {hasRealProgress ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{renderedValue}%</span>
        ) : null}
      </div>

      <Progress
        value={renderedValue}
        aria-valuenow={hasRealProgress ? renderedValue : undefined}
        className="h-0.5 bg-border/30"
      />
    </div>
  );
}

function FailureBanner({ repositoryId, job }: { repositoryId: Id<"repositories">; job: Doc<"jobs"> }) {
  const requestGeneration = useMutation(api.systemDesign.requestSystemDesignGeneration);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const descriptor = describeRepositoryGuideFailure(job);
  const kindFailures = (job.kindFailures ?? []) as ReadonlyArray<{
    kind: string;
    errorId: string;
    message: string;
  }>;

  const [isSubmitting, retry] = useAsyncCallback(async () => {
    if (!descriptor) return;
    setSubmitError(null);
    try {
      // Preserve the original job's (provider, model) so the retry runs
      // against the same pair the user picked the first time. Both
      // fields travel together — when either is missing on a legacy job
      // row, omit both and let the mutation fall back to the System
      // Design defaults.
      const samePick = job.provider !== undefined && job.modelName !== undefined;
      await requestGeneration({
        repositoryId,
        selections: descriptor.selections,
        ...(samePick ? { provider: job.provider, modelName: job.modelName } : {}),
      });
    } catch (err) {
      setSubmitError(toUserErrorMessage(err, "Couldn't start the run. Try again."));
    }
  });

  // No descriptor → render the minimal banner so rows without a structured
  // descriptor still display the error inline.
  if (!descriptor) {
    return (
      <div className="space-y-0 border-b border-border/50">
        <Alert
          variant="destructive"
          className="grid-cols-[auto_1fr] items-start gap-x-2 border-x-0 border-t-0 border-destructive/20 bg-destructive/5 px-4 py-1.5 pr-4 md:px-6"
        >
          <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-destructive" />
          <AlertDescription className="min-w-0 text-xs text-destructive">
            {job.errorMessage ?? job.outputSummary ?? `${REPOSITORY_GUIDE_COPY.name} generation failed`}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-0 border-b border-border/50">
      <Alert
        variant="destructive"
        className="grid-cols-[auto_1fr_auto] items-start gap-x-2 border-x-0 border-t-0 border-destructive/20 bg-destructive/5 px-4 py-2 md:px-6"
      >
        <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold text-destructive">{descriptor.title}</p>
          <p className="text-xs text-destructive/90">{descriptor.reasonText}</p>
          {submitError ? <p className="text-[11px] text-destructive/80">{submitError}</p> : null}
        </div>
        <Button
          size="sm"
          variant="destructive"
          className="shrink-0 gap-1"
          onClick={() => {
            void retry();
          }}
          disabled={isSubmitting}
        >
          {descriptor.buttonLabel}
          <ArrowRightIcon size={12} weight="bold" />
        </Button>
      </Alert>

      {kindFailures.length > 0 ? (
        <details className="cursor-pointer border-t border-destructive/20 bg-destructive/5">
          <summary className="px-4 py-1.5 text-[11px] font-medium text-destructive md:px-6">See what failed</summary>
          <div className="space-y-1 border-t border-destructive/20 px-4 py-2 md:px-6">
            {kindFailures.map((failure) => {
              const kindTitle = getRepositoryGuideKindTitle(failure.kind);
              return (
                <div key={failure.errorId} className="text-[10px] text-destructive/80">
                  <div className="font-medium">{kindTitle}</div>
                  <div className="mt-0.5 line-clamp-2">{failure.message}</div>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}
