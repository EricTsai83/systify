// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { MessageBubble } from "./chat-message";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
}));

afterEach(() => {
  cleanup();
  vi.mocked(useQuery).mockReset();
  vi.mocked(useQuery).mockReturnValue([]);
});

function makeAssistantMessage(overrides: Partial<Doc<"messages">> = {}): Doc<"messages"> {
  return {
    _creationTime: 1,
    _id: "message_1" as Doc<"messages">["_id"],
    content: "Reply content",
    mode: "discuss",
    ownerTokenIdentifier: "owner",
    role: "assistant",
    status: "completed",
    threadId: "thread_1" as Doc<"messages">["threadId"],
    ...overrides,
  };
}

describe("MessageBubble", () => {
  test("does not render a duplicate error line when failed content already contains the same error", () => {
    const errorMessage = "The assistant reply stalled and was automatically marked as failed.";
    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: errorMessage,
          errorMessage,
          status: "failed",
        })}
        activeMessageStream={null}
      />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getAllByText(errorMessage)).toHaveLength(1);
  });

  test("keeps the error line when failed content contains useful partial output", () => {
    render(
      <MessageBubble
        message={makeAssistantMessage({
          content: "Partial answer before the provider failed.",
          errorMessage: "Provider request failed.",
          status: "failed",
        })}
        activeMessageStream={null}
      />,
    );

    expect(screen.getByText("Partial answer before the provider failed.")).toBeInTheDocument();
    expect(screen.getByText("Provider request failed.")).toBeInTheDocument();
  });
});
