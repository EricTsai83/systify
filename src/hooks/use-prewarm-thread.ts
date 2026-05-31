import { useCallback } from "react";
import { useConvex } from "convex/react";
import { api } from "../../convex/_generated/api";
import { CHAT_MESSAGES_FIRST_PAGE_ARGS } from "../../convex/lib/constants";
import type { ThreadId } from "@/lib/types";

/**
 * The "hesitation budget" for sidebar hover prefetch — how long we hold the
 * subscription open while assuming the user might click. Short enough that
 * mass-hovering across the list doesn't fan out long-lived subscriptions,
 * long enough that a thoughtful click still lands inside the window.
 */
const PREWARM_DURATION_MS = 8_000;

/**
 * Returns a stable callback that warms a thread's Convex subscriptions
 * (messages + active stream) for ~8 seconds. Wire to hover/focus on
 * sidebar thread rows so that by the time the user clicks, both
 * subscriptions are already alive on the client and the switch is
 * instant. Because subscriptions are ref-counted by `(query, args)`,
 * prewarming shares the subscription with the `ChatContainer` query
 * once the user actually selects the thread.
 */
export function usePrewarmThread(): (threadId: ThreadId) => void {
  const convex = useConvex();
  return useCallback(
    (threadId: ThreadId) => {
      convex.prewarmQuery({
        query: api.chat.threads.listMessagesPaginated,
        args: { threadId, paginationOpts: CHAT_MESSAGES_FIRST_PAGE_ARGS },
        extendSubscriptionFor: PREWARM_DURATION_MS,
      });
      convex.prewarmQuery({
        query: api.chat.streaming.getActiveMessageStream,
        args: { threadId },
        extendSubscriptionFor: PREWARM_DURATION_MS,
      });
    },
    [convex],
  );
}
