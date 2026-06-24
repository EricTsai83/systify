import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { useChatComposerSession } from "@/components/chat-shell-shared/use-chat-composer-session";
import { useChatShellLifecycle } from "@/components/chat-shell-shared/use-chat-shell-lifecycle";
import { useRepositoryLandingDecision } from "@/components/chat-shell-shared/use-repository-landing";
import { useRepositoryPersistence } from "@/components/chat-shell-shared/use-repository-persistence";
import { useThreadDeletionRecovery } from "@/components/chat-shell-shared/use-thread-deletion-recovery";
import type { ChatComposerViewModel } from "@/components/chat-shell-shared/chat-composer-types";
import { useCheckForUpdates } from "@/hooks/use-check-for-updates";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useRepositoryLifecycle } from "@/hooks/use-repository-lifecycle";
import { useChatMode } from "@/hooks/use-service-mode";
import { useThreadCapabilities, type ThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useViewerAccess, isViewerFeatureEnabled, type ViewerAccess } from "@/hooks/use-viewer-access";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import { DEMO_MODE_COPY } from "@/lib/demo-content";
import type { ArtifactId, ChatMode, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import {
  DEFAULT_AUTHENTICATED_PATH,
  discussPath,
  libraryArtifactPath,
  libraryPath,
  modeAwareThreadPath,
  newDiscussPath,
  repolessThreadPath,
  repositoryPath,
} from "@/route-paths";

type RepositoryShellStatus = "initializing" | "ready";

const DESKTOP_LAYOUT_QUERY = "(min-width: 1280px)";

type RepositoryActionNotice = { title: string; message: string };
type RepositoryDetail = ReturnType<typeof useQuery<typeof api.repositories.getRepositoryDetail>>;

export type RepositoryWorkspaceState = {
  repositories: Doc<"repositories">[] | undefined;
  activeRepositoryId: RepositoryId | null;
  selectedRepositoryId: RepositoryId | null;
  artifactRepositoryId: RepositoryId | null;
  selectedThreadId: ThreadId | null;
  chatMode: ChatMode;
  capabilities: ThreadCapabilities;
  viewerAccess: ViewerAccess | undefined;
  repoDetail: RepositoryDetail;
  shellStatus: RepositoryShellStatus;
  isChatShellLoading: boolean;
  isRepoMissing: boolean;
  isRepoArchived: boolean;
  isSyncing: boolean;
  isRestoringRepository: boolean;
  isArtifactPanelEnabled: boolean;
  isDesktopLayout: boolean;
  actionError: string | null;
  actionNotice: RepositoryActionNotice | null;
  importDisabledReason?: string;
  syncDisabledReason?: string;
  generateSystemDesignDisabledReason?: string;
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
  composer: ChatComposerViewModel;
  panels: {
    artifact: {
      isDesktopOpen: boolean;
      isMobileOpen: boolean;
      setMobileOpen: (open: boolean) => void;
      toggle: () => void;
      selectArtifact: (artifactId: ArtifactId) => void;
      selectMobileArtifact: (artifactId: ArtifactId) => void;
    };
    status: {
      isOpen: boolean;
      setOpen: (open: boolean) => void;
      close: () => void;
    };
    threadSearch: {
      isOpen: boolean;
      setOpen: (open: boolean) => void;
      open: () => void;
    };
  };
  dialogs: {
    threadArchive: {
      isOpen: boolean;
      setOpen: (open: boolean) => void;
      isPending: boolean;
      confirm: () => void;
    };
    repositoryArchive: {
      isOpen: boolean;
      setOpen: (open: boolean) => void;
      isPending: boolean;
      confirm: () => void;
    };
    permanentDelete: {
      isOpen: boolean;
      setOpen: (open: boolean) => void;
      isPending: boolean;
      confirm: () => void;
    };
    generateSystemDesign: {
      isOpen: boolean;
      setOpen: (open: boolean) => void;
    };
  };
  handlers: {
    switchRepository: (repositoryId: RepositoryId) => void;
    selectThread: (threadId: ThreadId | null, threadMode: ThreadMode) => void;
    requestArchiveThread: (threadId: ThreadId) => void;
    requestNewThread: () => void;
    imported: (repoId: RepositoryId, threadId: ThreadId | null, threadMode: ThreadMode | null) => void;
    threadMovedToRepository: (repositoryId: RepositoryId | null, threadMode: ThreadMode | null) => void;
    setActionError: (message: string | null) => void;
    dismissActionError: () => void;
    backToDefault: () => void;
    sync: () => void;
    restoreRepository: () => void;
    requestArchiveRepository: () => void;
    requestPermanentDeleteRepository: () => void;
  };
};

export function useRepositoryWorkspaceState({
  urlRepositoryId,
  urlThreadId,
  isNewThreadRoute = false,
}: {
  urlRepositoryId: RepositoryId | null;
  urlThreadId: ThreadId | null;
  isNewThreadRoute?: boolean;
}): RepositoryWorkspaceState {
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
  const chatMode: ChatMode = landingDecision.intendedChatMode;

  const [threadToArchive, setThreadToArchive] = useState<ThreadId | null>(null);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showPermanentDeleteDialog, setShowPermanentDeleteDialog] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<RepositoryActionNotice | null>(null);
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

  const selectedRepositoryId: RepositoryId | null = currentRepositoryId;
  const selectedThreadId: ThreadId | null = urlThreadId;
  const artifactRepositoryId: RepositoryId | null = capabilities.attachedRepository?.id ?? currentRepositoryId;
  const recentThreadIds = useRecentThreads(selectedThreadId);
  useWarmThreadSubscriptions(recentThreadIds);

  const repoDetail = useQuery(
    api.repositories.getRepositoryDetail,
    artifactRepositoryId ? { repositoryId: artifactRepositoryId } : "skip",
  );
  const isRepoMissing =
    selectedRepositoryId !== null && artifactRepositoryId === selectedRepositoryId && repoDetail === null;
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
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsGenerateDialogOpen(false);
  }, [selectedRepositoryId]);

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

  useCheckForUpdates(selectedRepositoryId, checkForUpdatesEnabled);

  const shellStatus: RepositoryShellStatus =
    repositories === undefined || landingDecision.status !== "ready" ? "initializing" : "ready";
  const isChatShellLoading = shellStatus === "initializing" || (selectedThreadId !== null && capabilities.isLoading);

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
        void navigate(repolessThreadPath(threadId));
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
      if (artifactRepositoryId === null) {
        return;
      }
      void navigate(libraryArtifactPath(artifactRepositoryId, artifactId));
    },
    [navigate, artifactRepositoryId],
  );

  const handleSelectMobileArtifact = useCallback(
    (artifactId: ArtifactId) => {
      handleSelectArtifact(artifactId);
      setIsArtifactSheetOpen(false);
    },
    [handleSelectArtifact],
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
      if (currentRepositoryId === null) {
        void navigate(repolessThreadPath(threadId), { replace: true });
        return;
      }
      void navigate(modeAwareThreadPath(currentRepositoryId, threadId, threadMode), { replace: true });
    },
    [currentRepositoryId, navigate],
  );

  const handleRequestNewThread = useCallback(() => {
    if (currentRepositoryId === null) {
      void navigate(DEFAULT_AUTHENTICATED_PATH);
      return;
    }
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
    selectedThreadId,
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
    selectedRepositoryId,
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
    threadId: selectedThreadId,
    repositoryId: currentRepositoryId,
    mode: chatMode,
    capabilities,
    groundingAvailability: availability?.grounding,
    viewerAccess,
    isSyncing: isSyncing || isRepositorySyncing,
    isReadOnly: isRepoArchived,
    readOnlyHint: chatReadOnlyHint,
    setActionError,
    onAfterCreateThread,
  });

  return {
    repositories,
    activeRepositoryId,
    selectedRepositoryId,
    artifactRepositoryId,
    selectedThreadId,
    chatMode,
    capabilities,
    viewerAccess,
    repoDetail,
    shellStatus,
    isChatShellLoading,
    isRepoMissing,
    isRepoArchived,
    isSyncing: isSyncing || isRepositorySyncing,
    isRestoringRepository: isRestoringRepo,
    isArtifactPanelEnabled,
    isDesktopLayout,
    actionError,
    actionNotice,
    importDisabledReason,
    syncDisabledReason,
    generateSystemDesignDisabledReason,
    premiumModelsDisabledReason,
    highReasoningDisabledReason,
    composer,
    panels: {
      artifact: {
        isDesktopOpen: isArtifactPanelOpen,
        isMobileOpen: isArtifactSheetOpen,
        setMobileOpen: setIsArtifactSheetOpen,
        toggle: handleToggleArtifactPanel,
        selectArtifact: handleSelectArtifact,
        selectMobileArtifact: handleSelectMobileArtifact,
      },
      status: {
        isOpen: isStatusOpen,
        setOpen: handleSetStatusOpen,
        close: () => setIsStatusOpen(false),
      },
      threadSearch: {
        isOpen: isThreadSearchOpen,
        setOpen: setIsThreadSearchOpen,
        open: () => setIsThreadSearchOpen(true),
      },
    },
    dialogs: {
      threadArchive: {
        isOpen: threadToArchive !== null,
        setOpen: (open) => {
          if (!open) setThreadToArchive(null);
        },
        isPending: isArchivingThread,
        confirm: () => void handleArchiveThread(),
      },
      repositoryArchive: {
        isOpen: showArchiveDialog,
        setOpen: setShowArchiveDialog,
        isPending: isArchivingRepo,
        confirm: () => void handleArchiveRepo(),
      },
      permanentDelete: {
        isOpen: showPermanentDeleteDialog,
        setOpen: setShowPermanentDeleteDialog,
        isPending: isPermanentDeletingRepo,
        confirm: () => void handlePermanentDeleteRepo(),
      },
      generateSystemDesign: {
        isOpen: isGenerateDialogOpen,
        setOpen: setIsGenerateDialogOpen,
      },
    },
    handlers: {
      switchRepository: handleSwitchRepository,
      selectThread: handleSelectThread,
      requestArchiveThread: setThreadToArchive,
      requestNewThread: handleRequestNewThread,
      imported: handleImported,
      threadMovedToRepository: handleThreadMovedToRepository,
      setActionError,
      dismissActionError: () => setActionError(null),
      backToDefault: () => void navigate(DEFAULT_AUTHENTICATED_PATH),
      sync: () => void handleSync(),
      restoreRepository: () => void handleRestoreRepo(),
      requestArchiveRepository: () => setShowArchiveDialog(true),
      requestPermanentDeleteRepository: () => setShowPermanentDeleteDialog(true),
    },
  };
}
