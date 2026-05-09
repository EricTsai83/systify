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
  threadId,
  attachedRepository,
  isAttachedRepositoryLoading,
  availableRepositories,
  isSyncing,
  isInitialSetup,
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
  threadId: ThreadId | null;
  attachedRepository: AttachedRepositorySummary | null;
  /**
   * True while the upstream `getThreadContext` query is still resolving the
   * thread's attached-repository binding. During that window `attachedRepository`
   * is conservatively `null`, but we should not yet conclude "no repo" — gating
   * on this flag prevents the AttachRepoMenu from flashing in for a thread that
   * actually has a repo, only to be replaced by the repo title once the query
   * resolves.
   */
  isAttachedRepositoryLoading: boolean;
  availableRepositories: ReadonlyArray<Doc<"repositories">>;
  isSyncing: boolean;
  /**
   * Mirrors {@link WorkspaceSetupBanner}'s render condition — true while the
   * workspace has not yet produced its first deep_analysis artifact and a
   * setup-related job is in flight. Lets the StatusPill swap "Syncing…" /
   * "Analyzing…" for a unified "Setting up…" so the chrome speaks one
   * vocabulary during the initial-setup window.
   */
  isInitialSetup: boolean;
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
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
      <SidebarTrigger />
      {/*
       * Title block renders only once `repoDetail` is fully resolved. Earlier
       * versions surfaced the cached repo name through a `<h1>` fallback so
       * the name appeared ~50–200ms sooner, but the fallback used the default
       * `text-foreground` colour while the eventual `RepoInfoPopover` trigger
       * is a ghost-variant Button (`text-muted-foreground`) — the swap caused
       * a visible white-to-grey flash and a layout shift as the inner element
       * went from `<h1>` (block) to `<Button>` (inline-flex) and the
       * `RepoStatusIndicator` mounted alongside it. Waiting for `repoDetail`
       * removes the swap entirely; the entire block fades in once with its
       * final styling.
       *
       * Uses the codebase's `animate-fade-in` (opacity-only) rather than
       * tw-animate-css's `animate-in fade-in`: the latter always applies
       * `transform: translate3d(0,0,0)` and `filter: blur(0)` during the
       * keyframe, which the default `fill-mode: none` then strips at the end
       * — promoting and demoting the GPU layer can cause a sub-pixel snap
       * after the fade. `animate-fade-in` only animates opacity, so the
       * element stays on the same render layer throughout.
       *
       * Keyed on the repository `_id` so the entry animation fires on
       * workspace transitions (different repo → new key → React unmounts the
       * old node and mounts a new one) but stays put on thread switches
       * within the same repo (same key → same DOM node → CSS animation
       * doesn't replay). The shell caches `repoDetail` across the brief
       * capability-loading gap so this slot doesn't unmount transiently —
       * see `displayedRepoDetail` in repository-shell.tsx.
       */}
      {repoDetail ? (
        <div key={repoDetail.repository._id} className="flex min-w-0 flex-1 items-center gap-2 animate-fade-in">
          <RepoInfoPopover repoDetail={repoDetail} title={repoDetail.repository.sourceRepoFullName} />
          <RepoStatusIndicator sandbox={repoDetail.sandbox} />
        </div>
      ) : null}

      {threadId !== null && !isAttachedRepositoryLoading && attachedRepository === null ? (
        // PRD US 2: one-shot affordance for promoting a no-repo thread into a
        // repository workspace. Hidden once a repo is attached because the
        // binding is permanent — to work against another repo, start a new thread.
        //
        // Wrapping fade-in mirrors the title block above so both surfaces
        // (title for repo-bound threads, AttachRepoMenu for unbound ones) share
        // the same entry timing. Combined with the `isAttachedRepositoryLoading`
        // gate, this avoids the "AttachRepoMenu flashes then gets replaced by
        // the title" sequence on thread switches — the slot stays empty until
        // we know which surface belongs there, then the chosen one fades in.
        <div className="animate-fade-in">
          <AttachRepoMenu
            threadId={threadId}
            availableRepositories={availableRepositories}
            onMovedToWorkspace={onThreadMovedToWorkspace}
          />
        </div>
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
                  isInitialSetup={isInitialSetup}
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
              isInitialSetup={isInitialSetup}
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
