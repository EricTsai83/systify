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

// StatusPill is exercised by its own tests; in TopBar's scope it only matters
// that the chip is rendered when a repo is attached, not which tone it picks.
vi.mock("@/components/status-pill", () => ({
  StatusPill: () => <div data-testid="status-pill" />,
}));

// StatusPanel mounts inside the desktop Popover and the mobile Sheet. The
// content rendering is covered in status-panel-focused tests; here we only
// need a lightweight stand-in so TopBar's surface assertions don't need a
// repo-aware fixture.
vi.mock("@/components/status-panel", () => ({
  StatusPanel: () => <div data-testid="status-panel" />,
}));

// The Popover wrapper around the desktop StatusPill renders inside a Radix
// portal, which jsdom can mount but which obscures the assertions below.
// Stubbing to plain divs keeps the shape (`Trigger > children` + portaled
// `Content`) addressable while side-stepping the portal/animation machinery.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { TopBar, type TopBarRepoDetail } from "./top-bar";

const threadId = "thread_1" as ThreadId;
const repoId = "repo_1" as RepositoryId;

afterEach(() => {
  cleanup();
});

type TopBarTestProps = React.ComponentProps<typeof TopBar>;

function makeRepoDetail(overrides: Partial<TopBarRepoDetail> = {}): TopBarRepoDetail {
  // The TopBar surface actually reads only `sourceRepoFullName` and
  // `importStatus` off the repository — the rest of the Convex Doc shape is
  // irrelevant to this test, so we cast a narrow fixture rather than
  // hand-typing every field. The `as` form keeps the cast explicit so a future
  // accidental access to a missing field stays loud (undefined at runtime,
  // visible in jsdom).
  const repository = {
    sourceRepoFullName: "octocat/hello-world",
    importStatus: "completed",
    defaultBranch: "main",
    detectedLanguages: ["TypeScript"],
  } as unknown as TopBarRepoDetail["repository"];

  return {
    repository,
    isArchived: false,
    archivedAt: null,
    sandbox: null,
    sandboxModeStatus: { reasonCode: "available", message: null },
    hasRemoteUpdates: false,
    fileCount: 12,
    fileCountLabel: "12",
    jobs: [],
    activeDeepAnalysisJob: null,
    artifacts: [],
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
    isStatusPanelOpen: false,
    onSetStatusPanelOpen: vi.fn(),
    onArchiveRepo: vi.fn(),
    onRestoreRepo: vi.fn(),
    onPermanentDeleteRepo: vi.fn(),
    onThreadMovedToWorkspace: vi.fn(),
    isDesktopLayout: true,
    onSync: vi.fn(),
    onRunAnalysis: vi.fn(),
    onViewArtifact: vi.fn(),
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
    renderTopBar({
      attachedRepository: { id: repoId, fullName: "octocat/hello-world", shortName: "hello-world" },
    });

    expect(screen.queryByTestId("attach-repo-menu")).not.toBeInTheDocument();
    expect(screen.getByText("octocat/hello-world")).toBeInTheDocument();
  });
});

describe("TopBar kebab actions reflect archive state", () => {
  test("active repo shows Archive action only", () => {
    renderTopBar();

    expect(screen.getByText("Archive repository")).toBeInTheDocument();
    expect(screen.queryByText("Restore repository")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete permanently")).not.toBeInTheDocument();
  });

  test("archived repo shows Restore + Delete permanently actions", () => {
    renderTopBar({
      repoDetail: makeRepoDetail({ isArchived: true, archivedAt: Date.now() }),
    });

    expect(screen.getByText("Restore repository")).toBeInTheDocument();
    expect(screen.getByText("Delete permanently")).toBeInTheDocument();
    expect(screen.queryByText("Archive repository")).not.toBeInTheDocument();
  });
});
