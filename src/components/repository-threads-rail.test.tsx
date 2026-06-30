// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { RepolessChatsRail, RepositoryThreadsRail } from "./repository-threads-rail";

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
  vi.useRealTimers();
  vi.mocked(useConvex).mockReset();
  vi.mocked(useMutation).mockReset();
  vi.mocked(useQuery).mockReset();
});

describe("RepolessChatsRail", () => {
  test("leaves the thread list empty while threads load", () => {
    vi.mocked(useQuery).mockReturnValue(undefined);

    const { container } = render(
      <RepolessChatsRail
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onRequestNewThread={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /new thread/i })).toBeInTheDocument();
    expect(screen.queryByText("No conversations yet. Start one above.")).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).not.toBeInTheDocument();
  });

  test("separates agents from conversations", () => {
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

    const agentSection = getSection("Agents");
    const regularSection = getSection("Conversations");

    expect(within(agentSection).getByText("Translation agent")).toBeInTheDocument();
    expect(within(agentSection).queryByLabelText("Single-turn")).not.toBeInTheDocument();
    expect(within(agentSection).queryByText("General planning")).not.toBeInTheDocument();
    expect(within(agentSection).queryByText("Former agent")).not.toBeInTheDocument();

    expect(within(regularSection).getByText("Former agent")).toBeInTheDocument();
    expect(within(regularSection).getByText("General planning")).toBeInTheDocument();
    expect(within(regularSection).queryByText("Translation agent")).not.toBeInTheDocument();
  });

  test("groups conversations by recent activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00"));
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    vi.mocked(useQuery).mockReturnValue([
      makeThread({
        _id: "thread_yesterday" as Id<"threads">,
        title: "Yesterday planning",
        lastMessageAt: todayMs - 12 * 60 * 60 * 1000,
      }),
      makeThread({
        _id: "thread_last_7" as Id<"threads">,
        title: "Week-old planning",
        lastMessageAt: todayMs - 3 * 24 * 60 * 60 * 1000,
      }),
      makeThread({
        _id: "thread_last_30" as Id<"threads">,
        title: "Month planning",
        lastMessageAt: todayMs - 14 * 24 * 60 * 60 * 1000,
      }),
      makeThread({
        _id: "thread_agent" as Id<"threads">,
        title: "Translation agent",
        agentRole: "Translation agent",
        lastMessageAt: todayMs - 3 * 24 * 60 * 60 * 1000,
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

    const conversationsSection = getSection("Conversations");
    const yesterdayGroup = within(conversationsSection).getByRole("group", { name: "Yesterday" });
    const last7Group = within(conversationsSection).getByRole("group", { name: "Last 7 days" });
    const last30Group = within(conversationsSection).getByRole("group", { name: "Last 30 days" });

    expect(within(yesterdayGroup).getByText("Yesterday planning")).toBeInTheDocument();
    expect(within(last7Group).getByText("Week-old planning")).toBeInTheDocument();
    expect(within(last30Group).getByText("Month planning")).toBeInTheDocument();
    expect(within(conversationsSection).queryByText("Translation agent")).not.toBeInTheDocument();
  });

  test("collapses agent and pinned sections", async () => {
    vi.mocked(useQuery).mockReturnValue([
      makeThread({
        _id: "thread_pinned" as Id<"threads">,
        title: "Pinned planning",
        pinnedAt: 300,
        lastMessageAt: 300,
      }),
      makeThread({
        _id: "thread_pinned_agent" as Id<"threads">,
        title: "Pinned translator",
        agentRole: "Translator",
        pinnedAt: 250,
        lastMessageAt: 250,
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

    const agentToggle = screen.getByRole("button", { name: "Collapse Agents" });
    const pinnedToggle = screen.getByRole("button", { name: "Collapse Pinned" });

    expect(screen.getByText("Translation agent")).toBeVisible();
    expect(screen.getByText("Pinned planning")).toBeVisible();
    expect(within(rowButtonForText("Pinned planning")).getByLabelText("Conversation")).toBeVisible();
    expect(within(rowButtonForText("Pinned translator")).getByLabelText("Agent")).toBeVisible();
    expect(within(rowButtonForText("Translation agent")).queryByLabelText("Agent")).not.toBeInTheDocument();
    expect(within(rowButtonForText("General planning")).queryByLabelText("Conversation")).not.toBeInTheDocument();
    expect(screen.getByText("General planning")).toBeVisible();

    fireEvent.click(agentToggle);
    fireEvent.click(pinnedToggle);

    await waitFor(() => {
      expect(screen.queryByText("Translation agent")).not.toBeInTheDocument();
      expect(screen.queryByText("Pinned planning")).not.toBeInTheDocument();
      expect(screen.queryByText("Pinned translator")).not.toBeInTheDocument();
    });
    expect(screen.getByText("General planning")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Expand Agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Pinned" }));

    await waitFor(() => {
      expect(screen.getByText("Translation agent")).toBeVisible();
      expect(screen.getByText("Pinned planning")).toBeVisible();
      expect(screen.getByText("Pinned translator")).toBeVisible();
    });
  });
});

describe("RepositoryThreadsRail create controls", () => {
  test("leaves the repository thread list empty while threads load", () => {
    vi.mocked(useQuery).mockReturnValue(undefined);

    const { container } = render(
      <RepositoryThreadsRail
        repositoryId={"repo_1" as Id<"repositories">}
        threadMode="discuss"
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onError={vi.fn()}
        createControl={{ kind: "navigate", label: "New thread", onRequestNewThread: vi.fn() }}
      />,
    );

    expect(screen.getByRole("button", { name: /new thread/i })).toBeInTheDocument();
    expect(screen.queryByText("Threads")).not.toBeInTheDocument();
    expect(screen.queryByText("No conversations yet. Start one above.")).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).not.toBeInTheDocument();
  });

  test("navigate create control does not create a backend thread", () => {
    const createThread = vi.fn();
    const createLibraryAskThread = vi.fn();
    const onRequestNewThread = vi.fn();
    vi.mocked(useMutation)
      .mockReturnValueOnce(createThread as unknown as ReturnType<typeof useMutation>)
      .mockReturnValueOnce(createLibraryAskThread as unknown as ReturnType<typeof useMutation>)
      .mockReturnValueOnce(vi.fn() as unknown as ReturnType<typeof useMutation>);
    vi.mocked(useQuery).mockReturnValue([]);

    render(
      <RepositoryThreadsRail
        repositoryId={"repo_1" as Id<"repositories">}
        threadMode="discuss"
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onError={vi.fn()}
        createControl={{ kind: "navigate", label: "New thread", onRequestNewThread }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /new thread/i }));

    expect(onRequestNewThread).toHaveBeenCalledTimes(1);
    expect(createThread).not.toHaveBeenCalled();
    expect(createLibraryAskThread).not.toHaveBeenCalled();
  });

  test("createLibraryAsk create control uses library ask mutation", async () => {
    const createLibraryAskThread = vi.fn().mockResolvedValue({
      _id: "thread_library" as Id<"threads">,
      mode: "library",
    });
    const onSelectThread = vi.fn();
    vi.mocked(useMutation)
      .mockReturnValueOnce(vi.fn() as unknown as ReturnType<typeof useMutation>)
      .mockReturnValueOnce(createLibraryAskThread as unknown as ReturnType<typeof useMutation>)
      .mockReturnValueOnce(vi.fn() as unknown as ReturnType<typeof useMutation>);
    vi.mocked(useQuery).mockReturnValue([]);

    render(
      <RepositoryThreadsRail
        repositoryId={"repo_1" as Id<"repositories">}
        threadMode="library"
        selectedThreadId={null}
        onSelectThread={onSelectThread}
        onDeleteThread={vi.fn()}
        onError={vi.fn()}
        createControl={{ kind: "createLibraryAsk", label: "New Ask", requireRepository: true }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /new ask/i }));

    await waitFor(() => {
      expect(createLibraryAskThread).toHaveBeenCalledWith({ repositoryId: "repo_1" });
    });
    expect(onSelectThread).toHaveBeenCalledWith("thread_library", "library");
  });

  test("createDiscuss create control uses discuss mutation", async () => {
    const createThread = vi.fn().mockResolvedValue({
      _id: "thread_discuss" as Id<"threads">,
      mode: "discuss",
    });
    const onSelectThread = vi.fn();
    vi.mocked(useMutation)
      .mockReturnValueOnce(createThread as unknown as ReturnType<typeof useMutation>)
      .mockReturnValueOnce(vi.fn() as unknown as ReturnType<typeof useMutation>)
      .mockReturnValueOnce(vi.fn() as unknown as ReturnType<typeof useMutation>);
    vi.mocked(useQuery).mockReturnValue([]);

    render(
      <RepositoryThreadsRail
        repositoryId={"repo_1" as Id<"repositories">}
        threadMode="discuss"
        selectedThreadId={null}
        onSelectThread={onSelectThread}
        onDeleteThread={vi.fn()}
        onError={vi.fn()}
        createControl={{ kind: "createDiscuss" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /new thread/i }));

    await waitFor(() => {
      expect(createThread).toHaveBeenCalledWith({ repositoryId: "repo_1", mode: "discuss" });
    });
    expect(onSelectThread).toHaveBeenCalledWith("thread_discuss", "discuss");
  });

  test("requireRepository prevents discuss creation when repository is null", () => {
    const createThread = vi.fn();
    vi.mocked(useMutation)
      .mockReturnValueOnce(createThread as unknown as ReturnType<typeof useMutation>)
      .mockReturnValueOnce(vi.fn() as unknown as ReturnType<typeof useMutation>)
      .mockReturnValueOnce(vi.fn() as unknown as ReturnType<typeof useMutation>);
    vi.mocked(useQuery).mockReturnValue([]);

    render(
      <RepositoryThreadsRail
        repositoryId={null}
        threadMode="discuss"
        selectedThreadId={null}
        onSelectThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onError={vi.fn()}
        createControl={{ kind: "createDiscuss", requireRepository: true }}
      />,
    );

    expect(screen.getByRole("button", { name: /new thread/i })).toBeDisabled();
    expect(createThread).not.toHaveBeenCalled();
  });
});

function rowButtonForText(text: string): HTMLElement {
  const button = screen.getByText(text).closest("button");
  if (!button) {
    throw new Error(`Thread row not found: ${text}`);
  }
  return button;
}

function getSection(label: "Agents" | "Conversations"): HTMLElement {
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
