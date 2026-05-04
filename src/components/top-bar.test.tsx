// @vitest-environment jsdom

import type React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RepositoryId, ThreadId } from "@/lib/types";

// Stub heavyweight UI primitives down to plain DOM so the test focuses on the
// TopBar's own conditional rendering rather than Radix portal mechanics.
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <div />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button aria-label="Toggle sidebar" />,
}));

// AttachRepoMenu pulls in `useMutation` from convex/react; we don't exercise
// the mutation flow here, so a lightweight stand-in keeps the test deterministic
// without needing a Convex provider. The mock only renders when TopBar
// actually mounts AttachRepoMenu — i.e. when no repo is attached to the
// thread — so a fixed "Attach repository" label is enough to assert presence.
vi.mock("@/components/attach-repo-menu", () => ({
  AttachRepoMenu: ({ threadId }: { threadId: ThreadId }) => (
    <div data-testid="attach-repo-menu" data-thread-id={threadId}>
      Attach repository
    </div>
  ),
}));

vi.mock("@/components/repo-info-popover", () => ({
  RepoInfoPopover: ({ title }: { title: string }) => <span>{title}</span>,
}));

vi.mock("@/components/repo-status-indicator", () => ({
  RepoStatusIndicator: () => null,
}));

import { TopBar, type TopBarRepoDetail } from "./top-bar";

const threadId = "thread_1" as ThreadId;
const repoId = "repo_1" as RepositoryId;

afterEach(() => {
  cleanup();
});

type TopBarTestProps = React.ComponentProps<typeof TopBar>;

function makeRepoDetail(overrides: Partial<TopBarRepoDetail> = {}): TopBarRepoDetail {
  return {
    repository: {
      sourceRepoFullName: "octocat/hello-world",
      importStatus: "completed",
      defaultBranch: "main",
      detectedLanguages: ["TypeScript"],
    },
    sandbox: null,
    sandboxModeStatus: { reasonCode: "available", message: null },
    hasRemoteUpdates: false,
    fileCount: 12,
    fileCountLabel: "12",
    ...overrides,
  };
}

function createTopBarProps(overrides: Partial<TopBarTestProps> = {}): TopBarTestProps {
  return {
    repoDetail: makeRepoDetail(),
    threadId,
    attachedRepository: null,
    availableRepositories: [],
    isSyncing: false,
    onSync: vi.fn(),
    onDeleteRepo: vi.fn(),
    onRunAnalysis: vi.fn(),
    onThreadMovedToWorkspace: vi.fn(),
    ...overrides,
  };
}

function renderTopBar(overrides: Partial<TopBarTestProps> = {}) {
  return render(<TopBar {...createTopBarProps(overrides)} />);
}

describe("TopBar attach repo chip behavior", () => {
  test("hides attach chip when no thread is selected", () => {
    renderTopBar({ threadId: null });

    expect(screen.queryByTestId("attach-repo-menu")).not.toBeInTheDocument();
  });

  test("shows attach chip when thread exists but no repository is attached", () => {
    // Thread-only routes (repo just got detached, or a fresh thread) must
    // still surface the attach affordance — otherwise the user has no way
    // back to a repo-grounded conversation from the TopBar.
    renderTopBar();

    const chip = screen.getByTestId("attach-repo-menu");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("Attach repository");
  });

  test("hides standalone attach chip once a repository is bound to the thread", () => {
    // Once a repo is attached, swap/detach controls live inside the
    // RepoInfoPopover's workspace section instead of in the TopBar — the
    // header stays uncluttered for the long-tail of session time the user
    // isn't swapping. The attached repo name is still visible via the
    // (mocked) popover trigger that wraps the title.
    renderTopBar({
      attachedRepository: { id: repoId, fullName: "octocat/hello-world", shortName: "hello-world" },
    });

    expect(screen.queryByTestId("attach-repo-menu")).not.toBeInTheDocument();
    expect(screen.getByText("octocat/hello-world")).toBeInTheDocument();
  });
});
