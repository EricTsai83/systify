// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ThreadId } from "@/lib/types";

const { archiveThreadMutationMock } = vi.hoisted(() => ({
  archiveThreadMutationMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: () => archiveThreadMutationMock,
}));

import { useChatShellLifecycle } from "./use-chat-shell-lifecycle";

const archivedThreadId = "thread_archive" as ThreadId;
const nextThreadId = "thread_next" as ThreadId;

beforeEach(() => {
  archiveThreadMutationMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useChatShellLifecycle", () => {
  test("archive completion uses the latest selected thread before redirecting", async () => {
    let resolveArchive!: () => void;
    archiveThreadMutationMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveArchive = resolve;
      }),
    );
    const setActionError = vi.fn();
    const setThreadToArchive = vi.fn();
    const onAfterArchiveThread = vi.fn();
    const { result, rerender } = renderHook(
      ({ selectedThreadId }) =>
        useChatShellLifecycle({
          selectedThreadId,
          threadToArchive: archivedThreadId,
          setActionError,
          setThreadToArchive,
          onAfterArchiveThread,
        }),
      {
        initialProps: { selectedThreadId: archivedThreadId as ThreadId | null },
      },
    );

    let archivePromise!: Promise<void>;
    await act(async () => {
      archivePromise = result.current.handleArchiveThread();
      await Promise.resolve();
    });

    rerender({ selectedThreadId: nextThreadId });

    await act(async () => {
      resolveArchive();
      await archivePromise;
    });

    expect(archiveThreadMutationMock).toHaveBeenCalledWith({ threadId: archivedThreadId });
    expect(setThreadToArchive).toHaveBeenCalledWith(null);
    expect(onAfterArchiveThread).not.toHaveBeenCalled();
  });
});
