import type { ReactNode } from "react";
import { ArchiveIcon, ArrowCounterClockwiseIcon, DotsThreeVerticalIcon, TrashIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RepoInfoPopover } from "@/components/repo-info-popover";
import { RepoStatusIndicator } from "@/components/repo-status-indicator";
import { SwapThreadRepositoryControl } from "@/components/swap-thread-repository-control";
import { StatusPill } from "@/components/status-pill";
import { StatusPanel } from "@/components/status-panel";
import { ChatModeControls } from "@/components/chat-mode-controls";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttachedRepositorySummary } from "@/hooks/use-thread-capabilities";
import type { ArtifactId, RepositoryId, SandboxModeStatus, ThreadId, ThreadMode } from "@/lib/types";

export type TopBarRepoDetail = {
  repository: Doc<"repositories"> & {
    sourceRepoFullName: string;
    importStatus: string;
    defaultBranch?: string | null;
    detectedLanguages: string[];
    lastImportedAt?: number;
    lastSyncedCommitSha?: string;
  };
  isArchived: boolean;
  archivedAt: number | null;
  sandbox: { status: string; ttlExpiresAt: number; autoArchiveIntervalMinutes: number } | null;
  sandboxModeStatus: SandboxModeStatus;
  hasRemoteUpdates: boolean;
  fileCount: number;
  fileCountLabel: string;
  jobs: Doc<"jobs">[];
  /**
   * Artifacts attached to the repository. Used by the embedded StatusPanel to
   * map activity rows back to their generated artifact for the inline
   * "View …" affordance. The shell passes these through from the same
   * `getRepositoryDetail` query that populates the rest of `repoDetail`, so
   * the field is always coherent with the other status surfaces.
   */
  artifacts: Doc<"artifacts">[];
};

type TopBarStatusControl =
  | { isVisible: false }
  | {
      isVisible: true;
      isOpen: boolean;
      onOpenChange: (open: boolean) => void;
      repository: TopBarRepoDetail["repository"];
      sandboxModeStatus: TopBarRepoDetail["sandboxModeStatus"];
      sandbox: TopBarRepoDetail["sandbox"];
      jobs: TopBarRepoDetail["jobs"];
      artifacts: TopBarRepoDetail["artifacts"];
      hasRemoteUpdates: boolean;
      isSyncing: boolean;
      onSync: () => void;
      syncDisabledReason?: string;
      onViewArtifact: (artifactId: ArtifactId) => void;
    };

/**
 * TopBar — minimal command surface above the chat. After the Surface 1
 * redesign (`background-operations-ux-redesign.md`) the bar holds only:
 *   - sidebar toggle + repo title chip (with detail popover)
 *   - swap-repo affordance when the active thread is bound and other
 *     repos are available
 *   - the StatusPill, which doubles as the trigger for an inline Popover
 *     (desktop) or a bottom Sheet (mobile) carrying the on-demand
 *     {@link StatusPanel} — sync, run analysis, activity history all live
 *     inside that panel
 *   - a kebab menu for repo-level destructive actions (currently just
 *     Delete repository)
 *
 * Why a Popover (instead of an inline right-side column): the StatusPanel
 * carries on-demand reference data, but chat should remain the primary
 * surface. Status overlays only when the user explicitly asks for it.
 */
export function TopBar({
  repoDetail,
  isRepoDetailLoading,
  threadId,
  attachedRepository,
  availableRepositories,
  isSyncing,
  isStatusPanelOpen,
  onSetStatusPanelOpen,
  onArchiveRepo,
  onRestoreRepo,
  onPermanentDeleteRepo,
  onThreadMovedToRepository,
  isDesktopLayout,
  onSearchThreads,
  onNewThread,
  onSync,
  syncDisabledReason,
  onViewArtifact,
  showSystemStatus,
}: {
  repoDetail?: TopBarRepoDetail;
  /**
   * Whether a repository-detail query is in flight (a repo is selected but its
   * detail hasn't resolved yet). Distinguishes "loading a repo title" from the
   * repoless `/chat` surface — only the former reserves a title skeleton, so
   * the repoless surface doesn't show a perpetual placeholder.
   */
  isRepoDetailLoading: boolean;
  threadId: ThreadId | null;
  attachedRepository: AttachedRepositorySummary | null;
  availableRepositories: ReadonlyArray<Doc<"repositories">>;
  isSyncing: boolean;
  isStatusPanelOpen: boolean;
  onSetStatusPanelOpen: (open: boolean) => void;
  /** Archive an active repository. Triggered when `repoDetail.isArchived` is false. */
  onArchiveRepo: () => void;
  /** Restore an archived repository. Triggered when `repoDetail.isArchived` is true. */
  onRestoreRepo: () => void;
  /** Permanently delete an archived repository. Triggered only from the archived kebab. */
  onPermanentDeleteRepo: () => void;
  onThreadMovedToRepository: (repositoryId: RepositoryId | null, mode: ThreadMode | null) => void;
  isDesktopLayout: boolean;
  onSearchThreads: () => void;
  onNewThread: () => void;
  onSync: () => void;
  syncDisabledReason?: string;
  onViewArtifact: (artifactId: ArtifactId) => void;
  /**
   * Whether the system-status chrome (StatusPill + sandbox badge next to the
   * title) is allowed to render. The repository shell drives this from the
   * repository actually backing the current surface or attached thread.
   */
  showSystemStatus: boolean;
}) {
  const statusControl: TopBarStatusControl =
    repoDetail && showSystemStatus
      ? {
          isVisible: true,
          isOpen: isStatusPanelOpen,
          onOpenChange: onSetStatusPanelOpen,
          repository: repoDetail.repository,
          sandboxModeStatus: repoDetail.sandboxModeStatus,
          sandbox: repoDetail.sandbox,
          jobs: repoDetail.jobs,
          artifacts: repoDetail.artifacts,
          hasRemoteUpdates: repoDetail.hasRemoteUpdates,
          isSyncing,
          onSync,
          syncDisabledReason,
          onViewArtifact,
        }
      : { isVisible: false };

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
      <ChatModeControls onSearchThreads={onSearchThreads} onNewThread={onNewThread} />
      <TopBarTitleArea
        repoDetail={repoDetail}
        isRepoDetailLoading={isRepoDetailLoading}
        showSystemStatus={showSystemStatus}
      />
      <TopBarSwapRepositorySlot
        threadId={threadId}
        attachedRepository={attachedRepository}
        availableRepositories={availableRepositories}
        onThreadMovedToRepository={onThreadMovedToRepository}
      />

      <div className="ml-auto flex items-center gap-1.5">
        <TopBarStatusSlot statusControl={statusControl} isDesktopLayout={isDesktopLayout} />
        <RepositoryActionsMenu
          repoDetail={repoDetail}
          onArchiveRepo={onArchiveRepo}
          onRestoreRepo={onRestoreRepo}
          onPermanentDeleteRepo={onPermanentDeleteRepo}
        />
      </div>
    </div>
  );
}

function TopBarTitleArea({
  repoDetail,
  isRepoDetailLoading,
  showSystemStatus,
}: {
  repoDetail: TopBarRepoDetail | undefined;
  isRepoDetailLoading: boolean;
  showSystemStatus: boolean;
}) {
  if (!repoDetail) {
    // Repoless `/chat` (or a missing repo) has no title to show — collapse the
    // slot entirely. Only reserve a placeholder while a real title is loading,
    // so the swap-repo slot and status pill don't jump when it arrives.
    if (!isRepoDetailLoading) {
      return null;
    }
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Skeleton className="h-5 w-40" />
        {showSystemStatus ? <RepoStatusIndicatorSlot /> : null}
      </div>
    );
  }
  return (
    <div key={repoDetail.repository._id} className="flex min-w-0 flex-1 items-center gap-2 animate-fade-in">
      <RepoInfoPopover repoDetail={repoDetail} title={repoDetail.repository.sourceRepoFullName} />
      {showSystemStatus ? (
        <RepoStatusIndicatorSlot>
          <RepoStatusIndicator sandbox={repoDetail.sandbox} />
        </RepoStatusIndicatorSlot>
      ) : null}
    </div>
  );
}

/**
 * Fixed-width holder for the sandbox status badge. The badge only renders for
 * `failed` / `provisioning` states, so a bare `RepoStatusIndicator` pops in
 * from zero width (e.g. when lazy sandbox provisioning starts) and shoves the
 * title. Reserving the width here means the badge fades in within space that
 * was always there.
 */
function RepoStatusIndicatorSlot({ children }: { children?: ReactNode }) {
  return <div className="flex min-w-[88px] shrink-0 items-center">{children}</div>;
}

function TopBarSwapRepositorySlot({
  threadId,
  attachedRepository,
  availableRepositories,
  onThreadMovedToRepository,
}: {
  threadId: ThreadId | null;
  attachedRepository: AttachedRepositorySummary | null;
  availableRepositories: ReadonlyArray<Doc<"repositories">>;
  onThreadMovedToRepository: (repositoryId: RepositoryId | null, mode: ThreadMode | null) => void;
}) {
  if (threadId === null || attachedRepository === null) {
    return null;
  }
  const candidates = availableRepositories.filter((candidate) => candidate._id !== attachedRepository.id);
  if (candidates.length === 0) {
    return null;
  }
  return (
    <div className="hidden md:flex">
      <SwapThreadRepositoryControl
        threadId={threadId}
        attachedRepositoryFullName={attachedRepository.fullName}
        candidates={candidates}
        onMovedToRepository={onThreadMovedToRepository}
      />
    </div>
  );
}

function TopBarStatusSlot({
  statusControl,
  isDesktopLayout,
}: {
  statusControl: TopBarStatusControl;
  isDesktopLayout: boolean;
}) {
  if (!statusControl.isVisible) {
    return null;
  }
  if (isDesktopLayout) {
    return <DesktopStatusPopover statusControl={statusControl} />;
  }
  return (
    <StatusPill
      repository={statusControl.repository}
      sandboxModeStatus={statusControl.sandboxModeStatus}
      jobs={statusControl.jobs}
      hasRemoteUpdates={statusControl.hasRemoteUpdates}
      isSyncing={statusControl.isSyncing}
      isOpen={statusControl.isOpen}
      onClick={() => statusControl.onOpenChange(!statusControl.isOpen)}
    />
  );
}

function DesktopStatusPopover({ statusControl }: { statusControl: Extract<TopBarStatusControl, { isVisible: true }> }) {
  return (
    <Popover open={statusControl.isOpen} onOpenChange={statusControl.onOpenChange}>
      <PopoverTrigger asChild>
        <StatusPill
          repository={statusControl.repository}
          sandboxModeStatus={statusControl.sandboxModeStatus}
          jobs={statusControl.jobs}
          hasRemoteUpdates={statusControl.hasRemoteUpdates}
          isSyncing={statusControl.isSyncing}
          isOpen={statusControl.isOpen}
        />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-88 max-h-[min(36rem,calc(100vh-5rem))] overflow-hidden p-0"
      >
        <StatusPanel
          repository={statusControl.repository}
          sandboxModeStatus={statusControl.sandboxModeStatus}
          sandbox={statusControl.sandbox}
          jobs={statusControl.jobs}
          artifacts={statusControl.artifacts}
          hasRemoteUpdates={statusControl.hasRemoteUpdates}
          isSyncing={statusControl.isSyncing}
          onSync={statusControl.onSync}
          syncDisabledReason={statusControl.syncDisabledReason}
          onViewArtifact={statusControl.onViewArtifact}
          onClose={() => statusControl.onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function RepositoryActionsMenu({
  repoDetail,
  onArchiveRepo,
  onRestoreRepo,
  onPermanentDeleteRepo,
}: {
  repoDetail: TopBarRepoDetail | undefined;
  onArchiveRepo: () => void;
  onRestoreRepo: () => void;
  onPermanentDeleteRepo: () => void;
}) {
  return (
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
      <DropdownMenuContent align="end" className="w-56">
        {repoDetail?.isArchived ? (
          <>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                onRestoreRepo();
              }}
            >
              <ArrowCounterClockwiseIcon weight="bold" />
              Restore repository
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={(e) => {
                e.preventDefault();
                onPermanentDeleteRepo();
              }}
            >
              <TrashIcon weight="bold" />
              Delete permanently
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onArchiveRepo();
            }}
          >
            <ArchiveIcon weight="bold" />
            Archive repository
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
