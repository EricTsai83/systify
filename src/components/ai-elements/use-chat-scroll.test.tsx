// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useChatScroll } from "./use-chat-scroll";

type TestMessage = { readonly _id: string };

const message = (_id: string): TestMessage => ({ _id });

describe("useChatScroll prepend detection", () => {
  test("does not treat the first async load after an empty thread as a prepend", async () => {
    const onLoadOlder = vi.fn();
    const { result, rerender } = renderHook(
      ({ messages }: { messages: readonly TestMessage[] }) =>
        useChatScroll({
          threadId: "thread-1",
          messages,
          canLoadOlder: false,
          onLoadOlder,
        }),
      { initialProps: { messages: [] as readonly TestMessage[] } },
    );

    expect(result.current.didPrepend).toBe(false);

    rerender({ messages: [message("message-1"), message("message-2")] });

    await waitFor(() => {
      expect(result.current.didPrepend).toBe(false);
    });
  });

  test("marks a prepend when older messages arrive before existing content", async () => {
    const onLoadOlder = vi.fn();
    const { result, rerender } = renderHook(
      ({ messages }: { messages: readonly TestMessage[] }) =>
        useChatScroll({
          threadId: "thread-1",
          messages,
          canLoadOlder: false,
          onLoadOlder,
        }),
      { initialProps: { messages: [message("message-1"), message("message-2")] } },
    );

    expect(result.current.didPrepend).toBe(false);

    rerender({ messages: [message("older-message"), message("message-1"), message("message-2")] });

    await waitFor(() => {
      expect(result.current.didPrepend).toBe(true);
    });
  });
});
