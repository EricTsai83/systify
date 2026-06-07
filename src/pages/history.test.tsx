// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HistoryPage } from "./history";

const createShareMock = vi.fn();
const archiveThreadMock = vi.fn();
const revokeShareMock = vi.fn();
const clipboardWriteTextMock = vi.fn();
const loadMoreGroupsMock = vi.fn();
const loadMoreSharesMock = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: vi.fn(),
  usePaginatedQuery: vi.fn(),
  useQuery: vi.fn(),
}));

function functionName(reference: unknown): string {
  try {
    return getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
  } catch {
    return "";
  }
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

beforeEach(() => {
  createShareMock.mockResolvedValue({
    _id: "share_1",
    token: "share_token",
    tokenPrefix: "share_toke",
    threadId: "thread_repo_discuss",
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  archiveThreadMock.mockResolvedValue(null);
  revokeShareMock.mockResolvedValue(null);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteTextMock.mockResolvedValue(undefined) },
  });
  vi.mocked(useMutation).mockImplementation((reference) => {
    const name = functionName(reference);
    if (name.endsWith("createOrGetThreadShare")) return createShareMock as unknown as ReturnType<typeof useMutation>;
    if (name.endsWith("archiveThread")) return archiveThreadMock as unknown as ReturnType<typeof useMutation>;
    if (name.endsWith("revokeThreadShare")) return revokeShareMock as unknown as ReturnType<typeof useMutation>;
    return vi.fn() as unknown as ReturnType<typeof useMutation>;
  });
  vi.mocked(usePaginatedQuery).mockImplementation((reference, args) => {
    const name = functionName(reference);
    if (name.endsWith("listThreadHistoryGroups")) {
      return paginated(
        [
          {
            _id: "group_no_repo",
            groupKey: "no_repository",
            lastThreadAt: 200,
            lastThreadId: "thread_no_repo",
            threadCount: 1,
            repository: null,
          },
          {
            _id: "group_repo",
            groupKey: "repository:repo_1",
            repositoryId: "repo_1",
            lastThreadAt: 100,
            lastThreadId: "thread_repo_discuss",
            threadCount: 2,
            repository: {
              _id: "repo_1",
              sourceRepoFullName: "acme/systify",
              visibility: "private",
            },
          },
        ],
        { loadMore: loadMoreGroupsMock },
      );
    }
    if (name.endsWith("listActiveThreadShares")) {
      return paginated(
        [
          {
            _id: "share_1",
            token: "share_token",
            threadId: "thread_repo_discuss",
            repositoryId: "repo_1",
            title: "Discuss thread",
            repositoryLabel: "acme/systify",
            createdAt: 100,
            expiresAt: Date.now() + 18 * 24 * 60 * 60 * 1000,
          },
        ],
        { loadMore: loadMoreSharesMock },
      );
    }
    if (name.endsWith("listThreadsForHistoryGroup")) {
      const repositoryId =
        typeof args === "object" && args !== null && "repositoryId" in args ? args.repositoryId : null;
      return repositoryId === null
        ? paginated([
            {
              _id: "thread_no_repo",
              title: "General planning",
              mode: "discuss",
              lastMessageAt: 200,
              activeShare: null,
            },
          ])
        : paginated([
            {
              _id: "thread_repo_discuss",
              repositoryId: "repo_1",
              title: "Discuss thread",
              mode: "discuss",
              lastMessageAt: 100,
              activeShare: {
                _id: "share_1",
                token: "share_token",
                createdAt: 100,
                expiresAt: Date.now() + 18 * 24 * 60 * 60 * 1000,
              },
            },
            {
              _id: "thread_repo_library",
              repositoryId: "repo_1",
              title: "Library thread",
              mode: "library",
              lastMessageAt: 90,
              activeShare: null,
            },
          ]);
    }
    return paginated([]);
  });
  vi.mocked(useQuery).mockReturnValue([]);
});

afterEach(() => {
  cleanup();
  vi.mocked(useMutation).mockReset();
  vi.mocked(usePaginatedQuery).mockReset();
  vi.mocked(useQuery).mockReset();
  createShareMock.mockReset();
  archiveThreadMock.mockReset();
  revokeShareMock.mockReset();
  clipboardWriteTextMock.mockReset();
  loadMoreGroupsMock.mockReset();
  loadMoreSharesMock.mockReset();
});

describe("HistoryPage", () => {
  test("renders archive action, repository selector, selected repository threads, and no search input", () => {
    renderHistoryPage();

    expect(screen.getByRole("button", { name: /open archive/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /chat history pages/i })).toHaveStyle({ minHeight: "632px" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loaded repository threads: 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Loaded no-repository chats: 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Shared links: 1")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /select chat history repository/i })).toHaveTextContent("acme/systify");
    expect(screen.getAllByText("acme/systify").length).toBeGreaterThan(0);
    expect(screen.queryByText("General planning")).not.toBeInTheDocument();
    expect(screen.getByText("Library Ask")).toBeInTheDocument();
  });

  test("keeps archive available when chat history is empty", () => {
    vi.mocked(usePaginatedQuery).mockImplementation((reference) => {
      const name = functionName(reference);
      if (name.endsWith("listThreadHistoryGroups")) return paginated([]);
      if (name.endsWith("listActiveThreadShares")) return paginated([]);
      if (name.endsWith("listThreadsForHistoryGroup")) return paginated([]);
      return paginated([]);
    });

    renderHistoryPage();

    expect(screen.getByText("No chat history yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open archive/i })).toBeInTheDocument();
  });

  test("history loading skeleton occupies the chat history card layout", () => {
    vi.mocked(usePaginatedQuery).mockImplementation((reference) => {
      const name = functionName(reference);
      if (name.endsWith("listThreadHistoryGroups")) return loadingFirstPagePaginated();
      if (name.endsWith("listActiveThreadShares")) return paginated([]);
      if (name.endsWith("listThreadsForHistoryGroup")) return paginated([]);
      return paginated([]);
    });

    const { container } = renderHistoryPage();
    const historyCard = screen.getByRole("group", { name: /chat history pages/i });
    const selectorSkeleton = container.querySelector("[data-history-repository-selector-skeleton='true']");
    const groupSkeleton = container.querySelector("[data-history-group-skeleton='true']");
    const rowSkeleton = container.querySelector("[data-history-thread-rows-skeleton='true']");

    expect(screen.queryByText("Loading")).not.toBeInTheDocument();
    expect(selectorSkeleton).not.toBeNull();
    expect(groupSkeleton).not.toBeNull();
    expect(rowSkeleton).not.toBeNull();
    expect(historyCard.contains(groupSkeleton)).toBe(true);
    expect(groupSkeleton?.querySelectorAll('[data-history-button-skeleton="true"]')).toHaveLength(9);
  });

  test("opens repository threads on their canonical routes", () => {
    renderHistoryPage();

    fireEvent.click(openButtonForRow("Discuss thread"));
    expect(screen.getByTestId("location")).toHaveTextContent("/r/repo_1/discuss/thread_repo_discuss");

    fireEvent.click(openButtonForRow("Library thread"));
    expect(screen.getByTestId("location")).toHaveTextContent("/r/repo_1/library?ask=thread_repo_library");
  });

  test("opens no-repository threads on their canonical route", () => {
    vi.mocked(usePaginatedQuery).mockImplementation((reference, args) => {
      const name = functionName(reference);
      if (name.endsWith("listThreadHistoryGroups")) {
        return paginated([
          {
            _id: "group_no_repo",
            groupKey: "no_repository",
            lastThreadAt: 200,
            lastThreadId: "thread_no_repo",
            threadCount: 1,
            repository: null,
          },
        ]);
      }
      if (name.endsWith("listActiveThreadShares")) return paginated([]);
      if (name.endsWith("listThreadsForHistoryGroup")) {
        const repositoryId =
          typeof args === "object" && args !== null && "repositoryId" in args ? args.repositoryId : null;
        return repositoryId === null
          ? paginated([
              {
                _id: "thread_no_repo",
                title: "General planning",
                mode: "discuss",
                lastMessageAt: 200,
                activeShare: null,
              },
            ])
          : paginated([]);
      }
      return paginated([]);
    });

    renderHistoryPage();

    fireEvent.click(openButtonForRow("General planning"));
    expect(screen.getByTestId("location")).toHaveTextContent("/chat/thread_no_repo");
  });

  test("share copies a public URL and shared links support copy and revoke", async () => {
    renderHistoryPage();

    fireEvent.click(rowButton("Discuss thread", /share/i));
    await waitFor(() => {
      expect(createShareMock).toHaveBeenCalledWith({ threadId: "thread_repo_discuss" });
      expect(clipboardWriteTextMock).toHaveBeenCalledWith("http://localhost:3000/share/t/share_token");
    });

    fireEvent.click(screen.getByRole("button", { name: /copy link/i }));
    await waitFor(() => {
      expect(clipboardWriteTextMock).toHaveBeenCalledWith("http://localhost:3000/share/t/share_token");
    });

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() => {
      expect(revokeShareMock).toHaveBeenCalledWith({ shareId: "share_1" });
    });
  });

  test("archived active share renders a badge and keeps revoke enabled", () => {
    vi.mocked(usePaginatedQuery).mockImplementation((reference) => {
      const name = functionName(reference);
      if (name.endsWith("listThreadHistoryGroups")) return paginated([]);
      if (name.endsWith("listActiveThreadShares")) {
        return paginated([
          {
            _id: "share_archived",
            token: "share_archived_token",
            threadId: "thread_archived",
            title: "Archived shared thread",
            repositoryLabel: "No repository",
            createdAt: 100,
            expiresAt: Date.now() + 18 * 24 * 60 * 60 * 1000,
            threadArchivedAt: Date.now(),
          },
        ]);
      }
      if (name.endsWith("listThreadsForHistoryGroup")) return paginated([]);
      return paginated([]);
    });

    renderHistoryPage();

    expect(screen.getByText("Archived thread")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeEnabled();
  });

  test("empty visible shares with more pages renders load-more instead of empty state", () => {
    vi.mocked(usePaginatedQuery).mockImplementation((reference) => {
      const name = functionName(reference);
      if (name.endsWith("listThreadHistoryGroups")) return paginated([]);
      if (name.endsWith("listActiveThreadShares")) {
        return paginated([], { status: "CanLoadMore", loadMore: loadMoreSharesMock });
      }
      if (name.endsWith("listThreadsForHistoryGroup")) return paginated([]);
      return paginated([]);
    });

    renderHistoryPage();

    expect(screen.queryByText("No active public share links.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /load more links/i }));
    expect(loadMoreSharesMock).toHaveBeenCalledWith(20);
  });

  test("history group selector can load additional repository groups", () => {
    vi.mocked(usePaginatedQuery).mockImplementation((reference) => {
      const name = functionName(reference);
      if (name.endsWith("listThreadHistoryGroups")) {
        return paginated(
          [
            {
              _id: "group_repo",
              groupKey: "repository:repo_1",
              repositoryId: "repo_1",
              lastThreadAt: 100,
              lastThreadId: "thread_repo_discuss",
              threadCount: 2,
              repository: {
                _id: "repo_1",
                sourceRepoFullName: "acme/systify",
                visibility: "private",
              },
            },
          ],
          { status: "CanLoadMore", loadMore: loadMoreGroupsMock },
        );
      }
      if (name.endsWith("listActiveThreadShares")) return paginated([]);
      if (name.endsWith("listThreadsForHistoryGroup")) return paginated([]);
      return paginated([]);
    });

    renderHistoryPage();

    fireEvent.click(screen.getByRole("button", { name: /load more repositories/i }));
    expect(loadMoreGroupsMock).toHaveBeenCalledWith(100);
  });

  test("archive action confirms before calling the mutation", async () => {
    renderHistoryPage();

    fireEvent.click(rowButton("Discuss thread", /archive/i));
    expect(archiveThreadMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /archive thread/i }));
    await waitFor(() => {
      expect(archiveThreadMock).toHaveBeenCalledWith({ threadId: "thread_repo_discuss" });
    });
  });
});

function renderHistoryPage() {
  return render(
    <MemoryRouter initialEntries={["/settings/history"]}>
      <HistoryPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function paginated(
  results: unknown[],
  options: {
    status?: "CanLoadMore" | "Exhausted";
    loadMore?: ReturnType<typeof usePaginatedQuery>["loadMore"];
  } = {},
): ReturnType<typeof usePaginatedQuery> {
  return {
    results,
    status: options.status ?? ("Exhausted" as const),
    loadMore: options.loadMore ?? vi.fn(),
    isLoading: false as const,
  };
}

function loadingFirstPagePaginated(): ReturnType<typeof usePaginatedQuery> {
  return {
    results: [],
    status: "LoadingFirstPage",
    loadMore: vi.fn(),
    isLoading: true,
  } as unknown as ReturnType<typeof usePaginatedQuery>;
}

function rowForText(text: string): HTMLElement {
  const element = screen.getAllByText(text).find((candidate) => candidate.closest(".group"));
  const row = element?.closest(".group");
  if (!row) {
    throw new Error(`Could not find row for ${text}`);
  }
  return row as HTMLElement;
}

function openButtonForRow(text: string): HTMLElement {
  return rowButton(text, /^open$/i);
}

function rowButton(text: string, name: RegExp): HTMLElement {
  return within(rowForText(text)).getByRole("button", { name });
}
