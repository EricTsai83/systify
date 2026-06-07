// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArtifactId, ChatMode, MessageId, RepositoryId, ThreadId } from "@/lib/types";

const {
  useMutationMock,
  sendMessageMock,
  sendMessageStartingNewThreadMock,
  cancelInFlightReplyMock,
  archiveThreadMock,
} = vi.hoisted(() => ({
  useMutationMock: vi.fn(),
  sendMessageMock: vi.fn(),
  sendMessageStartingNewThreadMock: vi.fn(),
  cancelInFlightReplyMock: vi.fn(),
  archiveThreadMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
}));

import { useChatLifecycle } from "./use-chat-lifecycle";

type LifecycleArgs = Parameters<typeof useChatLifecycle>[0];

const repositoryId = "repo_1" as RepositoryId;
const threadId = "thread_1" as ThreadId;
const createdThreadId = "thread_created" as ThreadId;
const artifactId = "artifact_1" as ArtifactId;
const userMessageId = "message_user" as MessageId;
const assistantMessageId = "message_assistant" as MessageId;

const startResult = {
  threadId: createdThreadId,
  jobId: "job_1",
  userMessageId,
  assistantMessageId,
  mode: "library" as ChatMode,
};

const mutationName = (mutation: unknown) => {
  try {
    return getFunctionName(mutation as Parameters<typeof getFunctionName>[0]);
  } catch {
    return null;
  }
};

function submitEvent(): React.FormEvent<HTMLFormElement> {
  return {
    preventDefault: vi.fn(),
  } as unknown as React.FormEvent<HTMLFormElement>;
}

function baseArgs(overrides: Partial<LifecycleArgs> = {}): LifecycleArgs {
  return {
    selectedThreadId: null,
    repositoryId,
    threadToArchive: null,
    chatInput: "question",
    chatMode: "library",
    selectedProvider: null,
    selectedModelName: null,
    selectedReasoningEffort: null,
    clearChatInput: vi.fn(),
    setActionError: vi.fn(),
    setThreadToArchive: vi.fn(),
    onAfterCreateThread: vi.fn(),
    onAfterArchiveThread: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({
    jobId: "job_1",
    userMessageId,
    assistantMessageId,
  });
  sendMessageStartingNewThreadMock.mockReset();
  sendMessageStartingNewThreadMock.mockResolvedValue(startResult);
  cancelInFlightReplyMock.mockReset();
  cancelInFlightReplyMock.mockResolvedValue(undefined);
  archiveThreadMock.mockReset();
  archiveThreadMock.mockResolvedValue(undefined);
  useMutationMock.mockReset();
  useMutationMock.mockImplementation((mutation) => {
    switch (mutationName(mutation)) {
      case "chat/send:sendMessage":
        return sendMessageMock;
      case "chat/send:sendMessageStartingNewThread":
        return sendMessageStartingNewThreadMock;
      case "chat/cancel:cancelInFlightReply":
        return cancelInFlightReplyMock;
      case "chat/threads:archiveThread":
        return archiveThreadMock;
      default:
        throw new Error(`Unexpected mutation ${mutationName(mutation) ?? "unknown"}`);
    }
  });
});

afterEach(() => {
  cleanup();
});

describe("useChatLifecycle send", () => {
  test("Library first send forwards repository, title, and artifact context", async () => {
    const clearChatInput = vi.fn();
    const onAfterCreateThread = vi.fn();
    const { result } = renderHook(() =>
      useChatLifecycle(
        baseArgs({
          chatMode: "library",
          newThreadTitle: "Library Ask",
          newThreadArtifactContext: [artifactId],
          clearChatInput,
          onAfterCreateThread,
        }),
      ),
    );

    await act(async () => {
      await result.current.handleSendMessage(submitEvent());
    });

    expect(sendMessageStartingNewThreadMock).toHaveBeenCalledWith({
      repositoryId,
      content: "question",
      mode: "library",
      title: "Library Ask",
      artifactContext: [artifactId],
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(clearChatInput).toHaveBeenCalledTimes(1);
    expect(onAfterCreateThread).toHaveBeenCalledWith(createdThreadId, "library");
  });

  test("Existing thread send does not forward new-thread title or artifact context", async () => {
    const { result } = renderHook(() =>
      useChatLifecycle(
        baseArgs({
          selectedThreadId: threadId,
          newThreadTitle: "Library Ask",
          newThreadArtifactContext: [artifactId],
        }),
      ),
    );

    await act(async () => {
      await result.current.handleSendMessage(submitEvent());
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const payload = sendMessageMock.mock.calls[0]?.[0];
    expect(payload).toEqual({
      threadId,
      content: "question",
      mode: "library",
    });
    expect(payload).not.toHaveProperty("title");
    expect(payload).not.toHaveProperty("artifactContext");
    expect(sendMessageStartingNewThreadMock).not.toHaveBeenCalled();
  });

  test("Discuss send preserves grounding, model, and reasoning args without artifact context", async () => {
    const { result } = renderHook(() =>
      useChatLifecycle(
        baseArgs({
          chatMode: "discuss",
          selectedThreadId: null,
          groundLibrary: true,
          groundSandbox: false,
          selectedProvider: "openai",
          selectedModelName: "gpt-test",
          selectedReasoningEffort: "high",
          newThreadArtifactContext: [artifactId],
        }),
      ),
    );

    await act(async () => {
      await result.current.handleSendMessage(submitEvent());
    });

    const payload = sendMessageStartingNewThreadMock.mock.calls[0]?.[0];
    expect(payload).toEqual({
      repositoryId,
      content: "question",
      mode: "discuss",
      groundLibrary: true,
      groundSandbox: false,
      provider: "openai",
      modelName: "gpt-test",
      reasoningEffort: "high",
    });
    expect(payload).not.toHaveProperty("artifactContext");
  });

  test("Pending send reentry calls the mutation only once", async () => {
    let resolveStart: (value: typeof startResult) => void = () => {};
    sendMessageStartingNewThreadMock.mockImplementation(
      () =>
        new Promise<typeof startResult>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const { result } = renderHook(() => useChatLifecycle(baseArgs()));

    let firstSubmit!: Promise<void>;
    act(() => {
      firstSubmit = result.current.handleSendMessage(submitEvent());
    });

    await act(async () => {
      await result.current.handleSendMessage(submitEvent());
    });

    expect(sendMessageStartingNewThreadMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStart(startResult);
      await firstSubmit;
    });
  });
});
