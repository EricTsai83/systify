import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { getDefaultThreadMode, type ChatMode, type ChatModeResolution } from "../../convex/chatModeResolver";
import type { RepositoryId, SandboxModeStatus, ThreadId } from "@/lib/types";

export type SandboxLifecycleStatus = Doc<"sandboxes">["status"];

export interface AttachedRepositorySummary {
  id: RepositoryId;
  fullName: string;
  shortName: string;
}

/**
 * Plan 10 — sandbox daily-cost-cap snapshot for the chat-panel ticker.
 *
 * `remainingUsd` / `capacityUsd` are USD floats so the UI can format
 * with two decimals directly; cents-as-int is a server-side concern
 * the hook abstracts away. `resetAtMs` drives the "Resets in 3h 12m"
 * countdown.
 *
 * Always non-null when sandbox mode is at least theoretically usable
 * (thread has a repo). The frontend takes `min(user.remaining,
 * workspace.remaining)` as the visible budget so the ticker reflects
 * whichever cap will fire first.
 */
export interface SandboxDailyCostBudget {
  remainingUsd: number;
  capacityUsd: number;
  resetAtMs: number;
}

export interface ThreadCapabilities {
  /** True while the underlying `getThreadContext` query is still in flight. */
  isLoading: boolean;
  /** True when a non-null thread id resolved to no thread (deleted / unauthorized). */
  isMissingThread: boolean;
  /** Repository attached to the thread, if any. */
  attachedRepository: AttachedRepositorySummary | null;
  /** Sandbox lifecycle status of the attached repository's latest sandbox. */
  sandboxStatus: SandboxLifecycleStatus | null;
  /** User-facing sandbox-mode status when a repository is attached. */
  sandboxModeStatus: SandboxModeStatus | null;
  /** Modes the UI should render as enabled in the selector. */
  availableModes: readonly ChatMode[];
  /** Mode the UI should preselect when the thread first loads. */
  defaultMode: ChatMode;
  /** Tooltip text keyed by mode for the greyed-out options. */
  disabledReasons: ChatModeResolution["disabledReasons"];
  /** Non-null when a legacy thread has been archived for read-only browsing. */
  lockedAt: number | null;
  /**
   * Plan 10 — visible sandbox cost budget for the ticker. `null` when
   * sandbox mode isn't currently relevant (no repo attached). When
   * non-null, this reflects the *more restrictive* of the per-user and
   * per-workspace caps so the user sees a single coherent number.
   */
  sandboxCostBudget: SandboxDailyCostBudget | null;
}

/**
 * Disabled-mode hints for the "no thread selected" state. Mirrors the no-repo
 * branch of {@link resolveChatModes} but tailored for the case where the user
 * has not even started a thread yet — the unlock instructions need to nudge
 * them to start a conversation first, then attach a repo.
 */
const NO_THREAD_DISABLED_REASONS: ChatModeResolution["disabledReasons"] = {
  docs: "Start a thread and attach a repository to use Design Docs mode.",
  sandbox: "Start a thread, attach a repository, and provision a sandbox to use Sandbox mode.",
};

const NO_THREAD_CAPABILITIES: ThreadCapabilities = {
  isLoading: false,
  isMissingThread: false,
  attachedRepository: null,
  sandboxStatus: null,
  sandboxModeStatus: null,
  availableModes: ["discuss"],
  defaultMode: getDefaultThreadMode(false),
  disabledReasons: NO_THREAD_DISABLED_REASONS,
  sandboxCostBudget: null,
  lockedAt: null,
};

const NO_THREAD_LOADING_CAPABILITIES: ThreadCapabilities = {
  ...NO_THREAD_CAPABILITIES,
  isLoading: true,
};

const MISSING_THREAD_CAPABILITIES: ThreadCapabilities = {
  ...NO_THREAD_CAPABILITIES,
  isMissingThread: true,
};

/**
 * Bridges {@link api.threadContext.getThreadContext} (which itself wraps
 * {@link resolveChatModes}) into the UI capability shape. This is the only
 * source of mode-availability the UI consumes — chat-panel selectors,
 * mode-gated buttons, and disabled-mode tooltips all read from here.
 *
 * Behavior:
 *
 * - `threadId === null`: returns "no-thread" defaults (general only). The chat
 *   input is always present per US 8, so callers must still get a coherent
 *   capability shape even before any thread exists.
 * - Query in flight: `isLoading` is true; modes default to general so the
 *   selector renders something sensible during the brief loading window.
 * - Query returns `null` (thread was deleted out from under us): falls back to
 *   the no-thread defaults so the UI does not get stuck.
 * - Query resolves: the resolver output is forwarded verbatim, paired with the
 *   attached repository's display fields and the sandbox lifecycle status.
 */
export function useThreadCapabilities(threadId: ThreadId | null): ThreadCapabilities {
  const ctx = useQuery(api.threadContext.getThreadContext, threadId ? { threadId } : "skip");
  if (threadId === null) {
    return NO_THREAD_CAPABILITIES;
  }

  if (ctx === undefined) {
    return NO_THREAD_LOADING_CAPABILITIES;
  }

  if (ctx === null) {
    return MISSING_THREAD_CAPABILITIES;
  }

  const attachedRepository = ctx.attachedRepository
    ? {
        id: ctx.attachedRepository._id,
        fullName: ctx.attachedRepository.sourceRepoFullName,
        shortName: ctx.attachedRepository.sourceRepoName,
      }
    : null;

  return {
    isLoading: false,
    isMissingThread: false,
    attachedRepository,
    sandboxStatus: ctx.sandboxStatus,
    sandboxModeStatus: ctx.sandboxModeStatus,
    availableModes: ctx.chatModes.availableModes,
    defaultMode: ctx.chatModes.defaultMode,
    disabledReasons: ctx.chatModes.disabledReasons,
    lockedAt: ctx.thread.lockedAt ?? null,
    sandboxCostBudget: deriveSandboxCostBudget(ctx.sandboxCostBudgets),
  };
}

/**
 * Plan 10 — collapse the (per-user, per-workspace) budget pair into a
 * single user-facing budget. Returns the *more restrictive* of the two
 * remaining values so the ticker shows the budget that will actually
 * block the next send.
 *
 * Returns the smaller `capacityUsd` and the smaller `remainingUsd`
 * (independent picks) and the *earlier* `resetAtMs`. They might come
 * from different buckets — that is fine for the ticker, which only
 * needs a coherent "your floor" number rather than perfect
 * reconciliation between the two scopes.
 */
function deriveSandboxCostBudget(
  budgets: NonNullable<ReturnType<typeof useQuery<typeof api.threadContext.getThreadContext>>>["sandboxCostBudgets"],
): SandboxDailyCostBudget | null {
  if (!budgets) {
    return null;
  }
  const userRemaining = budgets.userBudget.remainingCents / 100;
  const userCapacity = budgets.userBudget.capacityCents / 100;
  if (!budgets.workspaceBudget) {
    return {
      remainingUsd: userRemaining,
      capacityUsd: userCapacity,
      resetAtMs: budgets.userBudget.resetAtMs,
    };
  }
  const workspaceRemaining = budgets.workspaceBudget.remainingCents / 100;
  const workspaceCapacity = budgets.workspaceBudget.capacityCents / 100;
  // Pick the more restrictive remaining + the earlier reset. Capacity is
  // tied to whichever side gave us the binding remaining — using the
  // matching capacity keeps "$0.02 of $5.00 remaining" coherent.
  const userBinds = userRemaining <= workspaceRemaining;
  return {
    remainingUsd: userBinds ? userRemaining : workspaceRemaining,
    capacityUsd: userBinds ? userCapacity : workspaceCapacity,
    resetAtMs: Math.min(budgets.userBudget.resetAtMs, budgets.workspaceBudget.resetAtMs),
  };
}
