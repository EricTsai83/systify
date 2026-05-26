import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { SidebarInset } from "@/components/ui/sidebar";
import { AppNotice } from "@/components/app-notice";
import { AppSidebarLeft } from "@/components/app-sidebar";
import { AttachRepoMenu } from "@/components/attach-repo-menu";
import { ChatContainer } from "@/components/chat-panel";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Logo } from "@/components/logo";
import { useChatShellLifecycle } from "@/components/chat-shell-shared/use-chat-shell-lifecycle";
import { useThreadDeletionRecovery } from "@/components/chat-shell-shared/use-thread-deletion-recovery";
import { useRecentThreads } from "@/hooks/use-recent-threads";
import { useThreadCapabilities } from "@/hooks/use-thread-capabilities";
import { useWarmThreadSubscriptions } from "@/hooks/use-warm-thread-subscriptions";
import type { ChatMode, RepositoryId, ThreadId, ThreadMode, WorkspaceId } from "@/lib/types";
import { DEFAULT_AUTHENTICATED_PATH, modeAwareThreadPath, workspacePath, workspacelessThreadPath } from "@/route-paths";

/**
 * Shell for the workspaceless chat surface mounted at `/chat` and
 * `/chat/:threadId`. A workspaceless thread structurally cannot satisfy
 * Library mode (no repo to anchor artifacts) so this shell is permanently
 * Discuss-only — no `useChatMode`, no service-mode switcher, no artifact
 * panel, no Sandbox grounding affordance.
 *
 * Surface:
 *   - `/chat`             → owl + "Start a conversation" empty state.
 *                            Composer is live; the first send lazily
 *                            creates a workspaceless thread and the
 *                            redirect lands the user on `/chat/:tid`.
 *   - `/chat/:threadId`   → standard Discuss surface for a workspaceless
 *                            thread, with `AttachRepoMenu` in the top bar
 *                            so the user can promote the thread into a
 *                            repo workspace.
 *
 * Thread missing → bounce to `/chat` (not into a workspace), since the
 * workspaceless surface has no workspace context to fall back on.
 */
export function WorkspacelessChatShell({ urlThreadId }: { urlThreadId: ThreadId | null }) {
  const navigate = useNavigate();
  const repositories = useQuery(api.repositories.listRepositories);
  const workspaces = useQuery(api.workspaces.listWorkspaces);
  // Live id sets for the localStorage GC sweep that runs inside the
  // shared chat-shell lifecycle bundle.
  const ownerThreadIds = useQuery(api.chat.threads.listAllOwnerThreadIds, {});
  const liveWorkspaceIds = useMemo(
    () => (workspaces ? new Set(workspaces.map((w) => w._id as string)) : null),
    [workspaces],
  );
  const liveRepositoryIds = useMemo(
    () => (repositories ? new Set(repositories.map((r) => r._id as string)) : null),
    [repositories],
  );
  const liveThreadIds = useMemo(
    () => (ownerThreadIds ? new Set(ownerThreadIds.map((id) => id as string)) : null),
    [ownerThreadIds],
  );

  // The workspaceless shell never picks an "active workspace" — workspace
  // switches navigate into the repo shell via `workspacePath` and let
  // RepositoryShell take over.
  const handleSwitchWorkspace = useCallback(
    (workspaceId: WorkspaceId) => {
      void navigate(workspacePath(workspaceId));
    },
    [navigate],
  );

  const capabilities = useThreadCapabilities(urlThreadId);

  const [threadToDelete, setThreadToDelete] = useState<ThreadId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Workspaceless threads are structurally Discuss-only (Library requires
  // a repo binding). No `useChatMode` here — the canonical chat mode is
  // a static literal.
  const chatMode: ChatMode = "discuss";

  // Keep the chat surface hot-warm across thread switches inside the
  // workspaceless rail so flipping between recent workspaceless threads
  // doesn't refetch every time.
  const recentThreadIds = useRecentThreads(urlThreadId);
  useWarmThreadSubscriptions(recentThreadIds);

  // Replace the URL with the canonical `/chat/:tid` path once the lazy
  // first send materialised a thread. `replace: true` keeps the prior
  // `/chat` landing out of history so Back doesn't bounce-redirect.
  const onAfterCreateThread = useCallback(
    (threadId: ThreadId) => {
      void navigate(workspacelessThreadPath(threadId), { replace: true });
    },
    [navigate],
  );

  const onAfterDeleteThread = useCallback(() => {
    void navigate(DEFAULT_AUTHENTICATED_PATH);
  }, [navigate]);

  const { chatInput, setChatInput, isSending, handleSendMessage, isDeletingThread, handleDeleteThread } =
    useChatShellLifecycle({
      urlThreadId,
      workspaceId: null,
      chatMode,
      liveWorkspaceIds,
      liveRepositoryIds,
      liveThreadIds,
      threadToDelete,
      setActionError,
      setThreadToDelete,
      onAfterCreateThread,
      onAfterDeleteThread,
    });

  // Thread missing → bounce to `/chat` (workspaceless landing). The shell
  // has no workspace context to redirect into, so we cannot mirror the
  // RepositoryShell behaviour of returning to the workspace URL.
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
      // Rail rows render workspaceless threads (no `workspaceId`) and any
      // repo-bound threads the user surfaces from another sidebar section.
      // The rail forwards the persisted mode so we can route to the
      // canonical mode-aware URL when the click crosses into a repo
      // workspace.
      void navigate(workspacelessThreadPath(threadId));
      void threadMode;
    },
    [navigate],
  );

  const handleRequestNewThread = useCallback(() => {
    void navigate(DEFAULT_AUTHENTICATED_PATH);
  }, [navigate]);

  // After attach: the thread is now bound to a repo workspace; navigate
  // straight into the canonical mode-aware URL inside that workspace so
  // RepositoryShell takes over.
  const handleThreadMovedToWorkspace = useCallback(
    (workspaceId: WorkspaceId | null, threadMode: ThreadMode | null) => {
      if (!workspaceId) return;
      if (urlThreadId !== null && threadMode) {
        void navigate(modeAwareThreadPath(workspaceId, urlThreadId, threadMode));
      } else {
        void navigate(workspacePath(workspaceId));
      }
    },
    [navigate, urlThreadId],
  );

  const handleImported = useCallback(
    (_repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId, threadMode: ThreadMode | null) => {
      setActionError(null);
      if (threadId && threadMode) {
        void navigate(modeAwareThreadPath(workspaceId, threadId, threadMode));
      } else {
        void navigate(workspacePath(workspaceId));
      }
    },
    [navigate],
  );

  const isChatShellLoading = urlThreadId !== null && capabilities.isLoading;

  return (
    <>
      <AppSidebarLeft
        repositories={repositories}
        workspaces={workspaces}
        activeWorkspaceId={null}
        onSwitchWorkspace={handleSwitchWorkspace}
        selectedThreadId={urlThreadId}
        onSelectThread={handleSelectThread}
        onDeleteThread={setThreadToDelete}
        onRequestNewThread={handleRequestNewThread}
        onImported={handleImported}
        onError={setActionError}
      />

      <SidebarInset>
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <div className="flex items-center gap-2 text-sm">
            <Logo size={20} />
            <span className="font-medium text-foreground">Chat</span>
          </div>
          {urlThreadId !== null ? (
            <AttachRepoMenu
              threadId={urlThreadId}
              availableRepositories={repositories ?? []}
              onMovedToWorkspace={handleThreadMovedToWorkspace}
            />
          ) : null}
        </div>

        {actionError ? (
          <div className="border-b border-border px-6 py-3">
            <AppNotice title="Action failed" message={actionError} tone="error" />
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1">
          <ChatContainer
            selectedThreadId={urlThreadId}
            workspaceId={null}
            isShellLoading={isChatShellLoading}
            chatInput={chatInput}
            setChatInput={setChatInput}
            chatMode={chatMode}
            groundLibrary={false}
            groundSandbox={false}
            setGroundLibrary={() => {}}
            setGroundSandbox={() => {}}
            grounding={undefined}
            isSending={isSending}
            onSendMessage={handleSendMessage}
            sandboxModeStatus={null}
            isSyncing={false}
            onSync={() => {}}
            showArtifactToggle={false}
            hasAttachedRepository={false}
            availableRepositories={repositories ?? []}
            onImported={handleImported}
            onThreadMovedToWorkspace={handleThreadMovedToWorkspace}
          />
        </div>
      </SidebarInset>

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
    </>
  );
}
