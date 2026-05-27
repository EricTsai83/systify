// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RepositoryId, ThreadId } from "@/lib/types";

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: useQueryMock,
}));

// Imported after vi.mock so the mock is in place when the hook resolves
// `useQuery` from `convex/react`.
import { useThreadCapabilities } from "./use-thread-capabilities";

const threadId = "thread_1" as ThreadId;
const repositoryId = "repo_1" as RepositoryId;

beforeEach(() => {
  useQueryMock.mockReset();
});

describe("useThreadCapabilities — bridging behavior", () => {
  test("threadId null: skips the query and returns discuss-only defaults", () => {
    useQueryMock.mockReturnValue(undefined);

    const { result } = renderHook(() => useThreadCapabilities(null));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isMissingThread).toBe(false);
    expect(result.current.attachedRepository).toBeNull();
    expect(result.current.sandboxStatus).toBeNull();
    expect(result.current.modes.discuss.enabled).toBe(true);
    expect(result.current.modes.library.enabled).toBe(false);
    expect(result.current.defaultMode).toBe("discuss");
    // Default grounding flags start off so a click in the composer is
    // always intentional.
    expect(result.current.defaultGroundLibrary).toBe(false);
    expect(result.current.defaultGroundSandbox).toBe(false);
    // The hook must pass the literal 'skip' sentinel so Convex does not run
    // the query for the non-thread case.
    expect(useQueryMock).toHaveBeenCalledWith(expect.anything(), "skip");
  });

  test("threadId set, query loading: surfaces isLoading without dropping the selector", () => {
    useQueryMock.mockReturnValue(undefined);

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isMissingThread).toBe(false);
    // Even while loading, the selector still has a sensible shape so the UI
    // does not blink between "no modes" and "modes" within a few hundred ms.
    expect(result.current.modes.discuss.enabled).toBe(true);
    expect(result.current.modes.library.enabled).toBe(false);
    expect(result.current.defaultMode).toBe("discuss");
    expect(useQueryMock).toHaveBeenCalledWith(expect.anything(), { threadId });
  });

  test("threadId set, query returns null (thread missing): falls back to no-thread defaults", () => {
    useQueryMock.mockReturnValue(null);

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isMissingThread).toBe(true);
    expect(result.current.modes.discuss.enabled).toBe(true);
    expect(result.current.modes.library.enabled).toBe(false);
    expect(result.current.attachedRepository).toBeNull();
  });

  test("thread without a repository: forwards resolver output (discuss only) and exposes library unlock hint", () => {
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: null,
      sandboxStatus: null,
      sandboxModeStatus: null,
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: {
            enabled: false,
            code: "no_repository_attached",
            message: "Attach a repository to use Library mode.",
          },
        },
        defaultMode: "discuss",
      },
      sandboxIsActivatable: false,
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.attachedRepository).toBeNull();
    expect(result.current.modes.discuss.enabled).toBe(true);
    expect(result.current.modes.library.enabled).toBe(false);
    expect(result.current.defaultMode).toBe("discuss");
    if (!result.current.modes.library.enabled) {
      expect(result.current.modes.library.message).toBeTruthy();
    }
    expect(result.current.sandboxIsActivatable).toBe(false);
  });

  test("thread with a repository but no sandbox: bridges discuss+library and flags activation", () => {
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, repositoryId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: {
        _id: repositoryId,
        sourceRepoFullName: "acme/widget",
        sourceRepoName: "widget",
      },
      sandboxStatus: null,
      sandboxModeStatus: {
        reasonCode: "missing_sandbox",
        message:
          "A live sandbox is unavailable because no sandbox is ready for this repository yet. Sync the repository to provision one.",
      },
      chatModes: {
        // Post-Lab collapse: `resolveChatModes` no longer surfaces a `lab`
        // disabled-reason. The "no sandbox" hint travels via grounding /
        // sandboxIsActivatable instead.
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library",
      },
      sandboxIsActivatable: true,
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.attachedRepository).toEqual({
      id: repositoryId,
      fullName: "acme/widget",
      shortName: "widget",
    });
    expect(result.current.sandboxStatus).toBeNull();
    expect(result.current.modes.discuss.enabled).toBe(true);
    expect(result.current.modes.library.enabled).toBe(true);
    expect(result.current.defaultMode).toBe("library");
    // The missing-sandbox case is the headline activation surface — the
    // disabled Sandbox option should still accept a click and enqueue a
    // lazy provision.
    expect(result.current.sandboxIsActivatable).toBe(true);
  });

  test("thread with a ready sandbox: bridges discuss+library; sandbox surfaces via sandboxStatus", () => {
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, repositoryId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: {
        _id: repositoryId,
        sourceRepoFullName: "acme/widget",
        sourceRepoName: "widget",
      },
      sandboxStatus: "ready",
      sandboxModeStatus: {
        reasonCode: "available",
        message: null,
      },
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library",
      },
      sandboxIsActivatable: false,
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.modes.discuss.enabled).toBe(true);
    expect(result.current.modes.library.enabled).toBe(true);
    expect(result.current.defaultMode).toBe("library");
    expect(result.current.sandboxStatus).toBe("ready");
    // Already-ready sandboxes don't need to be activated again.
    expect(result.current.sandboxIsActivatable).toBe(false);
  });

  test("thread with a provisioning sandbox: bridges the provisioning state via sandboxStatus", () => {
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, repositoryId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: {
        _id: repositoryId,
        sourceRepoFullName: "acme/widget",
        sourceRepoName: "widget",
      },
      sandboxStatus: "provisioning",
      sandboxModeStatus: {
        reasonCode: "sandbox_provisioning",
        message:
          "A live sandbox is unavailable because the sandbox is still provisioning. Wait for the import to finish or sync the repository again.",
      },
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library",
      },
      sandboxIsActivatable: false,
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.sandboxStatus).toBe("provisioning");
    // A second activation click during provisioning would just dedupe;
    // the UI surfaces that more cleanly by leaving the option in its
    // disabled state until the in-flight job finishes.
    expect(result.current.sandboxIsActivatable).toBe(false);
  });

  test("thread with a stopped sandbox: forwards schema status verbatim and flags activation", () => {
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, repositoryId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: {
        _id: repositoryId,
        sourceRepoFullName: "acme/widget",
        sourceRepoName: "widget",
      },
      // The schema-level status is "stopped"; the hook hands it back
      // verbatim and trusts the sandboxModeStatus / grounding axis to
      // carry the user-visible explanation.
      sandboxStatus: "stopped",
      sandboxModeStatus: {
        reasonCode: "sandbox_expired",
        message:
          "A live sandbox is unavailable because the sandbox expired. Sync the repository to provision a fresh sandbox.",
      },
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library",
      },
      sandboxIsActivatable: true,
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.sandboxStatus).toBe("stopped");
    // Expired sandboxes are re-activatable — same activation path as
    // the missing-sandbox case provisions a fresh one.
    expect(result.current.sandboxIsActivatable).toBe(true);
  });

  test("thread carries per-thread default-grounding snapshot for the composer", () => {
    // Persisted defaults from `threads.defaultGroundLibrary` /
    // `threads.defaultGroundSandbox` are forwarded so the shell can seed
    // the Discuss composer toggles when a thread is opened.
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, repositoryId, defaultGroundLibrary: true, defaultGroundSandbox: true },
      attachedRepository: {
        _id: repositoryId,
        sourceRepoFullName: "acme/widget",
        sourceRepoName: "widget",
      },
      sandboxStatus: "ready",
      sandboxModeStatus: { reasonCode: "available", message: null },
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library",
      },
      sandboxIsActivatable: false,
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.defaultGroundLibrary).toBe(true);
    expect(result.current.defaultGroundSandbox).toBe(true);
  });
});

/**
 * Plan 10 — sandbox cost-budget bridging from the threadContext query
 * into the hook's flat shape.
 *
 * The hook consolidates the (per-user, per-repository) budget pair into
 * a single user-facing budget so the UI doesn't have to make the
 * "which cap binds first?" decision in JSX. Tests anchor that
 * consolidation logic.
 */
describe("useThreadCapabilities — Plan 10 sandbox cost budget", () => {
  test("threads without budget data (no repo attached) report sandboxCostBudget: null", () => {
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: null,
      sandboxStatus: null,
      sandboxModeStatus: null,
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: {
            enabled: false,
            code: "no_repository_attached",
            message: "Attach a repository to use Library mode.",
          },
        },
        defaultMode: "discuss",
      },
      sandboxIsActivatable: false,
      sandboxCostBudgets: null,
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.sandboxCostBudget).toBeNull();
  });

  test("user-only budget (no repository) is exposed verbatim in USD", () => {
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, repositoryId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: {
        _id: repositoryId,
        sourceRepoFullName: "acme/widget",
        sourceRepoName: "widget",
      },
      sandboxStatus: "ready",
      sandboxModeStatus: { reasonCode: "available", message: null },
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library",
      },
      sandboxIsActivatable: false,
      sandboxCostBudgets: {
        userBudget: { remainingCents: 320, capacityCents: 500, resetAtMs: 1_700_000_000_000 },
        repositoryBudget: null,
      },
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    // Cents → USD with two-decimal precision; the hook is the right
    // place for this conversion because every UI consumer would
    // otherwise re-do it.
    expect(result.current.sandboxCostBudget).toEqual({
      remainingUsd: 3.2,
      capacityUsd: 5,
      resetAtMs: 1_700_000_000_000,
    });
  });

  test("when both caps are present, the hook surfaces the more restrictive remaining (repository)", () => {
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, repositoryId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: {
        _id: repositoryId,
        sourceRepoFullName: "acme/widget",
        sourceRepoName: "widget",
      },
      sandboxStatus: "ready",
      sandboxModeStatus: { reasonCode: "available", message: null },
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library",
      },
      sandboxIsActivatable: false,
      sandboxCostBudgets: {
        userBudget: { remainingCents: 480, capacityCents: 500, resetAtMs: 1_700_000_010_000 },
        // Repository cap has only $0.10 left — far less than the user's
        // $4.80, so the repository cap is the binding constraint.
        repositoryBudget: { remainingCents: 10, capacityCents: 5000, resetAtMs: 1_700_000_005_000 },
      },
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.sandboxCostBudget).not.toBeNull();
    expect(result.current.sandboxCostBudget!.remainingUsd).toBeCloseTo(0.1);
    // Capacity tracks the binding cap (repository = $50) — keeps the
    // ratio "10¢ of $50.00 remaining" coherent rather than the cross-
    // axis "10¢ of $5.00".
    expect(result.current.sandboxCostBudget!.capacityUsd).toBe(50);
    // Reset is the *earlier* of the two so the countdown reflects when
    // the binding constraint releases (repository's earlier reset wins).
    expect(result.current.sandboxCostBudget!.resetAtMs).toBe(1_700_000_005_000);
  });

  test("when both caps are present, the hook surfaces the more restrictive remaining (user)", () => {
    // Mirror of the above with the user cap binding instead.
    useQueryMock.mockReturnValue({
      thread: { _id: threadId, repositoryId, defaultGroundLibrary: false, defaultGroundSandbox: false },
      attachedRepository: {
        _id: repositoryId,
        sourceRepoFullName: "acme/widget",
        sourceRepoName: "widget",
      },
      sandboxStatus: "ready",
      sandboxModeStatus: { reasonCode: "available", message: null },
      chatModes: {
        modes: {
          discuss: { enabled: true },
          library: { enabled: true },
        },
        defaultMode: "library",
      },
      sandboxIsActivatable: false,
      sandboxCostBudgets: {
        userBudget: { remainingCents: 5, capacityCents: 500, resetAtMs: 1_700_000_010_000 },
        repositoryBudget: { remainingCents: 4500, capacityCents: 5000, resetAtMs: 1_700_000_020_000 },
      },
    });

    const { result } = renderHook(() => useThreadCapabilities(threadId));

    expect(result.current.sandboxCostBudget!.remainingUsd).toBeCloseTo(0.05);
    expect(result.current.sandboxCostBudget!.capacityUsd).toBe(5);
    // Repository reset is later, but user cap binds first (and resets
    // earlier in this fixture too).
    expect(result.current.sandboxCostBudget!.resetAtMs).toBe(1_700_000_010_000);
  });
});
