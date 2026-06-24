import { useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { ChatSendRequest } from "@/lib/chat-composer-session";
import type { ChatMode, ThreadId } from "@/lib/types";

/**
 * Executes already-shaped chat send requests and owns cancellation for the
 * selected thread. Composer-specific payload decisions stay outside this
 * hook; callers provide `buildSendRequest`, and this hook only chooses the
 * matching Convex mutation for the returned discriminant.
 */
export function useChatLifecycle({
  selectedThreadId,
  buildSendRequest,
  clearChatInput,
  setActionError,
  onAfterCreateThread,
}: {
  selectedThreadId: ThreadId | null;
  buildSendRequest: (content: string) => ChatSendRequest | null;
  clearChatInput: () => void;
  setActionError: (value: string | null) => void;
  onAfterCreateThread: (threadId: ThreadId, mode: ChatMode) => void;
}) {
  const sendMessageMutation = useMutation(api.chat.send.sendMessage);
  const sendMessageStartingNewThreadMutation = useMutation(api.chat.send.sendMessageStartingNewThread);
  const cancelInFlightReplyMutation = useMutation(api.chat.cancel.cancelInFlightReply);
  const sendLockRef = useRef(false);

  const [isSending, handleSendMessage] = useAsyncCallback(
    useCallback(
      async (event: React.FormEvent<HTMLFormElement>, contentOverride?: string) => {
        event.preventDefault();
        if (sendLockRef.current) return;
        const content = contentOverride ?? readMessageContent(event);
        if (!content.trim()) return;
        const request = buildSendRequest(content);
        if (request === null) return;
        sendLockRef.current = true;
        setActionError(null);
        try {
          if (request.kind === "existingThread") {
            const result = await sendMessageMutation(request.args);
            if ("status" in result && result.status === "singleTurnResetPending") {
              setActionError(result.message);
              return;
            }
            clearChatInput();
            return;
          }
          const result = await sendMessageStartingNewThreadMutation(request.args);
          clearChatInput();
          onAfterCreateThread(result.threadId, result.mode);
        } catch (error) {
          setActionError(toUserErrorMessage(error, "Failed to send the message."));
        } finally {
          sendLockRef.current = false;
        }
      },
      [
        buildSendRequest,
        clearChatInput,
        onAfterCreateThread,
        sendMessageMutation,
        sendMessageStartingNewThreadMutation,
        setActionError,
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

  return {
    isSending,
    handleSendMessage,
    isCancellingReply,
    handleCancelInFlightReply,
  };
}

function readMessageContent(event: React.FormEvent<HTMLFormElement>): string {
  const form = event.currentTarget;
  if (form instanceof HTMLFormElement) {
    const value = new FormData(form).get("message");
    return typeof value === "string" ? value : "";
  }
  return "";
}
