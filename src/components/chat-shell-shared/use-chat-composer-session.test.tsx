// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ThreadCapabilities } from "@/hooks/use-thread-capabilities";
import type { ViewerAccess } from "@/hooks/use-viewer-access";
import type { ComposerGroundingAvailability } from "@/lib/chat-composer-session";
import type { PickableModelEntry, RepositoryId, ThreadId } from "@/lib/types";

const {
  useAuthMock,
  useQueryMock,
  useChatLifecycleMock,
  useComposerDraftMock,
  useComposerModelPickMock,
  useStorageGCMock,
} = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  useQueryMock: vi.fn(),
  useChatLifecycleMock: vi.fn(),
  useComposerDraftMock: vi.fn(),
  useComposerModelPickMock: vi.fn(),
  useStorageGCMock: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: useAuthMock,
}));

vi.mock("convex/react", () => ({
  useQuery: useQueryMock,
}));

vi.mock("@/hooks/use-chat-lifecycle", () => ({
  useChatLifecycle: useChatLifecycleMock,
}));

vi.mock("@/hooks/use-composer-draft", () => ({
  useComposerDraft: useComposerDraftMock,
}));

vi.mock("@/hooks/use-composer-model-pick", () => ({
  useComposerModelPick: useComposerModelPickMock,
}));

vi.mock("@/hooks/use-storage-gc", () => ({
  useStorageGC: useStorageGCMock,
}));

import { useChatComposerSession } from "./use-chat-composer-session";

const repositoryId = "repo_1" as RepositoryId;
const secondRepositoryId = "repo_2" as RepositoryId;
const threadId = "thread_1" as ThreadId;
const nextThreadId = "thread_2" as ThreadId;

const catalogEntry = {
  provider: "openai",
  modelName: "gpt-test",
  displayName: "GPT Test",
  capability: "discuss",
  supportsReasoning: true,
  supportsTools: true,
  contextWindow: 128_000,
  userPickable: true,
  favorite: false,
  default: true,
  defaultSource: "system",
  reasoningEffort: "medium",
  supportedReasoningEfforts: ["none", "medium", "high", "xhigh"],
} satisfies PickableModelEntry;

beforeEach(() => {
  useAuthMock.mockReturnValue({ user: { id: "user_1" }, isLoading: false });
  useQueryMock.mockReturnValue([catalogEntry]);
  useChatLifecycleMock.mockReturnValue({
    isSending: false,
    handleSendMessage: vi.fn(),
    isCancellingReply: false,
    handleCancelInFlightReply: vi.fn(),
  });
  useComposerDraftMock.mockImplementation(() => {
    const [value, setValue] = useState("Ask about this repository");
    return [value, setValue, vi.fn()] as const;
  });
  useComposerModelPickMock.mockImplementation(() => ({
    selectedProvider: "openai",
    selectedModelName: "gpt-test",
    selectedModel: { provider: "openai", modelName: "gpt-test" },
    setSelectedModel: vi.fn(),
    selectedReasoningEffort: null,
    setSelectedReasoningEffort: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useChatComposerSession", () => {
  test("thread switch seeds grounding defaults from capabilities", () => {
    const { result, rerender } = renderHook(
      ({ activeThreadId, capabilities }) =>
        useChatComposerSession({
          surface: "repository",
          threadId: activeThreadId,
          repositoryId,
          mode: "discuss",
          capabilities,
          groundingAvailability: enabledGrounding(),
          viewerAccess: viewerAccess(),
          isSyncing: false,
          isReadOnly: false,
          setActionError: vi.fn(),
          onAfterCreateThread: vi.fn(),
        }),
      {
        initialProps: {
          activeThreadId: null as ThreadId | null,
          capabilities: capabilities(),
        },
      },
    );

    expect(result.current.tools.grounding?.groundLibrary).toBe(false);

    rerender({
      activeThreadId: threadId,
      capabilities: capabilities({ defaultGroundLibrary: true, defaultGroundSandbox: true }),
    });

    expect(result.current.tools.grounding?.groundLibrary).toBe(false);
    expect(result.current.tools.grounding?.groundSandbox).toBe(true);
  });

  test("same new-thread id keeps grounding exclusive and does not share it across repositories", () => {
    const { result, rerender } = renderHook(
      ({ repositoryId }) =>
        useChatComposerSession({
          surface: "repository",
          threadId: null,
          repositoryId,
          mode: "discuss",
          capabilities: capabilities({
            attachedRepository: { id: repositoryId, fullName: "owner/repo", shortName: "repo" },
          }),
          groundingAvailability: enabledGrounding(),
          viewerAccess: viewerAccess(),
          isSyncing: false,
          isReadOnly: false,
          setActionError: vi.fn(),
          onAfterCreateThread: vi.fn(),
        }),
      {
        initialProps: { repositoryId },
      },
    );

    act(() => {
      result.current.tools.grounding?.setGroundLibrary(true);
      result.current.tools.grounding?.setGroundSandbox(true);
    });
    expect(result.current.tools.grounding?.groundLibrary).toBe(false);
    expect(result.current.tools.grounding?.groundSandbox).toBe(true);

    rerender({ repositoryId: secondRepositoryId });

    expect(result.current.tools.grounding?.groundLibrary).toBe(false);
    expect(result.current.tools.grounding?.groundSandbox).toBe(false);
  });

  test("active thread grounding defaults seed after capabilities settle", () => {
    const { result, rerender } = renderHook(
      ({ capabilities }) =>
        useChatComposerSession({
          surface: "repository",
          threadId,
          repositoryId,
          mode: "discuss",
          capabilities,
          groundingAvailability: enabledGrounding(),
          viewerAccess: viewerAccess(),
          isSyncing: false,
          isReadOnly: false,
          setActionError: vi.fn(),
          onAfterCreateThread: vi.fn(),
        }),
      {
        initialProps: {
          capabilities: capabilities({
            isLoading: true,
            defaultGroundLibrary: true,
            defaultGroundSandbox: true,
          }),
        },
      },
    );

    expect(result.current.tools.grounding?.groundLibrary).toBe(false);
    expect(result.current.tools.grounding?.groundSandbox).toBe(false);

    rerender({
      capabilities: capabilities({
        defaultGroundLibrary: true,
        defaultGroundSandbox: true,
      }),
    });

    expect(result.current.tools.grounding?.groundLibrary).toBe(false);
    expect(result.current.tools.grounding?.groundSandbox).toBe(true);
  });

  test("disabled Library grounding auto-turns off", () => {
    const { result, rerender } = renderHook(
      ({ groundingAvailability }) =>
        useChatComposerSession({
          surface: "repository",
          threadId,
          repositoryId,
          mode: "discuss",
          capabilities: capabilities(),
          groundingAvailability,
          viewerAccess: viewerAccess(),
          isSyncing: false,
          isReadOnly: false,
          setActionError: vi.fn(),
          onAfterCreateThread: vi.fn(),
        }),
      { initialProps: { groundingAvailability: enabledGrounding() } },
    );

    act(() => result.current.tools.grounding?.setGroundLibrary(true));
    expect(result.current.tools.grounding?.groundLibrary).toBe(true);

    rerender({
      groundingAvailability: {
        library: { enabled: false, code: "library_no_artifact", message: "Generate at least one Design Doc first." },
        sandbox: { enabled: true },
      },
    });

    expect(result.current.tools.grounding?.groundLibrary).toBe(false);
  });

  test("non-activatable disabled Sandbox auto-turns off", () => {
    const { result, rerender } = renderHook(
      ({ groundingAvailability }) =>
        useChatComposerSession({
          surface: "repository",
          threadId,
          repositoryId,
          mode: "discuss",
          capabilities: capabilities(),
          groundingAvailability,
          viewerAccess: viewerAccess(),
          isSyncing: false,
          isReadOnly: false,
          setActionError: vi.fn(),
          onAfterCreateThread: vi.fn(),
        }),
      { initialProps: { groundingAvailability: enabledGrounding() } },
    );

    act(() => result.current.tools.grounding?.setGroundSandbox(true));
    rerender({
      groundingAvailability: {
        library: { enabled: true },
        sandbox: {
          enabled: false,
          code: "sandbox_failed",
          message: "Sandbox is unavailable.",
          isActivatable: false,
        },
      },
    });

    expect(result.current.tools.grounding?.groundSandbox).toBe(false);
  });

  test("activatable Sandbox remains selectable and switches model route", () => {
    const { result, rerender } = renderHook(
      ({ groundingAvailability }) =>
        useChatComposerSession({
          surface: "repository",
          threadId,
          repositoryId,
          mode: "discuss",
          capabilities: capabilities(),
          groundingAvailability,
          viewerAccess: viewerAccess(),
          isSyncing: false,
          isReadOnly: false,
          setActionError: vi.fn(),
          onAfterCreateThread: vi.fn(),
        }),
      { initialProps: { groundingAvailability: enabledGrounding() } },
    );

    act(() => result.current.tools.grounding?.setGroundSandbox(true));
    rerender({
      groundingAvailability: {
        library: { enabled: true },
        sandbox: {
          enabled: false,
          code: "sandbox_missing",
          message: "Sandbox will be prepared on send.",
          isActivatable: true,
        },
      },
    });

    expect(result.current.tools.grounding?.groundSandbox).toBe(true);
    expect(useComposerModelPickMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capability: "sandbox",
        preferenceScope: "sandbox",
      }),
    );
  });

  test("viewer access gates surface disabled reasons", () => {
    const { result } = renderHook(() =>
      useChatComposerSession({
        surface: "repository",
        threadId: nextThreadId,
        repositoryId,
        mode: "discuss",
        capabilities: capabilities(),
        groundingAvailability: enabledGrounding(),
        viewerAccess: viewerAccess({ chatSend: false, sandboxGrounding: false }),
        isSyncing: false,
        isReadOnly: false,
        setActionError: vi.fn(),
        onAfterCreateThread: vi.fn(),
      }),
    );

    expect(result.current.send.disabledReason).toBe("Demo mode does not send messages.");
    expect(result.current.tools.grounding?.grounding?.sandbox).toEqual({
      enabled: false,
      code: "feature_not_included",
      message: "Demo mode does not start live source sessions.",
      isActivatable: false,
    });
  });

  test("access loading does not auto-clear Sandbox grounding before access resolves", () => {
    const { result, rerender } = renderHook(
      ({ viewerAccessValue }) =>
        useChatComposerSession({
          surface: "repository",
          threadId: nextThreadId,
          repositoryId,
          mode: "discuss",
          capabilities: capabilities(),
          groundingAvailability: enabledGrounding(),
          viewerAccess: viewerAccessValue,
          isSyncing: false,
          isReadOnly: false,
          setActionError: vi.fn(),
          onAfterCreateThread: vi.fn(),
        }),
      {
        initialProps: { viewerAccessValue: undefined as ViewerAccess | undefined },
      },
    );

    act(() => result.current.tools.grounding?.setGroundSandbox(true));

    expect(result.current.tools.grounding?.groundSandbox).toBe(true);

    rerender({ viewerAccessValue: viewerAccess({ sandboxGrounding: false }) });

    expect(result.current.tools.grounding?.groundSandbox).toBe(false);
  });
});

function enabledGrounding(): ComposerGroundingAvailability {
  return {
    library: { enabled: true },
    sandbox: { enabled: true },
  };
}

function capabilities(overrides: Partial<ThreadCapabilities> = {}): ThreadCapabilities {
  return {
    isLoading: false,
    isMissingThread: false,
    attachedRepository: { id: repositoryId, fullName: "owner/repo", shortName: "repo" },
    sandboxStatus: null,
    sandboxModeStatus: null,
    modes: {
      discuss: { enabled: true },
      library: { enabled: true },
    },
    defaultMode: "discuss",
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
    ...overrides,
  };
}

function viewerAccess(disabled: Partial<Record<keyof ViewerAccess["features"], boolean>> = {}): ViewerAccess {
  const featureNames: Array<keyof ViewerAccess["features"]> = [
    "demoMode",
    "repoImport",
    "syncRepository",
    "checkForUpdates",
    "chatSend",
    "libraryAsk",
    "generateSystemDesign",
    "sandboxGrounding",
    "artifactIndexing",
    "premiumModels",
    "highReasoning",
  ];
  return {
    ownerTokenIdentifier: "user|1",
    email: "user@example.com",
    plan: "internal",
    billingStatus: "active",
    features: Object.fromEntries(
      featureNames.map((feature) => [
        feature,
        {
          enabled: disabled[feature] === undefined ? true : disabled[feature],
          code: disabled[feature] === false ? "FEATURE_NOT_INCLUDED" : null,
          message: null,
        },
      ]),
    ) as ViewerAccess["features"],
  };
}
