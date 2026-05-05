import { memo, useMemo, type ReactNode } from "react";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  EyeIcon,
  LightningIcon,
  SparkleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

type RepositoryStatusDeckProps = {
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
   * Wired to the same `handleSelectArtifact` the chat citation jumps use, so
   * "View analysis" from the deck and `[A#]` in chat both land on the same
   * affordance.
   */
  onViewArtifact: (artifactId: ArtifactId) => void;
};

/**
 * Surface 1 (per `background-operations-ux-redesign.md`). Three compact status
 * cards plus an inline Activity Timeline answer the three questions the design
 * doc opens with: can I use this repo, what did I just start, where are the
 * results.
 *
 * Each card sources its (title, description, tone) from a pure `present*Surface`
 * helper in `lib/operations.ts` so the StatusDeck, the chat empty state, and
 * any future status surfaces stay aligned on the same vocabulary. The
 * Activity Timeline reuses `presentOperation` for each job row — the same
 * helper the chat-side ticker would reach for if we ever surface an inline
 * progress strip there.
 */
export function RepositoryStatusDeck({
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
}: RepositoryStatusDeckProps) {
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
    // Belt-and-braces guard mirroring the disabled state below: if the sandbox
    // status flips to unavailable between render and click, swallow the call
    // so we don't open the dialog with a backend that will reject. Same
    // pattern as the existing call-site so the disabled UI and the click
    // guard never disagree.
    if (activeDeepAnalysisJob || !isSandboxAvailable) {
      return;
    }
    onRunAnalysis();
  };

  return (
    <section className="border-b border-border bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.10),transparent_32rem)] px-4 py-3 md:px-6">
      <div className="grid gap-3 xl:grid-cols-[1.1fr_1fr_1.1fr]">
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
            >
              <ArrowsClockwiseIcon weight="bold" className={cn(repositoryBusy && "animate-spin")} />
              {repositoryBusy
                ? "Syncing..."
                : hasRemoteUpdates
                  ? "Sync updates"
                  : repositoryFailed
                    ? "Retry sync"
                    : "Sync"}
            </Button>
          }
        />

        <StatusCard
          eyebrow="Live sandbox"
          surface={sandboxStatus}
          icon={<LightningIcon weight="bold" />}
          meta={
            sandboxStatus.ttlExpiresAt ? (
              <RelativeExpiry timestamp={sandboxStatus.ttlExpiresAt} />
            ) : null
          }
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
            <DeepAnalysisCardActions
              hasActiveJob={Boolean(activeDeepAnalysisJob)}
              hasLatestAnalysis={Boolean(latestDeepAnalysis)}
              isSandboxAvailable={isSandboxAvailable}
              onRunAnalysis={handleRunAnalysis}
              onViewAnalysis={() => latestDeepAnalysis && onViewArtifact(latestDeepAnalysis._id)}
            />
          }
        />
      </div>

      <ActivityTimeline
        jobs={jobs}
        activeDeepAnalysisJob={activeDeepAnalysisJob}
        artifacts={artifacts}
        onViewArtifact={onViewArtifact}
        onRetrySync={onSync}
        repositoryFailed={repositoryFailed}
      />
    </section>
  );
}

// Plain function component. We previously wrapped this in `memo()` but the
// caller passes inline JSX for `icon` / `action` / `meta`, so the shallow
// comparison always failed and the memo did no work. The card itself is
// trivial to re-render — keep the cost transparent rather than paying for
// dead ceremony.
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
    <Card className="overflow-hidden border-border/80 bg-background/80 p-4 shadow-sm backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <span className={cn("grid size-7 place-items-center rounded-md", toneClassName(surface.tone))}>{icon}</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {eyebrow}
            </span>
          </div>
          <h2 className="text-sm font-semibold tracking-tight">{surface.title}</h2>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{surface.description}</p>
          {meta ? <div className="mt-1.5 text-[11px] text-muted-foreground/90">{meta}</div> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </Card>
  );
}

function DeepAnalysisCardActions({
  hasActiveJob,
  hasLatestAnalysis,
  isSandboxAvailable,
  onRunAnalysis,
  onViewAnalysis,
}: {
  hasActiveJob: boolean;
  hasLatestAnalysis: boolean;
  isSandboxAvailable: boolean;
  onRunAnalysis: () => void;
  onViewAnalysis: () => void;
}) {
  // When an analysis already exists we show two actions side-by-side ("View
  // analysis" + "Run again"). The dual layout matches the design doc Surface
  // 4 — the latest deep analysis is featured as a result, and re-running is a
  // secondary affordance rather than the primary CTA.
  if (hasLatestAnalysis) {
    return (
      <div className="flex flex-col items-stretch gap-1.5">
        <Button type="button" size="sm" variant="default" onClick={onViewAnalysis}>
          <EyeIcon weight="bold" />
          View analysis
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={hasActiveJob || !isSandboxAvailable}
          onClick={onRunAnalysis}
        >
          <SparkleIcon weight="bold" />
          {hasActiveJob ? "Running" : "Run again"}
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      disabled={hasActiveJob || !isSandboxAvailable}
      onClick={onRunAnalysis}
    >
      <SparkleIcon weight="bold" />
      {hasActiveJob ? "Running" : "Run analysis"}
    </Button>
  );
}

function RelativeCompletion({ timestamp }: { timestamp: number }) {
  const label = useRelativeTime(timestamp);
  if (!label) return null;
  return <span>Completed {label}</span>;
}

/**
 * Displays the sandbox auto-archive countdown ("Auto-archives in 23 min").
 * The hook handles cadence and re-renders on tick; the component is a thin
 * formatter wrapper so the deck stays declarative.
 */
function RelativeExpiry({ timestamp }: { timestamp: number }) {
  const label = useTimeUntil(timestamp);
  if (!label) return null;
  return <span>Auto-archives {label}</span>;
}

const TIMELINE_VISIBLE_LIMIT = 6;

/**
 * Surface 3 — Activity Timeline. Replaces the generic JobsPopoverButton's
 * debug-flavoured list with an inline timeline of user-relevant work. We keep
 * it surgical: only show jobs that pass `isUserRelevantJob` (no cleanup or
 * webhook noise), favour active work first, then recent failures, then recent
 * completions; cap at `TIMELINE_VISIBLE_LIMIT` so the deck stays compact.
 *
 * Result CTAs come from the artifact-by-jobId map: when a deep_analysis job
 * produced an artifact, "View analysis" jumps the user to the artifact card;
 * when an import job failed, the row offers "Retry sync".
 */
function ActivityTimeline({
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
  // The active deep-analysis job is queried via a separate index for low-
  // latency reads (see `getRepositoryDetail`); merge it into the timeline so
  // the user sees a single coherent list rather than wondering why "Run deep
  // analysis" didn't surface progress here. De-dupe by id against the recent
  // jobs feed in case the same row appears in both.
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

  // Index artifacts by source job once per render so each row's CTA lookup is
  // O(1) — at 30 jobs and ~20 artifacts the linear search would be cheap, but
  // the map also documents the relationship explicitly for any future code
  // that needs the same pairing.
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
    <div className="mt-3 rounded-xl border border-border/80 bg-background/70 p-3">
      <div className="mb-2 flex items-center gap-2">
        <ClockCounterClockwiseIcon size={14} weight="bold" className="text-muted-foreground" />
        <h3 className="text-xs font-semibold">Activity timeline</h3>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {visibleJobs.length} visible
        </Badge>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {visibleJobs.map((job) => (
          <ActivityRow
            key={job._id}
            job={job}
            artifact={artifactByJobId.get(job._id)}
            onViewArtifact={onViewArtifact}
            onRetrySync={job.kind === "import" && job.status === "failed" && repositoryFailed ? onRetrySync : undefined}
          />
        ))}
      </div>
    </div>
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
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <span className={cn("mt-1 grid size-5 place-items-center rounded-full", toneClassName(operation.tone))}>
        {operation.tone === "error" ? (
          <WarningCircleIcon size={12} weight="bold" />
        ) : (
          <CheckCircleIcon size={12} weight="bold" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-xs font-medium">{operation.title}</p>
          <Badge variant="outline" className="text-[10px]">
            {operation.statusLabel}
          </Badge>
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{operation.stageLabel}</p>
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
    </div>
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
