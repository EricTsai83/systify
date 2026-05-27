import { useEffect } from "react";
import type { ThreadId } from "@/lib/types";

/**
 * Bounce the user away from a thread URL when the underlying thread has
 * disappeared (deleted on another device, ownership transferred, etc).
 *
 * `onMissingThread` is fired once per (thread id, missing-flag) transition
 * — callers shape the bounce destination (repository landing for the
 * repo shell, `/chat` for the repoless shell) inside the callback so
 * this hook can stay destination-agnostic.
 *
 * Pre-conditions:
 *   - `urlThreadId === null` short-circuits: no thread to recover from.
 *   - `isMissingThread === false` short-circuits: thread is still there.
 *
 * Memoise `onMissingThread` (e.g. via `useCallback`) so the effect re-runs
 * only on genuine state changes rather than every render.
 */
export function useThreadDeletionRecovery({
  urlThreadId,
  isMissingThread,
  onMissingThread,
}: {
  urlThreadId: ThreadId | null;
  isMissingThread: boolean;
  onMissingThread: () => void;
}): void {
  useEffect(() => {
    if (urlThreadId === null) return;
    if (!isMissingThread) return;
    onMissingThread();
  }, [urlThreadId, isMissingThread, onMissingThread]);
}
