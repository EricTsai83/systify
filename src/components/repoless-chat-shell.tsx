import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { AppNotice } from "@/components/app-notice";
import { AppSidebarLeft } from "@/components/app-sidebar";
import { ChatContainer } from "@/components/chat-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  RepolessChatTypeToggle,
  RepolessSingleTurnToggle,
  type RepolessAgentProfileValue,
} from "@/components/repoless-agent-profile-bar";
import { useChatShellLifecycle } from "@/components/chat-shell-shared/use-chat-shell-lifecycle";
import { useThreadDeletionRecovery } from "@/components/chat-shell-shared/use-thread-deletion-recovery";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useComposerModelPick } from "@/hooks/use-composer-model-pick";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import { isViewerFeatureEnabled, useViewerAccess } from "@/hooks/use-viewer-access";
import type { ChatMode, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { DEMO_MODE_COPY } from "@/lib/demo-content";
import { toUserErrorMessage } from "@/lib/errors";
import { DEFAULT_AUTHENTICATED_PATH, modeAwareThreadPath, repolessThreadPath, repositoryPath } from "@/route-paths";

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
  const [draftAgentProfile, setDraftAgentProfile] = useState<RepolessAgentProfileValue>({
    agentEnabled: false,
    singleTurnEnabled: false,
    agentRole: "",
    agentInstructions: "",
  });

  const chatMode: ChatMode = "discuss";

  const { selectedProvider, selectedModelName, setSelectedModel, selectedReasoningEffort, setSelectedReasoningEffort } =
    useComposerModelPick({
      threadId: urlThreadId,
      capability: "discuss",
      preferenceScope: "chat",
      threadLockedProvider: capabilities.lockedProvider,
      threadDefaultModelName: capabilities.defaultModelName,
    });

  const recentThreadIds = useRecentThreads(urlThreadId);
  useWarmThreadSubscriptions(recentThreadIds);

  const onAfterCreateThread = useCallback(
    (threadId: ThreadId) => {
      void navigate(repolessThreadPath(threadId), { replace: true });
    },
    [navigate],
  );

  const onAfterArchiveThread = useCallback(() => {
    void navigate(DEFAULT_AUTHENTICATED_PATH);
  }, [navigate]);

  const { chatInput, setChatInput, isSending, handleSendMessage, isArchivingThread, handleArchiveThread } =
    useChatShellLifecycle({
      urlThreadId,
      repositoryId: null,
      chatMode,
      selectedProvider,
      selectedModelName,
      selectedReasoningEffort,
      newThreadSingleTurnEnabled: urlThreadId === null ? draftAgentProfile.singleTurnEnabled : undefined,
      newThreadAgentEnabled: urlThreadId === null ? draftAgentProfile.agentEnabled : undefined,
      newThreadAgentRole: urlThreadId === null ? draftAgentProfile.agentRole : undefined,
      newThreadAgentInstructions: urlThreadId === null ? draftAgentProfile.agentInstructions : undefined,
      threadToArchive,
      setActionError,
      setThreadToArchive,
      onAfterCreateThread,
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

  const isChatShellLoading = urlThreadId !== null && capabilities.isLoading;
  const accessLoadingReason = viewerAccess === undefined ? "Loading access…" : undefined;
  const chatSendDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "chatSend") ? undefined : DEMO_MODE_COPY.lockedMessage);
  const importDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "repoImport") ? undefined : DEMO_MODE_COPY.importDisabled);
  const premiumModelsDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "premiumModels") ? undefined : DEMO_MODE_COPY.premiumModelsDisabled);
  const highReasoningDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "highReasoning") ? undefined : DEMO_MODE_COPY.highReasoningDisabled);

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
            repositoryId={null}
            isShellLoading={isChatShellLoading}
            chatInput={chatInput}
            setChatInput={setChatInput}
            chatMode={chatMode}
            groundLibrary={false}
            groundSandbox={false}
            setGroundLibrary={() => {}}
            setGroundSandbox={() => {}}
            selectedProvider={selectedProvider}
            selectedModelName={selectedModelName}
            setSelectedModel={setSelectedModel}
            premiumModelsDisabledReason={premiumModelsDisabledReason}
            modelPreferenceScope="chat"
            selectedReasoningEffort={selectedReasoningEffort}
            setSelectedReasoningEffort={setSelectedReasoningEffort}
            highReasoningDisabledReason={highReasoningDisabledReason}
            threadLockedProvider={capabilities.lockedProvider}
            grounding={undefined}
            showGroundingToggles={false}
            composerControls={[
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
            ]}
            composerControlsReady={!capabilities.isLoading}
            isSending={isSending}
            onSendMessage={handleSendMessage}
            sendDisabledReason={
              capabilities.singleTurnResetPending ? "Clearing previous messages…" : chatSendDisabledReason
            }
            sandboxModeStatus={null}
            isSyncing={false}
            onSync={() => {}}
            showArtifactToggle={false}
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
