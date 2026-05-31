import { useMemo } from "react";
import { useQueries } from "convex/react";
import { api } from "../../convex/_generated/api";
import { CHAT_MESSAGES_FIRST_PAGE_ARGS } from "../../convex/lib/constants";
import type { ThreadId } from "@/lib/types";

/**
 * Hold Convex subscriptions open for `threadIds` so switching between them is
 * instantaneous and stays live-reactive.
 *
 * Convex's `useQuery` re-subscribes from scratch when its args change,
 * returning `undefined` until the server responds — that gap is the
 * "blank flash" users feel when switching threads. By subscribing in
 * parallel at a parent level via `useQueries`, the data for these
 * threads is already on the client. When `ChatContainer`'s `useQuery`
 * mounts with the same `(query, args)` it shares the same ref-counted
 * subscription and returns the value synchronously.
 *
 * This is *not* a cache — every entry is a real, server-pushed
 * subscription, so server-side edits stream in normally with no stale
 * read risk. The cost is N extra subscriptions; bound `threadIds` to a
 * small MRU window (see `useRecentThreads`).
 *
 * Both the first message page and `getActiveMessageStream` are warmed
 * because the chat UI renders both together — warming only one would
 * still let streaming indicators flash on switch.
 */
export function useWarmThreadSubscriptions(threadIds: readonly ThreadId[]): void {
  const queries = useMemo(() => {
    const map: Record<
      string,
      {
        query: typeof api.chat.threads.listMessagesPaginated | typeof api.chat.streaming.getActiveMessageStream;
        args: { threadId: ThreadId; paginationOpts?: typeof CHAT_MESSAGES_FIRST_PAGE_ARGS };
      }
    > = {};
    for (const threadId of threadIds) {
      map[`messages:${threadId}`] = {
        query: api.chat.threads.listMessagesPaginated,
        args: { threadId, paginationOpts: CHAT_MESSAGES_FIRST_PAGE_ARGS },
      };
      map[`stream:${threadId}`] = {
        query: api.chat.streaming.getActiveMessageStream,
        args: { threadId },
      };
    }
    return map;
  }, [threadIds]);

  useQueries(queries);
}
