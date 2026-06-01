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
  test("renders an error-only failed reply as a system alert without duplicating the message", () => {
    const errorMessage =
      "This reply stopped before it could finish. Try sending your message again. If it keeps happening, choose another model or check the provider configuration.";
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
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Reply could not finish")).toBeInTheDocument();
    expect(screen.getAllByText(errorMessage)).toHaveLength(1);
  });

  test("keeps a system alert when failed content contains useful partial output", () => {
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
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Reply could not finish")).toBeInTheDocument();
    expect(screen.getByText("Provider request failed.")).toBeInTheDocument();
  });
});
