import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  LightningIcon,
  SparkleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SandboxModeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatArtifactKind, isUserRelevantActiveJob, presentOperation, type OperationTone } from "@/lib/operations";

type RepositoryStatusDeckProps = {
  repository: Doc<"repositories">;
  sandboxModeStatus: SandboxModeStatus;
  jobs: Doc<"jobs">[];
  activeDeepAnalysisJob: Doc<"jobs"> | null;
  artifacts: Doc<"artifacts">[];
  hasRemoteUpdates: boolean;
  isSyncing: boolean;
  onSync: () => void;
  onRunAnalysis: () => void;
};

export function RepositoryStatusDeck({
  repository,
  sandboxModeStatus,
  jobs,
  activeDeepAnalysisJob,
  artifacts,
  hasRemoteUpdates,
  isSyncing,
  onSync,
  onRunAnalysis,
}: RepositoryStatusDeckProps) {
  const activeDeepAnalysis = activeDeepAnalysisJob;
  const latestDeepAnalysis = artifacts.find((artifact) => artifact.kind === "deep_analysis");
  const repositoryBusy = isSyncing || repository.importStatus === "queued" || repository.importStatus === "running";
  const repositoryFailed = repository.importStatus === "failed";

  return (
    <section className="border-b border-border bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.10),transparent_32rem)] px-4 py-3 md:px-6">
      <div className="grid gap-3 xl:grid-cols-[1.1fr_1fr_1.1fr]">
        <StatusCard
          eyebrow="Repository intelligence"
          title={repositoryBusy ? "Sync in progress" : repositoryFailed ? "Sync needs attention" : "Knowledge ready"}
          description={
            repositoryBusy
              ? "Indexing files and refreshing repository context."
              : repositoryFailed
                ? "The last import failed. Retry to restore repo-aware features."
                : hasRemoteUpdates
                  ? "New commits are available on the remote."
                  : "Indexed context is ready for chat and artifact generation."
          }
          tone={repositoryFailed ? "error" : repositoryBusy ? "active" : hasRemoteUpdates ? "warning" : "success"}
          icon={<DatabaseIcon weight="bold" />}
          action={
            <Button
              type="button"
              size="sm"
              variant={hasRemoteUpdates || repositoryFailed ? "default" : "outline"}
              onClick={onSync}
            >
              <ArrowsClockwiseIcon weight="bold" />
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
          title={sandboxModeStatus.reasonCode === "available" ? "Sandbox ready" : "Sandbox unavailable"}
          description={
            sandboxModeStatus.reasonCode === "available"
              ? "Sandbox-backed chat, scans, and deep analysis can inspect the live filesystem."
              : (sandboxModeStatus.message ?? "Provision or refresh the sandbox to unlock live analysis.")
          }
          tone={sandboxModeStatus.reasonCode === "available" ? "success" : "warning"}
          icon={<LightningIcon weight="bold" />}
        />

        <StatusCard
          eyebrow="Deep analysis"
          title={
            activeDeepAnalysis
              ? presentOperation(activeDeepAnalysis).stageLabel
              : latestDeepAnalysis
                ? "Latest analysis ready"
                : "No analysis yet"
          }
          description={
            activeDeepAnalysis
              ? "A repository-wide analysis is running in the background."
              : latestDeepAnalysis
                ? latestDeepAnalysis.summary
                : "Run a reusable source-tree analysis for future conversations."
          }
          tone={activeDeepAnalysis ? "active" : latestDeepAnalysis ? "success" : "neutral"}
          icon={<SparkleIcon weight="bold" />}
          action={
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={Boolean(activeDeepAnalysis)}
              onClick={onRunAnalysis}
            >
              <SparkleIcon weight="bold" />
              {activeDeepAnalysis ? "Running" : latestDeepAnalysis ? "Run again" : "Run analysis"}
            </Button>
          }
        />
      </div>

      <ActivityTimeline
        jobs={
          activeDeepAnalysis && !jobs.some((job) => job._id === activeDeepAnalysis._id)
            ? [activeDeepAnalysis, ...jobs]
            : jobs
        }
        artifacts={artifacts}
      />
    </section>
  );
}

function StatusCard({
  eyebrow,
  title,
  description,
  tone,
  icon,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  tone: OperationTone;
  icon: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden border-border/80 bg-background/80 p-4 shadow-sm backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <span className={cn("grid size-7 place-items-center rounded-md", toneClassName(tone))}>{icon}</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {eyebrow}
            </span>
          </div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </Card>
  );
}

function ActivityTimeline({ jobs, artifacts }: { jobs: Doc<"jobs">[]; artifacts: Doc<"artifacts">[] }) {
  const visibleJobs = jobs.filter((job) => isUserRelevantActiveJob(job) || job.status === "failed").slice(0, 5);
  const artifactByJobId = new Map(
    artifacts.flatMap((artifact) => (artifact.jobId ? [[artifact.jobId, artifact]] : [])),
  );

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
        {visibleJobs.map((job) => {
          const operation = presentOperation(job);
          const artifact = artifactByJobId.get(job._id);
          return (
            <div
              key={job._id}
              className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
            >
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
                  <p className="mt-1 text-[10px] text-primary">{formatArtifactKind(artifact.kind)} ready</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
