import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import { ArchiveIcon, ArrowCounterClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AppSidebarLeft } from "@/components/app-sidebar";
import { ArtifactPanel } from "@/components/artifact-panel";
import { TopBar } from "@/components/top-bar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AppNotice } from "@/components/app-notice";
import { ChatContainer } from "@/components/chat-panel";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { StatusPanel } from "@/components/status-panel";
import { useChatShellLifecycle } from "@/components/chat-shell-shared/use-chat-shell-lifecycle";
import { useThreadDeletionRecovery } from "@/components/chat-shell-shared/use-thread-deletion-recovery";
import { useRepositoryPersistence } from "@/components/chat-shell-shared/use-repository-persistence";
import { useCheckForUpdates } from "@/hooks/use-check-for-updates";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useRepositoryLifecycle } from "@/hooks/use-repository-lifecycle";
import { useChatMode } from "@/hooks/use-service-mode";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import type { ArtifactId, ChatMode, RepositoryId, SandboxModeStatus, ThreadId, ThreadMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DEFAULT_AUTHENTICATED_PATH,
  discussPath,
  libraryArtifactPath,
  libraryPath,
  modeAwareThreadPath,
  repositoryPath,
  withLibraryAskParam,
} from "@/route-paths";

type RepositoryShellStatus = "initializing" | "ready";
const DESKTOP_LAYOUT_QUERY = "(min-width: 1280px)";

const MOBILE_DRAWER_HEIGHT_CLASS = "h-[95dvh] data-[vaul-drawer-direction=bottom]:max-h-[95dvh]";

export function RepositoryShell({
  urlRepositoryId,
  urlThreadId,
}: {
  urlRepositoryId: RepositoryId | null;
  urlThreadId: ThreadId | null;
}) {
  const navigate = useNavigate();

  const {
    repositories,
    touchRepository,
    activeRepositoryId,
    currentRepositoryId,
    currentRepository,
    handleSwitchRepository,
  } = useRepositoryPersistence({ urlRepositoryId, navigate });

  const ownerRepositoryIds = useQuery(api.repositoryPreferences.listAllOwnerRepositoryIds, {});
  const ownerThreadIds = useQuery(api.chat.threads.listAllOwnerThreadIds, {});
  // GC needs the full owned set so repositories outside the switcher's
  // 20-row recency window aren't garbage-collected from localStorage.
  const liveRepositoryIds = useMemo(
    () => (ownerRepositoryIds ? new Set(ownerRepositoryIds.map((id) => id as string)) : null),
    [ownerRepositoryIds],
  );
  const liveThreadIds = useMemo(
    () => (ownerThreadIds ? new Set(ownerThreadIds.map((id) => id as string)) : null),
    [ownerThreadIds],
  );

  const { mode, availability } = useChatMode(currentRepositoryId);
  const intendedChatMode = useMemo<ChatMode>(() => {
    if (mode) return mode;
    const lastMode = currentRepository?.lastMode ?? null;
    const lastModeAvailable = lastMode ? (availability?.modes[lastMode].enabled ?? false) : false;
    if (lastModeAvailable && lastMode) return lastMode;
    return availability?.defaultMode ?? "discuss";
  }, [mode, currentRepository?.lastMode, availability]);

  const capabilities = useThreadCapabilities(urlThreadId);

  const isArtifactPanelEnabled = mode === "library" || (mode === "discuss" && capabilities.attachedRepository !== null);

  const ownerThreads = useQuery(
    api.chat.threads.listThreads,
    urlThreadId === null && currentRepositoryId !== null
      ? { repositoryId: currentRepositoryId, mode: intendedChatMode }
      : "skip",
  );

  const [threadToDelete, setThreadToDelete] = useState<ThreadId | null>(null);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showPermanentDeleteDialog, setShowPermanentDeleteDialog] = useState(false);
  const chatMode: ChatMode = "discuss";

  const [groundingByThread, setGroundingByThread] = useState<{
    threadId: ThreadId | null;
    library: boolean;
    sandbox: boolean;
  }>({ threadId: urlThreadId, library: false, sandbox: false });
  const groundLibrary = groundingByThread.library;
  const groundSandbox = groundingByThread.sandbox;
  const setGroundLibrary = useCallback(
    (next: boolean) => setGroundingByThread((prev) => ({ ...prev, library: next })),
    [],
  );
  const setGroundSandbox = useCallback(
    (next: boolean) => setGroundingByThread((prev) => ({ ...prev, sandbox: next })),
    [],
  );
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
  const effectiveSandboxModeStatus: SandboxModeStatus | null =
    effectiveSelectedThreadId !== null ? capabilities.sandboxModeStatus : (repoDetail?.sandboxModeStatus ?? null);

  useEffect(() => {
    if (urlThreadId !== null) {
      return;
    }
    if (urlRepositoryId === null) {
      return;
    }
    if (availability === undefined) return;
    if (repositories === undefined) return;
    if (ownerThreads === undefined) return;
    if (intendedChatMode === "library") {
      const askThreadId = ownerThreads[0]?._id;
      const base = libraryPath(urlRepositoryId);
      const target = askThreadId ? withLibraryAskParam(base, askThreadId) : base;
      void navigate(target, { replace: true });
      return;
    }
    const tid = ownerThreads[0]?._id;
    if (tid) {
      void navigate(discussPath(urlRepositoryId, tid), { replace: true });
      return;
    }
    if (mode === null) {
      void navigate(discussPath(urlRepositoryId), { replace: true });
    }
  }, [
    navigate,
    ownerThreads,
    urlRepositoryId,
    urlThreadId,
    activeRepositoryId,
    mode,
    intendedChatMode,
    availability,
    repositories,
  ]);

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

  useCheckForUpdates(effectiveSelectedRepositoryId);

  const isAboutToRedirect =
    urlThreadId === null &&
    urlRepositoryId !== null &&
    (mode === null || ownerThreads === undefined || ownerThreads.length > 0);

  const shellStatus: RepositoryShellStatus =
    isRepositoriesLoading || repositories === undefined || isAboutToRedirect ? "initializing" : "ready";

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
    void navigate(discussPath(currentRepositoryId));
  }, [currentRepositoryId, navigate]);

  const onAfterDeleteThread = useCallback(() => {
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

  const {
    chatInput,
    setChatInput,
    isSending,
    handleSendMessage,
    isCancellingReply,
    handleCancelInFlightReply,
    isDeletingThread,
    handleDeleteThread,
  } = useChatShellLifecycle({
    urlThreadId,
    repositoryId: currentRepositoryId,
    chatMode,
    groundLibrary,
    groundSandbox,
    liveRepositoryIds,
    liveThreadIds,
    threadToDelete,
    setActionError,
    setThreadToDelete,
    onAfterCreateThread,
    onAfterDeleteThread,
  });

  useEffect(() => {
    if (groundingByThread.threadId === urlThreadId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGroundingByThread({
      threadId: urlThreadId,
      library: urlThreadId === null ? false : capabilities.defaultGroundLibrary,
      sandbox: urlThreadId === null ? false : capabilities.defaultGroundSandbox,
    });
  }, [urlThreadId, capabilities.defaultGroundLibrary, capabilities.defaultGroundSandbox, groundingByThread.threadId]);

  const groundingState = availability?.grounding;
  useEffect(() => {
    if (groundingState && !groundingState.library.enabled && groundLibrary) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroundLibrary(false);
    }
  }, [groundingState, groundLibrary, setGroundLibrary]);
  useEffect(() => {
    if (groundingState && !groundingState.sandbox.enabled && groundSandbox) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroundSandbox(false);
    }
  }, [groundingState, groundSandbox, setGroundSandbox]);

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
    onAfterArchiveRepo: () => {
      void navigate(DEFAULT_AUTHENTICATED_PATH);
    },
    onAfterRestoreRepo: () => {},
    onAfterPermanentDeleteRepo: () => {
      void navigate(DEFAULT_AUTHENTICATED_PATH);
    },
  });

  const chatReadOnlyHint = isRepoArchived ? "Restore this repository to send messages or run analyses." : undefined;

  const chatContainerNode = (
    <ChatContainer
      selectedThreadId={effectiveSelectedThreadId}
      repositoryId={currentRepositoryId}
      isShellLoading={isChatShellLoading}
      chatInput={chatInput}
      setChatInput={setChatInput}
      chatMode={chatMode}
      groundLibrary={groundLibrary}
      groundSandbox={groundSandbox}
      setGroundLibrary={setGroundLibrary}
      setGroundSandbox={setGroundSandbox}
      grounding={availability?.grounding}
      onOpenGenerateSystemDesign={() => setIsGenerateDialogOpen(true)}
      isSending={isSending}
      onSendMessage={handleSendMessage}
      onCancelInFlightReply={handleCancelInFlightReply}
      isCancellingReply={isCancellingReply}
      sandboxModeStatus={effectiveSandboxModeStatus}
      isSyncing={isSyncing || isRepositorySyncing}
      onSync={() => void handleSync()}
      isArtifactPanelOpen={isDesktopLayout ? isArtifactPanelOpen : isArtifactSheetOpen}
      onToggleArtifactPanel={handleToggleArtifactPanel}
      showArtifactToggle={isArtifactPanelEnabled}
      hasAttachedRepository={capabilities.attachedRepository !== null}
      onSelectArtifact={handleSelectArtifact}
      isReadOnly={isRepoArchived}
      readOnlyHint={chatReadOnlyHint}
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
        onDeleteThread={setThreadToDelete}
        onRequestNewThread={handleRequestNewThread}
        onImported={handleImported}
        onError={setActionError}
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
          onSync={() => void handleSync()}
          onViewArtifact={handleSelectArtifact}
          showSystemStatus={isArtifactPanelEnabled}
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
                {isRestoringRepo ? "Restoring…" : "Restore"}
              </Button>
            </div>
          </div>
        ) : null}

        {actionError ? (
          <div className="border-b border-border px-6 py-3">
            <AppNotice title="Action failed" message={actionError} tone="error" />
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
                onViewArtifact={handleSelectArtifact}
                onClose={() => setIsStatusOpen(false)}
              />
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={threadToDelete !== null}
        onOpenChange={(open) => !open && setThreadToDelete(null)}
        title="Delete thread"
        description="This will permanently delete this thread and all its messages. This action cannot be undone."
        actionLabel="Delete thread"
        loadingLabel="Deleting…"
        isPending={isDeletingThread}
        onConfirm={() => void handleDeleteThread()}
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
  onRetry,
}: {
  errorMessage: string | null;
  isSyncing: boolean;
  onRetry: () => void;
}) {
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
          disabled={isSyncing}
          onClick={onRetry}
        >
          {isSyncing ? "Retrying…" : "Retry sync"}
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
