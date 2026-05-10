import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { getSandboxModeStatus, type SandboxModeStatus } from "./lib/sandboxAvailability";
import {
  DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
  DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
  resolveChatModes,
  type ChatModeResolution,
  type ChatModeSandboxStatus,
  type SandboxCostCapGate,
} from "./chatModeResolver";
import { getSandboxFeatureGate } from "./lib/sandboxFeatureFlag";
import {
  getSandboxReplyEstimateCents,
  peekSandboxDailyCostForUser,
  peekSandboxDailyCostForWorkspace,
  type SandboxDailyCostBudget,
} from "./lib/rateLimit";

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
}

/**
 * Maps the centralized sandbox availability result onto the legacy
 * ChatModeResolver input domain. This keeps TTL, missing remote id/path, and
 * provider status semantics in `lib/sandboxAvailability` instead of duplicating
 * them across UI capability queries.
 */
function toChatModeSandboxStatus(status: SandboxModeStatus | null): ChatModeSandboxStatus {
  switch (status?.reasonCode ?? "missing_sandbox") {
    case "available":
      return "ready";
    case "sandbox_provisioning":
      return "provisioning";
    case "sandbox_expired":
      return "expired";
    case "sandbox_unavailable":
      return "failed";
    case "missing_sandbox":
      return "none";
  }
}

async function loadThread(ctx: QueryCtx, threadId: Id<"threads">): Promise<Doc<"threads"> | null> {
  return await ctx.db.get(threadId);
}

/**
 * Build the resolver inputs for a thread.
 *
 * `viewerTokenIdentifier` is the *authenticated* viewer's identifier from
 * `requireViewerIdentity` — never a function argument or stored doc field.
 * It feeds the Plan-04 sandbox feature gate (`getSandboxFeatureGate`) so the
 * resolver can return the correct `disabledReasons.sandbox` tooltip for *this*
 * viewer (private-beta flag off vs. allowlist miss vs. lifecycle-derived).
 *
 * The internal variant of the query trusts its callers (other Convex
 * functions) and uses the thread's owner as the viewer — there is no
 * authenticated context inside an internal query, and the contract is "give
 * me the same view the owner would see" so they share one code path.
 */
/**
 * Plan 10 — derive the cost-cap gate from a peek of both the per-user
 * and per-workspace daily buckets. Returns:
 *
 *   - the gate (closed iff either bucket would refuse the projected
 *     estimate cost);
 *   - the bucket snapshots (always, for UI rendering);
 *
 * Both peeks happen inside the query's transaction so the gate decision
 * and the displayed budget agree even under concurrent settlement: a
 * rate-limit settle that lands between the user-peek and the workspace-
 * peek would update both buckets atomically from the user's POV.
 *
 * Why we peek even when the gate ends up open: the UI's cost-ticker
 * tooltip ("$X.XX of $Y.YY remaining today") is shown regardless of
 * whether the cap blocked the send. Doing both peeks once keeps the
 * query a single source of truth.
 */
async function computeSandboxCostBudgets(
  ctx: QueryCtx,
  ownerTokenIdentifier: string,
  workspaceId: Id<"workspaces"> | null,
): Promise<{ gate: SandboxCostCapGate; budgets: ThreadContextSandboxCostBudgets }> {
  const estimateCents = getSandboxReplyEstimateCents();
  const userBudget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
  const workspaceBudget = workspaceId ? await peekSandboxDailyCostForWorkspace(ctx, workspaceId) : null;

  // User cap is checked first to match `assertSandboxDailyCostBudget`'s
  // ordering on the write path (`convex/lib/rateLimit.ts`). When both
  // would block the gate surfaces the user-cap tooltip — the more
  // user-actionable signal because the user can switch to docs/discuss
  // immediately, whereas the workspace-cap reset would also gate every
  // other workspace member.
  if (userBudget.remainingCents < estimateCents) {
    return {
      gate: {
        enabled: false,
        reason: "user_daily_cap_exceeded",
        tooltip: DISABLED_REASON_SANDBOX_USER_CAP_EXCEEDED,
        resetAtMs: userBudget.resetAtMs,
      },
      budgets: { userBudget, workspaceBudget },
    };
  }
  if (workspaceBudget && workspaceBudget.remainingCents < estimateCents) {
    return {
      gate: {
        enabled: false,
        reason: "workspace_daily_cap_exceeded",
        tooltip: DISABLED_REASON_SANDBOX_WORKSPACE_CAP_EXCEEDED,
        resetAtMs: workspaceBudget.resetAtMs,
      },
      budgets: { userBudget, workspaceBudget },
    };
  }
  return { gate: { enabled: true }, budgets: { userBudget, workspaceBudget } };
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
    if (attachedRepository?.latestSandboxId) {
      const sandbox = await ctx.db.get(attachedRepository.latestSandboxId);
      sandboxStatus = sandbox?.status ?? null;
      sandboxModeStatus = getSandboxModeStatus(sandbox);
    } else if (attachedRepository) {
      sandboxModeStatus = getSandboxModeStatus(null);
    }
  }

  // Plan 10 — only consult the cost-cap gate when sandbox mode is at
  // all relevant (a repository is attached). Without a repo, sandbox
  // mode is already gated by the no-repo branch of the resolver, and
  // an extra rate-limiter peek would be wasted query work that also
  // pollutes the reactive query's read set with rate-limiter docs that
  // change as ANY user settles cost. Skipping the peek for no-repo
  // threads keeps those subscriptions stable and bounds re-renders to
  // threads where sandbox mode is at least theoretically usable.
  let costGate: SandboxCostCapGate = { enabled: true };
  let sandboxCostBudgets: ThreadContextSandboxCostBudgets | null = null;
  if (attachedRepository !== null) {
    const { gate, budgets } = await computeSandboxCostBudgets(ctx, viewerTokenIdentifier, thread.workspaceId ?? null);
    costGate = gate;
    sandboxCostBudgets = budgets;
  }

  const chatModes = resolveChatModes(
    attachedRepository !== null,
    toChatModeSandboxStatus(sandboxModeStatus),
    getSandboxFeatureGate(viewerTokenIdentifier),
    costGate,
  );

  return {
    thread,
    attachedRepository,
    sandboxStatus,
    sandboxModeStatus,
    chatModes,
    sandboxCostBudgets,
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
    // representation of "what the owner would see right now". Until Plan
    // 13's percentage rollout we evaluate the gate against the owner;
    // afterwards this becomes the obvious place to swap in the rollout
    // hash without disturbing public-query semantics.
    const thread = await loadThread(ctx, args.threadId);
    if (!thread) {
      return null;
    }
    return enrichThreadContext(ctx, thread, thread.ownerTokenIdentifier);
  },
});
