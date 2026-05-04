import {
  DotsThreeVerticalIcon,
  SparkleIcon,
  TrashIcon,
  ArrowsClockwiseIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRelativeTime } from "@/hooks/use-relative-time";
import { RepoInfoPopover } from "@/components/repo-info-popover";
import { RepoStatusIndicator } from "@/components/repo-status-indicator";
import { AttachRepoMenu } from "@/components/attach-repo-menu";
import type { AttachedRepositorySummary } from "@/hooks/use-thread-capabilities";
import type { SandboxModeStatus, ThreadId, WorkspaceId } from "@/lib/types";

export type TopBarRepoDetail = {
  repository: {
    sourceRepoFullName: string;
    importStatus: string;
    defaultBranch?: string | null;
    detectedLanguages: string[];
    lastImportedAt?: number;
    lastSyncedCommitSha?: string;
  };
  sandbox: { status: string; ttlExpiresAt: number; autoArchiveIntervalMinutes: number } | null;
  sandboxModeStatus: SandboxModeStatus;
  hasRemoteUpdates: boolean;
  fileCount: number;
  fileCountLabel: string;
};

export function TopBar({
  repoDetail,
  repoName,
  threadId,
  attachedRepository,
  availableRepositories,
  isSyncing,
  onSync,
  onDeleteRepo,
  onRunAnalysis,
  onThreadMovedToWorkspace,
}: {
  repoDetail?: TopBarRepoDetail;
  /** Immediate repo name from the already-loaded repository list so the title
   *  never flashes "Repository" while `repoDetail` is still loading. */
  repoName?: string;
  /**
   * The thread the workspace is currently viewing, or `null` on bare-repo
   * (`/r/:repoId`) and empty (`/chat`) routes. Drives whether the inline
   * {@link AttachRepoMenu} chip renders — without a thread there is nothing
   * to attach a repo *to*.
   */
  threadId: ThreadId | null;
  /** Repository currently attached to {@link threadId}, if any. */
  attachedRepository: AttachedRepositorySummary | null;
  /** All repositories the viewer owns, used to populate the swap menu. */
  availableRepositories: ReadonlyArray<Doc<"repositories">>;
  isSyncing: boolean;
  onSync: () => void;
  onDeleteRepo: () => void;
  onRunAnalysis: () => void;
  onThreadMovedToWorkspace: (workspaceId: WorkspaceId | null) => void;
}) {
  const title = repoDetail?.repository.sourceRepoFullName ?? repoName;

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
      <SidebarTrigger />
      {title ? (
        // Title group only renders when the workspace has a repo to title —
        // for thread-only views (no repo attached yet) we skip straight to
        // the AttachRepoMenu so the user is never stranded without an entry
        // point to attach one. `flex-1 min-w-0` lets long repo names truncate
        // gracefully while leaving room for the attach chip and the right
        // cluster.
        <div className="flex min-w-0 flex-1 items-center gap-2 animate-in fade-in duration-300">
          {repoDetail ? (
            <RepoInfoPopover repoDetail={repoDetail} title={title} />
          ) : (
            <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight md:text-base">{title}</h1>
          )}
          {repoDetail ? <RepoStatusIndicator sandbox={repoDetail.sandbox} /> : null}
        </div>
      ) : null}

      {threadId !== null && attachedRepository === null ? (
        // PRD US 2: one-shot affordance for promoting a no-repo thread into a
        // repository workspace ("abstract discussion → grounded analysis").
        // Once a repo is attached, the binding is permanent — there is no
        // swap or detach UI by design (see decision log: avoiding Frankenstein
        // conversations where history is grounded against repo A but new
        // messages reference repo B). To work against a different repo, the
        // user starts a new thread. Hidden when `threadId === null` because
        // there is nothing to bind a repo to.
        <AttachRepoMenu
          threadId={threadId}
          availableRepositories={availableRepositories}
          onMovedToWorkspace={onThreadMovedToWorkspace}
        />
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        <TooltipProvider delayDuration={150}>
          <SyncButton repoDetail={repoDetail} isSyncing={isSyncing} onSync={onSync} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={!repoDetail}
                aria-label="Repository actions"
                className="text-muted-foreground hover:text-foreground"
              >
                <DotsThreeVerticalIcon weight="bold" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => onRunAnalysis()}>
                <SparkleIcon weight="bold" />
                Run deep analysis
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={(e) => {
                  e.preventDefault();
                  onDeleteRepo();
                }}
              >
                <TrashIcon weight="bold" />
                Delete repository
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      </div>
    </div>
  );
}

/**
 * Unified sync button — the single source of truth for sync / import status.
 * Covers idle, in-progress, failed, and update-available states so no other
 * component needs to duplicate this information.
 */
function SyncButton({
  repoDetail,
  isSyncing,
  onSync,
}: {
  repoDetail?: TopBarRepoDetail;
  isSyncing: boolean;
  onSync: () => void;
}) {
  const syncedLabel = useRelativeTime(repoDetail?.repository.lastImportedAt);
  const repositoryImportStatus = repoDetail?.repository.importStatus;
  const isRepositorySyncing = repositoryImportStatus === "queued" || repositoryImportStatus === "running";
  const isFailed = repositoryImportStatus === "failed";
  const isBusy = isSyncing || isRepositorySyncing;
  const hasUpdates = repoDetail?.hasRemoteUpdates && !isBusy && !isFailed;
  const isExpanded = isBusy || hasUpdates || isFailed;

  // Derive the text shown inside the button
  let label: string | null = null;
  if (isBusy) {
    label = "Syncing…";
  } else if (isFailed) {
    label = "Sync failed";
  } else if (hasUpdates) {
    label = "Update available";
  } else if (syncedLabel) {
    label = `Synced ${syncedLabel}`;
  } else if (repoDetail) {
    label = "Sync";
  }

  const syncedTooltipLabel = syncedLabel ? `Synced ${syncedLabel}` : "Synced recently";
  const updateTooltipLabel = "New commits available on remote — click to sync";
  const failedTooltipLabel = "Import failed — click to retry";

  const buttonClassName = isFailed
    ? "relative justify-start gap-1.5 text-xs text-destructive hover:text-destructive"
    : hasUpdates
      ? "relative justify-start gap-1.5 text-xs text-primary hover:text-primary"
      : "justify-start gap-1.5 text-xs text-muted-foreground hover:text-foreground";

  if (label === null && !repoDetail && !isBusy) {
    return (
      <Button variant="ghost" size="icon" disabled aria-label="Sync unavailable">
        <ArrowsClockwiseIcon weight="bold" />
      </Button>
    );
  }

  if (!isExpanded) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={!repoDetail}
            onClick={onSync}
            aria-label={label ?? "Sync"}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowsClockwiseIcon weight="bold" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label ?? syncedTooltipLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" disabled={!repoDetail || isBusy} onClick={onSync} className={buttonClassName}>
          {(hasUpdates || isFailed) && (
            <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${isFailed ? "bg-destructive" : "bg-primary"}`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${isFailed ? "bg-destructive" : "bg-primary"}`}
              />
            </span>
          )}
          {label ? (
            <span className="inline-flex items-center gap-1.5 animate-in fade-in duration-300">
              {isFailed ? (
                <WarningCircleIcon weight="fill" className="size-3.5" />
              ) : (
                <ArrowsClockwiseIcon weight="bold" className={isBusy ? "animate-spin" : ""} />
              )}
              {label}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {isFailed ? failedTooltipLabel : hasUpdates ? updateTooltipLabel : syncedTooltipLabel}
      </TooltipContent>
    </Tooltip>
  );
}
