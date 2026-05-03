import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { getSandboxModeStatus, type SandboxModeStatus } from "./lib/sandboxAvailability";
import { resolveChatModes, type ChatModeResolution, type ChatModeSandboxStatus } from "./chatModeResolver";
import { getSandboxFeatureGate } from "./lib/sandboxFeatureFlag";

export type SandboxTableStatus = Doc<"sandboxes">["status"];

export interface ThreadContext {
  thread: Doc<"threads">;
  attachedRepository: Doc<"repositories"> | null;
  sandboxStatus: SandboxTableStatus | null;
  sandboxModeStatus: SandboxModeStatus | null;
  chatModes: ChatModeResolution;
}

/**
 * Maps the sandbox table status enum onto the ChatModeResolver's input domain.
 *
 * The sandbox table tracks provider-level lifecycle (`stopped`, `archived`, ...)
 * but the resolver only cares about whether sandbox mode is available right now.
 * Both `stopped` and `archived` collapse to `expired` for resolver purposes —
 * they are not currently usable but the user can re-provision a sandbox.
 */
function toChatModeSandboxStatus(status: SandboxTableStatus | null): ChatModeSandboxStatus {
  if (!status) {
    return "none";
  }
  switch (status) {
    case "ready":
    case "provisioning":
    case "failed":
      return status;
    case "stopped":
    case "archived":
      return "expired";
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

  const chatModes = resolveChatModes(
    attachedRepository !== null,
    toChatModeSandboxStatus(sandboxStatus),
    getSandboxFeatureGate(viewerTokenIdentifier),
  );

  return {
    thread,
    attachedRepository,
    sandboxStatus,
    sandboxModeStatus,
    chatModes,
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
