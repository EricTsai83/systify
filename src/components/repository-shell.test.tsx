// @vitest-environment jsdom

import type React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RepositoryWorkspaceState } from "@/components/chat-shell-shared/use-repository-workspace-state";
import { RepositoryShell } from "@/components/repository-shell";
import type { RepositoryId } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  useRepositoryWorkspaceState: vi.fn<() => RepositoryWorkspaceState>(),
  chatContainer: vi.fn<(props: Record<string, unknown>) => void>(),
}));

vi.mock("@/components/chat-shell-shared/use-repository-workspace-state", () => ({
  useRepositoryWorkspaceState: () => mocks.useRepositoryWorkspaceState(),
}));

vi.mock("@/components/app-sidebar", () => ({
  AppSidebarLeft: () => <aside data-testid="app-sidebar" />,
}));

vi.mock("@/components/chat-panel", () => ({
  ChatContainer: (props: Record<string, unknown>) => {
    mocks.chatContainer(props);
    return <div data-testid="chat-container" data-has-artifact-toggle={String("artifactToggle" in props)} />;
  },
}));

vi.mock("@/components/top-bar", () => ({
  TopBar: () => <header data-testid="top-bar" />,
}));

vi.mock("@/components/thread-search-dialog", () => ({
  ThreadSearchDialog: () => null,
}));

vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/generate-system-design-dialog", () => ({
  GenerateSystemDesignDialog: () => null,
}));

vi.mock("@/components/status-panel", () => ({
  StatusPanel: () => <div data-testid="status-panel" />,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

afterEach(() => {
  cleanup();
  mocks.useRepositoryWorkspaceState.mockReset();
  mocks.chatContainer.mockClear();
});

describe("RepositoryShell", () => {
  test("does not render the Discuss artifact panel or drawer", () => {
    mocks.useRepositoryWorkspaceState.mockReturnValue(makeWorkspace());

    render(<RepositoryShell urlRepositoryId={"repo_1" as RepositoryId} urlThreadId={null} />);

    expect(screen.getByTestId("chat-container")).toHaveAttribute("data-has-artifact-toggle", "false");
    expect(screen.queryByLabelText("artifact-drawer")).not.toBeInTheDocument();
  });
});

function makeWorkspace(): RepositoryWorkspaceState {
  const repositoryId = "repo_1" as RepositoryId;
  return {
    repositories: [],
    activeRepositoryId: repositoryId,
    selectedRepositoryId: repositoryId,
    artifactRepositoryId: repositoryId,
    selectedThreadId: null,
    chatMode: "discuss",
    capabilities: {
      isLoading: false,
      isMissingThread: false,
      attachedRepository: null,
      sandboxStatus: null,
      sandboxModeStatus: null,
      modes: {
        discuss: { enabled: true },
        library: { enabled: false, code: "no_repository_attached", message: "No repository." },
      },
      defaultMode: "discuss",
      sandboxIsActivatable: false,
      sandboxCostBudget: null,
      defaultGroundLibrary: false,
      defaultGroundSandbox: false,
      singleTurnEnabled: false,
      singleTurnResetPending: false,
      agentEnabled: false,
      agentRole: null,
      agentInstructions: null,
      lockedProvider: null,
      defaultModelName: null,
    },
    viewerAccess: undefined,
    repoDetail: {
      repository: {
        _id: repositoryId,
        _creationTime: 1,
        ownerTokenIdentifier: "owner",
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/systify",
        sourceRepoFullName: "acme/systify",
        sourceRepoOwner: "acme",
        sourceRepoName: "systify",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 1,
        color: "blue",
        lastAccessedAt: 1,
      },
      isArchived: false,
      archivedAt: null,
      artifacts: [],
      jobs: [],
      threads: [],
      fileCount: 1,
      fileCountLabel: "1",
      sandboxModeStatus: { reasonCode: "available", message: null },
      hasRemoteUpdates: false,
      latestFailedImportError: null,
      sandbox: null,
    } as RepositoryWorkspaceState["repoDetail"],
    shellStatus: "ready",
    isChatShellLoading: false,
    isRepoMissing: false,
    isRepoArchived: false,
    isSyncing: false,
    isRestoringRepository: false,
    isRepositoryStatusEnabled: true,
    isDesktopLayout: false,
    actionError: null,
    actionNotice: null,
    composer: {} as RepositoryWorkspaceState["composer"],
    panels: {
      artifact: {
        selectArtifact: vi.fn(),
      },
      status: {
        isOpen: false,
        setOpen: vi.fn(),
        close: vi.fn(),
      },
      threadSearch: {
        isOpen: false,
        setOpen: vi.fn(),
        open: vi.fn(),
      },
    },
    dialogs: {
      threadArchive: {
        isOpen: false,
        setOpen: vi.fn(),
        isPending: false,
        confirm: vi.fn(),
      },
      repositoryArchive: {
        isOpen: false,
        setOpen: vi.fn(),
        isPending: false,
        confirm: vi.fn(),
      },
      permanentDelete: {
        isOpen: false,
        setOpen: vi.fn(),
        isPending: false,
        confirm: vi.fn(),
      },
      generateSystemDesign: {
        isOpen: false,
        setOpen: vi.fn(),
      },
    },
    handlers: {
      switchRepository: vi.fn(),
      selectThread: vi.fn(),
      requestArchiveThread: vi.fn(),
      requestNewThread: vi.fn(),
      imported: vi.fn(),
      threadMovedToRepository: vi.fn(),
      setActionError: vi.fn(),
      dismissActionError: vi.fn(),
      backToDefault: vi.fn(),
      sync: vi.fn(),
      restoreRepository: vi.fn(),
      requestArchiveRepository: vi.fn(),
      requestPermanentDeleteRepository: vi.fn(),
    },
  };
}
