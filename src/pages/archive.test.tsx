// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ArchiveSettingsSection } from "./archive";

vi.mock("convex/react", () => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));

function functionName(reference: unknown): string {
  try {
    return getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
  } catch {
    return "";
  }
}

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue(vi.fn() as unknown as ReturnType<typeof useMutation>);
});

afterEach(() => {
  cleanup();
  vi.mocked(useMutation).mockReset();
  vi.mocked(useQuery).mockReset();
});

describe("ArchiveSettingsSection", () => {
  test("renders archived thread controls before scopes load", () => {
    vi.mocked(useQuery).mockImplementation((reference, _args?) => {
      const name = functionName(reference);
      if (name.endsWith("listArchivedRepositories")) {
        return undefined;
      }
      if (name.endsWith("listArchivedThreadRepositoryScopes")) {
        return undefined;
      }
      return undefined;
    });

    const { container } = renderArchiveSettingsSection();

    expect(screen.getByRole("button", { name: /unarchive all/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /permanently delete all/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /select archive repository/i })).toHaveTextContent(
      "Choose repository / workspace",
    );
    expect(container.querySelectorAll("[data-archive-skeleton-row='thread']")).toHaveLength(7);
    expect(container.querySelectorAll("[data-archive-skeleton-row='repository']")).toHaveLength(0);
    expect(container.querySelectorAll("[data-archive-pagination-skeleton='true']")).toHaveLength(1);
    const threadSkeletonRow = container.querySelector("[data-archive-skeleton-row='thread']");
    const paginationSkeleton = container.querySelector("[data-archive-pagination-skeleton='true']");
    expect(threadSkeletonRow?.parentElement?.contains(paginationSkeleton)).toBe(false);
  });

  test("pages archived repositories with previous and next controls", () => {
    const repositoryPageSizes: unknown[] = [];
    const repositoryPageCursors: unknown[] = [];
    vi.mocked(useQuery).mockImplementation((reference, args?) => {
      const name = functionName(reference);
      if (name.endsWith("listArchivedRepositories")) {
        if (
          typeof args === "object" &&
          args !== null &&
          "paginationOpts" in args &&
          typeof args.paginationOpts === "object" &&
          args.paginationOpts !== null &&
          "numItems" in args.paginationOpts
        ) {
          repositoryPageSizes.push(args.paginationOpts.numItems);
        }
        const cursor =
          typeof args === "object" &&
          args !== null &&
          "paginationOpts" in args &&
          typeof args.paginationOpts === "object" &&
          args.paginationOpts !== null &&
          "cursor" in args.paginationOpts
            ? args.paginationOpts.cursor
            : null;
        repositoryPageCursors.push(cursor);
        return cursor === "repo-page-2"
          ? archivedRepositoryPage(repositoryRange(8, 14), { isDone: true, continueCursor: "done" })
          : archivedRepositoryPage(repositoryRange(1, 7), {
              isDone: false,
              continueCursor: "repo-page-2",
            });
      }
      if (name.endsWith("listArchivedThreadRepositoryScopes")) {
        return [];
      }
      return undefined;
    });

    renderArchiveSettingsSection();

    expect(screen.getByText("acme/repo-1")).toBeInTheDocument();
    expect(screen.getByText("acme/repo-7")).toBeInTheDocument();
    expect(screen.queryByText("acme/repo-8")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(repositoryPageSizes).toContain(7);
    expect(repositoryPageCursors.at(-1)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /next archived repositories page/i }));

    expect(screen.getByText("acme/repo-8")).toBeInTheDocument();
    expect(screen.getByText("acme/repo-14")).toBeInTheDocument();
    expect(screen.queryByText("acme/repo-1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next archived repositories page/i })).toBeDisabled();
    expect(repositoryPageCursors.at(-1)).toBe("repo-page-2");

    fireEvent.click(screen.getByRole("button", { name: /previous archived repositories page/i }));

    expect(screen.getByText("acme/repo-1")).toBeInTheDocument();
    expect(screen.getByText("acme/repo-7")).toBeInTheDocument();
    expect(screen.queryByText("acme/repo-8")).not.toBeInTheDocument();
    expect(repositoryPageCursors.at(-1)).toBeNull();
  });

  test("pages archived threads with previous and next controls instead of appending rows", () => {
    const threadPageSizes: unknown[] = [];
    const threadPageCursors: unknown[] = [];
    vi.mocked(useQuery).mockImplementation((reference, args?) => {
      const name = functionName(reference);
      if (name.endsWith("listArchivedRepositories")) {
        return archivedRepositoryPage([], { isDone: true, continueCursor: "done" });
      }
      if (name.endsWith("listArchivedThreadRepositoryScopes")) {
        return [{ repositoryId: null, label: "No repository" }];
      }
      if (name.endsWith("listArchivedThreads")) {
        if (
          typeof args === "object" &&
          args !== null &&
          "paginationOpts" in args &&
          typeof args.paginationOpts === "object" &&
          args.paginationOpts !== null &&
          "numItems" in args.paginationOpts
        ) {
          threadPageSizes.push(args.paginationOpts.numItems);
        }
        const cursor =
          typeof args === "object" &&
          args !== null &&
          "paginationOpts" in args &&
          typeof args.paginationOpts === "object" &&
          args.paginationOpts !== null &&
          "cursor" in args.paginationOpts
            ? args.paginationOpts.cursor
            : null;
        threadPageCursors.push(cursor);
        return cursor === "thread-page-2"
          ? archivedThreadPage(threadRange(8, 14), { isDone: true, continueCursor: "done" })
          : archivedThreadPage(threadRange(1, 7), {
              isDone: false,
              continueCursor: "thread-page-2",
            });
      }
      return undefined;
    });

    renderArchiveSettingsSection();

    expect(screen.getByText("Archived thread 1")).toBeInTheDocument();
    expect(screen.getByText("Archived thread 7")).toBeInTheDocument();
    expect(screen.queryByText("Archived thread 8")).not.toBeInTheDocument();
    expect(threadPageSizes).toContain(7);
    expect(threadPageCursors.at(-1)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /next archived threads page/i }));

    expect(screen.getByText("Archived thread 8")).toBeInTheDocument();
    expect(screen.getByText("Archived thread 14")).toBeInTheDocument();
    expect(screen.queryByText("Archived thread 1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next archived threads page/i })).toBeDisabled();
    expect(threadPageCursors.at(-1)).toBe("thread-page-2");

    fireEvent.click(screen.getByRole("button", { name: /previous archived threads page/i }));

    expect(screen.getByText("Archived thread 1")).toBeInTheDocument();
    expect(screen.getByText("Archived thread 7")).toBeInTheDocument();
    expect(screen.queryByText("Archived thread 8")).not.toBeInTheDocument();
    expect(threadPageCursors.at(-1)).toBeNull();
  });

  test("renders a full archive list skeleton while archived threads load", () => {
    vi.mocked(useQuery).mockImplementation((reference, _args?) => {
      const name = functionName(reference);
      if (name.endsWith("listArchivedRepositories")) {
        return archivedRepositoryPage([], { isDone: true, continueCursor: "done" });
      }
      if (name.endsWith("listArchivedThreadRepositoryScopes")) {
        return [{ repositoryId: null, label: "No repository" }];
      }
      if (name.endsWith("listArchivedThreads")) {
        return undefined;
      }
      return undefined;
    });

    const { container } = renderArchiveSettingsSection();

    expect(container.querySelectorAll("[data-archive-skeleton-row='thread']")).toHaveLength(7);
    expect(container.querySelectorAll("[data-archive-skeleton-row='repository']")).toHaveLength(0);
    expect(container.querySelectorAll("[data-archive-pagination-skeleton='true']")).toHaveLength(1);
    const threadSkeletonRow = container.querySelector("[data-archive-skeleton-row='thread']");
    const paginationSkeleton = container.querySelector("[data-archive-pagination-skeleton='true']");
    expect(threadSkeletonRow?.parentElement?.contains(paginationSkeleton)).toBe(false);
  });

  test("renders a full archive list skeleton while repositories load", () => {
    vi.mocked(useQuery).mockImplementation((reference, _args?) => {
      const name = functionName(reference);
      if (name.endsWith("listArchivedRepositories")) {
        return undefined;
      }
      if (name.endsWith("listArchivedThreadRepositoryScopes")) {
        return [];
      }
      return undefined;
    });

    const { container } = renderArchiveSettingsSection();

    expect(container.querySelectorAll("[data-archive-skeleton-row='repository']")).toHaveLength(7);
    expect(container.querySelectorAll("[data-archive-skeleton-row='thread']")).toHaveLength(0);
    expect(container.querySelectorAll("[data-archive-pagination-skeleton='true']")).toHaveLength(1);
  });
});

function renderArchiveSettingsSection() {
  return render(
    <MemoryRouter>
      <ArchiveSettingsSection />
    </MemoryRouter>,
  );
}

function archivedRepositoryPage(
  page: unknown[],
  options: { isDone: boolean; continueCursor: string },
): { page: unknown[]; isDone: boolean; continueCursor: string } {
  return {
    page,
    isDone: options.isDone,
    continueCursor: options.continueCursor,
  };
}

function archivedThreadPage(
  page: unknown[],
  options: { isDone: boolean; continueCursor: string },
): { page: unknown[]; isDone: boolean; continueCursor: string } {
  return {
    page,
    isDone: options.isDone,
    continueCursor: options.continueCursor,
  };
}

function repositoryRange(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const index = start + offset;
    return repository(`repo_${index}`, `acme/repo-${index}`);
  });
}

function threadRange(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const index = start + offset;
    return thread(`thread_${index}`, `Archived thread ${index}`);
  });
}

function repository(id: string, sourceRepoFullName: string) {
  return {
    _id: id,
    _creationTime: 1,
    ownerTokenIdentifier: "user|archive-test",
    sourceRepoFullName,
    sourceRepoName: sourceRepoFullName.split("/").at(-1) ?? sourceRepoFullName,
    sourceRepoOwner: sourceRepoFullName.split("/")[0] ?? "acme",
    sourceRepoUrl: `https://github.com/${sourceRepoFullName}`,
    sourceRepoId: 1,
    visibility: "private",
    defaultBranch: "main",
    importedAt: 1,
    lastImportedAt: 1,
    archivedAt: 1,
  };
}

function thread(id: string, title: string) {
  return {
    _id: id,
    repositoryId: undefined,
    title,
    mode: "discuss",
    archivedAt: 1,
    repository: null,
  };
}
