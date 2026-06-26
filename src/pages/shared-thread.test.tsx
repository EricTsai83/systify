// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SharedThreadPage } from "./shared-thread";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  usePaginatedQuery: vi.fn(),
}));

vi.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  vi.mocked(useQuery).mockReset();
  vi.mocked(usePaginatedQuery).mockReset();
});

describe("SharedThreadPage", () => {
  test("renders unavailable state for missing or inactive shares", () => {
    vi.mocked(useQuery).mockReturnValue(null);
    vi.mocked(usePaginatedQuery).mockReturnValue(paginated([]));

    renderSharedThread();

    expect(screen.getByText("Shared thread unavailable")).toBeInTheDocument();
  });

  test("renders public transcript messages", () => {
    vi.mocked(useQuery).mockReturnValue({
      _id: "share_1",
      token: "token_1",
      threadId: "thread_1",
      title: "Architecture review",
      repositoryLabel: "acme/systify",
      createdAt: 100,
      expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
    });
    vi.mocked(usePaginatedQuery).mockReturnValue(
      paginated([
        {
          _id: "message_1",
          role: "user",
          content: "What changed?",
          status: "completed",
          createdAt: 100,
        },
        {
          _id: "message_2",
          role: "assistant",
          content: "The API boundary moved.",
          status: "completed",
          createdAt: 200,
        },
      ]),
    );

    renderSharedThread();

    expect(screen.getByRole("heading", { name: "Architecture review" })).toBeInTheDocument();
    expect(screen.getByText("acme/systify")).toBeInTheDocument();
    expect(screen.getByText("What changed?")).toBeInTheDocument();
    expect(screen.getByText("The API boundary moved.")).toBeInTheDocument();
  });

  test("reserves placeholders for the initial public message page", () => {
    vi.mocked(useQuery).mockReturnValue({
      _id: "share_1",
      token: "token_1",
      threadId: "thread_1",
      title: "Architecture review",
      repositoryLabel: "acme/systify",
      createdAt: 100,
      expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
    });
    vi.mocked(usePaginatedQuery).mockReturnValue({
      ...paginated([]),
      status: "LoadingFirstPage" as const,
      isLoading: true as const,
    });

    renderSharedThread();

    const skeleton = screen.getByTestId("shared-thread-messages-skeleton");
    expect(within(skeleton).getAllByTestId("shared-thread-message-skeleton")).toHaveLength(40);
  });
});

function renderSharedThread() {
  return render(
    <MemoryRouter>
      <SharedThreadPage token="token_1" />
    </MemoryRouter>,
  );
}

function paginated(results: unknown[]): ReturnType<typeof usePaginatedQuery> {
  return {
    results,
    status: "Exhausted" as const,
    loadMore: vi.fn(),
    isLoading: false as const,
  };
}
