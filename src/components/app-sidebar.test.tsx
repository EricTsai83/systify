// @vitest-environment jsdom

import type React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { AppSidebarLeft, AppSidebarRight } from "./app-sidebar";
import type { ThreadId, WorkspaceId } from "@/lib/types";

const { createThreadMutationMock, useMutationMock, useQueryMock } = vi.hoisted(() => ({
  createThreadMutationMock: vi.fn(),
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
  useConvex: () => ({ prewarmQuery: () => undefined }),
}));

vi.mock("react-router-dom", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: { to: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  // `useChatMode` (used inside the sidebar header) calls
  // `useLocation` / `useParams` / `useNavigate`. Stub them with the
  // minimal shape the hook reads so the sidebar tests keep passing
  // without re-introducing react-router's BrowserRouter context.
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }),
  useParams: () => ({}),
  useNavigate: () => () => {},
}));

// `WorkspaceModeSwitcher` lives inside the sidebar but its rendering is
// irrelevant to these sidebar-specific tests. Mock it out so we don't
// have to wire a real router context just for the switcher's
// `useNavigate` call inside its click handler.
vi.mock("@/components/workspace-mode-switcher", () => ({
  WorkspaceModeSwitcher: () => <div data-testid="workspace-mode-switcher" />,
}));

vi.mock("@/components/profile-card", () => ({
  ProfileCard: () => <div>profile</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode; selected?: boolean }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <div />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
}));

vi.mock("@/components/logo", () => ({
  Logo: () => <div>logo</div>,
}));

vi.mock("@/components/import-repo-dialog", () => ({
  ImportRepoDialog: () => <div>import repo</div>,
}));

vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

// `LibraryAskPanel` is rendered by `AppSidebarRight`; the thread-list
// tests below exercise `AppSidebarLeft`. Mock it so the suite doesn't
// pull in the Ask panel's transitive module graph.
vi.mock("@/components/library-ask-panel", () => ({
  LibraryAskPanel: () => <div data-testid="library-ask-panel" />,
}));

// `LibraryTree` is only rendered when the left sidebar runs in Library
// mode (effectiveChatMode === "library"). Mocking it keeps the
// thread-rail tests below independent of the folder-tree module graph.
vi.mock("@/components/library-tree", () => ({
  LibraryTree: () => <div data-testid="library-tree" />,
}));

const threadOne = {
  _id: "thread_1",
  title: "First thread",
  repositoryId: null,
  lastMessageAt: 1,
} as unknown as Doc<"threads">;

const threadTwo = {
  _id: "thread_2",
  title: "Second thread",
  repositoryId: null,
  lastMessageAt: 2,
} as unknown as Doc<"threads">;

const threadThree = {
  _id: "thread_3",
  title: "Third thread",
  repositoryId: null,
  lastMessageAt: 3,
} as unknown as Doc<"threads">;

let threadsResult: Doc<"threads">[] | undefined;

beforeEach(() => {
  threadsResult = [];
  createThreadMutationMock.mockReset();
  useMutationMock.mockReset();
  useQueryMock.mockReset();
  useMutationMock.mockReturnValue(createThreadMutationMock);
  useQueryMock.mockImplementation(() => threadsResult);
});

afterEach(() => {
  cleanup();
});

describe("AppSidebarLeft", () => {
  test("surfaces create-thread failures through the shared error callback", async () => {
    const onError = vi.fn();
    createThreadMutationMock.mockRejectedValueOnce(new Error("Rate limit exceeded."));

    renderLeftSidebar({ onError });

    fireEvent.click(screen.getByRole("button", { name: /new thread/i }));

    await waitFor(() => {
      expect(onError).toHaveBeenLastCalledWith("Rate limit exceeded.");
    });
  });

  test("forwards the active service mode so the new thread matches the sidebar filter", async () => {
    createThreadMutationMock.mockResolvedValueOnce("thread_new" as ThreadId);

    renderLeftSidebar();

    fireEvent.click(screen.getByRole("button", { name: /new thread/i }));

    // Without an explicit `mode`, the backend defaults a repo-bound
    // workspace's thread to `ask`, which the `discuss` sidebar filter hides.
    await waitFor(() => {
      expect(createThreadMutationMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "discuss" }));
    });
  });

  test("announces thread-count deltas with distinct live-region text", () => {
    threadsResult = [threadOne];
    const { rerender } = renderLeftSidebar();

    expect(screen.getByRole("status")).toHaveTextContent("");

    threadsResult = [threadOne, threadTwo];
    rerender(createLeftSidebarElement());
    expect(screen.getByRole("status")).toHaveTextContent("1 new conversation. 2 total.");

    threadsResult = [threadOne, threadTwo, threadThree];
    rerender(createLeftSidebarElement());
    expect(screen.getByRole("status")).toHaveTextContent("1 new conversation. 3 total.");
  });

  test("offers repository import instead of manual workspace creation", () => {
    renderLeftSidebar();

    expect(screen.queryByText(/new workspace/i)).not.toBeInTheDocument();
    expect(screen.getByText(/import repo/i)).toBeInTheDocument();
  });
});

describe("AppSidebarRight", () => {
  test("renders the Library Ask panel", () => {
    render(
      <AppSidebarRight
        activeWorkspaceId={"workspace_1" as WorkspaceId}
        askThreadId={null}
        activeArtifactId={null}
        hasArtifacts={true}
        onSelectArtifact={vi.fn()}
        onSelectAskThread={vi.fn()}
      />,
    );

    expect(screen.getByTestId("library-ask-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new thread/i })).not.toBeInTheDocument();
  });
});

function renderLeftSidebar({
  onError = vi.fn(),
}: {
  onError?: (message: string | null) => void;
} = {}) {
  return render(createLeftSidebarElement({ onError }));
}

function createLeftSidebarElement({
  onError = vi.fn(),
}: {
  onError?: (message: string | null) => void;
} = {}) {
  return (
    <AppSidebarLeft
      repositories={[] as Doc<"repositories">[]}
      workspaces={[] as Doc<"workspaces">[]}
      activeWorkspaceId={null as WorkspaceId | null}
      onSwitchWorkspace={vi.fn()}
      selectedThreadId={null as ThreadId | null}
      onSelectThread={vi.fn()}
      onDeleteThread={vi.fn()}
      onImported={vi.fn()}
      onError={onError}
    />
  );
}
