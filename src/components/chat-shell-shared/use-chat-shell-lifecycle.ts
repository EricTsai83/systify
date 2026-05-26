import { useChatLifecycle } from "@/hooks/use-chat-lifecycle";
import { useComposerDraft } from "@/hooks/use-composer-draft";
import { useStorageGC } from "@/hooks/use-storage-gc";
import type { ChatMode, ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Bundles the chat-shell primitives both shells need so the RepositoryShell
 * and the WorkspacelessChatShell don't duplicate the same wiring:
 *
 *   - `useStorageGC` — sweep orphan per-workspace / per-repository /
 *     per-thread localStorage keys. The caller provides the live id sets so
 *     the GC sweep observes the same data the rest of the shell sees.
 *   - `useComposerDraft` — `localStorage`-backed composer text persisted
 *     per (workspace, thread, mode). The workspaceless shell passes
 *     `workspaceId: null` so the draft keys honour the dedicated
 *     workspaceless bucket in `use-composer-draft.ts`.
 *   - `useChatLifecycle` — send / cancel / delete mutations with the
 *     navigation callbacks the shell wires to its URL scheme.
 *
 * `useThreadCapabilities` is intentionally NOT bundled here — the shell
 * needs `capabilities` early enough that putting it inside this bundle
 * forces an awkward reorder of the shell's render flow. Each shell calls
 * `useThreadCapabilities(urlThreadId)` directly alongside this bundle.
 */
export function useChatShellLifecycle({
  urlThreadId,
  workspaceId,
  chatMode,
  groundLibrary,
  groundSandbox,
  liveWorkspaceIds,
  liveRepositoryIds,
  liveThreadIds,
  threadToDelete,
  setActionError,
  setThreadToDelete,
  onAfterCreateThread,
  onAfterDeleteThread,
}: {
  urlThreadId: ThreadId | null;
  workspaceId: WorkspaceId | null;
  chatMode: ChatMode;
  groundLibrary?: boolean;
  groundSandbox?: boolean;
  liveWorkspaceIds: ReadonlySet<string> | null;
  liveRepositoryIds: ReadonlySet<string> | null;
  liveThreadIds: ReadonlySet<string> | null;
  threadToDelete: ThreadId | null;
  setActionError: (value: string | null) => void;
  setThreadToDelete: (value: ThreadId | null) => void;
  onAfterCreateThread: (threadId: ThreadId, mode: ChatMode) => void;
  onAfterDeleteThread: (deletedThreadId: ThreadId) => void;
}): {
  chatInput: string;
  setChatInput: (next: string) => void;
  clearChatInput: () => void;
  isSending: boolean;
  handleSendMessage: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  isCancellingReply: boolean;
  handleCancelInFlightReply: () => Promise<void>;
  isDeletingThread: boolean;
  handleDeleteThread: () => Promise<void>;
} {
  useStorageGC({ liveWorkspaceIds, liveRepositoryIds, liveThreadIds });
  const [chatInput, setChatInput, clearChatInput] = useComposerDraft({
    workspaceId,
    threadId: urlThreadId,
    mode: chatMode,
  });
  const lifecycle = useChatLifecycle({
    selectedThreadId: urlThreadId,
    workspaceId,
    threadToDelete,
    chatInput,
    chatMode,
    groundLibrary,
    groundSandbox,
    clearChatInput,
    setActionError,
    setThreadToDelete,
    onAfterCreateThread,
    onAfterDeleteThread,
  });

  return {
    chatInput,
    setChatInput,
    clearChatInput,
    ...lifecycle,
  };
}
