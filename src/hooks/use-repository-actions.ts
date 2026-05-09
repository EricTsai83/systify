import { useCallback } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { ARCHIVE_PATH } from "@/route-paths";
import type { ChatMode, RepositoryId, ThreadId } from "@/lib/types";

/**
 * Aggregates all repo / thread mutations the workspace can fire and exposes
 * pending flags for the dialogs that wrap them. The hook is selection-aware
 * but selection-state-agnostic: callers tell us which thread / repo is
 * currently in view, and we hand back navigation hooks via
 * `onAfterDeleteThread` / `onAfterArchiveRepo` etc. so the parent can update
 * the URL once a destructive mutation succeeds.
 */
export function useRepositoryActions({
  selectedRepositoryId,
  selectedThreadId,
  threadToDelete,
  analysisPrompt,
  chatInput,
  chatMode,
  setChatInput,
  setActionError,
  setAnalysisError,
  setActionNotice,
  onAfterDeleteThread,
  onAfterArchiveRepo,
  onAfterRestoreRepo,
  onAfterPermanentDeleteRepo,
  setThreadToDelete,
  setShowArchiveDialog,
  setShowPermanentDeleteDialog,
  setShowAnalysisDialog,
}: {
  selectedRepositoryId: RepositoryId | null;
  selectedThreadId: ThreadId | null;
  threadToDelete: ThreadId | null;
  analysisPrompt: string;
  chatInput: string;
  chatMode: ChatMode;
  setChatInput: (value: string) => void;
  setActionError: (value: string | null) => void;
  setAnalysisError: (value: string | null) => void;
  setActionNotice?: (value: { title: string; message: string } | null) => void;
  onAfterDeleteThread: (deletedThreadId: ThreadId) => void;
  onAfterArchiveRepo: () => void;
  onAfterRestoreRepo: () => void;
  onAfterPermanentDeleteRepo: () => void;
  setThreadToDelete: (value: ThreadId | null) => void;
  setShowArchiveDialog: (value: boolean) => void;
  setShowPermanentDeleteDialog: (value: boolean) => void;
  setShowAnalysisDialog: (value: boolean) => void;
}) {
  const navigate = useNavigate();
  const requestDeepAnalysis = useMutation(api.analysis.requestDeepAnalysis);
  const sendMessageMutation = useMutation(api.chat.send.sendMessage);
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
        if (!selectedThreadId || !chatInput.trim()) return;
        setActionError(null);
        try {
          await sendMessageMutation({
            threadId: selectedThreadId,
            content: chatInput,
            mode: chatMode,
          });
          setChatInput("");
        } catch (error) {
          setActionError(toUserErrorMessage(error, "Failed to send the message."));
        }
      },
      [chatInput, chatMode, selectedThreadId, sendMessageMutation, setActionError, setChatInput],
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

  const [isRunningAnalysis, handleRunAnalysis] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      setActionError(null);
      setAnalysisError(null);
      try {
        await requestDeepAnalysis({ repositoryId: selectedRepositoryId, prompt: analysisPrompt });
        setShowAnalysisDialog(false);
        setActionNotice?.({
          title: "Deep analysis queued",
          message: "Track progress in the Activity timeline above.",
        });
      } catch (error) {
        const message = toUserErrorMessage(error, "Failed to start deep analysis.");
        setActionError(message);
        setAnalysisError(message);
      }
    }, [
      analysisPrompt,
      requestDeepAnalysis,
      selectedRepositoryId,
      setActionError,
      setActionNotice,
      setAnalysisError,
      setShowAnalysisDialog,
    ]),
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
    isRunningAnalysis,
    handleRunAnalysis,
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
