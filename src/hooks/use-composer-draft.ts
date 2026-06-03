import { useCallback, useEffect, useMemo, useState } from "react";
import { readString, removeKey, writeString } from "@/lib/storage";
import type { ChatMode, RepositoryId, ThreadId } from "@/lib/types";

const USER_KEY_PREFIX = "systify.composer.draft.user.";
/**
 * Dedicated bucket for the repoless `/chat` landing (no repository, no
 * thread yet). Carries any text the user types before the lazy first send
 * materialises a thread — at which point the draft key flips to the
 * thread-scoped form below.
 */
const REPOLESS_KEY = "chat";

function userScopedPrefix(authUserId: string): string {
  return `${USER_KEY_PREFIX}${encodeURIComponent(authUserId)}.`;
}

function deriveKey(args: {
  authUserId: string | null;
  repositoryId: RepositoryId | null;
  threadId: ThreadId | null;
  mode: ChatMode | null;
}): string | null {
  if (args.authUserId === null) {
    return null;
  }
  const prefix = userScopedPrefix(args.authUserId);
  if (args.threadId !== null) {
    return `${prefix}thread.${args.threadId}`;
  }
  if (args.repositoryId === null) {
    return `${prefix}${REPOLESS_KEY}`;
  }
  if (args.mode === null) {
    return null;
  }
  if (args.mode !== "discuss") {
    return null;
  }
  return `${prefix}repository.${args.repositoryId}.${args.mode}`;
}

/**
 * Persist the chat composer's draft to `localStorage` so switching threads,
 * switching service modes, or hard-refreshing the page does not lose what
 * the user was typing.
 *
 * Two key shapes:
 *   - `systify.composer.draft.user.{userId}.thread.{threadId}` — once a
 *     thread exists, the draft is per-user and per-thread.
 *   - `systify.composer.draft.user.{userId}.repository.{repositoryId}.discuss`
 *     — before a thread exists, the draft is scoped to (user, repository,
 *     mode).
 */
export function useComposerDraft(args: {
  authUserId: string | null;
  repositoryId: RepositoryId | null;
  threadId: ThreadId | null;
  mode: ChatMode | null;
}): readonly [string, (next: string) => void, () => void] {
  const currentKey = useMemo(
    () =>
      deriveKey({
        authUserId: args.authUserId,
        repositoryId: args.repositoryId,
        threadId: args.threadId,
        mode: args.mode,
      }),
    [args.authUserId, args.repositoryId, args.threadId, args.mode],
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
