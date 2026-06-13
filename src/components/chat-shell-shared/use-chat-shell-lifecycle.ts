import { useCallback, useLayoutEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { ThreadId } from "@/lib/types";

/**
 * Compatibility adapter for thread archive mutations shared by the
 * repository and repoless shells. Composer draft/send/cancel state now
 * lives in `useChatComposerSession`.
 */
export function useChatShellLifecycle({
  selectedThreadId,
  threadToArchive,
  setActionError,
  setThreadToArchive,
  onAfterArchiveThread,
}: {
  selectedThreadId: ThreadId | null;
  threadToArchive: ThreadId | null;
  setActionError: (value: string | null) => void;
  setThreadToArchive: (value: ThreadId | null) => void;
  onAfterArchiveThread: (archivedThreadId: ThreadId) => void;
}): {
  isArchivingThread: boolean;
  handleArchiveThread: () => Promise<void>;
} {
  const archiveThreadMutation = useMutation(api.chat.threads.archiveThread);
  const selectedThreadIdRef = useRef(selectedThreadId);
  useLayoutEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const [isArchivingThread, handleArchiveThread] = useAsyncCallback(
    useCallback(async () => {
      if (!threadToArchive) return;
      const archivedId = threadToArchive;
      setActionError(null);
      try {
        await archiveThreadMutation({ threadId: archivedId });
        setThreadToArchive(null);
        if (selectedThreadIdRef.current === archivedId) {
          onAfterArchiveThread(archivedId);
        }
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to archive the thread."));
      }
    }, [archiveThreadMutation, onAfterArchiveThread, setActionError, setThreadToArchive, threadToArchive]),
  );

  return {
    isArchivingThread,
    handleArchiveThread,
  };
}
