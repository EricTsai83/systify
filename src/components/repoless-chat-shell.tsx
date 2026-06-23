import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { AppNotice } from "@/components/app-notice";
import { AppSidebarLeft } from "@/components/app-sidebar";
import { ChatModeControls } from "@/components/chat-mode-controls";
import { ChatContainer } from "@/components/chat-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  RepolessChatTypeToggle,
  RepolessSingleTurnToggle,
  type RepolessAgentProfileValue,
} from "@/components/repoless-agent-profile-bar";
import { ThreadSearchDialog } from "@/components/thread-search-dialog";
import { useChatComposerSession } from "@/components/chat-shell-shared/use-chat-composer-session";
import { useChatShellLifecycle } from "@/components/chat-shell-shared/use-chat-shell-lifecycle";
import { useThreadDeletionRecovery } from "@/components/chat-shell-shared/use-thread-deletion-recovery";
import { useShouldShowChatModeControls } from "@/hooks/use-chat-mode-controls-visibility";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import { isViewerFeatureEnabled, useViewerAccess } from "@/hooks/use-viewer-access";
import type { ChatMode, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { DEMO_MODE_COPY } from "@/lib/demo-content";
import { toUserErrorMessage } from "@/lib/errors";
import { DEFAULT_AUTHENTICATED_PATH, modeAwareThreadPath, repolessThreadPath, repositoryPath } from "@/route-paths";

const DEFAULT_REPOLESS_AGENT_PROFILE: RepolessAgentProfileValue = {
  agentEnabled: false,
  singleTurnEnabled: false,
  agentRole: "",
  agentInstructions: "",
};

/**
 * Shell for the repoless chat surface mounted at `/chat` and
 * `/chat/:threadId`. A repoless thread structurally cannot satisfy
 * Library mode (no repo to anchor artifacts) so this shell is permanently
 * Discuss-only — no service-mode switcher, no artifact panel, no Sandbox
 * grounding affordance.
 */
export function RepolessChatShell({ urlThreadId }: { urlThreadId: ThreadId | null }) {
  const navigate = useNavigate();
  const viewerAccess = useViewerAccess();
  const repositories = useQuery(api.repositoryPreferences.listRepositoriesForSwitcher);

  // The repoless shell never picks an "active repository" — repository
  // switches navigate into the repository shell via `repositoryPath` and
  // let RepositoryShell take over.
  const handleSwitchRepository = useCallback(
    (repositoryId: RepositoryId) => {
      void navigate(repositoryPath(repositoryId));
    },
    [navigate],
  );

  const capabilities = useThreadCapabilities(urlThreadId);
  const updateAgentProfile = useMutation(api.chat.threads.updateRepolessThreadAgentProfile);

  const [threadToArchive, setThreadToArchive] = useState<ThreadId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftAgentProfile, setDraftAgentProfile] = useState<RepolessAgentProfileValue>(DEFAULT_REPOLESS_AGENT_PROFILE);
  const [isThreadSearchOpen, setIsThreadSearchOpen] = useState(false);
  const shouldShowChatNavigationControls = useShouldShowChatModeControls();

  const chatMode: ChatMode = "discuss";

  const recentThreadIds = useRecentThreads(urlThreadId);
  useWarmThreadSubscriptions(recentThreadIds);

  const onAfterCreateThread = useCallback(
    (threadId: ThreadId) => {
      setDraftAgentProfile(DEFAULT_REPOLESS_AGENT_PROFILE);
      void navigate(repolessThreadPath(threadId), { replace: true });
    },
    [navigate],
  );

  const onAfterArchiveThread = useCallback(() => {
    void navigate(DEFAULT_AUTHENTICATED_PATH);
  }, [navigate]);

  const { isArchivingThread, handleArchiveThread } = useChatShellLifecycle({
    selectedThreadId: urlThreadId,
    threadToArchive,
    setActionError,
    setThreadToArchive,
    onAfterArchiveThread,
  });

  const agentProfileValue: RepolessAgentProfileValue =
    urlThreadId === null
      ? draftAgentProfile
      : {
          singleTurnEnabled: capabilities.singleTurnEnabled,
          agentEnabled: capabilities.agentEnabled,
          agentRole: capabilities.agentRole ?? "",
          agentInstructions: capabilities.agentInstructions ?? "",
        };
  const agentProfileConfigured =
    !agentProfileValue.agentEnabled ||
    agentProfileValue.agentRole.trim().length > 0 ||
    agentProfileValue.agentInstructions.trim().length > 0;

  const handleSaveAgentProfile = useCallback(
    async (next: RepolessAgentProfileValue) => {
      setActionError(null);
      if (urlThreadId === null) {
        setDraftAgentProfile(next);
        return;
      }
      try {
        await updateAgentProfile({
          threadId: urlThreadId,
          agentEnabled: next.agentEnabled,
          singleTurnEnabled: next.singleTurnEnabled,
          agentRole: next.agentRole,
          agentInstructions: next.agentInstructions,
        });
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to save the Agent Profile."));
        throw error;
      }
    },
    [updateAgentProfile, urlThreadId],
  );

  const onMissingThread = useCallback(() => {
    void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
  }, [navigate]);
  useThreadDeletionRecovery({
    urlThreadId,
    isMissingThread: capabilities.isMissingThread,
    onMissingThread,
  });

  const handleSelectThread = useCallback(
    (threadId: ThreadId | null, threadMode: ThreadMode) => {
      setActionError(null);
      if (threadId === null) {
        void navigate(DEFAULT_AUTHENTICATED_PATH);
        return;
      }
      void navigate(repolessThreadPath(threadId));
      void threadMode;
    },
    [navigate],
  );

  const handleRequestNewThread = useCallback(() => {
    setDraftAgentProfile(DEFAULT_REPOLESS_AGENT_PROFILE);
    void navigate(DEFAULT_AUTHENTICATED_PATH);
  }, [navigate]);

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

  const accessLoadingReason = viewerAccess === undefined ? "Loading access…" : undefined;
  const importDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "repoImport") ? undefined : DEMO_MODE_COPY.importDisabled);
  const composerSendDisabledReason = capabilities.singleTurnResetPending
    ? "Clearing previous messages…"
    : agentProfileConfigured
      ? undefined
      : "Set up Agent before sending.";
  const composer = useChatComposerSession({
    surface: "repoless",
    threadId: urlThreadId,
    repositoryId: null,
    mode: chatMode,
    capabilities,
    viewerAccess,
    isSyncing: false,
    isReadOnly: false,
    setActionError,
    onAfterCreateThread,
    draftAgentProfile,
    extraControls: [
      <RepolessSingleTurnToggle
        key="single-turn"
        value={agentProfileValue}
        resetPending={capabilities.singleTurnResetPending}
        disabled={capabilities.isLoading}
        className="animate-enter-fade"
        onSave={handleSaveAgentProfile}
      />,
      <RepolessChatTypeToggle
        key="chat-type"
        value={agentProfileValue}
        disabled={capabilities.isLoading}
        className="animate-enter-fade"
        onSave={handleSaveAgentProfile}
      />,
    ],
    extraControlsReady: !capabilities.isLoading,
    extraSendDisabledReason: composerSendDisabledReason,
  });

  const isChatShellLoading = urlThreadId !== null && capabilities.isLoading;

  return (
    <>
      <AppSidebarLeft
        repositories={repositories}
        activeRepositoryId={null}
        onSwitchRepository={handleSwitchRepository}
        selectedThreadId={urlThreadId}
        onSelectThread={handleSelectThread}
        onDeleteThread={setThreadToArchive}
        onRequestNewThread={handleRequestNewThread}
        onImported={handleImported}
        onError={setActionError}
        importDisabledReason={importDisabledReason}
      />

      <SidebarInset>
        {shouldShowChatNavigationControls ? (
          <div className="pointer-events-none absolute top-3 left-3 z-20">
            <ChatModeControls
              className="pointer-events-auto bg-background"
              onSearchThreads={() => setIsThreadSearchOpen(true)}
              onNewThread={handleRequestNewThread}
            />
          </div>
        ) : null}

        {isThreadSearchOpen ? (
          <ThreadSearchDialog
            open={isThreadSearchOpen}
            onOpenChange={setIsThreadSearchOpen}
            repositoryId={null}
            mode={chatMode}
            selectedThreadId={urlThreadId}
            onSelectThread={handleSelectThread}
          />
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
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1">
          <ChatContainer
            selectedThreadId={urlThreadId}
            isShellLoading={isChatShellLoading}
            composer={composer}
            chatMode={chatMode}
            hasAttachedRepository={false}
          />
        </div>
      </SidebarInset>

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
    </>
  );
}
