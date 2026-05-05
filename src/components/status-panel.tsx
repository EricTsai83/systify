import { memo, useMemo, type ReactNode } from "react";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  EyeIcon,
  LightningIcon,
  SparkleIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRelativeTime, useTimeUntil } from "@/hooks/use-relative-time";
import type { ArtifactId, SandboxModeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  formatArtifactKind,
  isUserRelevantActiveJob,
  isUserRelevantJob,
  presentDeepAnalysisSurface,
  presentOperation,
  presentRepositoryIntelligenceSurface,
  presentSandboxSurface,
  type OperationTone,
  type SurfaceStatus,
} from "@/lib/operations";

type StatusPanelProps = {
  repository: Doc<"repositories">;
  sandboxModeStatus: SandboxModeStatus;
  sandbox: { status: string; ttlExpiresAt: number } | null;
  jobs: Doc<"jobs">[];
  activeDeepAnalysisJob: Doc<"jobs"> | null;
  artifacts: Doc<"artifacts">[];
  hasRemoteUpdates: boolean;
  isSyncing: boolean;
  onSync: () => void;
  onRunAnalysis: () => void;
  /**
   * Opens the artifact panel and scrolls/highlights the given artifact card.
   * Closes this status panel as part of mutual exclusion (see the shell
   * `handleSelectArtifact`); we do not need to dismiss here.
   */
  onViewArtifact: (artifactId: ArtifactId) => void;
  /** Hides the panel close affordance on mobile where the parent Sheet owns it. */
  onClose?: () => void;
  className?: string;
};

/**
 * StatusPanel — the on-demand right-side surface that replaces the always-
 * visible Repository Status Deck. Surfaced via the top-bar status pill so the
 * chat surface stays uncluttered; opened and closed as a peer of the artifact
 * panel under mutual exclusion (only one of the two can be open at a time).
 *
 * Three sections, top-to-bottom:
 *   1. Status cards — Repository intelligence, Live sandbox, Deep analysis.
 *      Same `present*Surface` helpers as the previous deck, so wording stays
 *      aligned with the empty-state nudge and the chat ticker.
 *   2. Operations — currently just "Run deep analysis"; the architecture /
 *      ADR / failure-mode launchers live inside the artifact panel where
 *      they have visual context for what they produce.
 *   3. Activity — user-relevant jobs with relative timestamps so two
 *      successive "Repository sync · Complete" rows can be told apart.
 */
export function StatusPanel({
  repository,
  sandboxModeStatus,
  sandbox,
  jobs,
  activeDeepAnalysisJob,
  artifacts,
  hasRemoteUpdates,
  isSyncing,
  onSync,
  onRunAnalysis,
  onViewArtifact,
  onClose,
  className,
}: StatusPanelProps) {
  const latestDeepAnalysis = useMemo(
    () => artifacts.find((artifact) => artifact.kind === "deep_analysis"),
    [artifacts],
  );

  const repositoryIntelligence = useMemo(
    () =>
      presentRepositoryIntelligenceSurface({
        importStatus: repository.importStatus,
        isSyncing,
        hasRemoteUpdates,
      }),
    [repository.importStatus, isSyncing, hasRemoteUpdates],
  );

  const sandboxStatus = useMemo(
    () => presentSandboxSurface({ sandboxModeStatus, sandbox }),
    [sandboxModeStatus, sandbox],
  );

  const deepAnalysisStatus = useMemo(
    () =>
      presentDeepAnalysisSurface({
        activeJob: activeDeepAnalysisJob,
        latestArtifact: latestDeepAnalysis,
      }),
    [activeDeepAnalysisJob, latestDeepAnalysis],
  );

  const isSandboxAvailable = sandboxModeStatus.reasonCode === "available";
  const repositoryBusy = isSyncing || repository.importStatus === "queued" || repository.importStatus === "running";
  const repositoryFailed = repository.importStatus === "failed";

  const handleRunAnalysis = () => {
    if (activeDeepAnalysisJob || !isSandboxAvailable) {
      return;
    }
    onRunAnalysis();
  };

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col bg-card", className)}>
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-sm font-semibold tracking-tight">Repository status</h2>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close repository status"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <XIcon size={14} weight="bold" />
          </Button>
        ) : null}
      </header>

      <ScrollArea type="always" className="flex-1 min-h-0">
        <div className="flex flex-col gap-4 p-4">
          <section className="flex flex-col gap-2">
            <StatusCard
              eyebrow="Repository intelligence"
              surface={repositoryIntelligence}
              icon={<DatabaseIcon weight="bold" />}
              action={
                <Button
                  type="button"
                  size="sm"
                  variant={hasRemoteUpdates || repositoryFailed ? "default" : "outline"}
                  disabled={repositoryBusy}
                  onClick={onSync}
                  className="w-full"
                >
                  <ArrowsClockwiseIcon weight="bold" className={cn(repositoryBusy && "animate-spin")} />
                  {repositoryBusy
                    ? "Syncing…"
                    : hasRemoteUpdates
                      ? "Sync updates"
                      : repositoryFailed
                        ? "Retry sync"
                        : "Sync now"}
                </Button>
              }
            />

            <StatusCard
              eyebrow="Live sandbox"
              surface={sandboxStatus}
              icon={<LightningIcon weight="bold" />}
              meta={sandboxStatus.ttlExpiresAt ? <RelativeExpiry timestamp={sandboxStatus.ttlExpiresAt} /> : null}
            />

            <StatusCard
              eyebrow="Deep analysis"
              surface={deepAnalysisStatus}
              icon={<SparkleIcon weight="bold" />}
              meta={
                deepAnalysisStatus.lastCompletedAt ? (
                  <RelativeCompletion timestamp={deepAnalysisStatus.lastCompletedAt} />
                ) : null
              }
              action={
                latestDeepAnalysis ? (
                  <div className="flex flex-col gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={() => onViewArtifact(latestDeepAnalysis._id)}
                      className="w-full"
                    >
                      <EyeIcon weight="bold" />
                      View analysis
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={Boolean(activeDeepAnalysisJob) || !isSandboxAvailable}
                      onClick={handleRunAnalysis}
                      className="w-full"
                    >
                      <SparkleIcon weight="bold" />
                      {activeDeepAnalysisJob ? "Running…" : "Run again"}
                    </Button>
                  </div>
                ) : null
              }
            />
          </section>

          {!latestDeepAnalysis ? (
            <section className="rounded-lg border border-dashed border-border/80 bg-muted/30 p-3">
              <p className="text-xs font-semibold">Run a deep analysis</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Reusable source-tree analysis. Future conversations cite it. Usually 2–3 minutes.
              </p>
              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={Boolean(activeDeepAnalysisJob) || !isSandboxAvailable}
                onClick={handleRunAnalysis}
                className="mt-2 w-full"
              >
                <SparkleIcon weight="bold" />
                {activeDeepAnalysisJob ? "Running…" : "Start analysis"}
              </Button>
              {!isSandboxAvailable ? (
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Sandbox required — sync the repository first.
                </p>
              ) : null}
            </section>
          ) : null}

          <ActivitySection
            jobs={jobs}
            activeDeepAnalysisJob={activeDeepAnalysisJob}
            artifacts={artifacts}
            onViewArtifact={onViewArtifact}
            onRetrySync={onSync}
            repositoryFailed={repositoryFailed}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

function StatusCard({
  eyebrow,
  surface,
  icon,
  action,
  meta,
}: {
  eyebrow: string;
  surface: SurfaceStatus;
  icon: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/80 bg-background/60 p-3">
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-md", toneClassName(surface.tone))}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</p>
          <p className="mt-0.5 text-sm font-semibold tracking-tight">{surface.title}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{surface.description}</p>
          {meta ? <p className="mt-1 text-[11px] text-muted-foreground/90">{meta}</p> : null}
        </div>
      </div>
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  );
}

function RelativeCompletion({ timestamp }: { timestamp: number }) {
  const label = useRelativeTime(timestamp);
  if (!label) return null;
  return <span>Completed {label}</span>;
}

function RelativeExpiry({ timestamp }: { timestamp: number }) {
  const label = useTimeUntil(timestamp);
  if (!label) return null;
  return <span>Auto-archives {label}</span>;
}

const TIMELINE_VISIBLE_LIMIT = 8;

function ActivitySection({
  jobs,
  activeDeepAnalysisJob,
  artifacts,
  onViewArtifact,
  onRetrySync,
  repositoryFailed,
}: {
  jobs: Doc<"jobs">[];
  activeDeepAnalysisJob: Doc<"jobs"> | null;
  artifacts: Doc<"artifacts">[];
  onViewArtifact: (artifactId: ArtifactId) => void;
  onRetrySync: () => void;
  repositoryFailed: boolean;
}) {
  const mergedJobs = useMemo(() => {
    if (!activeDeepAnalysisJob) return jobs;
    if (jobs.some((job) => job._id === activeDeepAnalysisJob._id)) return jobs;
    return [activeDeepAnalysisJob, ...jobs];
  }, [activeDeepAnalysisJob, jobs]);

  const visibleJobs = useMemo(() => {
    const active: Doc<"jobs">[] = [];
    const failed: Doc<"jobs">[] = [];
    const recent: Doc<"jobs">[] = [];
    for (const job of mergedJobs) {
      if (!isUserRelevantJob(job)) continue;
      if (isUserRelevantActiveJob(job)) {
        active.push(job);
      } else if (job.status === "failed") {
        failed.push(job);
      } else if (job.status === "completed") {
        recent.push(job);
      }
    }
    return [...active, ...failed, ...recent].slice(0, TIMELINE_VISIBLE_LIMIT);
  }, [mergedJobs]);

  const artifactByJobId = useMemo(() => {
    const map = new Map<string, Doc<"artifacts">>();
    for (const artifact of artifacts) {
      if (artifact.jobId) map.set(artifact.jobId, artifact);
    }
    return map;
  }, [artifacts]);

  if (visibleJobs.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <ClockCounterClockwiseIcon size={14} weight="bold" className="text-muted-foreground" />
        <h3 className="text-xs font-semibold">Activity</h3>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {visibleJobs.length}
        </Badge>
      </div>
      <ol className="flex flex-col gap-1.5">
        {visibleJobs.map((job) => (
          <ActivityRow
            key={job._id}
            job={job}
            artifact={artifactByJobId.get(job._id)}
            onViewArtifact={onViewArtifact}
            onRetrySync={job.kind === "import" && job.status === "failed" && repositoryFailed ? onRetrySync : undefined}
          />
        ))}
      </ol>
    </section>
  );
}

const ActivityRow = memo(function ActivityRow({
  job,
  artifact,
  onViewArtifact,
  onRetrySync,
}: {
  job: Doc<"jobs">;
  artifact: Doc<"artifacts"> | undefined;
  onViewArtifact: (artifactId: ArtifactId) => void;
  onRetrySync?: () => void;
}) {
  const operation = presentOperation(job);
  // Prefer `completedAt` for terminal rows so the user sees when the work
  // actually ended; fall back to creation for queued/running rows where there
  // is no terminal stamp yet. This is the missing piece from the previous deck
  // — without it, two completed sync rows render identically.
  const referenceTimestamp = job.completedAt ?? job._creationTime;
  const relative = useRelativeTime(referenceTimestamp);
  return (
    <li className="flex items-start gap-2.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
      <span
        className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full", toneClassName(operation.tone))}
      >
        {operation.tone === "error" ? (
          <WarningCircleIcon size={11} weight="bold" />
        ) : operation.tone === "active" ? (
          <CircleNotchIcon size={11} weight="bold" className="animate-spin" />
        ) : (
          <CheckCircleIcon size={11} weight="bold" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-xs font-medium">{operation.title}</p>
          <Badge variant="outline" className="text-[10px]">
            {operation.statusLabel}
          </Badge>
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
          {relative ? (
            <>
              {operation.stageLabel} · {relative}
            </>
          ) : (
            operation.stageLabel
          )}
        </p>
        {artifact ? (
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
            onClick={() => onViewArtifact(artifact._id)}
          >
            <EyeIcon size={10} weight="bold" />
            View {formatArtifactKind(artifact.kind).toLowerCase()}
          </button>
        ) : null}
        {onRetrySync ? (
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-destructive hover:underline"
            onClick={onRetrySync}
          >
            <ArrowsClockwiseIcon size={10} weight="bold" />
            Retry sync
          </button>
        ) : null}
      </div>
    </li>
  );
});

function toneClassName(tone: OperationTone) {
  switch (tone) {
    case "active":
      return "bg-primary/10 text-primary";
    case "success":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "warning":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "error":
      return "bg-destructive/10 text-destructive";
    case "neutral":
      return "bg-muted text-muted-foreground";
  }
}
