import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { AppNotice } from "@/components/app-notice";
import { AppSidebarLeft } from "@/components/app-sidebar";
import { ChatContainer } from "@/components/chat-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useChatShellLifecycle } from "@/components/chat-shell-shared/use-chat-shell-lifecycle";
import { useThreadDeletionRecovery } from "@/components/chat-shell-shared/use-thread-deletion-recovery";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useComposerModelPick } from "@/hooks/use-composer-model-pick";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import type { ChatMode, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
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
  const repositories = useQuery(api.repositoryPreferences.listRepositoriesForSwitcher);
  // Live id sets for the localStorage GC sweep that runs inside the
  // shared chat-shell lifecycle bundle. The GC sweep needs the *complete*
  // owned-repo set (`listAllOwnerRepositoryIds`); the switcher's 20-row
  // recency window would otherwise garbage-collect localStorage tied to
  // repos the user still owns but hasn't touched recently.
  const ownerRepositoryIds = useQuery(api.repositoryPreferences.listAllOwnerRepositoryIds, {});
  const ownerThreadIds = useQuery(api.chat.threads.listAllOwnerThreadIds, {});
  const liveRepositoryIds = useMemo(
    () => (ownerRepositoryIds ? new Set(ownerRepositoryIds.map((id) => id as string)) : null),
    [ownerRepositoryIds],
  );
  const liveThreadIds = useMemo(
    () => (ownerThreadIds ? new Set(ownerThreadIds.map((id) => id as string)) : null),
    [ownerThreadIds],
  );

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

  const [threadToArchive, setThreadToArchive] = useState<ThreadId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
      liveRepositoryIds,
      liveThreadIds,
      threadToArchive,
      setActionError,
      setThreadToArchive,
      onAfterCreateThread,
      onAfterArchiveThread,
    });

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
            modelPreferenceScope="chat"
            selectedReasoningEffort={selectedReasoningEffort}
            setSelectedReasoningEffort={setSelectedReasoningEffort}
            threadLockedProvider={capabilities.lockedProvider}
            grounding={undefined}
            showGroundingToggles={false}
            isSending={isSending}
            onSendMessage={handleSendMessage}
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
