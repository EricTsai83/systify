// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ImportRepoDialog } from "./import-repo-dialog";

const { useActionMock, useGitHubConnectionMock, useMutationMock, useQueryMock } = vi.hoisted(() => ({
  useActionMock: vi.fn(),
  useGitHubConnectionMock: vi.fn(),
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useAction: useActionMock,
  useMutation: useMutationMock,
  useQuery: useQueryMock,
}));

vi.mock("@/hooks/use-github-connection", () => ({
  useGitHubConnection: useGitHubConnectionMock,
}));

function functionName(ref: unknown): string {
  try {
    return getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
  } catch {
    return "";
  }
}

const onImported = vi.fn();
const listReposMock = vi.fn();
const disconnectGitHubMock = vi.fn();

beforeEach(() => {
  onImported.mockReset();
  listReposMock.mockReset();
  disconnectGitHubMock.mockReset();
  disconnectGitHubMock.mockResolvedValue(undefined);
  useActionMock.mockReset();
  useMutationMock.mockReset();
  useQueryMock.mockReset();
  useGitHubConnectionMock.mockReset();

  useActionMock.mockImplementation((ref: unknown) => {
    const name = functionName(ref);
    if (name.endsWith("listInstallationRepos")) {
      return listReposMock;
    }
    return vi.fn();
  });
  useMutationMock.mockImplementation((ref: unknown) => {
    const name = functionName(ref);
    if (name.endsWith("disconnectGitHub")) {
      return disconnectGitHubMock;
    }
    return vi.fn();
  });
  useQueryMock.mockReturnValue({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ImportRepoDialog", () => {
  test("renders the suspended installation branch without loading authorized repos", async () => {
    useGitHubConnectionMock.mockReturnValue({
      isLoading: false,
      isConnected: false,
      installationId: 123,
      accountLogin: "acme",
      repositorySelection: "selected",
      installationStatus: "suspended",
      isSuspended: true,
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<ImportRepoDialog open={true} onOpenChange={vi.fn()} onImported={onImported} />);

    expect(screen.getByText("GitHub App installation suspended")).toBeInTheDocument();
    expect(screen.getByText(/acme is connected but unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open GitHub settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disconnect/i })).toBeInTheDocument();
    expect(listReposMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Open GitHub settings/i }));
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/settings/installations/123",
      "systify-github-permissions",
      "width=1020,height=720,popup=yes",
    );

    fireEvent.click(screen.getByRole("button", { name: /Disconnect/i }));
    await waitFor(() => {
      expect(disconnectGitHubMock).toHaveBeenCalledWith({});
    });
  });

  test("renders a truncation notice when authorized repos have more pages", async () => {
    useGitHubConnectionMock.mockReturnValue({
      isLoading: false,
      isConnected: true,
      installationId: 456,
      accountLogin: "acme",
      repositorySelection: "selected",
      installationStatus: "active",
      isSuspended: false,
    });
    listReposMock.mockResolvedValue({
      repos: [
        {
          fullName: "acme/alpha",
          isPrivate: true,
          defaultBranch: "main",
          description: null,
          htmlUrl: "https://github.com/acme/alpha",
          updatedAt: new Date().toISOString(),
          ownerAvatarUrl: "https://example.com/avatar.png",
        },
        {
          fullName: "acme/beta",
          isPrivate: true,
          defaultBranch: "main",
          description: null,
          htmlUrl: "https://github.com/acme/beta",
          updatedAt: new Date().toISOString(),
          ownerAvatarUrl: "https://example.com/avatar.png",
        },
      ],
      totalCount: 3,
      hasMore: true,
    });

    render(<ImportRepoDialog open={true} onOpenChange={vi.fn()} onImported={onImported} />);

    expect(await screen.findByText("Showing 2 of 3 repositories. Use search to find the rest.")).toBeInTheDocument();
    expect(screen.getByText("acme/alpha")).toBeInTheDocument();
    expect(screen.getByText("acme/beta")).toBeInTheDocument();
  });
});
