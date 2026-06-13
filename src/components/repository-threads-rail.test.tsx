// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  test("separates agent chats from regular chats", () => {
    vi.mocked(useQuery).mockReturnValue([
      makeThread({
        _id: "thread_agent" as Id<"threads">,
        title: "Translation agent",
        agentRole: "Translation agent",
        singleTurnEnabled: true,
        lastMessageAt: 200,
      }),
      makeThread({
        _id: "thread_disabled_agent" as Id<"threads">,
        title: "Former agent",
        agentEnabled: false,
        agentRole: "Former agent",
        lastMessageAt: 150,
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

    const agentSection = getSection("Agent chats");
    const regularSection = getSection("Regular chats");

    expect(within(agentSection).getByText("Translation agent")).toBeInTheDocument();
    expect(within(agentSection).queryByLabelText("Single-turn")).not.toBeInTheDocument();
    expect(within(agentSection).queryByText("General planning")).not.toBeInTheDocument();
    expect(within(agentSection).queryByText("Former agent")).not.toBeInTheDocument();

    expect(within(regularSection).getByText("Former agent")).toBeInTheDocument();
    expect(within(regularSection).getByText("General planning")).toBeInTheDocument();
    expect(within(regularSection).queryByText("Translation agent")).not.toBeInTheDocument();
  });

  test("collapses agent and pinned chat sections", async () => {
    vi.mocked(useQuery).mockReturnValue([
      makeThread({
        _id: "thread_pinned" as Id<"threads">,
        title: "Pinned planning",
        pinnedAt: 300,
        lastMessageAt: 300,
      }),
      makeThread({
        _id: "thread_agent" as Id<"threads">,
        title: "Translation agent",
        agentRole: "Translation agent",
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

    const agentToggle = screen.getByRole("button", { name: "Collapse Agent chats" });
    const pinnedToggle = screen.getByRole("button", { name: "Collapse Pinned" });

    expect(screen.getByText("Translation agent")).toBeVisible();
    expect(screen.getByText("Pinned planning")).toBeVisible();
    expect(screen.getByText("General planning")).toBeVisible();

    fireEvent.click(agentToggle);
    fireEvent.click(pinnedToggle);

    await waitFor(() => {
      expect(screen.queryByText("Translation agent")).not.toBeInTheDocument();
      expect(screen.queryByText("Pinned planning")).not.toBeInTheDocument();
    });
    expect(screen.getByText("General planning")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Expand Agent chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Pinned" }));

    await waitFor(() => {
      expect(screen.getByText("Translation agent")).toBeVisible();
      expect(screen.getByText("Pinned planning")).toBeVisible();
    });
  });
});

function getSection(label: "Agent chats" | "Regular chats"): HTMLElement {
  const heading = screen.getByText(label);
  const section = heading.closest("div")?.parentElement;
  if (!section) {
    throw new Error(`Section not found: ${label}`);
  }
  return section;
}

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
