// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { RepolessChatsRail } from "./repository-threads-rail";

vi.mock("convex/react", () => ({
  useConvex: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(useConvex).mockReturnValue({
    prewarmQuery: vi.fn(),
  } as unknown as ReturnType<typeof useConvex>);
  vi.mocked(useMutation).mockReturnValue(vi.fn() as unknown as ReturnType<typeof useMutation>);
});

afterEach(() => {
  cleanup();
  vi.mocked(useConvex).mockReset();
  vi.mocked(useMutation).mockReset();
  vi.mocked(useQuery).mockReset();
});

describe("RepolessChatsRail", () => {
  test("separates Agent Mode threads from Thread Mode threads", () => {
    vi.mocked(useQuery).mockReturnValue([
      makeThread({
        _id: "thread_agent" as Id<"threads">,
        title: "Translation agent",
        agentRole: "Translation agent",
        singleTurnEnabled: true,
        lastMessageAt: 200,
      }),
      makeThread({
        _id: "thread_regular" as Id<"threads">,
        title: "General planning",
        lastMessageAt: 100,
      }),
    ]);

    render(
      <RepolessChatsRail
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onRequestNewThread={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Agent Mode").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Thread Mode").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Translation agent")).toBeInTheDocument();
    expect(screen.getByText("Single-turn")).toBeInTheDocument();
    expect(screen.getByText("General planning")).toBeInTheDocument();
  });
});

function makeThread(overrides: Partial<Doc<"threads">>): Doc<"threads"> {
  return {
    _id: "thread_default" as Id<"threads">,
    _creationTime: 1,
    ownerTokenIdentifier: "user|rail-test",
    title: "Thread",
    mode: "discuss",
    lastMessageAt: 1,
    ...overrides,
  } as Doc<"threads">;
}
