import type React from "react";
import { Link } from "react-router-dom";
import {
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CircleNotchIcon,
  CubeIcon,
  DatabaseIcon,
  LightningIcon,
  StackIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Logo } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTimeUntil, useRelativeTime } from "@/hooks/use-relative-time";
import {
  presentRepositoryIntelligenceSurface,
  presentSandboxSurface,
  type OperationTone,
  type SurfaceStatus,
} from "@/lib/operations";
import { cn } from "@/lib/utils";
import { DEFAULT_AUTHENTICATED_PATH, repositoryPath } from "@/route-paths";

/**
 * Resources — viewer-scoped inventory of the viewer's active repositories
 * with their live sandbox state. Surfaces what the per-thread TopBar's
 * StatusPill shows, but at user-aggregate granularity, so a viewer
 * who is in Discuss mode (where the pill is intentionally hidden) still
 * has a single place to answer "what is my system doing right now".
 *
 * Read-only by design. Activate / stop / sync affordances stay on the
 * per-repository TopBar where the user already has the repository
 * context — Resources is a navigation surface, not a control plane.
 */
export function ResourcesPage() {
  return (
    <div className="flex h-dvh w-full flex-1 flex-col overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-3 px-4 sm:px-6">
          <Link
            to={DEFAULT_AUTHENTICATED_PATH}
            className="group flex min-w-0 shrink-0 items-center gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Systify · back to chat"
            title="Back to chat"
          >
            <Logo size={26} />
            <span className="truncate font-mono text-[15px] font-semibold tracking-tight text-foreground transition-colors group-hover:text-muted-foreground">
              Systify
            </span>
          </Link>
          <CaretRightIcon size={12} weight="bold" aria-hidden="true" className="shrink-0 text-muted-foreground/60" />
          <h1 className="flex min-w-0 items-center gap-2">
            <StackIcon size={14} weight="bold" className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">Resources</span>
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 pb-10 pt-5 sm:px-6 sm:pb-12 sm:pt-8">
        <div className="mx-auto w-full max-w-4xl">
          {/*
           * Back-to-chat affordance lives in the content area (not the
           * header) so it stays visible across loading, empty, and
           * populated states without competing with the breadcrumb-like
           * "Systify · Resources" title block. -ml-2 nudges the ghost
           * button's hit target back to the left content edge.
           */}
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground hover:text-foreground">
            <Link to={DEFAULT_AUTHENTICATED_PATH}>
              <CaretLeftIcon weight="bold" />
              Back to chat
            </Link>
          </Button>

          <ResourcesSettingsSection />
        </div>
      </main>
    </div>
  );
}

export function ResourcesSettingsSection() {
  const inventory = useQuery(api.repositories.listResourceInventory, {});

  return (
    <>
      <p className="mb-4 text-sm leading-relaxed text-muted-foreground sm:mb-5">
        Live status for every repository you have imported. Track repository knowledge, live source access, and remote
        updates in one place. Open a repository to sync, refresh, or activate resources.
      </p>

      {inventory === undefined ? (
        <ResourceListSkeleton />
      ) : inventory.length === 0 ? (
        <ResourceEmptyState />
      ) : (
        <>
          <ResourceSummary inventory={inventory} />
          <ul className="mt-4 flex flex-col gap-2.5">
            {inventory.map((row) => (
              <li key={row.repositoryId}>
                <ResourceRow row={row} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

type InventoryRow = NonNullable<ReturnType<typeof useQuery<typeof api.repositories.listResourceInventory>>>[number];

function ResourceSummary({ inventory }: { inventory: InventoryRow[] }) {
  const summary = inventory.reduce(
    (acc, row) => {
      const intelligence = presentRepositoryIntelligenceSurface({
        importStatus: row.importStatus,
        isSyncing: isRepositorySyncing(row),
        hasRemoteUpdates: row.hasRemoteUpdates,
      });
      const sandbox = presentSandboxSurface({
        sandboxModeStatus: row.sandboxModeStatus,
        sandbox: row.sandbox,
      });

      if (intelligence.tone === "error" || sandbox.tone === "error") {
        acc.needsAttention += 1;
      }
      if (isRepositorySyncing(row) || sandbox.tone === "active") {
        acc.working += 1;
      }
      if (row.hasRemoteUpdates) {
        acc.updates += 1;
      }
      if (intelligence.tone === "success" && sandbox.tone === "success" && !row.hasRemoteUpdates) {
        acc.ready += 1;
      }
      return acc;
    },
    { needsAttention: 0, ready: 0, updates: 0, working: 0 },
  );

  return (
    <div className="flex flex-wrap gap-2">
      <ResourceSummaryBadge label="Repositories" value={inventory.length} />
      <ResourceSummaryBadge label="Ready" value={summary.ready} tone="success" />
      <ResourceSummaryBadge label="Working" value={summary.working} tone="active" />
      <ResourceSummaryBadge label="Needs attention" value={summary.needsAttention} tone="error" />
      <ResourceSummaryBadge label="Updates" value={summary.updates} tone="warning" />
    </div>
  );
}

function ResourceSummaryBadge({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: OperationTone;
}) {
  return (
    <Badge variant="outline" className={cn("h-7 gap-1.5", toneTextClassName(tone))}>
      <span className="font-mono tabular-nums">{formatCount(value)}</span>
      <span className="font-medium">{label}</span>
    </Badge>
  );
}

function ResourceRow({ row }: { row: InventoryRow }) {
  const intelligence = presentRepositoryIntelligenceSurface({
    importStatus: row.importStatus,
    isSyncing: isRepositorySyncing(row),
    hasRemoteUpdates: row.hasRemoteUpdates,
  });
  const sandbox = presentSandboxSurface({
    sandboxModeStatus: row.sandboxModeStatus,
    sandbox: row.sandbox,
  });
  const lastSyncedLabel = useRelativeTime(row.lastImportedAt);
  const targetPath = repositoryPath(row.repositoryId);

  return (
    <Card className="p-4 transition-colors hover:border-foreground/25">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border",
              toneClassName(getRowTone(intelligence, sandbox)),
            )}
            aria-hidden="true"
          >
            {getRowTone(intelligence, sandbox) === "error" ? (
              <WarningCircleIcon size={14} weight="bold" />
            ) : (
              <CubeIcon size={14} weight="bold" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold tracking-tight sm:text-base">{row.fullName}</h3>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <ResourceStatus
                label="Repository knowledge"
                surface={intelligence}
                icon={<DatabaseIcon size={12} weight="bold" aria-hidden="true" />}
              />
              <ResourceStatus
                label="Live source"
                surface={sandbox}
                icon={<LightningIcon size={12} weight="bold" aria-hidden="true" />}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground sm:text-xs">
              {sandbox.ttlExpiresAt ? <SandboxExpiry ttlExpiresAt={sandbox.ttlExpiresAt} /> : null}
              {lastSyncedLabel ? (
                <span className="inline-flex items-center gap-1">
                  <ArrowsClockwiseIcon size={11} weight="bold" aria-hidden="true" />
                  Synced {lastSyncedLabel}
                </span>
              ) : null}
              {row.hasRemoteUpdates ? (
                <span className="inline-flex items-center gap-1 text-warning">
                  <LightningIcon size={11} weight="bold" aria-hidden="true" />
                  Updates available
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-row gap-2 sm:shrink-0">
          <Button asChild type="button" variant="secondary" size="sm" className="flex-1 sm:flex-none">
            <Link to={targetPath}>Open repository</Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ResourceStatus({ label, surface, icon }: { label: string; surface: SurfaceStatus; icon: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/40 px-3 py-2">
      <div
        className={cn("flex min-w-0 items-center gap-1.5 text-[11px] font-semibold", toneTextClassName(surface.tone))}
      >
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-1 truncate text-xs font-medium text-foreground">{surface.title}</p>
      <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{surface.description}</p>
    </div>
  );
}

function SandboxExpiry({ ttlExpiresAt }: { ttlExpiresAt: number }) {
  const label = useTimeUntil(ttlExpiresAt);
  if (!label) return null;
  return <span>Auto-archives {label}</span>;
}

function ResourceListSkeleton() {
  return (
    <ul aria-hidden="true" className="mt-4 flex flex-col gap-2.5">
      {Array.from({ length: 3 }).map((_, index) => (
        <li key={index}>
          <Card className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <Skeleton className="size-8 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-64" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
              <Skeleton className="h-8 w-full sm:w-32" />
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function ResourceEmptyState() {
  return (
    <div className="mt-4 flex flex-col items-center justify-center px-4 py-12 text-center sm:py-16">
      <CircleNotchIcon size={22} className="text-muted-foreground" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold tracking-tight sm:text-lg">No active repositories</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Import a repository from the sidebar to see its sandbox and sync state here.
      </p>
      <Button asChild variant="secondary" size="sm" className="mt-6">
        <Link to={DEFAULT_AUTHENTICATED_PATH}>
          <CaretLeftIcon weight="bold" />
          Back to chat
        </Link>
      </Button>
    </div>
  );
}

function isRepositorySyncing(row: InventoryRow) {
  return row.importStatus === "queued" || row.importStatus === "running";
}

function getRowTone(intelligence: SurfaceStatus, sandbox: SurfaceStatus): OperationTone {
  if (intelligence.tone === "error" || sandbox.tone === "error") {
    return "error";
  }
  if (intelligence.tone === "active" || sandbox.tone === "active") {
    return "active";
  }
  if (intelligence.tone === "warning" || sandbox.tone === "warning") {
    return "warning";
  }
  if (intelligence.tone === "success" && sandbox.tone === "success") {
    return "success";
  }
  return "neutral";
}

function formatCount(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function toneTextClassName(tone: OperationTone) {
  switch (tone) {
    case "active":
      return "text-primary";
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "error":
      return "text-destructive";
    case "neutral":
    default:
      return "text-muted-foreground";
  }
}

function toneClassName(tone: OperationTone) {
  switch (tone) {
    case "active":
      return "bg-primary/10 text-primary border-primary/40";
    case "success":
      return "bg-success/10 text-success border-success/40";
    case "warning":
      return "bg-warning/10 text-warning border-warning/40";
    case "error":
      return "bg-destructive/10 text-destructive border-destructive/40";
    case "neutral":
    default:
      return "bg-muted text-muted-foreground";
  }
}
