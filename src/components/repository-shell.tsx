import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import { ArchiveIcon, ArrowCounterClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AppSidebarLeft } from "@/components/app-sidebar";
import { ArtifactPanel } from "@/components/artifact-panel";
import { TopBar } from "@/components/top-bar";
import { ThreadSearchDialog } from "@/components/thread-search-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AppNotice } from "@/components/app-notice";
import { ChatContainer } from "@/components/chat-panel";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { StatusPanel } from "@/components/status-panel";
import { useChatComposerSession } from "@/components/chat-shell-shared/use-chat-composer-session";
import { useChatShellLifecycle } from "@/components/chat-shell-shared/use-chat-shell-lifecycle";
import { useThreadDeletionRecovery } from "@/components/chat-shell-shared/use-thread-deletion-recovery";
import { useRepositoryLandingDecision } from "@/components/chat-shell-shared/use-repository-landing";
import { useRepositoryPersistence } from "@/components/chat-shell-shared/use-repository-persistence";
import { useCheckForUpdates } from "@/hooks/use-check-for-updates";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useRepositoryLifecycle } from "@/hooks/use-repository-lifecycle";
import { useChatMode } from "@/hooks/use-service-mode";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import { isViewerFeatureEnabled, useViewerAccess } from "@/hooks/use-viewer-access";
import type { ArtifactId, ChatMode, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { DEMO_MODE_COPY } from "@/lib/demo-content";
import { cn } from "@/lib/utils";
import {
  DEFAULT_AUTHENTICATED_PATH,
  discussPath,
  libraryArtifactPath,
  libraryPath,
  modeAwareThreadPath,
  newDiscussPath,
  repositoryPath,
} from "@/route-paths";

type RepositoryShellStatus = "initializing" | "ready";
const DESKTOP_LAYOUT_QUERY = "(min-width: 1280px)";

const MOBILE_DRAWER_HEIGHT_CLASS = "h-[95dvh] data-[vaul-drawer-direction=bottom]:max-h-[95dvh]";

export function RepositoryShell({
  urlRepositoryId,
  urlThreadId,
  isNewThreadRoute = false,
}: {
  urlRepositoryId: RepositoryId | null;
  urlThreadId: ThreadId | null;
  isNewThreadRoute?: boolean;
}) {
  const navigate = useNavigate();
  const viewerAccess = useViewerAccess();
  const suppressThreadAutoOpen = urlThreadId === null && isNewThreadRoute;

  const {
    repositories,
    touchRepository,
    activeRepositoryId,
    currentRepositoryId,
    currentRepository,
    handleSwitchRepository,
  } = useRepositoryPersistence({ urlRepositoryId, navigate });

  const { mode, availability } = useChatMode(currentRepositoryId);
  const landingDecision = useRepositoryLandingDecision({
    urlRepositoryId,
    urlThreadId,
    currentRepositoryId,
    currentRepository,
    mode,
    availability,
    repositories,
    suppressThreadAutoOpen,
  });

  const capabilities = useThreadCapabilities(urlThreadId);

  const isArtifactPanelEnabled = mode === "library" || (mode === "discuss" && capabilities.attachedRepository !== null);

  const [threadToArchive, setThreadToArchive] = useState<ThreadId | null>(null);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showPermanentDeleteDialog, setShowPermanentDeleteDialog] = useState(false);
  const chatMode: ChatMode = landingDecision.intendedChatMode;

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ title: string; message: string } | null>(null);
  useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);
  const [isArtifactPanelOpen, setIsArtifactPanelOpen] = useLocalStorageBoolean("systify.artifactPanel.open", false);
  const [isArtifactSheetOpen, setIsArtifactSheetOpen] = useState(false);
  const [isGenerateDialogOpen, setIsGenerateDialogOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isThreadSearchOpen, setIsThreadSearchOpen] = useState(false);
  const [isDesktopLayout, setIsDesktopLayout] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.matchMedia(DESKTOP_LAYOUT_QUERY).matches;
  });

  const isRepositoriesLoading = repositories === undefined;

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktopLayout(event.matches);
      setIsStatusOpen(false);
      if (event.matches) {
        setIsArtifactSheetOpen(false);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const effectiveSelectedRepositoryId: RepositoryId | null = currentRepositoryId;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsGenerateDialogOpen(false);
  }, [effectiveSelectedRepositoryId]);

  const effectiveSelectedThreadId: ThreadId | null = urlThreadId;

  const recentThreadIds = useRecentThreads(effectiveSelectedThreadId);
  useWarmThreadSubscriptions(recentThreadIds);

  const repoDetail = useQuery(
    api.repositories.getRepositoryDetail,
    effectiveSelectedRepositoryId ? { repositoryId: effectiveSelectedRepositoryId } : "skip",
  );
  const isRepoMissing = effectiveSelectedRepositoryId !== null && repoDetail === null;
  const isRepoArchived = repoDetail !== null && repoDetail !== undefined && repoDetail.isArchived;
  const isRepositorySyncing =
    !isRepoArchived &&
    (repoDetail?.repository.importStatus === "queued" || repoDetail?.repository.importStatus === "running");
  const accessLoadingReason = viewerAccess === undefined ? "Loading access…" : undefined;
  const importDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "repoImport") ? undefined : DEMO_MODE_COPY.importDisabled);
  const syncDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "syncRepository") ? undefined : DEMO_MODE_COPY.syncDisabled);
  const checkForUpdatesEnabled = isViewerFeatureEnabled(viewerAccess, "checkForUpdates");
  let generateSystemDesignDisabledReason = accessLoadingReason;
  if (!generateSystemDesignDisabledReason) {
    if (!isViewerFeatureEnabled(viewerAccess, "generateSystemDesign")) {
      generateSystemDesignDisabledReason = DEMO_MODE_COPY.generateDisabled;
    } else if (!isViewerFeatureEnabled(viewerAccess, "sandboxGrounding")) {
      generateSystemDesignDisabledReason = DEMO_MODE_COPY.sandboxDisabled;
    }
  }
  const premiumModelsDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "premiumModels") ? undefined : DEMO_MODE_COPY.premiumModelsDisabled);
  const highReasoningDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "highReasoning") ? undefined : DEMO_MODE_COPY.highReasoningDisabled);

  useEffect(() => {
    if (landingDecision.navigation === null) return;
    void navigate(landingDecision.navigation.to, { replace: landingDecision.navigation.replace });
  }, [landingDecision.navigation, navigate]);

  useEffect(() => {
    if (currentRepositoryId === null) return;
    if (mode === null) return;
    if (currentRepository === null) return;
    if (currentRepository.lastMode === mode) return;
    void touchRepository({ repositoryId: currentRepositoryId, mode }).catch(() => {});
  }, [currentRepositoryId, currentRepository, mode, touchRepository]);

  const onMissingThread = useCallback(() => {
    if (urlRepositoryId !== null) {
      void navigate(repositoryPath(urlRepositoryId), { replace: true });
    } else {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
    }
  }, [navigate, urlRepositoryId]);
  useThreadDeletionRecovery({
    urlThreadId,
    isMissingThread: capabilities.isMissingThread,
    onMissingThread,
  });

  useCheckForUpdates(effectiveSelectedRepositoryId, checkForUpdatesEnabled);

  const shellStatus: RepositoryShellStatus =
    isRepositoriesLoading || repositories === undefined || landingDecision.status !== "ready"
      ? "initializing"
      : "ready";

  const isChatShellLoading =
    shellStatus === "initializing" || (effectiveSelectedThreadId !== null && capabilities.isLoading);

  const handleSelectThread = useCallback(
    (threadId: ThreadId | null, threadMode: ThreadMode) => {
      setActionError(null);
      if (threadId === null) {
        if (currentRepositoryId !== null) {
          void navigate(repositoryPath(currentRepositoryId));
        } else {
          void navigate(DEFAULT_AUTHENTICATED_PATH);
        }
        return;
      }
      if (currentRepositoryId !== null) {
        void navigate(modeAwareThreadPath(currentRepositoryId, threadId, threadMode));
      } else {
        void navigate(DEFAULT_AUTHENTICATED_PATH);
      }
    },
    [navigate, currentRepositoryId],
  );

  const handleToggleArtifactPanel = useCallback(() => {
    if (!isArtifactPanelEnabled) {
      return;
    }
    if (isDesktopLayout) {
      setIsArtifactPanelOpen((open) => !open);
      return;
    }
    setIsArtifactSheetOpen((open) => {
      const next = !open;
      if (next) {
        setIsStatusOpen(false);
      }
      return next;
    });
  }, [isArtifactPanelEnabled, isDesktopLayout, setIsArtifactPanelOpen]);

  const handleSetStatusOpen = useCallback(
    (open: boolean) => {
      if (!isArtifactPanelEnabled) {
        if (open) return;
        setIsStatusOpen(false);
        return;
      }
      if (open && !isDesktopLayout) {
        setIsArtifactSheetOpen(false);
      }
      setIsStatusOpen(open);
    },
    [isDesktopLayout, isArtifactPanelEnabled],
  );

  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      if (currentRepositoryId === null) {
        return;
      }
      void navigate(libraryArtifactPath(currentRepositoryId, artifactId));
    },
    [navigate, currentRepositoryId],
  );

  useEffect(() => {
    if (!isArtifactPanelEnabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key !== "." || (!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (target instanceof HTMLElement) {
        if (target.isContentEditable || target.closest('[contenteditable="true"], [role="textbox"], .monaco-editor')) {
          return;
        }
      }

      event.preventDefault();
      handleToggleArtifactPanel();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleToggleArtifactPanel, isArtifactPanelEnabled]);

  const handleImported = useCallback(
    (repoId: RepositoryId, threadId: ThreadId | null, threadMode: ThreadMode | null) => {
      setActionError(null);
      if (threadId && threadMode) {
        void navigate(modeAwareThreadPath(repoId, threadId, threadMode));
      } else {
        void navigate(repositoryPath(repoId));
      }
    },
    [navigate],
  );

  const handleThreadMovedToRepository = useCallback(
    (repositoryId: RepositoryId | null, threadMode: ThreadMode | null) => {
      if (!repositoryId) {
        return;
      }
      if (urlThreadId !== null && threadMode) {
        void navigate(modeAwareThreadPath(repositoryId, urlThreadId, threadMode));
      } else {
        void navigate(repositoryPath(repositoryId));
      }
    },
    [navigate, urlThreadId],
  );

  const onAfterCreateThread = useCallback(
    (threadId: ThreadId, threadMode: ChatMode) => {
      if (currentRepositoryId === null) return;
      void navigate(modeAwareThreadPath(currentRepositoryId, threadId, threadMode), { replace: true });
    },
    [currentRepositoryId, navigate],
  );

  const handleRequestNewThread = useCallback(() => {
    if (currentRepositoryId === null) return;
    void navigate(newDiscussPath(currentRepositoryId));
  }, [currentRepositoryId, navigate]);

  const onAfterArchiveThread = useCallback(() => {
    if (currentRepositoryId !== null) {
      if (mode === "library") {
        void navigate(libraryPath(currentRepositoryId));
      } else if (mode === "discuss") {
        void navigate(discussPath(currentRepositoryId));
      } else {
        void navigate(repositoryPath(currentRepositoryId));
      }
    } else {
      void navigate(DEFAULT_AUTHENTICATED_PATH);
    }
  }, [currentRepositoryId, mode, navigate]);

  const { isArchivingThread, handleArchiveThread } = useChatShellLifecycle({
    selectedThreadId: effectiveSelectedThreadId,
    threadToArchive,
    setActionError,
    setThreadToArchive,
    onAfterArchiveThread,
  });

  const {
    isSyncing,
    handleSync,
    isArchivingRepo,
    handleArchiveRepo,
    isRestoringRepo,
    handleRestoreRepo,
    isPermanentDeletingRepo,
    handlePermanentDeleteRepo,
  } = useRepositoryLifecycle({
    selectedRepositoryId: effectiveSelectedRepositoryId,
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

  const chatReadOnlyHint = isRepoArchived ? "Restore this repository to send messages or run analyses." : undefined;
  const composer = useChatComposerSession({
    surface: "repository",
    threadId: effectiveSelectedThreadId,
    repositoryId: currentRepositoryId,
    mode: chatMode,
    capabilities,
    groundingAvailability: availability?.grounding,
    viewerAccess,
    isSyncing: isSyncing || isRepositorySyncing,
    isReadOnly: isRepoArchived,
    readOnlyHint: chatReadOnlyHint,
    setActionError,
    onOpenGenerateSystemDesign: () => setIsGenerateDialogOpen(true),
    onAfterCreateThread,
  });

  const chatContainerNode = (
    <ChatContainer
      selectedThreadId={effectiveSelectedThreadId}
      isShellLoading={isChatShellLoading}
      composer={composer}
      chatMode={chatMode}
      artifactToggle={
        isArtifactPanelEnabled
          ? {
              isOpen: isDesktopLayout ? isArtifactPanelOpen : isArtifactSheetOpen,
              onToggle: handleToggleArtifactPanel,
            }
          : null
      }
      hasAttachedRepository={capabilities.attachedRepository !== null}
      onSelectArtifact={handleSelectArtifact}
      attachedRepositoryId={capabilities.attachedRepository?.id}
    />
  );

  return (
    <>
      <AppSidebarLeft
        repositories={repositories}
        activeRepositoryId={activeRepositoryId}
        onSwitchRepository={handleSwitchRepository}
        selectedThreadId={effectiveSelectedThreadId}
        onSelectThread={handleSelectThread}
        onDeleteThread={setThreadToArchive}
        onRequestNewThread={handleRequestNewThread}
        onImported={handleImported}
        onError={setActionError}
        importDisabledReason={importDisabledReason}
      />

      <SidebarInset>
        <TopBar
          repoDetail={repoDetail ?? undefined}
          isSyncing={isSyncing || isRepositorySyncing}
          isStatusPanelOpen={isStatusOpen}
          onSetStatusPanelOpen={handleSetStatusOpen}
          onArchiveRepo={() => setShowArchiveDialog(true)}
          onRestoreRepo={() => void handleRestoreRepo()}
          onPermanentDeleteRepo={() => setShowPermanentDeleteDialog(true)}
          threadId={effectiveSelectedThreadId}
          attachedRepository={capabilities.attachedRepository}
          availableRepositories={repositories ?? []}
          onThreadMovedToRepository={handleThreadMovedToRepository}
          isDesktopLayout={isDesktopLayout}
          onSearchThreads={() => setIsThreadSearchOpen(true)}
          onNewThread={handleRequestNewThread}
          onSync={() => void handleSync()}
          syncDisabledReason={syncDisabledReason}
          onViewArtifact={handleSelectArtifact}
          showSystemStatus={isArtifactPanelEnabled}
        />

        <ThreadSearchDialog
          open={isThreadSearchOpen}
          onOpenChange={setIsThreadSearchOpen}
          repositoryId={currentRepositoryId}
          mode={chatMode}
          selectedThreadId={effectiveSelectedThreadId}
          onSelectThread={handleSelectThread}
        />

        {isRepoArchived ? (
          <div className="border-b border-border bg-muted/40 px-6 py-3">
            <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <ArchiveIcon size={18} weight="bold" className="mt-0.5 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">This repository is archived</p>
                  <p className="text-xs text-muted-foreground">
                    Threads and artifacts stay readable. Restore to continue chatting and run analyses.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={isRestoringRepo}
                onClick={() => void handleRestoreRepo()}
              >
                <ArrowCounterClockwiseIcon weight="bold" />
                <ButtonStateText
                  current={isRestoringRepo ? "Restoring…" : "Restore"}
                  states={["Restore", "Restoring…"]}
                />
              </Button>
            </div>
          </div>
        ) : null}

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
        ) : actionNotice ? (
          <div className="border-b border-border px-6 py-3">
            <AppNotice title={actionNotice.title} message={actionNotice.message} tone="info" />
          </div>
        ) : null}

        {!isRepoArchived && repoDetail?.repository.importStatus === "failed" ? (
          <ImportFailedBanner
            errorMessage={repoDetail.latestFailedImportError}
            isSyncing={isSyncing || isRepositorySyncing}
            syncDisabledReason={syncDisabledReason}
            onRetry={() => void handleSync()}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1">
          {isRepoMissing ? (
            <RepositoryMissingState onBack={() => void navigate(DEFAULT_AUTHENTICATED_PATH)} />
          ) : (
            <>
              {chatContainerNode}
              {isDesktopLayout && isArtifactPanelEnabled ? (
                <div
                  aria-hidden={!isArtifactPanelOpen}
                  data-state={isArtifactPanelOpen ? "open" : "closed"}
                  className="shrink-0 overflow-hidden border-l border-border motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out motion-reduce:transition-none will-change-[width] data-[state=closed]:w-0 data-[state=closed]:border-l-0 xl:data-[state=open]:w-96 2xl:data-[state=open]:w-md"
                >
                  <div className="h-full xl:w-96 2xl:w-md">
                    <ArtifactPanel
                      repositoryId={effectiveSelectedRepositoryId}
                      artifacts={repoDetail?.artifacts}
                      isVisible={isArtifactPanelOpen}
                      className="flex h-full w-full border-l-0"
                      onOpenInReader={handleSelectArtifact}
                    />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </SidebarInset>

      {!isDesktopLayout && isArtifactPanelEnabled ? (
        <Drawer open={isArtifactSheetOpen} onOpenChange={setIsArtifactSheetOpen} aria-label="artifact-drawer">
          <DrawerContent className={cn(MOBILE_DRAWER_HEIGHT_CLASS, "rounded-t-2xl")}>
            <DrawerTitle className="sr-only">Results and artifacts</DrawerTitle>
            <DrawerDescription className="sr-only">
              Persistent results and artifacts for the current conversation and attached repository.
            </DrawerDescription>
            <div className="flex min-h-0 flex-1 flex-col">
              <ArtifactPanel
                repositoryId={effectiveSelectedRepositoryId}
                artifacts={repoDetail?.artifacts}
                isVisible={isArtifactSheetOpen}
                className="flex h-full w-full border-l-0"
                onOpenInReader={(artifactId) => {
                  handleSelectArtifact(artifactId);
                  setIsArtifactSheetOpen(false);
                }}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}

      {!isDesktopLayout && repoDetail && isArtifactPanelEnabled ? (
        <Drawer open={isStatusOpen} onOpenChange={handleSetStatusOpen} aria-label="status-drawer">
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
                isSyncing={isSyncing || isRepositorySyncing}
                onSync={() => void handleSync()}
                syncDisabledReason={syncDisabledReason}
                onViewArtifact={handleSelectArtifact}
                onClose={() => setIsStatusOpen(false)}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={threadToArchive !== null}
        onOpenChange={(open) => !open && setThreadToArchive(null)}
        title="Archive thread"
        description="This removes the thread from active history. You can restore or permanently delete it from Archive."
        actionLabel="Archive thread"
        loadingLabel="Archiving…"
        isPending={isArchivingThread}
        onConfirm={() => void handleArchiveThread()}
      />

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

      {effectiveSelectedRepositoryId ? (
        <GenerateSystemDesignDialog
          open={isGenerateDialogOpen}
          onOpenChange={setIsGenerateDialogOpen}
          repositoryId={effectiveSelectedRepositoryId}
          disabledReason={generateSystemDesignDisabledReason}
          premiumModelsDisabledReason={premiumModelsDisabledReason}
          highReasoningDisabledReason={highReasoningDisabledReason}
        />
      ) : null}
    </>
  );
}

function RepositoryMissingState({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="w-full max-w-md text-center">
        <h2 className="text-base font-semibold text-foreground">This repository is unavailable</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been deleted, or you no longer have access to it.
        </p>
        <Button type="button" variant="default" size="sm" className="mt-5" onClick={onBack}>
          Back to chat
        </Button>
      </div>
    </div>
  );
}

function ImportFailedBanner({
  errorMessage,
  isSyncing,
  syncDisabledReason,
  onRetry,
}: {
  errorMessage: string | null;
  isSyncing: boolean;
  syncDisabledReason?: string;
  onRetry: () => void;
}) {
  const retryDisabled = isSyncing || syncDisabledReason !== undefined;
  return (
    <div className="flex shrink-0 flex-col border-b border-destructive/40 bg-destructive/5 px-6 py-3 text-destructive">
      <div role="alert" aria-live="assertive" aria-atomic="true" className="flex items-start gap-2">
        <WarningCircleIcon size={18} weight="fill" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Repository import failed</p>
          <p className="mt-0.5 text-xs leading-5">
            The latest sync did not finish. Retry to restore repo-aware features for this repository.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          disabled={retryDisabled}
          title={syncDisabledReason}
          onClick={onRetry}
        >
          <ButtonStateText current={isSyncing ? "Retrying…" : "Retry sync"} states={["Retry sync", "Retrying…"]} />
        </Button>
      </div>
      {errorMessage ? (
        <Accordion type="single" collapsible className="mt-1 ml-7">
          <AccordionItem value="details" className="border-b-0">
            <AccordionTrigger className="py-1 text-[11px] font-semibold tracking-wider uppercase text-destructive/80 hover:text-destructive hover:no-underline">
              Error details
            </AccordionTrigger>
            <AccordionContent className="pt-1.5 pb-0">
              <pre className="max-h-48 overflow-auto rounded-sm border border-destructive/20 bg-destructive/10 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words text-destructive">
                {errorMessage}
              </pre>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}
    </div>
  );
}
