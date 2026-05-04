// @vitest-environment jsdom

import type React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { RepositoryShell } from "./repository-shell";
import type { RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";

// Convex's `api`/`anyApi` proxy returns a fresh FunctionReference object on
// every property access, so `query === api.foo.bar` is never true. Compare the
// canonical "module:function" name string instead.
const queryName = (query: unknown) => {
  try {
    return getFunctionName(query as Parameters<typeof getFunctionName>[0]);
  } catch {
    return null;
  }
};

const { useMutationMock, useQueryMock } = vi.hoisted(() => ({
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

const navigateMock = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: ({
    activeWorkspaceId,
    onImported,
  }: {
    activeWorkspaceId: WorkspaceId | null;
    onImported: (repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => void;
  }) => (
    <div data-testid="sidebar" data-active-workspace-id={activeWorkspaceId ?? ""}>
      <button
        type="button"
        data-testid="sidebar-import"
        onClick={() =>
          onImported(
            "repo_imported" as RepositoryId,
            "thread_imported" as ThreadId,
            "workspace_imported" as WorkspaceId,
          )
        }
      >
        Import from sidebar
      </button>
    </div>
  ),
}));

vi.mock("@/components/top-bar", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));

vi.mock("@/components/chat-panel", () => ({
  ChatPanel: ({
    showArtifactToggle,
    isArtifactPanelOpen,
    onToggleArtifactPanel,
  }: {
    showArtifactToggle?: boolean;
    isArtifactPanelOpen?: boolean;
    onToggleArtifactPanel?: () => void;
  }) => (
    <div data-testid="chat-panel">
      {showArtifactToggle ? (
        <button
          data-testid="artifact-panel-toggle"
          data-open={isArtifactPanelOpen ? "true" : "false"}
          onClick={onToggleArtifactPanel}
        >
          Toggle artifacts
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/artifact-panel", () => ({
  ArtifactPanel: () => <div data-testid="artifact-panel" />,
}));

vi.mock("@/components/empty-state", () => ({
  EmptyState: ({
    onImported,
  }: {
    onImported: (repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => void;
  }) => (
    <button
      type="button"
      data-testid="empty-state"
      onClick={() =>
        onImported("repo_empty" as RepositoryId, "thread_empty" as ThreadId, "workspace_empty" as WorkspaceId)
      }
    >
      Empty import
    </button>
  ),
}));

vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/app-notice", () => ({
  AppNotice: () => null,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    <div data-testid="artifact-sheet" data-open={open ? "true" : "false"}>
      {children}
    </div>
  ),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div />,
}));

vi.mock("@/hooks/use-thread-capabilities", () => ({
  useThreadCapabilities: () => ({
    availableModes: ["discuss"],
    defaultMode: "discuss",
    attachedRepository: null,
    sandboxModeStatus: { reasonCode: "missing_sandbox", message: null },
    disabledReasons: {},
    isMissingThread: false,
    isLoading: false,
    // Plan 10 — sandboxCostBudget is null when no repo is attached
    // (which is the no-repo fixture case here).
    sandboxCostBudget: null,
  }),
}));

vi.mock("@/hooks/use-check-for-updates", () => ({
  useCheckForUpdates: vi.fn(),
}));

vi.mock("@/hooks/use-repository-actions", () => ({
  useRepositoryActions: () => ({
    isSending: false,
    handleSendMessage: vi.fn(),
    isRunningAnalysis: false,
    handleRunAnalysis: vi.fn(),
    isSyncing: false,
    handleSync: vi.fn(),
    isDeletingThread: false,
    handleDeleteThread: vi.fn(),
    isDeletingRepo: false,
    handleDeleteRepo: vi.fn(),
  }),
}));

type MatchMediaListener = (event: MediaQueryListEvent) => void;
type ViewerPreferencesResult =
  | { lastActiveWorkspaceId: WorkspaceId | null; lastActiveWorkspaceUpdatedAt: number | null }
  | null
  | undefined;

let repositoriesResult: Doc<"repositories">[] | undefined;
let workspacesResult: Doc<"workspaces">[] | undefined;
let viewerPreferencesResult: ViewerPreferencesResult;
let ownerThreadsResult: Doc<"threads">[] | undefined;
let isDesktopMatches = false;
let mediaListener: MatchMediaListener | null = null;
let storedActiveWorkspaceId: string | null = null;

// Convex's `useMutation` returns a callable `ReactMutation` object that also
// exposes `.withOptimisticUpdate(...)`. The repository-shell now wraps
// `touchWorkspace` with an optimistic update, so the mock has to be both
// callable AND carry that method (returning itself so the wrapped value is
// still the same vi.fn we assert against).
type CallableMockWithOptimistic = ReturnType<typeof vi.fn> & {
  withOptimisticUpdate: ReturnType<typeof vi.fn>;
};

function makeCallableMock(): CallableMockWithOptimistic {
  const fn = vi.fn() as CallableMockWithOptimistic;
  fn.mockResolvedValue(null);
  fn.withOptimisticUpdate = vi.fn().mockReturnValue(fn);
  return fn;
}

function resetCallableMock(fn: CallableMockWithOptimistic) {
  fn.mockReset();
  fn.mockResolvedValue(null);
  fn.withOptimisticUpdate.mockReset();
  fn.withOptimisticUpdate.mockReturnValue(fn);
}

const touchWorkspaceMock = makeCallableMock();
const initializeWorkspacesMock = makeCallableMock();
const createThreadMock = makeCallableMock();

beforeEach(() => {
  navigateMock.mockReset();
  storedActiveWorkspaceId = null;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => (key === "systify.activeWorkspaceId" ? storedActiveWorkspaceId : null)),
      setItem: vi.fn((key: string, value: string) => {
        if (key === "systify.activeWorkspaceId") {
          storedActiveWorkspaceId = value;
        }
      }),
      removeItem: vi.fn((key: string) => {
        if (key === "systify.activeWorkspaceId") {
          storedActiveWorkspaceId = null;
        }
      }),
    },
  });
  repositoriesResult = [];
  // Default to "no workspaces yet" so existing tests that don't care about the
  // workspace reconciliation paths short-circuit on `workspaces.length === 0`.
  workspacesResult = [];
  // Default to "no preference recorded" so the DB-wins effect is a no-op for
  // tests that aren't exercising cross-device convergence.
  viewerPreferencesResult = null;
  ownerThreadsResult = [];
  isDesktopMatches = false;
  mediaListener = null;

  resetCallableMock(touchWorkspaceMock);
  resetCallableMock(initializeWorkspacesMock);
  resetCallableMock(createThreadMock);

  useMutationMock.mockReset();
  useQueryMock.mockReset();
  // Dispatch by mutation name so each call site gets its own spy. Falls
  // back to a fresh resolved-null mock for mutations the tests don't assert on.
  useMutationMock.mockImplementation((mutation: unknown) => {
    switch (queryName(mutation)) {
      case "workspaces:touchWorkspace":
        return touchWorkspaceMock;
      case "workspaces:initializeWorkspaces":
        return initializeWorkspacesMock;
      case "chat/threads:createThread":
        return createThreadMock;
      default:
        return vi.fn().mockResolvedValue(null);
    }
  });
  // Dispatch by query name. The previous arg-shape dispatcher collided for
  // any two queries that take no args (e.g. listRepositories, listWorkspaces,
  // getViewerPreferences), making it impossible to vary viewerPreferences
  // without also changing repositories. Each query now has its own knob.
  useQueryMock.mockImplementation((query: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    switch (queryName(query)) {
      case "repositories:listRepositories":
        return repositoriesResult;
      case "workspaces:listWorkspaces":
        return workspacesResult;
      case "userPreferences:getViewerPreferences":
        return viewerPreferencesResult;
      case "chat/threads:listThreads":
        return ownerThreadsResult;
      case "repositories:getRepositoryDetail":
        return null;
      case "chat/threads:listMessages":
        return [];
      case "chat/streaming:getActiveMessageStream":
        return null;
      default:
        return undefined;
    }
  });

  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: isDesktopMatches,
    media: "(min-width: 1024px)",
    onchange: null,
    addEventListener: (_: "change", listener: MatchMediaListener) => {
      mediaListener = listener;
    },
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
});

const repoId = "repo_1" as RepositoryId;

function makeRepository(overrides: Partial<Doc<"repositories">> = {}): Doc<"repositories"> {
  return {
    _id: repoId,
    _creationTime: Date.now(),
    sourceRepoFullName: "octocat/hello-world",
    ...overrides,
  } as unknown as Doc<"repositories">;
}

function makeWorkspace(overrides: Omit<Partial<Doc<"workspaces">>, "_id"> & { _id: string }): Doc<"workspaces"> {
  return {
    _creationTime: Date.now(),
    ownerTokenIdentifier: "user|test",
    name: "Workspace",
    color: "blue",
    lastAccessedAt: Date.now(),
    ...overrides,
  } as unknown as Doc<"workspaces">;
}

describe("RepositoryShell artifact toggle behavior", () => {
  test("hides the artifact toggle while workspace is in no-repo state", () => {
    // The no-repo guard is structural — the ChatPanel-level toggle does not
    // render — instead of a disabled-but-present button. Assert the
    // absence and confirm the sheet stays closed once the workspace
    // transitions into ready, so the previous click intent (had there been
    // one) cannot have leaked into shared state.
    const { rerender } = render(<RepositoryShell urlThreadId={null} urlRepositoryId={null} />);

    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-panel-toggle")).not.toBeInTheDocument();

    repositoriesResult = [makeRepository()];
    rerender(<RepositoryShell urlThreadId={null} urlRepositoryId={repoId} />);

    expect(screen.getByTestId("artifact-sheet")).toHaveAttribute("data-open", "false");
  });

  test("opens mobile sheet in ready state and closes it on desktop breakpoint", () => {
    repositoriesResult = [makeRepository()];

    render(<RepositoryShell urlThreadId={null} urlRepositoryId={repoId} />);
    expect(screen.getByTestId("artifact-sheet")).toHaveAttribute("data-open", "false");

    fireEvent.click(screen.getByTestId("artifact-panel-toggle"));
    expect(screen.getByTestId("artifact-sheet")).toHaveAttribute("data-open", "true");

    act(() => {
      mediaListener?.({ matches: true } as MediaQueryListEvent);
    });
    expect(screen.queryByTestId("artifact-sheet")).not.toBeInTheDocument();
  });
});

describe("RepositoryShell import workspace routing", () => {
  test("sidebar import switches the active workspace and opens the imported default thread", () => {
    render(<RepositoryShell urlThreadId={null} urlRepositoryId={null} />);

    fireEvent.click(screen.getByTestId("sidebar-import"));

    expect(localStorage.getItem("systify.activeWorkspaceId")).toBe("workspace_imported");
    expect(navigateMock).toHaveBeenCalledWith("/t/thread_imported");
  });

  test("empty-state import follows the same workspace switch and thread navigation path", () => {
    render(<RepositoryShell urlThreadId={null} urlRepositoryId={null} />);

    fireEvent.click(screen.getByTestId("empty-state"));

    expect(localStorage.getItem("systify.activeWorkspaceId")).toBe("workspace_empty");
    expect(navigateMock).toHaveBeenCalledWith("/t/thread_empty");
  });
});

describe("RepositoryShell workspace reconciliation", () => {
  // The DB is the canonical source of truth and localStorage is a first-paint
  // cache. These three tests pin the contracts spelled out in
  // docs/workspace-persistence-system-design.md so future refactors can't
  // silently drop cross-device convergence, fallback seeding, or stale-cache
  // recovery without a failing test.

  test("DB-wins reconciliation overrides cached workspace once both queries resolve", async () => {
    // Cross-device case: this browser cached `ws_cached`, but the user's
    // canonical selection on another device is `ws_db`. The shell must adopt
    // `ws_db` and not issue a redundant touchWorkspace (the DB already holds
    // the right value).
    storedActiveWorkspaceId = "ws_cached";
    workspacesResult = [makeWorkspace({ _id: "ws_db" }), makeWorkspace({ _id: "ws_cached" })];
    viewerPreferencesResult = {
      lastActiveWorkspaceId: "ws_db" as WorkspaceId,
      lastActiveWorkspaceUpdatedAt: 1,
    };

    render(<RepositoryShell urlThreadId={null} urlRepositoryId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_db");
    });
    expect(localStorage.getItem("systify.activeWorkspaceId")).toBe("ws_db");
    expect(touchWorkspaceMock).not.toHaveBeenCalled();
  });

  test("fallback effect seeds touchWorkspace when no preference exists yet", async () => {
    // Brand-new browser: cache empty, DB has no preference recorded. The
    // fallback effect should pick the first (most-recent) workspace AND
    // promote it into userPreferences so the next device convergence works.
    // Without the seed, a fresh browser would silently re-fall-back forever
    // and never establish a canonical selection.
    storedActiveWorkspaceId = null;
    workspacesResult = [makeWorkspace({ _id: "ws_first" }), makeWorkspace({ _id: "ws_second" })];
    viewerPreferencesResult = null;

    render(<RepositoryShell urlThreadId={null} urlRepositoryId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_first");
    });
    expect(touchWorkspaceMock).toHaveBeenCalledWith({ workspaceId: "ws_first" });
  });

  test("stale localStorage pointing at a deleted workspace recovers via fallback and seeds the DB", async () => {
    // Cache points at a workspace deleted (on another device) since the cache
    // was written. The current device has no DB preference yet, so the
    // fallback path must both pick a surviving workspace and seed it as the
    // canonical selection.
    storedActiveWorkspaceId = "ws_deleted";
    workspacesResult = [makeWorkspace({ _id: "ws_alive" })];
    viewerPreferencesResult = null;

    render(<RepositoryShell urlThreadId={null} urlRepositoryId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_alive");
    });
    expect(localStorage.getItem("systify.activeWorkspaceId")).toBe("ws_alive");
    expect(touchWorkspaceMock).toHaveBeenCalledWith({ workspaceId: "ws_alive" });
  });

  test("live cross-tab push updates the active workspace without remounting", async () => {
    // Tab A renders happily on `ws_a`. Tab B then switches the user to `ws_b`;
    // Convex's subscription pushes the new viewerPreferences into Tab A's
    // `useQuery`. Without the one-shot reconciliation guard, the effect must
    // observe the diff and adopt `ws_b` live in Tab A — no reload required.
    storedActiveWorkspaceId = "ws_a";
    workspacesResult = [makeWorkspace({ _id: "ws_a" }), makeWorkspace({ _id: "ws_b" })];
    viewerPreferencesResult = {
      lastActiveWorkspaceId: "ws_a" as WorkspaceId,
      lastActiveWorkspaceUpdatedAt: 1,
    };

    const { rerender } = render(<RepositoryShell urlThreadId={null} urlRepositoryId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_a");
    });

    // Simulate Tab B's switch landing in Tab A's subscription.
    viewerPreferencesResult = {
      lastActiveWorkspaceId: "ws_b" as WorkspaceId,
      lastActiveWorkspaceUpdatedAt: 2,
    };
    rerender(<RepositoryShell urlThreadId={null} urlRepositoryId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_b");
    });
  });
});
