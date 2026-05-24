import { useCallback, useEffect, useMemo, useState } from "react";
import { readString, removeKey, writeString } from "@/lib/storage";
import type { ChatMode, ThreadId, WorkspaceId } from "@/lib/types";

/**
 * URL service mode the composer is rendered for when no thread exists yet.
 * `library` opens a different panel (LibraryAskPanel) that does not use
 * this hook, so the no-thread-key derivation only covers the two service
 * modes the main composer is ever mounted under.
 */
type ComposerChatMode = Extract<ChatMode, "discuss" | "lab">;

const THREAD_KEY_PREFIX = "systify.composer.draft.thread.";
const WORKSPACE_KEY_PREFIX = "systify.composer.draft.workspace.";

function deriveKey(args: {
  workspaceId: WorkspaceId | null;
  threadId: ThreadId | null;
  mode: ChatMode | null;
}): string | null {
  if (args.threadId !== null) {
    return `${THREAD_KEY_PREFIX}${args.threadId}`;
  }
  if (args.workspaceId === null || args.mode === null) {
    return null;
  }
  if (args.mode !== "discuss" && args.mode !== "lab") {
    return null;
  }
  const mode: ComposerChatMode = args.mode;
  return `${WORKSPACE_KEY_PREFIX}${args.workspaceId}.${mode}`;
}

/**
 * Persist the chat composer's draft to `localStorage` so switching threads,
 * switching service modes, or hard-refreshing the page does not lose what the
 * user was typing.
 *
 * Two key shapes:
 *   - `systify.composer.draft.thread.{threadId}` — once a thread exists, the
 *     draft is per-thread (mode-agnostic; the chat-mode dropdown at send time
 *     determines the message mode).
 *   - `systify.composer.draft.workspace.{workspaceId}.{mode}` — before
 *     a thread exists, the draft is scoped to (workspace, mode) so
 *     `/w/:wid/discuss` and `/w/:wid/lab` keep independent drafts.
 *
 * Writes are synchronous (no debounce):
 *   - `localStorage.setItem` on a few-KB value is microsecond-cost; even at
 *     typing speed (~5 keystrokes/sec) the per-frame cost is negligible.
 *   - A debounce window would race against (a) thread/mode switches that
 *     change the key mid-flight and (b) tab closes that don't fire
 *     `beforeunload` in time to flush. Sync writes avoid both.
 *
 * Empty strings are removed (not stored as `""`) so the GC sweep does not
 * have to distinguish "user cleared the draft" from "key is dormant".
 *
 * No cross-tab sync: composer drafts are inherently per-tab work-in-progress;
 * live-echoing keystrokes between tabs would be confusing, not helpful.
 */
export function useComposerDraft(args: {
  workspaceId: WorkspaceId | null;
  threadId: ThreadId | null;
  mode: ChatMode | null;
}): readonly [string, (next: string) => void, () => void] {
  const currentKey = useMemo(
    () => deriveKey({ workspaceId: args.workspaceId, threadId: args.threadId, mode: args.mode }),
    [args.workspaceId, args.threadId, args.mode],
  );

  const [value, setValue] = useState<string>(() => {
    if (currentKey === null) return "";
    return readString(currentKey) ?? "";
  });

  // Re-read when the key swaps (thread change, service-mode change, workspace
  // change). React's `useState` initializer only fires on mount, so the swap
  // must be reflected via a setState in this effect. The dependent
  // `currentKey` derivation guarantees this fires at most once per swap.
  useEffect(() => {
    const stored = currentKey === null ? "" : (readString(currentKey) ?? "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(stored);
  }, [currentKey]);

  // Mirror writes synchronously. Empty value clears the key so GC need not
  // treat zombie empty drafts as anomalies.
  useEffect(() => {
    if (currentKey === null) return;
    if (value === "") {
      removeKey(currentKey);
    } else {
      writeString(currentKey, value);
    }
  }, [currentKey, value]);

  const clear = useCallback(() => {
    setValue("");
  }, []);

  return [value, setValue, clear] as const;
}
