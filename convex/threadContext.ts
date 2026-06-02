import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { loadOwnedDoc } from "./lib/ownedDocs";
import { getRepositorySandboxStatus, type SandboxModeStatus } from "./lib/repositorySandbox";
import { type ChatModeResolution } from "./lib/chatEligibility";
import { evaluateThreadModeAvailability } from "./lib/modeAvailability";
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
  let sandboxSnapshot: { sandboxModeStatus: SandboxModeStatus; sandbox: Doc<"sandboxes"> | null } | null = null;

  if (attachedRepository) {
    sandboxSnapshot = await getRepositorySandboxStatus(ctx, attachedRepository);
  }

  const availability = await evaluateThreadModeAvailability(ctx, {
    thread,
    attachedRepository,
    viewerTokenIdentifier,
    preloadedSandboxStatus: sandboxSnapshot,
  });

  return {
    thread,
    attachedRepository,
    sandboxStatus: availability.sandbox?.status ?? null,
    sandboxModeStatus: availability.sandboxModeStatus,
    chatModes: availability.chatModes,
    sandboxCostBudgets: availability.sandboxCostBudgets,
    sandboxIsActivatable: availability.sandboxIsActivatable,
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
