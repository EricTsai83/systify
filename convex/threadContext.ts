import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { getRepositorySandboxStatus, type SandboxModeStatus } from "./lib/repositorySandbox";
import {
  computeSandboxCostCapEvaluation,
  resolveChatModes,
  toChatModeSandboxStatus,
  type ChatModeResolution,
  type SandboxCostCapGate,
} from "./lib/chatEligibility";
import { type SandboxDailyCostBudget } from "./lib/rateLimit";

export type SandboxTableStatus = Doc<"sandboxes">["status"];

/**
 * Plan 10 — daily-cost-cap signals piped through the thread-context query
 * so the UI can render a "spent today" indicator + a "resets at" countdown
 * without re-querying the rate-limiter component on the frontend.
 *
 * `userBudget` is always populated; `workspaceBudget` is populated only
 * when the thread has an attached workspace. The frontend takes the
 * minimum of the two `remainingCents` values for its visible budget.
 */
export interface ThreadContextSandboxCostBudgets {
  userBudget: SandboxDailyCostBudget;
  workspaceBudget: SandboxDailyCostBudget | null;
}

export interface ThreadContext {
  thread: Doc<"threads">;
  attachedRepository: Doc<"repositories"> | null;
  sandboxStatus: SandboxTableStatus | null;
  sandboxModeStatus: SandboxModeStatus | null;
  chatModes: ChatModeResolution;
  /**
   * Plan 10 — daily-cost-cap budgets for the viewer (always) and the
   * thread's workspace (when one is attached). `null` when sandbox mode
   * isn't currently relevant to this thread (no attached repo); avoids
   * the cost of a rate-limiter peek in the no-repo case where the UI
   * has no use for the value.
   */
  sandboxCostBudgets: ThreadContextSandboxCostBudgets | null;
  /**
   * True when clicking the (otherwise-disabled) Sandbox grounding
   * toggle should trigger a lazy sandbox provision via
   * `repositories.requestSandboxActivation`. The Sandbox grounding
   * axis stays disabled until activation completes; this flag is the
   * UI's signal that the disabled toggle is actionable (vs permanently
   * locked out by cost cap / no repo / already provisioning).
   *
   * Activatable iff: a repository is attached, the cost-cap gate is
   * open, and the sandbox lifecycle is in one of the "needs provision
   * or re-provision" states (`none` / `expired` / `failed`). Already-
   * provisioning sandboxes return false to avoid double-queueing.
   */
  sandboxIsActivatable: boolean;
}

async function loadThread(ctx: QueryCtx, threadId: Id<"threads">): Promise<Doc<"threads"> | null> {
  return await ctx.db.get(threadId);
}

async function enrichThreadContext(
  ctx: QueryCtx,
  thread: Doc<"threads">,
  viewerTokenIdentifier: string,
): Promise<ThreadContext> {
  let attachedRepository: Doc<"repositories"> | null = null;
  let sandboxStatus: SandboxTableStatus | null = null;
  let sandboxModeStatus: SandboxModeStatus | null = null;

  if (thread.repositoryId) {
    attachedRepository = await ctx.db.get(thread.repositoryId);
    if (attachedRepository) {
      const result = await getRepositorySandboxStatus(ctx, attachedRepository);
      sandboxStatus = result.sandbox?.status ?? null;
      sandboxModeStatus = result.sandboxModeStatus;
    }
  }

  // Only consult the cost-cap gate when sandbox mode is at all relevant
  // (a repository is attached). Without a repo, sandbox mode is already
  // gated by the no-repo branch of the resolver, and an extra rate-limiter
  // peek would be wasted query work that also pollutes the reactive query's
  // read set with rate-limiter docs that change as ANY user settles cost.
  // Skipping the peek for no-repo threads keeps those subscriptions stable
  // and bounds re-renders to threads where sandbox mode is at least
  // theoretically usable.
  let costGate: SandboxCostCapGate = { enabled: true };
  let sandboxCostBudgets: ThreadContextSandboxCostBudgets | null = null;
  if (attachedRepository !== null) {
    const evaluation = await computeSandboxCostCapEvaluation(ctx, viewerTokenIdentifier, thread.workspaceId ?? null);
    costGate = evaluation.gate;
    sandboxCostBudgets = { userBudget: evaluation.userBudget, workspaceBudget: evaluation.workspaceBudget };
  }

  const chatModeSandboxStatus = toChatModeSandboxStatus(sandboxModeStatus);
  // Post-Lab collapse `resolveChatModes` only takes `hasAttachedRepo`; the
  // (sandbox-status, cost-cap) matrix that used to live here is now
  // surfaced via the grounding axes on `resolveWorkspaceModes`. The
  // per-thread chat-mode resolver stays simple so legacy callers reading
  // `chatModes` get a stable shape.
  const chatModes = resolveChatModes(attachedRepository !== null);

  const sandboxIsActivatable =
    attachedRepository !== null &&
    costGate.enabled &&
    (chatModeSandboxStatus === "none" || chatModeSandboxStatus === "expired" || chatModeSandboxStatus === "failed");

  return {
    thread,
    attachedRepository,
    sandboxStatus,
    sandboxModeStatus,
    chatModes,
    sandboxCostBudgets,
    sandboxIsActivatable,
  };
}

export const getThreadContext = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const thread = await loadThread(ctx, args.threadId);

    if (!thread) {
      return null;
    }

    if (thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }

    if (thread.repositoryId) {
      const repository = await ctx.db.get(thread.repositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Thread not found.");
      }
    }

    return enrichThreadContext(ctx, thread, identity.tokenIdentifier);
  },
});

export const getThreadContextInternal = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    // Internal callers don't carry an authenticated viewer; surface the
    // thread owner's view of mode availability so the result is a faithful
    // representation of "what the owner would see right now".
    const thread = await loadThread(ctx, args.threadId);
    if (!thread) {
      return null;
    }
    return enrichThreadContext(ctx, thread, thread.ownerTokenIdentifier);
  },
});
