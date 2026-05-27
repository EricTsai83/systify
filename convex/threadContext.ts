import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { loadOwnedDoc } from "./lib/ownedDocs";
import { getRepositorySandboxStatus, type SandboxModeStatus } from "./lib/repositorySandbox";
import {
  computeSandboxCostCapEvaluation,
  resolveChatModes,
  resolveSandboxGroundingAxis,
  toChatModeSandboxStatus,
  type ChatModeResolution,
  type SandboxCostCapGate,
} from "./lib/chatEligibility";
import { type SandboxDailyCostBudget } from "./lib/rateLimit";

export type SandboxTableStatus = Doc<"sandboxes">["status"];

/**
 * Daily-cost-cap signals piped through the thread-context query
 * so the UI can render a "spent today" indicator + a "resets at" countdown
 * without re-querying the rate-limiter component on the frontend.
 *
 * `userBudget` is always populated; `repositoryBudget` is populated only
 * when the thread has an attached repository. The frontend takes the
 * minimum of the two `remainingCents` values for its visible budget.
 */
export interface ThreadContextSandboxCostBudgets {
  userBudget: SandboxDailyCostBudget;
  repositoryBudget: SandboxDailyCostBudget | null;
}

export interface ThreadContext {
  thread: Doc<"threads">;
  attachedRepository: Doc<"repositories"> | null;
  sandboxStatus: SandboxTableStatus | null;
  sandboxModeStatus: SandboxModeStatus | null;
  chatModes: ChatModeResolution;
  /**
   * Daily-cost-cap budgets for the viewer (always) and the
   * thread's repository (when one is attached). `null` when sandbox mode
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
  args: {
    thread: Doc<"threads">;
    /**
     * Pre-loaded by the public/internal query so {@link enrichThreadContext}
     * never re-fetches the same row. The public query also uses the doc
     * for ownership validation; threading it through here keeps the
     * total `ctx.db.get(repositoryId)` count at one per request.
     */
    attachedRepository: Doc<"repositories"> | null;
    viewerTokenIdentifier: string;
  },
): Promise<ThreadContext> {
  const { thread, attachedRepository, viewerTokenIdentifier } = args;
  let sandboxStatus: SandboxTableStatus | null = null;
  let sandboxModeStatus: SandboxModeStatus | null = null;

  if (attachedRepository) {
    const result = await getRepositorySandboxStatus(ctx, attachedRepository);
    sandboxStatus = result.sandbox?.status ?? null;
    sandboxModeStatus = result.sandboxModeStatus;
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
    const evaluation = await computeSandboxCostCapEvaluation(ctx, viewerTokenIdentifier, attachedRepository._id);
    costGate = evaluation.gate;
    sandboxCostBudgets = { userBudget: evaluation.userBudget, repositoryBudget: evaluation.repositoryBudget };
  }

  const chatModeSandboxStatus = toChatModeSandboxStatus(sandboxModeStatus);
  // `resolveChatModes` only takes `hasAttachedRepo`; sandbox status and
  // cost cap feed the grounding axes on `resolveRepositoryModes` instead.
  // The per-thread chat-mode resolver stays a thin function so `chatModes`
  // consumers see a stable shape.
  const chatModes = resolveChatModes(attachedRepository !== null);

  // Derive `sandboxIsActivatable` from the same grounding-axis resolver the
  // repository read path uses so the activation rule lives in exactly one
  // place. The verdict is "activatable" iff disabled with `isActivatable:
  // true` — covers (no sandbox / expired / failed) while a healthy ready
  // sandbox or a cost-capped one stays not-activatable.
  const sandboxGroundingVerdict = resolveSandboxGroundingAxis(
    attachedRepository !== null,
    chatModeSandboxStatus,
    costGate,
  );
  const sandboxIsActivatable = !sandboxGroundingVerdict.enabled && sandboxGroundingVerdict.isActivatable;

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
    // Probe for existence first so a stale thread id returns `null` (lets the
    // client clear the URL) instead of "Thread not found." — both missing and
    // unauthorized return null to avoid disclosing existence.
    const probe = await loadThread(ctx, args.threadId);
    if (!probe) {
      return null;
    }
    const { identity, doc: thread } = await loadOwnedDoc(ctx, args.threadId);
    if (!thread) {
      return null;
    }

    let attachedRepository: Doc<"repositories"> | null = null;
    if (thread.repositoryId) {
      const { doc } = await loadOwnedDoc(ctx, thread.repositoryId);
      attachedRepository = doc;
    }

    return enrichThreadContext(ctx, {
      thread,
      attachedRepository,
      viewerTokenIdentifier: identity.tokenIdentifier,
    });
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
    const attachedRepository = thread.repositoryId ? await ctx.db.get(thread.repositoryId) : null;
    return enrichThreadContext(ctx, {
      thread,
      attachedRepository,
      viewerTokenIdentifier: thread.ownerTokenIdentifier,
    });
  },
});
