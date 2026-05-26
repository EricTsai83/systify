// @vitest-environment jsdom

import type React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { RepositoryShell } from "./repository-shell";
import type { OnImportedCallback, RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";
import { DEFAULT_AUTHENTICATED_PATH, discussPath } from "@/route-paths";

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

const { useMutationMock, useQueryMock, useChatModeMock, useThreadCapabilitiesMock } = vi.hoisted(() => ({
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
  useChatModeMock: vi.fn(),
  useThreadCapabilitiesMock: vi.fn(),
}));

const navigateMock = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
  useQueries: () => ({}),
  useConvex: () => ({ prewarmQuery: () => undefined }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }),
  useParams: () => ({}),
}));

// `useChatMode` is mocked at the hook level so tests can dictate the
// active service mode without depending on URL-shape mocks. Post-Lab
// collapse: the shell gates the artifact panel surface on `mode === "library"`
// (or Discuss with an attached repo). The suite defaults to `library` to
// keep the legacy "ready state" artifact-toggle assertions intact; the
// dedicated discuss test below overrides it.
vi.mock("@/hooks/use-service-mode", () => ({
  useChatMode: useChatModeMock,
}));

vi.mock("@/components/app-sidebar", () => ({
  AppSidebarLeft: ({
    activeWorkspaceId,
    onImported,
  }: {
    activeWorkspaceId: WorkspaceId | null;
    onImported: OnImportedCallback;
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
            "discuss",
          )
        }
      >
        Import from sidebar
      </button>
    </div>
  ),
  AppSidebarRight: () => null,
}));

vi.mock("@/components/top-bar", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));

vi.mock("@/components/chat-panel", () => ({
  ChatContainer: ({
    chatMode,
    showArtifactToggle,
    isArtifactPanelOpen,
    onToggleArtifactPanel,
  }: {
    chatMode?: string;
    showArtifactToggle?: boolean;
    isArtifactPanelOpen?: boolean;
    onToggleArtifactPanel?: () => void;
  }) => (
    <div data-testid="chat-panel" data-chat-mode={chatMode ?? ""}>
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

vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/app-notice", () => ({
  AppNotice: () => null,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({
    open,
    "aria-label": ariaLabel,
    children,
  }: {
    "open": boolean;
    "aria-label"?: string;
    "children": React.ReactNode;
  }) => (
    <div data-open={open ? "true" : "false"} aria-label={ariaLabel}>
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div />,
}));

vi.mock("@/hooks/use-thread-capabilities", () => ({
  useThreadCapabilities: useThreadCapabilitiesMock,
}));

vi.mock("@/hooks/use-check-for-updates", () => ({
  useCheckForUpdates: vi.fn(),
}));

vi.mock("@/hooks/use-chat-lifecycle", () => ({
  useChatLifecycle: () => ({
    isSending: false,
    handleSendMessage: vi.fn(),
    isCancellingReply: false,
    handleCancelInFlightReply: vi.fn(),
    isDeletingThread: false,
    handleDeleteThread: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-repository-lifecycle", () => ({
  useRepositoryLifecycle: () => ({
    isSyncing: false,
    handleSync: vi.fn(),
    isArchivingRepo: false,
    handleArchiveRepo: vi.fn(),
    isRestoringRepo: false,
    handleRestoreRepo: vi.fn(),
    isPermanentDeletingRepo: false,
    handlePermanentDeleteRepo: vi.fn(),
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
  resetCallableMock(createThreadMock);

  useMutationMock.mockReset();
  useQueryMock.mockReset();
  useChatModeMock.mockReset();
  useChatModeMock.mockReturnValue({
    mode: "library",
    availability: undefined,
    placeholderAvailability: {
      modes: {
        discuss: { enabled: true },
        library: { enabled: true },
      },
      defaultMode: "library",
      hasAttachedRepo: true,
      hasAtLeastOneArtifact: false,
      askReadiness: { enabled: false, code: "library_no_artifact", message: "loading" },
      grounding: {
        library: { enabled: false, code: "library_no_artifact", message: "loading" },
        sandbox: { enabled: false, code: "sandbox_missing", message: "loading", isActivatable: false },
      },
    },
  });
  useThreadCapabilitiesMock.mockReset();
  useThreadCapabilitiesMock.mockReturnValue({
    modes: {
      discuss: { enabled: true },
      library: {
        enabled: false,
        code: "no_repository_attached",
        message: "Attach a repository to use Library mode.",
      },
    },
    defaultMode: "discuss",
    attachedRepository: null,
    sandboxModeStatus: { reasonCode: "missing_sandbox", message: null },
    isMissingThread: false,
    isLoading: false,
    sandboxCostBudget: null,
    sandboxIsActivatable: false,
  });
  // Dispatch by mutation name so each call site gets its own spy. Falls
  // back to a fresh resolved-null mock for mutations the tests don't assert on.
  useMutationMock.mockImplementation((mutation: unknown) => {
    switch (queryName(mutation)) {
      case "workspaces:touchWorkspace":
        return touchWorkspaceMock;
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
        // After the archive feature, `null` means "repo unavailable" and
        // triggers the inline missing-repo empty state. Tests that don't
        // care about the detail still need a non-null payload so the shell
        // proceeds to its normal ready branch.
        return {
          repository: makeRepository(),
          isArchived: false,
          archivedAt: null,
          artifacts: [],
          jobs: [],
          threads: [],
          fileCount: 0,
          fileCountLabel: "0",
          sandboxModeStatus: { reasonCode: "missing_sandbox", message: null },
          hasRemoteUpdates: false,
          latestFailedImportError: null,
          sandbox: null,
        };
      case "chat/threads:listMessages":
        return [];
      case "chat/streaming:getActiveMessageStream":
        return null;
      case "workspaceModeEligibility:evaluate":
        // `useChatMode` is mocked at the hook level above, so this case
        // is defensive: returning a placeholder keeps the underlying query
        // shape coherent for any code path that might subscribe directly.
        return {
          modes: {
            discuss: { enabled: true },
            library: {
              enabled: false,
              code: "no_repository_attached",
              message: "Attach a repository to use Library mode.",
            },
          },
          defaultMode: "discuss",
          hasAttachedRepo: false,
          hasAtLeastOneArtifact: false,
          askReadiness: { enabled: false, code: "no_repository_attached", message: "loading" },
          grounding: {
            library: { enabled: false, code: "no_repository_attached", message: "loading" },
            sandbox: { enabled: false, code: "no_repository_attached", message: "loading", isActivatable: false },
          },
        };
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

// Convenience: build a repo-bound workspace fixture and the matching repo so
// the whole "URL points at a repo workspace" branch of RepositoryShell can
// resolve synchronously from the cached `listWorkspaces` query (which is the
// design that lets the TopBar paint the right repo title without waiting on
// `getThreadContext`).
function makeRepoWorkspace(): { workspaceId: WorkspaceId; workspace: Doc<"workspaces"> } {
  const workspaceId = "ws_repo" as WorkspaceId;
  return {
    workspaceId,
    workspace: makeWorkspace({ _id: workspaceId, repositoryId: repoId }),
  };
}

describe("RepositoryShell artifact toggle behavior", () => {
  test("keeps chat hot-path subscriptions out of the workspace shell", () => {
    repositoriesResult = [makeRepository()];
    const { workspaceId, workspace } = makeRepoWorkspace();
    workspacesResult = [workspace];

    render(<RepositoryShell urlWorkspaceId={workspaceId} urlThreadId={null} />);

    const subscribedQueries = useQueryMock.mock.calls.map(([query]) => queryName(query));
    expect(subscribedQueries).not.toContain("chat/threads:listMessages");
    expect(subscribedQueries).not.toContain("chat/streaming:getActiveMessageStream");
  });

  test("opens mobile drawer in ready state and closes it on desktop breakpoint", () => {
    repositoriesResult = [makeRepository()];
    const { workspaceId, workspace } = makeRepoWorkspace();
    workspacesResult = [workspace];

    render(<RepositoryShell urlWorkspaceId={workspaceId} urlThreadId={null} />);
    expect(screen.getByLabelText("artifact-drawer")).toHaveAttribute("data-open", "false");

    fireEvent.click(screen.getByTestId("artifact-panel-toggle"));
    expect(screen.getByLabelText("artifact-drawer")).toHaveAttribute("data-open", "true");

    act(() => {
      mediaListener?.({ matches: true } as MediaQueryListEvent);
    });
    expect(screen.queryByLabelText("artifact-drawer")).not.toBeInTheDocument();
  });

  test("hides the artifact panel surface entirely in discuss mode", () => {
    // Discuss is "free-form discussion with no repository grounding"
    // (docs/service-modes-library-lab-system-design.md). The right-rail
    // artifact panel — repo-scoped folder tree plus sandbox-backed
    // launchers — must not surface in Discuss even when the workspace is
    // otherwise ready, because the user can read and ask over those
    // artifacts from Library instead. This pins all three artifact
    // affordances (the ChatPanel toggle, the mobile drawer, the desktop
    // column container) so a future refactor can't quietly bring one of
    // them back without a failing test.
    useChatModeMock.mockReturnValue({
      mode: "discuss",
      availability: undefined,
      placeholderAvailability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
        },
        defaultMode: "discuss",
        hasAttachedRepo: true,
        hasAtLeastOneArtifact: false,
        askReadiness: { enabled: false, code: "library_no_artifact", message: "loading" },
        grounding: {
          library: { enabled: false, code: "library_no_artifact", message: "loading" },
          sandbox: { enabled: false, code: "sandbox_missing", message: "loading", isActivatable: false },
        },
      },
    });
    repositoriesResult = [makeRepository()];
    const { workspaceId, workspace } = makeRepoWorkspace();
    workspacesResult = [workspace];

    render(<RepositoryShell urlWorkspaceId={workspaceId} urlThreadId={null} />);

    expect(screen.queryByTestId("artifact-panel-toggle")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("artifact-drawer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();
  });

  test("derives chatMode from the URL segment, not capability defaultMode, for an existing thread", () => {
    // Regression: `capabilities.defaultMode` is what
    // `getDefaultThreadMode(hasAttachedRepo)` returns — "library" for any
    // repo-attached workspace. Using it as the chatMode fallback on a
    // canonical discuss-thread URL silently sent `mode: "library"` to
    // `sendMessage`, which then tripped the `askReadiness` gate
    // ("Library Ask needs at least one artifact in this workspace") even
    // though the user was on /discuss/:tid and never touched Library.
    // The URL's mode-aware segment is the source of truth for an
    // existing thread's mode; the resolver default only applies to
    // brand-new threads created via `sendMessageStartingNewThread`.
    useChatModeMock.mockReturnValue({
      mode: "discuss",
      availability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library" as const,
        hasAttachedRepo: true,
        hasAtLeastOneArtifact: false,
        askReadiness: { enabled: false, code: "library_no_artifact", message: "loading" },
        grounding: {
          library: { enabled: false, code: "library_no_artifact", message: "loading" },
          sandbox: { enabled: false, code: "sandbox_missing", message: "loading", isActivatable: false },
        },
      },
      placeholderAvailability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
        },
        defaultMode: "discuss",
        hasAttachedRepo: false,
        hasAtLeastOneArtifact: false,
        askReadiness: { enabled: false, code: "no_repository_attached", message: "loading" },
        grounding: {
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
          sandbox: { enabled: false, code: "no_repository_attached", message: "loading", isActivatable: false },
        },
      },
    });
    useThreadCapabilitiesMock.mockReturnValue({
      modes: {
        discuss: { enabled: true },
        library: { enabled: true },
      },
      defaultMode: "library",
      attachedRepository: { id: repoId, fullName: "octocat/hello-world", shortName: "hello-world" },
      sandboxModeStatus: { reasonCode: "missing_sandbox", message: null },
      isMissingThread: false,
      isLoading: false,
      sandboxCostBudget: null,
      sandboxIsActivatable: false,
    });
    repositoriesResult = [makeRepository()];
    const { workspaceId, workspace } = makeRepoWorkspace();
    workspacesResult = [workspace];

    render(<RepositoryShell urlWorkspaceId={workspaceId} urlThreadId={"thread_discuss" as ThreadId} />);

    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-chat-mode", "discuss");
  });
});

describe("RepositoryShell import workspace routing", () => {
  // Imports navigate the user into the new workspace via the canonical
  // mode-aware URL (`/w/:wid/discuss/:tid` for the default thread the
  // backend creates on import) so the user lands in the right service mode
  // on first paint, without bouncing through `LegacyThreadRedirect`. The
  // URL→state sync effect (in the shell) then mirrors the new id into
  // `activeWorkspaceId` and `userPreferences.lastActiveWorkspaceId`.
  // These tests assert the navigation contract — the localStorage/
  // preference side effects are exercised by the workspace reconciliation
  // suite below (which simulates the URL change those navigations would
  // produce in a real router).
  test("sidebar import navigates to the canonical mode-aware thread URL", () => {
    render(<RepositoryShell urlWorkspaceId={null} urlThreadId={null} />);

    fireEvent.click(screen.getByTestId("sidebar-import"));

    expect(navigateMock).toHaveBeenCalledWith("/w/workspace_imported/discuss/thread_imported");
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
    // `ws_db` and not issue a redundant workspace-switch touchWorkspace (the
    // DB already holds the right value).
    //
    // `mode: null` mirrors what `useChatMode` would return on a
    // transient URL like `/chat` (URL has no `/w/:wid/{discuss,library}`
    // prefix). Without this override, the suite-wide mock would fire
    // the mode-record effect against `ws_cached` during the brief
    // window before DB-wins reconciliation lands — irrelevant noise
    // for what this test is actually asserting.
    useChatModeMock.mockReturnValue({
      mode: null,
      availability: undefined,
      placeholderAvailability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
        },
        defaultMode: "discuss",
        hasAttachedRepo: false,
        hasAtLeastOneArtifact: false,
        askReadiness: { enabled: false, code: "no_repository_attached", message: "loading" },
        grounding: {
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
          sandbox: { enabled: false, code: "no_repository_attached", message: "loading", isActivatable: false },
        },
      },
    });
    storedActiveWorkspaceId = "ws_cached";
    workspacesResult = [makeWorkspace({ _id: "ws_db" }), makeWorkspace({ _id: "ws_cached" })];
    viewerPreferencesResult = {
      lastActiveWorkspaceId: "ws_db" as WorkspaceId,
      lastActiveWorkspaceUpdatedAt: 1,
    };

    render(<RepositoryShell urlWorkspaceId={null} urlThreadId={null} />);

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

    render(<RepositoryShell urlWorkspaceId={null} urlThreadId={null} />);

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

    render(<RepositoryShell urlWorkspaceId={null} urlThreadId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_alive");
    });
    expect(localStorage.getItem("systify.activeWorkspaceId")).toBe("ws_alive");
    expect(touchWorkspaceMock).toHaveBeenCalledWith({ workspaceId: "ws_alive" });
  });

  test("URL workspace id promotes into active state and seeds the DB preference", async () => {
    // The URL is the canonical source of truth for "which workspace is the
    // user in". When the URL carries a workspace id different from the
    // cached/active value, the shell must adopt the URL's id immediately and
    // touch the DB so cross-device convergence catches up. This is what
    // makes `handleSwitchWorkspace` a one-line `navigate(workspacePath(id))`
    // — the URL change drives the state update without every callsite
    // having to remember it.
    //
    // The DB preference is intentionally left empty so the DB-wins effect
    // doesn't fight the URL-driven update; in production, `touchWorkspace`
    // applies an optimistic update that synchronises the cached
    // `getViewerPreferences` row with the new workspace before the next
    // render, but the test mock can't replicate that side effect on its
    // own. The cross-tab convergence path is exercised separately in the
    // "live cross-tab push" case below.
    storedActiveWorkspaceId = "ws_active";
    const urlWorkspaceId = "ws_url" as WorkspaceId;
    workspacesResult = [makeWorkspace({ _id: "ws_active" }), makeWorkspace({ _id: "ws_url" })];
    viewerPreferencesResult = null;

    render(<RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_url");
    });
    expect(touchWorkspaceMock).toHaveBeenCalledWith({ workspaceId: "ws_url" });
    expect(localStorage.getItem("systify.activeWorkspaceId")).toBe("ws_url");
  });

  test("URL workspace id pointing at a missing workspace redirects without entering a state loop", async () => {
    // Stale URLs (deleted workspace, copy/paste from another device, or a
    // bookmark to a workspace the current user no longer owns) must not be
    // adopted into `activeWorkspaceId`. Doing so would race with the fallback
    // effect — which keeps re-picking a surviving workspace whenever the
    // active id is invalid — and bounce the user back and forth forever. The
    // shell should validate the URL against `listWorkspaces` and redirect to
    // the default path when the id is stale.
    const urlWorkspaceId = "ws_missing" as WorkspaceId;
    workspacesResult = [makeWorkspace({ _id: "ws_other" })];
    viewerPreferencesResult = null;
    storedActiveWorkspaceId = null;

    render(<RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={null} />);

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(DEFAULT_AUTHENTICATED_PATH, { replace: true });
    });
    expect(touchWorkspaceMock).not.toHaveBeenCalledWith({ workspaceId: "ws_missing" });
    expect(screen.getByTestId("sidebar")).not.toHaveAttribute("data-active-workspace-id", "ws_missing");
  });

  test("workspace landing redirects into the remembered discuss mode even with no discuss thread", async () => {
    // Regression: the workspace's `lastMode` is "discuss", so the
    // `/chat` → `/w/:wid` redirect must settle the user in Discuss. The
    // Tier 2 redirect previously bailed without navigating when no thread of
    // the matching mode existed, stranding the user on the mode-less
    // `/w/:wid` URL — which renders the structural default (library) instead
    // of the mode they were last in.
    useChatModeMock.mockReturnValue({
      mode: null,
      availability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library" as const,
        hasAttachedRepo: true,
        hasAtLeastOneArtifact: true,
        askReadiness: { enabled: true },
        grounding: {
          library: { enabled: true },
          sandbox: { enabled: false, code: "sandbox_missing", message: "loading", isActivatable: false },
        },
      },
      placeholderAvailability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
        },
        defaultMode: "discuss",
        hasAttachedRepo: false,
        hasAtLeastOneArtifact: false,
        askReadiness: { enabled: false, code: "no_repository_attached", message: "loading" },
        grounding: {
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
          sandbox: { enabled: false, code: "no_repository_attached", message: "loading", isActivatable: false },
        },
      },
    });
    const urlWorkspaceId = "ws_discuss_memory" as WorkspaceId;
    workspacesResult = [makeWorkspace({ _id: "ws_discuss_memory", lastMode: "discuss" })];
    storedActiveWorkspaceId = "ws_discuss_memory";
    ownerThreadsResult = [];

    render(<RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={null} />);

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(discussPath(urlWorkspaceId), { replace: true });
    });
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

    const { rerender } = render(<RepositoryShell urlWorkspaceId={null} urlThreadId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_a");
    });

    // Simulate Tab B's switch landing in Tab A's subscription.
    viewerPreferencesResult = {
      lastActiveWorkspaceId: "ws_b" as WorkspaceId,
      lastActiveWorkspaceUpdatedAt: 2,
    };
    rerender(<RepositoryShell urlWorkspaceId={null} urlThreadId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_b");
    });
  });

  test("records the URL's settled service mode when it differs from the workspace's stored pick", async () => {
    // The user lands on a canonical mode URL whose mode differs from what
    // the workspace last recorded. The shell must fire a touchWorkspace
    // with `mode` so the next `/chat` → `/w/:wid` redirect lands
    // the user back here instead of bouncing them to the structural
    // default — the "Archive → back" round-trip this whole code path
    // exists to make sticky.
    useChatModeMock.mockReturnValue({
      mode: "discuss",
      availability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library" as const,
        hasAttachedRepo: true,
        hasAtLeastOneArtifact: true,
        askReadiness: { enabled: true },
        grounding: {
          library: { enabled: true },
          sandbox: { enabled: false, code: "sandbox_missing", message: "loading", isActivatable: false },
        },
      },
      placeholderAvailability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
        },
        defaultMode: "discuss",
        hasAttachedRepo: false,
        hasAtLeastOneArtifact: false,
        askReadiness: { enabled: false, code: "no_repository_attached", message: "loading" },
        grounding: {
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
          sandbox: { enabled: false, code: "no_repository_attached", message: "loading", isActivatable: false },
        },
      },
    });
    const urlWorkspaceId = "ws_canonical" as WorkspaceId;
    workspacesResult = [makeWorkspace({ _id: "ws_canonical", lastMode: "library" })];
    storedActiveWorkspaceId = "ws_canonical";

    render(<RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={"thread_canonical" as ThreadId} />);

    await waitFor(() => {
      expect(touchWorkspaceMock).toHaveBeenCalledWith({ workspaceId: "ws_canonical", mode: "discuss" });
    });
  });

  test("does not re-record when the URL's settled service mode already matches the workspace's stored pick", async () => {
    // Steady-state: user is already in their preferred mode for this
    // workspace. The mode-record effect must not fire a redundant write
    // every render — that would burn DB writes on every URL pathname
    // tick and undermine the optimistic-update fast path.
    useChatModeMock.mockReturnValue({
      mode: "discuss",
      availability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
        },
        defaultMode: "discuss" as const,
        hasAttachedRepo: false,
        hasAtLeastOneArtifact: false,
        askReadiness: { enabled: false, code: "no_repository_attached", message: "loading" },
        grounding: {
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
          sandbox: { enabled: false, code: "no_repository_attached", message: "loading", isActivatable: false },
        },
      },
      placeholderAvailability: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
        },
        defaultMode: "discuss",
        hasAttachedRepo: false,
        hasAtLeastOneArtifact: false,
        askReadiness: { enabled: false, code: "no_repository_attached", message: "loading" },
        grounding: {
          library: { enabled: false, code: "no_repository_attached", message: "loading" },
          sandbox: { enabled: false, code: "no_repository_attached", message: "loading", isActivatable: false },
        },
      },
    });
    const urlWorkspaceId = "ws_steady" as WorkspaceId;
    workspacesResult = [makeWorkspace({ _id: "ws_steady", lastMode: "discuss" })];
    storedActiveWorkspaceId = "ws_steady";

    render(<RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={"thread_steady" as ThreadId} />);

    // Give the effect a chance to run (and skip) before asserting.
    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "ws_steady");
    });
    expect(touchWorkspaceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_steady", mode: "discuss" }),
    );
  });
});
