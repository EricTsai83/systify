import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { requireActiveRepositoryForViewer } from "./lib/repositoryAccess";
import { requireOwnedDoc } from "./lib/ownedDocs";
import { assertFeatureAccess } from "./lib/entitlements";
import { DEFAULT_AUTO_STOP_MINUTES } from "./lib/constants";
import { resolveSandboxSessionStartStateForRepository } from "./lib/liveSourceLifecycle";

async function findReusableSession(
  ctx: QueryCtx,
  repositoryId: Id<"repositories">,
): Promise<Doc<"sandboxSessions"> | null> {
  for (const status of ["active", "starting", "paused"] as const) {
    const session = await ctx.db
      .query("sandboxSessions")
      .withIndex("by_repositoryId_and_status", (q) => q.eq("repositoryId", repositoryId).eq("status", status))
      .first();
    if (session) {
      return session;
    }
  }
  return null;
}

export const startSandboxSession = mutation({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const { identity, repository } = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: args.repositoryId,
      notFoundMessage: "Repository not found.",
      archivedMessage: "This repository is archived. Restore it to start a sandbox session.",
    });
    await assertFeatureAccess(ctx, identity, "sandboxGrounding");

    const existing = await findReusableSession(ctx, args.repositoryId);
    if (existing) {
      if (existing.status === "paused") {
        await ctx.db.patch(existing._id, {
          status: "active",
          lastActivityAt: Date.now(),
          lastResumedAt: Date.now(),
          pausedAt: undefined,
        });
      }
      return existing._id;
    }

    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
    const startState = resolveSandboxSessionStartStateForRepository({
      latestSandboxId: repository.latestSandboxId,
      sandbox,
    });
    const now = Date.now();
    return await ctx.db.insert("sandboxSessions", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: args.repositoryId,
      sandboxId: startState.sandboxId,
      status: startState.status,
      startedAt: now,
      lastActivityAt: now,
      lastResumedAt: now,
      idleAutoPauseMinutes: DEFAULT_AUTO_STOP_MINUTES,
      spentCents: 0,
    });
  },
});

export const pauseSandboxSession = mutation({
  args: { sessionId: v.id("sandboxSessions") },
  handler: async (ctx, args) => {
    const { doc: session } = await requireOwnedDoc(ctx, args.sessionId, {
      notFoundMessage: "Sandbox session not found.",
    });
    if (session.status !== "active") {
      return { paused: false, status: session.status };
    }
    await ctx.db.patch(args.sessionId, {
      status: "paused",
      pausedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.sandboxSessionsNode.stopRemoteSandboxForSession, {
      sessionId: args.sessionId,
    });
    return { paused: true, status: "paused" as const };
  },
});

export const stopSandboxSession = mutation({
  args: { sessionId: v.id("sandboxSessions") },
  handler: async (ctx, args) => {
    const { doc: session } = await requireOwnedDoc(ctx, args.sessionId, {
      notFoundMessage: "Sandbox session not found.",
    });
    if (session.status === "stopped" || session.status === "ended") {
      return { stopped: false, status: session.status };
    }
    await ctx.db.patch(args.sessionId, {
      status: "stopped",
      endedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.sandboxSessionsNode.stopRemoteSandboxForSession, {
      sessionId: args.sessionId,
    });
    return { stopped: true, status: "stopped" as const };
  },
});

export const getSandboxSessionCostSummary = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    await requireOwnedDoc(ctx, args.repositoryId, {
      notFoundMessage: "Repository not found.",
    });
    const current = (await findReusableSession(ctx, args.repositoryId)) ?? undefined;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let todaySpentCents = 0;
    for await (const session of ctx.db
      .query("sandboxSessions")
      .withIndex("by_repositoryId_and_startedAt", (q) =>
        q.eq("repositoryId", args.repositoryId).gte("startedAt", todayStart.getTime()),
      )) {
      todaySpentCents += session.spentCents;
    }

    return {
      current,
      todaySpentCents,
      now: Date.now(),
    };
  },
});

export const ensureSandboxSessionForThread = internalMutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || !thread.repositoryId) {
      throw new Error("Sandbox-grounded thread must be repository scoped.");
    }
    await assertFeatureAccess(ctx, thread.ownerTokenIdentifier, "sandboxGrounding");
    const reusable = thread.sandboxSessionId
      ? await ctx.db.get(thread.sandboxSessionId)
      : await findReusableSession(ctx, thread.repositoryId);
    if (reusable && reusable.status !== "stopped" && reusable.status !== "ended") {
      const now = Date.now();
      if (reusable.status === "paused") {
        await ctx.db.patch(reusable._id, {
          status: "active",
          lastActivityAt: now,
          lastResumedAt: now,
          pausedAt: undefined,
        });
      } else {
        await ctx.db.patch(reusable._id, { lastActivityAt: now });
      }
      if (thread.sandboxSessionId !== reusable._id) {
        await ctx.db.patch(thread._id, { sandboxSessionId: reusable._id });
      }
      return reusable._id;
    }

    const repository = await ctx.db.get(thread.repositoryId);
    if (!repository) {
      throw new Error("Repository not found.");
    }
    const sandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;
    const startState = resolveSandboxSessionStartStateForRepository({
      latestSandboxId: repository.latestSandboxId,
      sandbox,
    });
    const now = Date.now();
    const sessionId = await ctx.db.insert("sandboxSessions", {
      ownerTokenIdentifier: thread.ownerTokenIdentifier,
      repositoryId: thread.repositoryId,
      sandboxId: startState.sandboxId,
      status: startState.status,
      startedAt: now,
      lastActivityAt: now,
      lastResumedAt: now,
      idleAutoPauseMinutes: DEFAULT_AUTO_STOP_MINUTES,
      spentCents: 0,
    });
    await ctx.db.patch(thread._id, { sandboxSessionId: sessionId });
    return sessionId;
  },
});

export const recordSandboxSessionActivity = internalMutation({
  args: {
    sessionId: v.id("sandboxSessions"),
    spentCentsDelta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status === "stopped" || session.status === "ended") {
      return { recorded: false };
    }
    const delta = args.spentCentsDelta ?? 0;
    if (delta < 0) {
      throw new Error("spentCentsDelta cannot be negative");
    }
    await ctx.db.patch(args.sessionId, {
      lastActivityAt: Date.now(),
      spentCents: Math.max(0, session.spentCents + delta),
    });
    return { recorded: true };
  },
});

export const getSessionInternal = internalQuery({
  args: { sessionId: v.id("sandboxSessions") },
  handler: async (ctx, args) => await ctx.db.get(args.sessionId),
});

export const getSandboxInternal = internalQuery({
  args: { sandboxId: v.id("sandboxes") },
  handler: async (ctx, args) => await ctx.db.get(args.sandboxId),
});
