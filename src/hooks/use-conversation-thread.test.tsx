// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { CHAT_MESSAGES_PAGE_SIZE } from "../../convex/lib/constants";
import type { MessageId, ThreadId } from "@/lib/types";

const { usePaginatedQueryMock, useQueryMock } = vi.hoisted(() => ({
  usePaginatedQueryMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: usePaginatedQueryMock,
  useQuery: useQueryMock,
}));

import { findInFlightAssistantMessage, useConversationThread } from "./use-conversation-thread";

const threadId = "thread_1" as ThreadId;

const queryName = (query: unknown) => {
  try {
    return getFunctionName(query as Parameters<typeof getFunctionName>[0]);
  } catch {
    return null;
  }
};

function message({
  id,
  role,
  status,
  content = id,
}: {
  id: string;
  role: "assistant" | "user";
  status: "pending" | "streaming" | "completed";
  content?: string;
}): Doc<"messages"> {
  return {
    _id: id as MessageId,
    role,
    status,
    content,
    errorMessage: undefined,
  } as unknown as Doc<"messages">;
}

beforeEach(() => {
  usePaginatedQueryMock.mockReset();
  usePaginatedQueryMock.mockReturnValue({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  });
  useQueryMock.mockReset();
  useQueryMock.mockReturnValue(null);
});

describe("useConversationThread", () => {
  test("threadId null skips message and active-stream queries without entering loading state", () => {
    const { result } = renderHook(() => useConversationThread({ threadId: null }));

    expect(result.current.messages).toBeUndefined();
    expect(result.current.activeMessageStream).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(usePaginatedQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      "skip",
      expect.objectContaining({ initialNumItems: CHAT_MESSAGES_PAGE_SIZE }),
    );
    expect(useQueryMock).toHaveBeenCalledWith(expect.anything(), "skip");
  });

  test("LoadingFirstPage keeps messages undefined and reports loading", () => {
    usePaginatedQueryMock.mockReturnValue({
      results: [],
      status: "LoadingFirstPage",
      loadMore: vi.fn(),
      isLoading: true,
    });

    const { result } = renderHook(() => useConversationThread({ threadId }));

    expect(result.current.messages).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    expect(usePaginatedQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      { threadId },
      expect.objectContaining({ initialNumItems: CHAT_MESSAGES_PAGE_SIZE }),
    );
  });

  test("settled paginated results are reversed into ascending creation-time order", () => {
    const newest = message({ id: "message_newest", role: "assistant", status: "completed" });
    const middle = message({ id: "message_middle", role: "user", status: "completed" });
    const oldest = message({ id: "message_oldest", role: "assistant", status: "completed" });
    usePaginatedQueryMock.mockReturnValue({
      results: [newest, middle, oldest],
      status: "Exhausted",
      loadMore: vi.fn(),
      isLoading: false,
    });
    useQueryMock.mockImplementation((query) => {
      if (queryName(query) === "chat/streaming:getActiveMessageStream") {
        return {
          assistantMessageId: newest._id,
          content: "live",
          reasoning: null,
          reasoningStartedAt: null,
          reasoningEndedAt: null,
          startedAt: 1,
          lastAppendedAt: 2,
        };
      }
      return null;
    });

    const { result } = renderHook(() => useConversationThread({ threadId }));

    expect(result.current.messages?.map((row) => row._id)).toEqual([oldest._id, middle._id, newest._id]);
    expect(result.current.activeMessageStream?.content).toBe("live");
    expect(result.current.isLoading).toBe(false);
  });

  test("CanLoadMore exposes the load-older affordance and page-size callback", () => {
    const loadMore = vi.fn();
    usePaginatedQueryMock.mockReturnValue({
      results: [],
      status: "CanLoadMore",
      loadMore,
      isLoading: false,
    });

    const { result } = renderHook(() => useConversationThread({ threadId }));

    expect(result.current.canLoadOlderMessages).toBe(true);
    act(() => {
      result.current.handleLoadOlderMessages();
    });
    expect(loadMore).toHaveBeenCalledWith(CHAT_MESSAGES_PAGE_SIZE);
  });
});

describe("findInFlightAssistantMessage", () => {
  test("returns the latest assistant only when that assistant is pending or streaming", () => {
    const olderPending = message({ id: "message_pending", role: "assistant", status: "pending" });
    const latestCompleted = message({ id: "message_completed", role: "assistant", status: "completed" });
    expect(
      findInFlightAssistantMessage([
        olderPending,
        message({ id: "message_user", role: "user", status: "completed" }),
        latestCompleted,
      ]),
    ).toBeNull();

    const latestStreaming = message({ id: "message_streaming", role: "assistant", status: "streaming" });
    expect(findInFlightAssistantMessage([latestCompleted, latestStreaming])).toBe(latestStreaming);
  });
});
