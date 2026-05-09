// @vitest-environment jsdom

import type React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { AppSidebar } from "./app-sidebar";
import type { ThreadId, WorkspaceId } from "@/lib/types";

const { createThreadMutationMock, useMutationMock, useQueryMock } = vi.hoisted(() => ({
  createThreadMutationMock: vi.fn(),
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
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

describe("AppSidebar", () => {
  test("surfaces create-thread failures through the shared error callback", async () => {
    const onError = vi.fn();
    createThreadMutationMock.mockRejectedValueOnce(new Error("Rate limit exceeded."));

    renderSidebar({ onError });

    fireEvent.click(screen.getByRole("button", { name: /new thread/i }));

    await waitFor(() => {
      expect(onError).toHaveBeenLastCalledWith("Rate limit exceeded.");
    });
  });

  test("announces thread-count deltas with distinct live-region text", () => {
    threadsResult = [threadOne];
    const { rerender } = renderSidebar();

    expect(screen.getByRole("status")).toHaveTextContent("");

    threadsResult = [threadOne, threadTwo];
    rerender(createSidebarElement());
    expect(screen.getByRole("status")).toHaveTextContent("1 new conversation. 2 total.");

    threadsResult = [threadOne, threadTwo, threadThree];
    rerender(createSidebarElement());
    expect(screen.getByRole("status")).toHaveTextContent("1 new conversation. 3 total.");
  });

  test("offers repository import instead of manual workspace creation", () => {
    renderSidebar();

    expect(screen.queryByText(/new workspace/i)).not.toBeInTheDocument();
    expect(screen.getByText(/import repo/i)).toBeInTheDocument();
  });
});

function renderSidebar({
  onError = vi.fn(),
}: {
  onError?: (message: string | null) => void;
} = {}) {
  return render(createSidebarElement({ onError }));
}

function createSidebarElement({
  onError = vi.fn(),
}: {
  onError?: (message: string | null) => void;
} = {}) {
  return (
    <AppSidebar
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
