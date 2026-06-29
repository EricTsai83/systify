import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { BookOpenIcon, CaretDownIcon, FoldersIcon, PaperPlaneTiltIcon, SparkleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import {
  AppSidebarLeft,
  AppSidebarRight,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_WIDTH_STORAGE_KEY,
  LIBRARY_ASK_DEFAULT_WIDTH,
  LIBRARY_ASK_MAX_WIDTH,
  LIBRARY_ASK_WIDTH_STORAGE_KEY,
} from "@/components/app-sidebar";
import { AppNotice } from "@/components/app-notice";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { LibraryShell } from "@/components/library-shell";
import { LibraryTree } from "@/components/library-tree";
import { Logo } from "@/components/logo";
import { RepositoryModeSwitcher } from "@/components/repository-mode-switcher";
import { ScreenState } from "@/components/screen-state";
import { StatusPanel } from "@/components/status-panel";
import { TopBar } from "@/components/top-bar";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  PromptInputComposerFrame,
  PromptInputFooter,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useArtifactViewState } from "@/hooks/use-artifact-view-state";
import { useCheckForUpdates } from "@/hooks/use-check-for-updates";
import { useRepositoryLifecycle } from "@/hooks/use-repository-lifecycle";
import { isViewerFeatureEnabled, useViewerAccess } from "@/hooks/use-viewer-access";
import {
  DEFAULT_AUTHENTICATED_PATH,
  libraryArtifactPath,
  libraryPath,
  modeAwareThreadPath,
  repositoryPath,
  withLibraryAskParam,
} from "@/route-paths";
import type { ArtifactId, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { readString, writeString } from "@/lib/storage";
import { applyTouchRepositoryOptimistic } from "@/lib/repository-mutations";
import { DEMO_MODE_COPY } from "@/lib/demo-content";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ACTIVE_REPOSITORY_STORAGE_KEY = "systify.activeRepositoryId";
const DESKTOP_LAYOUT_QUERY = "(min-width: 1280px)";
const MOBILE_DRAWER_HEIGHT_CLASS = "h-[95dvh] data-[vaul-drawer-direction=bottom]:max-h-[95dvh]";

/**
 * Library service mode entry point.
 *
 * Mounted at:
 *   - `/r/:repositoryId/library`               → docs navigator.
 *   - `/r/:repositoryId/library/a/:artifactId` → shell with the artifact
 *                                                open in the reader.
 *
 * The active Library Ask thread is carried as a `?ask=:threadId` query
 * param on either of those URLs.
 */
export function LibraryPage() {
  const params = useParams<{ repositoryId?: string; artifactId?: string }>();
  const [searchParams] = useSearchParams();
  const urlRepositoryId = (params.repositoryId ?? null) as RepositoryId | null;
  const urlArtifactId = (params.artifactId ?? null) as ArtifactId | null;
  const urlAskThreadId = (searchParams.get("ask") ?? null) as ThreadId | null;

  if (!urlRepositoryId) {
    return (
      <ScreenState
        title="Missing repository"
        description="The link is missing a repository id. Return to your chat to continue."
      />
    );
  }

  return <LibraryRepository repositoryId={urlRepositoryId} artifactId={urlArtifactId} askThreadId={urlAskThreadId} />;
}

function LibraryRepository({
  repositoryId,
  artifactId,
  askThreadId,
}: {
  repositoryId: RepositoryId;
  artifactId: ArtifactId | null;
  askThreadId: ThreadId | null;
}) {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const viewerAccess = useViewerAccess();
  const [actionError, setActionError] = useState<string | null>(null);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showPermanentDeleteDialog, setShowPermanentDeleteDialog] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isDesktopLayout, setIsDesktopLayout] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.matchMedia(DESKTOP_LAYOUT_QUERY).matches;
  });

  const repositories = useQuery(api.repositoryPreferences.listRepositoriesForSwitcher);
  const authorizedRepositoryIds = useQuery(api.repositoryPreferences.listOwnedRepositoryIdsById, {
    repositoryIds: [repositoryId],
  });
  const baseTouchRepository = useMutation(api.repositoryPreferences.touchRepository);
  const touchRepository = useMemo(
    () => baseTouchRepository.withOptimisticUpdate(applyTouchRepositoryOptimistic),
    [baseTouchRepository],
  );

  const isAuthorizedForRepository = useMemo(() => {
    if (authorizedRepositoryIds === undefined) return null;
    return (authorizedRepositoryIds as ReadonlyArray<string>).includes(repositoryId);
  }, [authorizedRepositoryIds, repositoryId]);
  const canLoadRepositoryData = isAuthorizedForRepository === true;

  useEffect(() => {
    if (!repositoryId) return;
    // Avoid persisting an active-repository pointer (or touching the server)
    // before we know the viewer is authorized for this repo. Otherwise a
    // stale URL would poison localStorage and trip a server error.
    if (isAuthorizedForRepository !== true) return;
    writeString(ACTIVE_REPOSITORY_STORAGE_KEY, repositoryId);
    void touchRepository({ repositoryId, mode: "library" }).catch(() => {});
  }, [touchRepository, repositoryId, isAuthorizedForRepository]);

  const currentRepository = useMemo(
    () => repositories?.find((repo) => repo._id === repositoryId) ?? null,
    [repositories, repositoryId],
  );
  const hasLocalRepositoryIntent = readString(ACTIVE_REPOSITORY_STORAGE_KEY) === repositoryId;

  const activeArtifactId = canLoadRepositoryData ? artifactId : null;

  const allArtifacts = useQuery(
    api.artifacts.listMetadataByRepositoryWithFreshness,
    canLoadRepositoryData ? { repositoryId } : "skip",
  );
  const repoDetail = useQuery(api.repositories.getRepositoryDetail, canLoadRepositoryData ? { repositoryId } : "skip");
  const sandboxActivityStatus = useQuery(
    api.repositories.getSandboxActivityStatus,
    canLoadRepositoryData ? { repositoryId } : "skip",
  );
  const { isUnseen, markViewed } = useArtifactViewState(canLoadRepositoryData ? repositoryId : null);

  const hasArtifacts = allArtifacts === undefined ? undefined : allArtifacts.length > 0;

  useEffect(() => {
    if (!canLoadRepositoryData) return;
    if (activeArtifactId) {
      markViewed(activeArtifactId);
    }
  }, [activeArtifactId, canLoadRepositoryData, markViewed]);

  const [isGenerateDialogOpen, setIsGenerateDialogOpen] = useState(false);
  const openGenerateDialog = useCallback(() => setIsGenerateDialogOpen(true), []);
  const accessLoadingReason = viewerAccess === undefined ? "Loading access…" : undefined;
  const importDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "repoImport") ? undefined : DEMO_MODE_COPY.importDisabled);
  const syncDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "syncRepository") ? undefined : DEMO_MODE_COPY.syncDisabled);
  const checkForUpdatesEnabled = isViewerFeatureEnabled(viewerAccess, "checkForUpdates");
  const libraryAskDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "libraryAsk") ? undefined : DEMO_MODE_COPY.libraryAskDisabled);
  const generateSystemDesignDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "generateSystemDesign")
      ? isViewerFeatureEnabled(viewerAccess, "sandboxGrounding")
        ? undefined
        : DEMO_MODE_COPY.sandboxDisabled
      : DEMO_MODE_COPY.generateDisabled);
  const premiumModelsDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "premiumModels") ? undefined : DEMO_MODE_COPY.premiumModelsDisabled);
  const highReasoningDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "highReasoning") ? undefined : DEMO_MODE_COPY.highReasoningDisabled);
  const artifactDraftDisabledReason = libraryAskDisabledReason ?? generateSystemDesignDisabledReason;
  const isRepositorySyncing =
    repoDetail !== null &&
    repoDetail !== undefined &&
    !repoDetail.isArchived &&
    (repoDetail.repository.importStatus === "queued" || repoDetail.repository.importStatus === "running");

  const {
    isSyncing,
    handleSync,
    isArchivingRepo,
    handleArchiveRepo,
    handleRestoreRepo,
    isPermanentDeletingRepo,
    handlePermanentDeleteRepo,
  } = useRepositoryLifecycle({
    selectedRepositoryId: canLoadRepositoryData ? repositoryId : null,
    setActionError,
    setShowArchiveDialog,
    setShowPermanentDeleteDialog,
    syncDisabledReason,
    onAfterArchiveRepo: () => {
      void navigate(DEFAULT_AUTHENTICATED_PATH);
    },
    onAfterRestoreRepo: () => {},
    onAfterPermanentDeleteRepo: () => {
      void navigate(DEFAULT_AUTHENTICATED_PATH);
    },
  });
  const isHeaderSyncing = isSyncing || isRepositorySyncing;

  useCheckForUpdates(canLoadRepositoryData ? repositoryId : null, checkForUpdatesEnabled);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktopLayout(event.matches);
      setIsStatusOpen(false);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const handleSetStatusOpen = useCallback((open: boolean) => {
    setIsStatusOpen(open);
  }, []);

  const handleSwitchRepository = useCallback(
    (id: RepositoryId) => {
      void navigate(repositoryPath(id));
    },
    [navigate],
  );

  const handleSelectLibraryThread = useCallback(
    (threadId: ThreadId | null, options?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (threadId) {
            next.set("ask", threadId);
          } else {
            next.delete("ask");
          }
          return next;
        },
        { replace: options?.replace ?? false },
      );
    },
    [setSearchParams],
  );

  const handleSelectLibraryArtifact = useCallback(
    (nextArtifactId: ArtifactId) => {
      void navigate(withLibraryAskParam(libraryArtifactPath(repositoryId, nextArtifactId), askThreadId));
    },
    [askThreadId, navigate, repositoryId],
  );

  const handleShowLibraryNavigator = useCallback(() => {
    void navigate(withLibraryAskParam(libraryPath(repositoryId), askThreadId));
  }, [askThreadId, navigate, repositoryId]);

  const handleRailError = useCallback((message: string | null) => {
    if (!message) return;
    toast.error(message);
  }, []);
  const handleImported = useCallback(
    (importedRepositoryId: RepositoryId, threadId: ThreadId | null, threadMode: ThreadMode | null) => {
      if (threadId && threadMode) {
        void navigate(modeAwareThreadPath(importedRepositoryId, threadId, threadMode));
      } else {
        void navigate(libraryPath(importedRepositoryId));
      }
    },
    [navigate],
  );

  // Library only renders when the viewer owns the URL repository. Use the
  // complete owner-repo set (not the recency-limited switcher list) so a
  // repo outside the top-20 cache isn't mistakenly bounced to the landing.
  useEffect(() => {
    if (isAuthorizedForRepository === null) return;
    if (!isAuthorizedForRepository) {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
    }
  }, [isAuthorizedForRepository, navigate]);

  const artifactProbe = useQuery(api.artifacts.getById, canLoadRepositoryData && artifactId ? { artifactId } : "skip");
  useEffect(() => {
    if (!artifactId) return;
    if (repositories === undefined || !currentRepository) return;
    if (artifactProbe === undefined) return;
    if (artifactProbe === null || artifactProbe.repositoryId !== repositoryId) {
      void navigate(withLibraryAskParam(libraryPath(repositoryId), askThreadId), { replace: true });
    }
  }, [artifactId, artifactProbe, askThreadId, currentRepository, navigate, repositoryId, repositories]);

  const askThreadProbe = useQuery(
    api.chat.threads.getThreadSummary,
    canLoadRepositoryData && askThreadId ? { threadId: askThreadId } : "skip",
  );
  useEffect(() => {
    if (!askThreadId) return;
    if (askThreadProbe === undefined) return;
    if (askThreadProbe === null || askThreadProbe.repositoryId !== repositoryId || askThreadProbe.mode !== "library") {
      handleSelectLibraryThread(null, { replace: true });
    }
  }, [askThreadId, askThreadProbe, handleSelectLibraryThread, repositoryId]);

  if (isAuthorizedForRepository === null && (hasLocalRepositoryIntent || currentRepository)) {
    return (
      <PendingLibraryShell
        repositoryId={repositoryId}
        repositoryName={currentRepository?.sourceRepoFullName ?? "Library"}
      />
    );
  }
  if (repositories === undefined || isAuthorizedForRepository === null) {
    return <ScreenState title="Loading…" description="Loading your repository." isLoading />;
  }
  // Bounce to the landing has been scheduled by the effect above; render a
  // loading state in the meantime to avoid flashing repo-scoped chrome with
  // a stale/unauthorized id.
  if (!isAuthorizedForRepository) {
    return <ScreenState title="Loading…" description="Redirecting…" isLoading />;
  }

  return (
    <>
      <AppSidebarLeft
        repositories={repositories}
        selectedRepositoryId={repositoryId}
        onSwitchRepository={handleSwitchRepository}
        selectedThreadId={null}
        onSelectThread={() => {}}
        onDeleteThread={() => {}}
        onImported={handleImported}
        onError={handleRailError}
        importDisabledReason={importDisabledReason}
        libraryRepositoryId={repositoryId}
        libraryArtifacts={allArtifacts}
        libraryActiveArtifactId={activeArtifactId}
        onSelectLibraryArtifact={handleSelectLibraryArtifact}
        isUnseen={isUnseen}
      />
      <SidebarInset>
        <TopBar
          repoDetail={repoDetail ?? undefined}
          isRepoDetailLoading={repoDetail === undefined}
          isSyncing={isHeaderSyncing}
          isStatusPanelOpen={isStatusOpen}
          onSetStatusPanelOpen={handleSetStatusOpen}
          onArchiveRepo={() => setShowArchiveDialog(true)}
          onRestoreRepo={() => void handleRestoreRepo()}
          onPermanentDeleteRepo={() => setShowPermanentDeleteDialog(true)}
          threadId={askThreadId}
          attachedRepository={
            askThreadId && currentRepository
              ? {
                  id: repositoryId,
                  fullName: currentRepository.sourceRepoFullName,
                  shortName: currentRepository.sourceRepoName,
                }
              : null
          }
          availableRepositories={repositories}
          onThreadMovedToRepository={(movedRepositoryId, threadMode) => {
            if (!movedRepositoryId || !askThreadId || !threadMode) return;
            void navigate(modeAwareThreadPath(movedRepositoryId, askThreadId, threadMode));
          }}
          isDesktopLayout={isDesktopLayout}
          onSearchThreads={() => {}}
          onNewThread={() => {}}
          onSync={() => void handleSync()}
          syncDisabledReason={syncDisabledReason}
          onViewArtifact={handleSelectLibraryArtifact}
          showSystemStatus={repoDetail !== null}
          showRepositoryTitle={false}
          rightActions={
            <>
              <LibraryDesignDocsMenu
                onShowNavigator={handleShowLibraryNavigator}
                onGenerate={openGenerateDialog}
                generateDisabledReason={generateSystemDesignDisabledReason}
              />
              <SidebarTrigger side="right" />
            </>
          }
        />
        {actionError ? (
          <div className="border-b border-border px-6 py-3">
            <AppNotice
              title="Action failed"
              message={actionError}
              tone="error"
              onDismiss={() => setActionError(null)}
              dismissLabel="Dismiss action error"
            />
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1">
          <LibraryShell
            repositoryId={repositoryId}
            activeArtifactId={activeArtifactId}
            onSelectArtifact={handleSelectLibraryArtifact}
            allArtifacts={allArtifacts}
          />
        </div>
      </SidebarInset>
      <AppSidebarRight
        repositoryId={repositoryId}
        askThreadId={askThreadId}
        activeArtifactId={activeArtifactId}
        hasArtifacts={hasArtifacts}
        onSelectArtifact={handleSelectLibraryArtifact}
        onSelectAskThread={handleSelectLibraryThread}
        onGenerate={openGenerateDialog}
        askDisabledReason={libraryAskDisabledReason}
        generateDisabledReason={generateSystemDesignDisabledReason}
        artifactDraftDisabledReason={artifactDraftDisabledReason}
        liveSourceStatus={sandboxActivityStatus}
        premiumModelsDisabledReason={premiumModelsDisabledReason}
        highReasoningDisabledReason={highReasoningDisabledReason}
      />
      {!isDesktopLayout && repoDetail ? (
        <Drawer open={isStatusOpen} onOpenChange={setIsStatusOpen} aria-label="status-drawer">
          <DrawerContent className={cn(MOBILE_DRAWER_HEIGHT_CLASS, "rounded-t-2xl")}>
            <DrawerTitle className="sr-only">Repository status</DrawerTitle>
            <DrawerDescription className="sr-only">
              Current sync, sandbox, and analysis state, with recent activity and operation launchers.
            </DrawerDescription>
            <div className="flex min-h-0 flex-1 flex-col">
              <StatusPanel
                repository={repoDetail.repository}
                sandboxModeStatus={repoDetail.sandboxModeStatus}
                sandbox={repoDetail.sandbox}
                jobs={repoDetail.jobs}
                artifacts={repoDetail.artifacts}
                hasRemoteUpdates={repoDetail.hasRemoteUpdates}
                isSyncing={isHeaderSyncing}
                onSync={() => void handleSync()}
                syncDisabledReason={syncDisabledReason}
                onViewArtifact={handleSelectLibraryArtifact}
                onClose={() => setIsStatusOpen(false)}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}
      <ConfirmDialog
        open={showArchiveDialog}
        onOpenChange={setShowArchiveDialog}
        title="Archive repository"
        description="The repository disappears from your sidebar. Threads, messages, and artifacts are preserved — sandboxes are stopped to free resources. Restore any time from your archive."
        actionLabel="Archive repository"
        loadingLabel="Archiving…"
        isPending={isArchivingRepo}
        onConfirm={() => void handleArchiveRepo()}
      />
      <ConfirmDialog
        open={showPermanentDeleteDialog}
        onOpenChange={setShowPermanentDeleteDialog}
        title="Permanently delete repository?"
        description="This will permanently delete this repository and all its threads, messages, analysis artifacts, jobs, and indexed files. This action cannot be undone."
        actionLabel="Delete permanently"
        loadingLabel="Deleting…"
        isPending={isPermanentDeletingRepo}
        onConfirm={() => void handlePermanentDeleteRepo()}
      />
      <GenerateSystemDesignDialog
        open={isGenerateDialogOpen}
        onOpenChange={setIsGenerateDialogOpen}
        repositoryId={repositoryId}
        disabledReason={generateSystemDesignDisabledReason}
        premiumModelsDisabledReason={premiumModelsDisabledReason}
        highReasoningDisabledReason={highReasoningDisabledReason}
      />
    </>
  );
}

function LibraryDesignDocsMenu({
  className,
  onShowNavigator,
  onGenerate,
  generateDisabledReason,
}: {
  className?: string;
  onShowNavigator: () => void;
  onGenerate: () => void;
  generateDisabledReason?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={REPOSITORY_GUIDE_COPY.name}
          className={cn(
            "inline-flex h-8 items-center justify-center gap-1.5 border border-transparent bg-transparent px-2.5 text-xs font-semibold text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "aria-expanded:bg-accent aria-expanded:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50",
            "[&_svg]:pointer-events-none [&_svg]:shrink-0",
            className,
          )}
        >
          <BookOpenIcon size={14} weight="bold" />
          <span className="hidden sm:inline">{REPOSITORY_GUIDE_COPY.name}</span>
          <CaretDownIcon size={12} weight="bold" className="text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onShowNavigator}>
          <FoldersIcon weight="bold" />
          Open library overview
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onGenerate}
          disabled={generateDisabledReason !== undefined}
          title={generateDisabledReason}
        >
          <SparkleIcon weight="bold" />
          {REPOSITORY_GUIDE_COPY.generateAction}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PendingLibraryShell({ repositoryId, repositoryName }: { repositoryId: RepositoryId; repositoryName: string }) {
  return (
    <>
      <Sidebar
        side="left"
        widthStorageKey={LEFT_SIDEBAR_WIDTH_STORAGE_KEY}
        defaultWidth={LEFT_SIDEBAR_DEFAULT_WIDTH}
        maxWidth={LEFT_SIDEBAR_MAX_WIDTH}
      >
        <SidebarHeader>
          <Logo size={26} />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-lg font-semibold tracking-tight">Systify</div>
          </div>
        </SidebarHeader>
        <RepositoryModeSwitcher repositoryId={repositoryId} mode="library" availability={undefined} />
        <SidebarContent className="min-h-0 flex-1">
          <LibraryTree
            repositoryId={repositoryId}
            selectedArtifactId={null}
            onSelectArtifact={() => {}}
            loadFolders={false}
            canCreateFolders={false}
            className="min-h-0 flex-1"
          />
        </SidebarContent>
        <SidebarFooter className="px-3 py-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <Skeleton className="h-8 min-w-0 flex-1" />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
          <SidebarTrigger side="left" />
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground md:text-base">
            {repositoryName}
          </h1>
          <SidebarTrigger side="right" className="ml-auto" />
        </header>
        <div className="min-h-0 min-w-0 flex-1" />
      </SidebarInset>
      <Sidebar
        side="right"
        widthStorageKey={LIBRARY_ASK_WIDTH_STORAGE_KEY}
        defaultWidth={LIBRARY_ASK_DEFAULT_WIDTH}
        maxWidth={LIBRARY_ASK_MAX_WIDTH}
      >
        <PendingLibraryAskShell />
      </Sidebar>
    </>
  );
}

export function PendingLibraryAskShell() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1" />
      <div className="border-t border-border px-4 py-3">
        <PromptInputComposerFrame promptInputClassName="[&_[data-slot=input-group]]:min-h-[9rem]" onSubmit={() => {}}>
          <PromptInputTextarea
            value=""
            readOnly
            placeholder="Question about this library..."
            className="min-h-24 text-sm"
            aria-label="Library Ask input loading"
          />
          <PromptInputFooter className="h-11 min-h-11 flex-nowrap items-center overflow-hidden">
            <div aria-hidden="true" className="h-8 min-h-8 min-w-0 flex-1" />
            <Button
              type="button"
              size="icon"
              disabled
              aria-label="Asking..."
              title="Loading library data."
              className="h-8 w-8 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
            >
              <PaperPlaneTiltIcon size={14} weight="fill" />
            </Button>
          </PromptInputFooter>
        </PromptInputComposerFrame>
      </div>
    </div>
  );
}
