import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { getDefaultThreadMode, type ChatMode } from "../../convex/lib/chatMode";
import type { ChatModeResolution } from "../../convex/lib/chatEligibility";
import { isRepolessAgentEnabled } from "@/lib/repoless-agent";
import type { LlmProvider, RepositoryId, SandboxModeStatus, ThreadId } from "@/lib/types";

type ChatModeVerdicts = ChatModeResolution["modes"];

export type SandboxLifecycleStatus = Doc<"sandboxes">["status"];

export interface AttachedRepositorySummary {
  id: RepositoryId;
  fullName: string;
  shortName: string;
}

/**
 * Sandbox daily-cost-cap snapshot for the chat-panel ticker.
 *
 * `remainingUsd` / `capacityUsd` are USD floats so the UI can format
 * with two decimals directly; cents-as-int is a server-side concern
 * the hook abstracts away. `resetAtMs` drives the "Resets in 3h 12m"
 * countdown.
 *
 * Always non-null when sandbox mode is at least theoretically usable
 * (thread has a repo). The frontend takes `min(user.remaining,
 * repository.remaining)` as the visible budget so the ticker reflects
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
  /**
   * Per-mode verdict from the resolver. Consumers narrow on `.enabled` to
   * read `code` / `message` on the disabled branch.
   */
  modes: ChatModeVerdicts;
  /** Mode the UI should preselect when the thread first loads. */
  defaultMode: ChatMode;
  /**
   * Visible sandbox cost budget for the ticker. `null` when sandbox
   * mode isn't currently relevant (no repo attached). When
   * non-null, this reflects the *more restrictive* of the per-user and
   * per-repository caps so the user sees a single coherent number.
   */
  sandboxCostBudget: SandboxDailyCostBudget | null;
  /**
   * Per-thread composer-default snapshot for the Discuss grounding
   * toggles. Sourced from `threads.defaultGroundLibrary` /
   * `threads.defaultGroundSandbox`. The shell uses these to seed the
   * `groundLibrary` / `groundSandbox` state when a new thread is
   * opened so the composer "remembers" the user's last preference.
   * Both default to `false` on threads that have never recorded a
   * preference (freshly created threads, no-thread sentinel) — the
   * resolver does not infer "should be on" from structural availability
   * here so a click is always intentional.
   */
  defaultGroundLibrary: boolean;
  defaultGroundSandbox: boolean;
  singleTurnEnabled: boolean;
  singleTurnResetPending: boolean;
  agentEnabled: boolean;
  agentRole: string | null;
  agentInstructions: string | null;
  /**
   * Provider this thread is locked to, or `null` for fresh threads. The
   * composer narrows the model picker to this provider so provider-level
   * cached thread context stays coherent.
   */
  lockedProvider: LlmProvider | null;
  /**
   * Last model the user picked for this thread, refreshed on every
   * send. Pre-fills the composer picker when a thread is reopened.
   * `null` for fresh threads — the resolver falls back to the
   * capability default in that case.
   */
  defaultModelName: string | null;
}

/**
 * Per-mode verdict for the "no thread selected" state. Mirrors the no-repo
 * branch of {@link resolveChatModes} but tailored for the case where the
 * user has not even started a thread yet — the unlock instructions nudge
 * them to start a conversation first, then attach a repo.
 */
const NO_THREAD_MODE_VERDICTS: ChatModeVerdicts = {
  discuss: { enabled: true },
  library: {
    enabled: false,
    code: "no_repository_attached",
    message: "Start a thread and attach a repository to use Library mode.",
  },
};

const NO_THREAD_CAPABILITIES: ThreadCapabilities = {
  isLoading: false,
  isMissingThread: false,
  attachedRepository: null,
  sandboxStatus: null,
  sandboxModeStatus: null,
  modes: NO_THREAD_MODE_VERDICTS,
  defaultMode: getDefaultThreadMode(false),
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
    modes: ctx.chatModes.modes,
    defaultMode: ctx.chatModes.defaultMode,
    sandboxCostBudget: deriveSandboxCostBudget(ctx.sandboxCostBudgets),
    defaultGroundLibrary: ctx.thread.defaultGroundLibrary ?? false,
    defaultGroundSandbox: ctx.thread.defaultGroundSandbox ?? false,
    singleTurnEnabled: ctx.thread.singleTurnEnabled ?? false,
    singleTurnResetPending: ctx.thread.singleTurnResetPending ?? false,
    agentEnabled: isRepolessAgentEnabled(ctx.thread),
    agentRole: ctx.thread.agentRole ?? null,
    agentInstructions: ctx.thread.agentInstructions ?? null,
    lockedProvider: ctx.thread.lockedProvider ?? null,
    defaultModelName: ctx.thread.defaultModelName ?? null,
  };
}

/**
 * Collapse the (per-user, per-repository) budget pair into a
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
  if (!budgets.repositoryBudget) {
    return {
      remainingUsd: userRemaining,
      capacityUsd: userCapacity,
      resetAtMs: budgets.userBudget.resetAtMs,
    };
  }
  const repositoryRemaining = budgets.repositoryBudget.remainingCents / 100;
  const repositoryCapacity = budgets.repositoryBudget.capacityCents / 100;
  // Pick the more restrictive remaining + the earlier reset. Capacity is
  // tied to whichever side gave us the binding remaining — using the
  // matching capacity keeps "$0.02 of $5.00 remaining" coherent.
  const userBinds = userRemaining <= repositoryRemaining;
  return {
    remainingUsd: userBinds ? userRemaining : repositoryRemaining,
    capacityUsd: userBinds ? userCapacity : repositoryCapacity,
    resetAtMs: Math.min(budgets.userBudget.resetAtMs, budgets.repositoryBudget.resetAtMs),
  };
}
