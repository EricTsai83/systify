import { useCallback, useEffect, useMemo, useState } from "react";
import { readString, removeKey, writeString } from "@/lib/storage";
import type { ChatMode, RepositoryId, ThreadId } from "@/lib/types";

const THREAD_KEY_PREFIX = "systify.composer.draft.thread.";
const REPOSITORY_KEY_PREFIX = "systify.composer.draft.repository.";
/**
 * Dedicated bucket for the repoless `/chat` landing (no repository, no
 * thread yet). Carries any text the user types before the lazy first send
 * materialises a thread — at which point the draft key flips to the
 * thread-scoped form below.
 */
const REPOLESS_KEY = "systify.composer.draft.chat";

function deriveKey(args: {
  repositoryId: RepositoryId | null;
  threadId: ThreadId | null;
  mode: ChatMode | null;
}): string | null {
  if (args.threadId !== null) {
    return `${THREAD_KEY_PREFIX}${args.threadId}`;
  }
  if (args.repositoryId === null) {
    return REPOLESS_KEY;
  }
  if (args.mode === null) {
    return null;
  }
  if (args.mode !== "discuss") {
    return null;
  }
  return `${REPOSITORY_KEY_PREFIX}${args.repositoryId}.${args.mode}`;
}

/**
 * Persist the chat composer's draft to `localStorage` so switching threads,
 * switching service modes, or hard-refreshing the page does not lose what
 * the user was typing.
 *
 * Two key shapes:
 *   - `systify.composer.draft.thread.{threadId}` — once a thread exists,
 *     the draft is per-thread.
 *   - `systify.composer.draft.repository.{repositoryId}.discuss` — before
 *     a thread exists, the draft is scoped to (repository, mode).
 */
export function useComposerDraft(args: {
  repositoryId: RepositoryId | null;
  threadId: ThreadId | null;
  mode: ChatMode | null;
}): readonly [string, (next: string) => void, () => void] {
  const currentKey = useMemo(
    () => deriveKey({ repositoryId: args.repositoryId, threadId: args.threadId, mode: args.mode }),
    [args.repositoryId, args.threadId, args.mode],
  );

  const [value, setValue] = useState<string>(() => {
    if (currentKey === null) return "";
    return readString(currentKey) ?? "";
  });

  useEffect(() => {
    const stored = currentKey === null ? "" : (readString(currentKey) ?? "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(stored);
  }, [currentKey]);

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
