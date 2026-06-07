import { useCallback, useMemo } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { CHAT_MESSAGES_PAGE_SIZE } from "../../convex/lib/constants";
import type { ActiveMessageStream, ThreadId } from "@/lib/types";

export function findInFlightAssistantMessage(messages: readonly Doc<"messages">[] | undefined) {
  if (!messages) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message.status === "streaming" || message.status === "pending" ? message : null;
    }
  }
  return null;
}

export function useConversationThread({
  threadId,
  isShellLoading = false,
}: {
  threadId: ThreadId | null;
  isShellLoading?: boolean;
}): {
  messages: Doc<"messages">[] | undefined;
  activeMessageStream: ActiveMessageStream | null | undefined;
  isLoading: boolean;
  canLoadOlderMessages: boolean;
  handleLoadOlderMessages: () => void;
  inFlightAssistantMessage: Doc<"messages"> | null;
  latestAssistantInFlight: boolean;
} {
  const {
    results: paginatedResults,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(api.chat.threads.listMessagesPaginated, threadId ? { threadId } : "skip", {
    initialNumItems: CHAT_MESSAGES_PAGE_SIZE,
  });

  const messages = useMemo(() => {
    if (threadId === null) {
      return undefined;
    }
    if (paginationStatus === "LoadingFirstPage") {
      return undefined;
    }
    return [...paginatedResults].reverse();
  }, [paginatedResults, paginationStatus, threadId]);

  const activeMessageStream = useQuery(api.chat.streaming.getActiveMessageStream, threadId ? { threadId } : "skip");

  const handleLoadOlderMessages = useCallback(() => {
    loadMore(CHAT_MESSAGES_PAGE_SIZE);
  }, [loadMore]);

  const inFlightAssistantMessage = useMemo(() => findInFlightAssistantMessage(messages), [messages]);

  return {
    messages,
    activeMessageStream,
    isLoading: isShellLoading || (threadId !== null && messages === undefined),
    canLoadOlderMessages: paginationStatus === "CanLoadMore",
    handleLoadOlderMessages,
    inFlightAssistantMessage,
    latestAssistantInFlight: inFlightAssistantMessage !== null,
  };
}
