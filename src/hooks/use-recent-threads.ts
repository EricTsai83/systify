import { useState } from "react";
import type { ThreadId } from "@/lib/types";

const DEFAULT_LIMIT = 5;

/**
 * Track the most recently viewed thread ids in MRU (most-recently-used) order.
 *
 * The returned array's `[0]` element is `activeThreadId`; older entries follow.
 * When a thread is re-selected, it moves to the front rather than being added
 * again. Capped at `limit` entries so subscription fan-out stays bounded.
 *
 * Why this exists: paired with `useWarmThreadSubscriptions`, this list defines
 * the set of threads whose Convex subscriptions are held open in the
 * background. The MRU shape matches user intent — the last N threads they
 * touched are the ones they are most likely to switch back to.
 *
 * Why we update state during render (not in an effect): we want the new MRU
 * list to be visible *in the same render* that observes the new
 * `activeThreadId`, so the dependent `useQueries` subscribes to the new
 * thread immediately. Setting state during render is the React-documented
 * pattern for "derived state from props" — it triggers an immediate restart
 * of the current render with the new state, not a follow-up commit.
 */
export function useRecentThreads(activeThreadId: ThreadId | null, limit = DEFAULT_LIMIT): ThreadId[] {
  const [recent, setRecent] = useState<ThreadId[]>(() => (activeThreadId ? [activeThreadId] : []));
  const [lastSeen, setLastSeen] = useState<ThreadId | null>(() => activeThreadId);

  if (activeThreadId !== lastSeen) {
    setLastSeen(activeThreadId);
    if (activeThreadId !== null) {
      setRecent((prev) => {
        if (prev[0] === activeThreadId) return prev;
        const filtered = prev.filter((id) => id !== activeThreadId);
        return [activeThreadId, ...filtered].slice(0, limit);
      });
    }
  }

  return recent;
}
