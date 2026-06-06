import { memo, useMemo, type ReactNode } from "react";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  EyeIcon,
  LightningIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { useRelativeTime, useTimeUntil } from "@/hooks/use-relative-time";
import type { ArtifactId, SandboxModeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  formatArtifactKind,
  isUserRelevantActiveJob,
  isUserRelevantJob,
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
  artifacts: Doc<"artifacts">[];
  hasRemoteUpdates: boolean;
  isSyncing: boolean;
  onSync: () => void;
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
 * Two sections, top-to-bottom:
 *   1. Status cards — Repository intelligence and Live sandbox. Same
 *      `present*Surface` helpers as the previous deck, so wording stays
 *      aligned with the chat ticker.
 *   2. Activity — user-relevant jobs with relative timestamps so two
 *      successive "Repository sync · Complete" rows can be told apart.
 */
export function StatusPanel({
  repository,
  sandboxModeStatus,
  sandbox,
  jobs,
  artifacts,
  hasRemoteUpdates,
  isSyncing,
  onSync,
  onViewArtifact,
  onClose,
  className,
}: StatusPanelProps) {
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

  const repositoryBusy = isSyncing || repository.importStatus === "queued" || repository.importStatus === "running";
  const repositoryFailed = repository.importStatus === "failed";

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

      <ScrollArea className="flex-1 min-h-0">
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
                  <ArrowsClockwiseIcon weight="bold" className={cn(repositoryBusy && "motion-safe:animate-spin")} />
                  <ButtonStateText
                    current={
                      repositoryBusy
                        ? "Syncing…"
                        : hasRemoteUpdates
                          ? "Sync updates"
                          : repositoryFailed
                            ? "Retry sync"
                            : "Sync now"
                    }
                    states={["Sync now", "Sync updates", "Retry sync", "Syncing…"]}
                  />
                </Button>
              }
            />

            <StatusCard
              eyebrow="Live sandbox"
              surface={sandboxStatus}
              icon={<LightningIcon weight="bold" />}
              meta={sandboxStatus.ttlExpiresAt ? <RelativeExpiry timestamp={sandboxStatus.ttlExpiresAt} /> : null}
            />
          </section>

          <ActivitySection
            jobs={jobs}
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

function RelativeExpiry({ timestamp }: { timestamp: number }) {
  const label = useTimeUntil(timestamp);
  if (!label) return null;
  return <span>Auto-archives {label}</span>;
}

const TIMELINE_VISIBLE_LIMIT = 8;

function ActivitySection({
  jobs,
  artifacts,
  onViewArtifact,
  onRetrySync,
  repositoryFailed,
}: {
  jobs: Doc<"jobs">[];
  artifacts: Doc<"artifacts">[];
  onViewArtifact: (artifactId: ArtifactId) => void;
  onRetrySync: () => void;
  repositoryFailed: boolean;
}) {
  const visibleJobs = useMemo(() => {
    const active: Doc<"jobs">[] = [];
    const failed: Doc<"jobs">[] = [];
    const recent: Doc<"jobs">[] = [];
    for (const job of jobs) {
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
  }, [jobs]);

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
          <Spinner size={11} />
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
          <Button
            type="button"
            variant="link"
            size="xs"
            className="mt-1 h-auto px-0 text-[10px] text-primary"
            onClick={() => onViewArtifact(artifact._id)}
          >
            <EyeIcon size={10} weight="bold" />
            View {formatArtifactKind(artifact.kind).toLowerCase()}
          </Button>
        ) : null}
        {onRetrySync ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="mt-1 h-auto px-0 text-[10px] text-destructive"
            onClick={onRetrySync}
          >
            <ArrowsClockwiseIcon size={10} weight="bold" />
            Retry sync
          </Button>
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
      return "bg-success/10 text-success";
    case "warning":
      return "bg-warning/10 text-warning";
    case "error":
      return "bg-destructive/10 text-destructive";
    case "neutral":
      return "bg-muted text-muted-foreground";
  }
}
