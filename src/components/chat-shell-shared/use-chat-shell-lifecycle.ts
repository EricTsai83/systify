import { useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useChatLifecycle } from "@/hooks/use-chat-lifecycle";
import { useComposerDraft } from "@/hooks/use-composer-draft";
import { useStorageGC } from "@/hooks/use-storage-gc";
import type { ChatMode, LlmProvider, ReasoningEffort, RepositoryId, ThreadId } from "@/lib/types";

/**
 * Bundles the chat-shell primitives both shells need so the RepositoryShell
 * and the RepolessChatShell don't duplicate the same wiring:
 *
 *   - `useStorageGC` — sweep orphan per-repository / per-thread
 *     localStorage keys.
 *   - `useComposerDraft` — `localStorage`-backed composer text persisted
 *     per (repository, thread, mode).
 *   - `useChatLifecycle` — send / cancel / archive mutations.
 */
export function useChatShellLifecycle({
  urlThreadId,
  repositoryId,
  chatMode,
  groundLibrary,
  groundSandbox,
  selectedProvider,
  selectedModelName,
  selectedReasoningEffort,
  newThreadSingleTurnEnabled,
  newThreadAgentRole,
  newThreadAgentInstructions,
  threadToArchive,
  setActionError,
  setThreadToArchive,
  onAfterCreateThread,
  onAfterArchiveThread,
}: {
  urlThreadId: ThreadId | null;
  repositoryId: RepositoryId | null;
  chatMode: ChatMode;
  groundLibrary?: boolean;
  groundSandbox?: boolean;
  /**
   * Composer-picked `(provider, modelName)` forwarded into the send
   * mutations. Both `null` means "no explicit pick" — the resolver
   * falls through to the thread default or capability default.
   */
  selectedProvider?: LlmProvider | null;
  selectedModelName?: string | null;
  /**
   * Composer-picked reasoning-effort override for this send. `null`
   * means "no explicit pick" — the resolver falls back to the catalog
   * entry's default.
   */
  selectedReasoningEffort?: ReasoningEffort | null;
  newThreadSingleTurnEnabled?: boolean;
  newThreadAgentRole?: string;
  newThreadAgentInstructions?: string;
  threadToArchive: ThreadId | null;
  setActionError: (value: string | null) => void;
  setThreadToArchive: (value: ThreadId | null) => void;
  onAfterCreateThread: (threadId: ThreadId, mode: ChatMode) => void;
  onAfterArchiveThread: (archivedThreadId: ThreadId) => void;
}): {
  chatInput: string;
  setChatInput: (next: string) => void;
  clearChatInput: () => void;
  isSending: boolean;
  handleSendMessage: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  isCancellingReply: boolean;
  handleCancelInFlightReply: () => Promise<void>;
  isArchivingThread: boolean;
  handleArchiveThread: () => Promise<void>;
} {
  useStorageGC();
  const { user, isLoading: isAuthLoading } = useAuth();
  const [lastSettledAuthId, setLastSettledAuthId] = useState<string | null>(user?.id ?? null);
  useEffect(() => {
    if (!isAuthLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLastSettledAuthId(user?.id ?? null);
    }
  }, [isAuthLoading, user?.id]);
  const [chatInput, setChatInput, clearChatInput] = useComposerDraft({
    authUserId: isAuthLoading ? lastSettledAuthId : (user?.id ?? null),
    repositoryId,
    threadId: urlThreadId,
    mode: chatMode,
  });
  const lifecycle = useChatLifecycle({
    selectedThreadId: urlThreadId,
    repositoryId,
    threadToArchive,
    chatInput,
    chatMode,
    groundLibrary,
    groundSandbox,
    selectedProvider,
    selectedModelName,
    selectedReasoningEffort,
    newThreadSingleTurnEnabled,
    newThreadAgentRole,
    newThreadAgentInstructions,
    clearChatInput,
    setActionError,
    setThreadToArchive,
    onAfterCreateThread,
    onAfterArchiveThread,
  });

  return {
    chatInput,
    setChatInput,
    clearChatInput,
    isSending: lifecycle.isSending,
    handleSendMessage: lifecycle.handleSendMessage,
    isCancellingReply: lifecycle.isCancellingReply,
    handleCancelInFlightReply: lifecycle.handleCancelInFlightReply,
    isArchivingThread: lifecycle.isArchivingThread,
    handleArchiveThread: lifecycle.handleArchiveThread,
  };
}
