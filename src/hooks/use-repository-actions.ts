import { useCallback } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { ARCHIVE_PATH } from "@/route-paths";
import type { ChatMode, RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Aggregates all repo / thread mutations the workspace can fire and exposes
 * pending flags for the dialogs that wrap them. The hook is selection-aware
 * but selection-state-agnostic: callers tell us which thread / repo is
 * currently in view, and we hand back navigation hooks via
 * `onAfterDeleteThread` / `onAfterArchiveRepo` etc. so the parent can update
 * the URL once a destructive mutation succeeds.
 *
 * Send path branches on whether a thread already exists:
 *   - has-thread: forwards to `chat.sendMessage` with the current thread id;
 *   - no-thread:  forwards to `chat.sendMessageStartingNewThread` so the
 *                 backend atomically creates the thread and dispatches the
 *                 first reply. The shell hands back `onAfterCreateThread`
 *                 to replace the URL with the canonical mode-aware path.
 */
export function useRepositoryActions({
  selectedRepositoryId,
  selectedThreadId,
  workspaceId,
  threadToDelete,
  chatInput,
  chatMode,
  clearChatInput,
  setActionError,
  onAfterDeleteThread,
  onAfterArchiveRepo,
  onAfterRestoreRepo,
  onAfterPermanentDeleteRepo,
  onAfterCreateThread,
  setThreadToDelete,
  setShowArchiveDialog,
  setShowPermanentDeleteDialog,
}: {
  selectedRepositoryId: RepositoryId | null;
  selectedThreadId: ThreadId | null;
  workspaceId: WorkspaceId | null;
  threadToDelete: ThreadId | null;
  chatInput: string;
  chatMode: ChatMode;
  clearChatInput: () => void;
  setActionError: (value: string | null) => void;
  onAfterDeleteThread: (deletedThreadId: ThreadId) => void;
  onAfterArchiveRepo: () => void;
  onAfterRestoreRepo: () => void;
  onAfterPermanentDeleteRepo: () => void;
  onAfterCreateThread: (threadId: ThreadId, mode: ChatMode) => void;
  setThreadToDelete: (value: ThreadId | null) => void;
  setShowArchiveDialog: (value: boolean) => void;
  setShowPermanentDeleteDialog: (value: boolean) => void;
}) {
  const navigate = useNavigate();
  const sendMessageMutation = useMutation(api.chat.send.sendMessage);
  const sendMessageStartingNewThreadMutation = useMutation(api.chat.send.sendMessageStartingNewThread);
  const cancelInFlightReplyMutation = useMutation(api.chat.cancel.cancelInFlightReply);
  const syncRepositoryMutation = useMutation(api.repositories.syncRepository);
  const deleteThreadMutation = useMutation(api.chat.threads.deleteThread);
  const archiveRepositoryMutation = useMutation(api.repositories.archiveRepository);
  const restoreRepositoryMutation = useMutation(api.repositories.restoreRepository);
  const deleteRepositoryMutation = useMutation(api.repositories.deleteRepository);

  const [isSending, handleSendMessage] = useAsyncCallback(
    useCallback(
      async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmed = chatInput.trim();
        if (!trimmed) return;
        setActionError(null);
        try {
          if (selectedThreadId) {
            await sendMessageMutation({
              threadId: selectedThreadId,
              content: chatInput,
              mode: chatMode,
            });
            clearChatInput();
            return;
          }
          if (!workspaceId) return;
          const result = await sendMessageStartingNewThreadMutation({
            workspaceId,
            content: chatInput,
            mode: chatMode,
          });
          clearChatInput();
          onAfterCreateThread(result.threadId, result.mode);
        } catch (error) {
          setActionError(toUserErrorMessage(error, "Failed to send the message."));
        }
      },
      [
        chatInput,
        chatMode,
        clearChatInput,
        onAfterCreateThread,
        selectedThreadId,
        sendMessageMutation,
        sendMessageStartingNewThreadMutation,
        setActionError,
        workspaceId,
      ],
    ),
  );

  const [isCancellingReply, handleCancelInFlightReply] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedThreadId) return;
      setActionError(null);
      try {
        await cancelInFlightReplyMutation({ threadId: selectedThreadId });
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to stop the reply."));
      }
    }, [cancelInFlightReplyMutation, selectedThreadId, setActionError]),
  );

  const [isSyncing, handleSync] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      setActionError(null);
      try {
        await syncRepositoryMutation({ repositoryId: selectedRepositoryId });
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to sync the repository."));
      }
    }, [selectedRepositoryId, setActionError, syncRepositoryMutation]),
  );

  const [isDeletingThread, handleDeleteThread] = useAsyncCallback(
    useCallback(async () => {
      if (!threadToDelete) return;
      setActionError(null);
      try {
        await deleteThreadMutation({ threadId: threadToDelete });
        const deletedId = threadToDelete;
        setThreadToDelete(null);
        if (selectedThreadId === deletedId) {
          onAfterDeleteThread(deletedId);
        }
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to delete the thread."));
      }
    }, [
      deleteThreadMutation,
      onAfterDeleteThread,
      selectedThreadId,
      setActionError,
      setThreadToDelete,
      threadToDelete,
    ]),
  );

  const [isArchivingRepo, handleArchiveRepo] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      setActionError(null);
      try {
        await archiveRepositoryMutation({ repositoryId: selectedRepositoryId });
        setShowArchiveDialog(false);
        toast.success("Repository archived", {
          description: "Restore it any time from your archive.",
          action: {
            label: "View archive",
            onClick: () => void navigate(ARCHIVE_PATH),
          },
        });
        onAfterArchiveRepo();
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to archive the repository."));
      }
    }, [
      archiveRepositoryMutation,
      navigate,
      onAfterArchiveRepo,
      selectedRepositoryId,
      setActionError,
      setShowArchiveDialog,
    ]),
  );

  const [isRestoringRepo, handleRestoreRepo] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      setActionError(null);
      try {
        await restoreRepositoryMutation({ repositoryId: selectedRepositoryId });
        toast.success("Repository restored");
        onAfterRestoreRepo();
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to restore the repository."));
      }
    }, [onAfterRestoreRepo, restoreRepositoryMutation, selectedRepositoryId, setActionError]),
  );

  const [isPermanentDeletingRepo, handlePermanentDeleteRepo] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      setActionError(null);
      try {
        await deleteRepositoryMutation({ repositoryId: selectedRepositoryId });
        // Orphan localStorage entries for this repo's folder-nav state are
        // reaped reactively by `useStorageGC` once the `listRepositories`
        // subscription drops the deleted id — no manual cleanup here.
        setShowPermanentDeleteDialog(false);
        toast.success("Repository deleted permanently");
        onAfterPermanentDeleteRepo();
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to delete the repository."));
      }
    }, [
      deleteRepositoryMutation,
      onAfterPermanentDeleteRepo,
      selectedRepositoryId,
      setActionError,
      setShowPermanentDeleteDialog,
    ]),
  );

  return {
    isSending,
    handleSendMessage,
    isCancellingReply,
    handleCancelInFlightReply,
    isSyncing,
    handleSync,
    isDeletingThread,
    handleDeleteThread,
    isArchivingRepo,
    handleArchiveRepo,
    isRestoringRepo,
    handleRestoreRepo,
    isPermanentDeletingRepo,
    handlePermanentDeleteRepo,
  };
}
