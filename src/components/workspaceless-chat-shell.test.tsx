// @vitest-environment jsdom

import type React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WorkspacelessChatShell } from "./workspaceless-chat-shell";
import type { ThreadId } from "@/lib/types";

const { useQueryMock, useMutationMock, useChatShellLifecycleMock, useThreadCapabilitiesMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  useMutationMock: vi.fn(),
  useChatShellLifecycleMock: vi.fn(),
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
  useLocation: () => ({ pathname: "/chat", search: "", hash: "", state: null, key: "default" }),
  useParams: () => ({}),
}));

vi.mock("@/components/app-sidebar", () => ({
  AppSidebarLeft: ({ activeWorkspaceId }: { activeWorkspaceId: string | null }) => (
    <div data-testid="sidebar" data-active-workspace-id={activeWorkspaceId ?? ""} />
  ),
}));

vi.mock("@/components/chat-panel", () => ({
  ChatContainer: ({
    chatMode,
    workspaceId,
    onSendMessage,
  }: {
    chatMode?: string;
    workspaceId?: string | null;
    onSendMessage?: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
  }) => (
    <div
      data-testid="chat-panel"
      data-chat-mode={chatMode ?? ""}
      data-workspace-id={workspaceId ?? ""}
      onClick={() => {
        void onSendMessage?.({ preventDefault: () => {} } as React.FormEvent<HTMLFormElement>);
      }}
    />
  ),
}));

vi.mock("@/components/attach-repo-menu", () => ({
  AttachRepoMenu: ({ threadId }: { threadId: string }) => (
    <div data-testid="attach-repo-menu" data-thread-id={threadId} />
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

vi.mock("@/components/logo", () => ({
  Logo: () => <div>logo</div>,
}));

vi.mock("@/components/chat-shell-shared/use-chat-shell-lifecycle", () => ({
  useChatShellLifecycle: useChatShellLifecycleMock,
}));

vi.mock("@/components/chat-shell-shared/use-thread-deletion-recovery", () => ({
  useThreadDeletionRecovery: vi.fn(),
}));

vi.mock("@/hooks/use-thread-capabilities", () => ({
  useThreadCapabilities: useThreadCapabilitiesMock,
}));

vi.mock("@/hooks/use-recent-threads", () => ({
  useRecentThreads: () => [],
}));

vi.mock("@/hooks/use-warm-thread-subscriptions", () => ({
  useWarmThreadSubscriptions: vi.fn(),
}));

beforeEach(() => {
  navigateMock.mockReset();
  useQueryMock.mockReset();
  useMutationMock.mockReset();
  useChatShellLifecycleMock.mockReset();
  useThreadCapabilitiesMock.mockReset();

  // Default: every query returns an empty list / undefined so the shell renders
  // its no-data path without crashing.
  useQueryMock.mockReturnValue([]);
  useMutationMock.mockReturnValue(vi.fn());

  useThreadCapabilitiesMock.mockReturnValue({
    isLoading: false,
    isMissingThread: false,
    attachedRepository: null,
    sandboxStatus: null,
    sandboxModeStatus: null,
    modes: {
      discuss: { enabled: true },
      library: { enabled: false, code: "no_repository_attached", message: "Attach a repository." },
    },
    defaultMode: "discuss",
    sandboxIsActivatable: false,
    sandboxCostBudget: null,
    defaultGroundLibrary: false,
    defaultGroundSandbox: false,
  });

  useChatShellLifecycleMock.mockImplementation(({ onAfterCreateThread }) => ({
    chatInput: "",
    setChatInput: vi.fn(),
    clearChatInput: vi.fn(),
    isSending: false,
    handleSendMessage: vi.fn(async () => {
      onAfterCreateThread("thread_created" as ThreadId, "discuss");
    }),
    isCancellingReply: false,
    handleCancelInFlightReply: vi.fn(),
    isDeletingThread: false,
    handleDeleteThread: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
});

describe("WorkspacelessChatShell", () => {
  test("renders chat panel pinned to discuss mode with no workspace", () => {
    render(<WorkspacelessChatShell urlThreadId={null} />);
    const chat = screen.getByTestId("chat-panel");
    expect(chat).toHaveAttribute("data-chat-mode", "discuss");
    expect(chat).toHaveAttribute("data-workspace-id", "");
  });

  test("mounts AppSidebarLeft with no active workspace so the workspaceless rail surfaces", () => {
    render(<WorkspacelessChatShell urlThreadId={null} />);
    expect(screen.getByTestId("sidebar")).toHaveAttribute("data-active-workspace-id", "");
  });

  test("does not show the AttachRepoMenu on the workspaceless landing (no thread to attach)", () => {
    render(<WorkspacelessChatShell urlThreadId={null} />);
    expect(screen.queryByTestId("attach-repo-menu")).not.toBeInTheDocument();
  });

  test("shows the AttachRepoMenu inside a workspaceless thread URL", () => {
    render(<WorkspacelessChatShell urlThreadId={"thread_workspaceless" as ThreadId} />);
    const menu = screen.getByTestId("attach-repo-menu");
    expect(menu).toHaveAttribute("data-thread-id", "thread_workspaceless");
  });

  test("first send on /chat navigates to /chat/:newTid via onAfterCreateThread", async () => {
    render(<WorkspacelessChatShell urlThreadId={null} />);
    screen.getByTestId("chat-panel").click();
    await Promise.resolve();
    expect(navigateMock).toHaveBeenCalledWith("/chat/thread_created", { replace: true });
  });
});
