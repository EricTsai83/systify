import { useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { ArtifactId, ChatMode, LlmProvider, ReasoningEffort, RepositoryId, ThreadId } from "@/lib/types";

/**
 * Owns the in-flight reply lifecycle (send, cancel) plus thread archive.
 * Selection-aware but selection-state-agnostic: callers pass the current
 * thread / repository and the thread queued for archive, and the hook hands
 * back navigation hooks via `onAfterCreateThread` / `onAfterArchiveThread` so
 * the parent can update the URL once a mutation succeeds.
 *
 * Send path branches on whether a thread already exists:
 *   - has-thread: forwards to `chat.sendMessage` with the current thread id;
 *   - no-thread:  forwards to `chat.sendMessageStartingNewThread` so the
 *                 backend atomically creates the thread and dispatches the
 *                 first reply.
 */
export function useChatLifecycle({
  selectedThreadId,
  repositoryId,
  threadToArchive,
  chatInput,
  chatMode,
  groundLibrary,
  groundSandbox,
  selectedProvider,
  selectedModelName,
  selectedReasoningEffort,
  newThreadTitle,
  newThreadArtifactContext,
  newThreadSingleTurnEnabled,
  newThreadAgentRole,
  newThreadAgentInstructions,
  clearChatInput,
  setActionError,
  setThreadToArchive,
  onAfterCreateThread,
  onAfterArchiveThread,
}: {
  selectedThreadId: ThreadId | null;
  repositoryId: RepositoryId | null;
  threadToArchive: ThreadId | null;
  chatInput: string;
  chatMode: ChatMode;
  /**
   * Discuss-only per-message grounding flags. Forwarded into the send
   * mutation only when `chatMode === "discuss"` — Library Mode ignores
   * them (its grounding is implicit in the mode).
   */
  groundLibrary?: boolean;
  groundSandbox?: boolean;
  /**
   * Composer-picked `(provider, modelName)`. Both must be supplied
   * together to take effect; a half-set pair is dropped here so the
   * send mutation never has to reject one (the mutation rejects
   * half-pairs as well — this is defensive symmetry on the client).
   *
   * `null` means "no explicit pick" — the backend resolver falls
   * through to `threads.defaultModelName` or the capability default.
   */
  selectedProvider?: LlmProvider | null;
  selectedModelName?: string | null;
  /**
   * Composer-picked reasoning-effort override for this send. `null`
   * means "no explicit pick" — the backend resolver falls back to
   * the catalog entry's default effort. Forwarded to the send
   * mutation only when set; the picker hides itself on non-reasoning
   * models so a stale value from a prior pick cannot leak through.
   */
  selectedReasoningEffort?: ReasoningEffort | null;
  /**
   * Optional metadata for the lazy first-send path. Existing-thread sends
   * never forward these fields; Library Ask uses them to give the newly
   * created tab a stable title and optional artifact scope.
   */
  newThreadTitle?: string;
  newThreadArtifactContext?: ArtifactId[];
  newThreadSingleTurnEnabled?: boolean;
  newThreadAgentRole?: string;
  newThreadAgentInstructions?: string;
  clearChatInput: () => void;
  setActionError: (value: string | null) => void;
  setThreadToArchive: (value: ThreadId | null) => void;
  onAfterCreateThread: (threadId: ThreadId, mode: ChatMode) => void;
  onAfterArchiveThread: (archivedThreadId: ThreadId) => void;
}) {
  const sendMessageMutation = useMutation(api.chat.send.sendMessage);
  const sendMessageStartingNewThreadMutation = useMutation(api.chat.send.sendMessageStartingNewThread);
  const cancelInFlightReplyMutation = useMutation(api.chat.cancel.cancelInFlightReply);
  const archiveThreadMutation = useMutation(api.chat.threads.archiveThread);
  const sendLockRef = useRef(false);

  const [isSending, handleSendMessage] = useAsyncCallback(
    useCallback(
      async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (sendLockRef.current) return;
        const trimmed = chatInput.trim();
        if (!trimmed) return;
        sendLockRef.current = true;
        setActionError(null);
        const groundingArgs =
          chatMode === "discuss"
            ? {
                groundLibrary: groundLibrary === true,
                groundSandbox: groundSandbox === true,
              }
            : {};
        // Forward the picker pick to the send mutation only when BOTH
        // halves are present. The mutation rejects half-pairs with
        // `incomplete_model_pick`; we drop them here so an unmounted
        // picker (e.g. on the repoless shell before catalog query
        // resolves) doesn't fire a doomed send.
        const modelArgs =
          selectedProvider && selectedModelName
            ? {
                provider: selectedProvider,
                modelName: selectedModelName,
              }
            : {};
        const reasoningArgs =
          selectedReasoningEffort !== null && selectedReasoningEffort !== undefined
            ? { reasoningEffort: selectedReasoningEffort }
            : {};
        try {
          if (selectedThreadId) {
            const result = await sendMessageMutation({
              threadId: selectedThreadId,
              content: chatInput,
              mode: chatMode,
              ...groundingArgs,
              ...modelArgs,
              ...reasoningArgs,
            });
            if ("status" in result && result.status === "singleTurnResetPending") {
              setActionError(result.message);
              return;
            }
            clearChatInput();
            return;
          }
          const titleArgs = newThreadTitle !== undefined ? { title: newThreadTitle } : {};
          const artifactContextArgs =
            chatMode === "library" && newThreadArtifactContext && newThreadArtifactContext.length > 0
              ? { artifactContext: newThreadArtifactContext }
              : {};
          const agentProfileArgs =
            repositoryId === null
              ? {
                  ...(newThreadSingleTurnEnabled !== undefined
                    ? { singleTurnEnabled: newThreadSingleTurnEnabled }
                    : {}),
                  ...(newThreadAgentRole !== undefined ? { agentRole: newThreadAgentRole } : {}),
                  ...(newThreadAgentInstructions !== undefined
                    ? { agentInstructions: newThreadAgentInstructions }
                    : {}),
                }
              : {};
          // Lazy first send. Repoless threads (no `repositoryId`) are
          // legal — the backend creates the thread with `repositoryId:
          // undefined` and the repoless shell navigates to the matching
          // `/chat/:threadId` URL inside `onAfterCreateThread`.
          const result = await sendMessageStartingNewThreadMutation({
            ...(repositoryId ? { repositoryId } : {}),
            content: chatInput,
            mode: chatMode,
            ...titleArgs,
            ...artifactContextArgs,
            ...agentProfileArgs,
            ...groundingArgs,
            ...modelArgs,
            ...reasoningArgs,
          });
          clearChatInput();
          onAfterCreateThread(result.threadId, result.mode);
        } catch (error) {
          setActionError(toUserErrorMessage(error, "Failed to send the message."));
        } finally {
          sendLockRef.current = false;
        }
      },
      [
        chatInput,
        chatMode,
        groundLibrary,
        groundSandbox,
        selectedProvider,
        selectedModelName,
        selectedReasoningEffort,
        newThreadTitle,
        newThreadArtifactContext,
        newThreadSingleTurnEnabled,
        newThreadAgentRole,
        newThreadAgentInstructions,
        clearChatInput,
        onAfterCreateThread,
        selectedThreadId,
        sendMessageMutation,
        sendMessageStartingNewThreadMutation,
        setActionError,
        repositoryId,
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

  const [isArchivingThread, handleArchiveThread] = useAsyncCallback(
    useCallback(async () => {
      if (!threadToArchive) return;
      setActionError(null);
      try {
        await archiveThreadMutation({ threadId: threadToArchive });
        const archivedId = threadToArchive;
        setThreadToArchive(null);
        if (selectedThreadId === archivedId) {
          onAfterArchiveThread(archivedId);
        }
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to archive the thread."));
      }
    }, [
      archiveThreadMutation,
      onAfterArchiveThread,
      selectedThreadId,
      setActionError,
      setThreadToArchive,
      threadToArchive,
    ]),
  );

  return {
    isSending,
    handleSendMessage,
    isCancellingReply,
    handleCancelInFlightReply,
    isArchivingThread,
    handleArchiveThread,
  };
}
