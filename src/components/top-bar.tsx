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
import { SidebarTrigger } from "@/components/ui/sidebar";
import { RepoInfoPopover } from "@/components/repo-info-popover";
import { RepoStatusIndicator } from "@/components/repo-status-indicator";
import { AttachRepoMenu } from "@/components/attach-repo-menu";
import { StatusPill } from "@/components/status-pill";
import { StatusPanel } from "@/components/status-panel";
import type { AttachedRepositorySummary } from "@/hooks/use-thread-capabilities";
import type { ArtifactId, SandboxModeStatus, ThreadId, WorkspaceId } from "@/lib/types";

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
  activeDeepAnalysisJob: Doc<"jobs"> | null;
  /**
   * Artifacts attached to the repository. Used by the embedded StatusPanel to
   * surface the latest deep-analysis card and to map activity rows back to
   * their generated artifact for the inline "View …" affordance. The shell
   * passes these through from the same `getRepositoryDetail` query that
   * populates the rest of `repoDetail`, so the field is always coherent with
   * the other status surfaces.
   */
  artifacts: Doc<"artifacts">[];
};

/**
 * TopBar — minimal command surface above the chat. After the Surface 1
 * redesign (`background-operations-ux-redesign.md`) the bar holds only:
 *   - sidebar toggle + repo title chip (with detail popover)
 *   - attach-repo affordance for unattached threads (PRD US 2)
 *   - the StatusPill, which doubles as the trigger for an inline Popover
 *     (desktop) or a bottom Sheet (mobile) carrying the on-demand
 *     {@link StatusPanel} — sync, run analysis, activity history all live
 *     inside that panel
 *   - a kebab menu for repo-level destructive actions (currently just
 *     Delete repository)
 *
 * Why a Popover (instead of an inline right-side column): the StatusPanel
 * carries on-demand reference data; pinning it permanently to the right rail
 * forced a mutual-exclusion design with the always-on ArtifactPanel. Hosting
 * status as a Popover lets both panels coexist — Artifacts stays inline, and
 * Status overlays only when the user explicitly asks for it.
 */
export function TopBar({
  repoDetail,
  repoName,
  threadId,
  attachedRepository,
  availableRepositories,
  isSyncing,
  isStatusPanelOpen,
  onSetStatusPanelOpen,
  onArchiveRepo,
  onRestoreRepo,
  onPermanentDeleteRepo,
  onThreadMovedToWorkspace,
  isDesktopLayout,
  onSync,
  onRunAnalysis,
  onViewArtifact,
}: {
  repoDetail?: TopBarRepoDetail;
  repoName?: string;
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
  onThreadMovedToWorkspace: (workspaceId: WorkspaceId | null) => void;
  isDesktopLayout: boolean;
  onSync: () => void;
  onRunAnalysis: () => void;
  onViewArtifact: (artifactId: ArtifactId) => void;
}) {
  const title = repoDetail?.repository.sourceRepoFullName ?? repoName;

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
      <SidebarTrigger />
      {title ? (
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
        // repository workspace. Hidden once a repo is attached because the
        // binding is permanent — to work against another repo, start a new thread.
        <AttachRepoMenu
          threadId={threadId}
          availableRepositories={availableRepositories}
          onMovedToWorkspace={onThreadMovedToWorkspace}
        />
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        {repoDetail ? (
          isDesktopLayout ? (
            // Desktop: anchor a Popover to the pill so the StatusPanel
            // overlays the chat surface only on demand. PopoverTrigger asChild
            // composes with the pill's own TooltipTrigger via Radix Slot, so
            // both behaviours (hover tooltip + click-to-toggle popover) coexist
            // on the same Button without bespoke handler chaining.
            <Popover open={isStatusPanelOpen} onOpenChange={onSetStatusPanelOpen}>
              <PopoverTrigger asChild>
                <StatusPill
                  repository={repoDetail.repository}
                  sandboxModeStatus={repoDetail.sandboxModeStatus}
                  jobs={repoDetail.jobs}
                  activeDeepAnalysisJob={repoDetail.activeDeepAnalysisJob}
                  hasRemoteUpdates={repoDetail.hasRemoteUpdates}
                  isSyncing={isSyncing}
                  isOpen={isStatusPanelOpen}
                />
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="end"
                sideOffset={8}
                collisionPadding={12}
                // Width matches the previous inline column (22rem) so the panel
                // density stays stable; max-height caps the overlay so a long
                // activity timeline scrolls inside the popover instead of
                // bleeding past the viewport.
                className="w-[22rem] max-h-[min(36rem,calc(100vh-5rem))] overflow-hidden p-0"
              >
                <StatusPanel
                  repository={repoDetail.repository}
                  sandboxModeStatus={repoDetail.sandboxModeStatus}
                  sandbox={repoDetail.sandbox}
                  jobs={repoDetail.jobs}
                  activeDeepAnalysisJob={repoDetail.activeDeepAnalysisJob}
                  artifacts={repoDetail.artifacts}
                  hasRemoteUpdates={repoDetail.hasRemoteUpdates}
                  isSyncing={isSyncing}
                  onSync={onSync}
                  onRunAnalysis={onRunAnalysis}
                  onViewArtifact={onViewArtifact}
                  onClose={() => onSetStatusPanelOpen(false)}
                />
              </PopoverContent>
            </Popover>
          ) : (
            // Mobile: the panel renders as a bottom Sheet from the shell, so
            // here we only render the pill and forward clicks back up. The
            // shell-side onSetStatusPanelOpen handles the mutual-exclusion
            // with the artifact sheet (only one bottom sheet at a time).
            <StatusPill
              repository={repoDetail.repository}
              sandboxModeStatus={repoDetail.sandboxModeStatus}
              jobs={repoDetail.jobs}
              activeDeepAnalysisJob={repoDetail.activeDeepAnalysisJob}
              hasRemoteUpdates={repoDetail.hasRemoteUpdates}
              isSyncing={isSyncing}
              isOpen={isStatusPanelOpen}
              onClick={() => onSetStatusPanelOpen(!isStatusPanelOpen)}
            />
          )
        ) : null}

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
      </div>
    </div>
  );
}
