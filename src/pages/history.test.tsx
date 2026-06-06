// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HistoryPage } from "./history";

const createShareMock = vi.fn();
const deleteThreadMock = vi.fn();
const revokeShareMock = vi.fn();
const clipboardWriteTextMock = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: vi.fn(),
  usePaginatedQuery: vi.fn(),
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
  deleteThreadMock.mockResolvedValue(null);
  revokeShareMock.mockResolvedValue(null);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteTextMock.mockResolvedValue(undefined) },
  });
  vi.mocked(useMutation).mockImplementation((reference) => {
    const name = functionName(reference);
    if (name.endsWith("createOrGetThreadShare")) return createShareMock as unknown as ReturnType<typeof useMutation>;
    if (name.endsWith("deleteThread")) return deleteThreadMock as unknown as ReturnType<typeof useMutation>;
    if (name.endsWith("revokeThreadShare")) return revokeShareMock as unknown as ReturnType<typeof useMutation>;
    return vi.fn() as unknown as ReturnType<typeof useMutation>;
  });
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
      ]);
    }
    if (name.endsWith("listActiveThreadShares")) {
      return paginated([
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
      ]);
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
});

afterEach(() => {
  cleanup();
  vi.mocked(useMutation).mockReset();
  vi.mocked(usePaginatedQuery).mockReset();
  createShareMock.mockReset();
  deleteThreadMock.mockReset();
  revokeShareMock.mockReset();
  clipboardWriteTextMock.mockReset();
});

describe("HistoryPage", () => {
  test("renders archive action, repository groups, no-repository group, and no search input", () => {
    renderHistoryPage();

    expect(screen.getByRole("link", { name: /open archive/i })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getAllByText("acme/systify").length).toBeGreaterThan(0);
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(screen.getByText("General chats that are not attached to a repository.")).toBeInTheDocument();
    expect(screen.getByText("Library Ask")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  test("opens repository and no-repository threads on their canonical routes", () => {
    renderHistoryPage();

    fireEvent.click(openButtonForRow("Discuss thread"));
    expect(screen.getByTestId("location")).toHaveTextContent("/r/repo_1/discuss/thread_repo_discuss");

    fireEvent.click(openButtonForRow("Library thread"));
    expect(screen.getByTestId("location")).toHaveTextContent("/r/repo_1/library?ask=thread_repo_library");

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

  test("delete action confirms before calling the mutation", async () => {
    renderHistoryPage();

    fireEvent.click(rowButton("Discuss thread", /delete/i));
    expect(deleteThreadMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /delete thread/i }));
    await waitFor(() => {
      expect(deleteThreadMock).toHaveBeenCalledWith({ threadId: "thread_repo_discuss" });
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

function paginated(results: unknown[]): ReturnType<typeof usePaginatedQuery> {
  return {
    results,
    status: "Exhausted" as const,
    loadMore: vi.fn(),
    isLoading: false as const,
  };
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
