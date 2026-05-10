import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { requireActiveRepositoryForOwner } from "./lib/repositoryAccess";

const DEFAULT_IDLE_AUTO_PAUSE_MINUTES = 10;

function getIdleAutoPauseMinutes(): number {
  const raw = process.env.LAB_SESSION_IDLE_AUTO_PAUSE_MINUTES;
  const parsed = raw ? Number(raw) : DEFAULT_IDLE_AUTO_PAUSE_MINUTES;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_IDLE_AUTO_PAUSE_MINUTES;
}

async function findReusableSession(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"labSessions"> | null> {
  for (const status of ["active", "starting", "paused"] as const) {
    const session = await ctx.db
      .query("labSessions")
      .withIndex("by_workspaceId_and_status", (q) => q.eq("workspaceId", workspaceId).eq("status", status))
      .first();
    if (session) {
      return session;
    }
  }
  return null;
}

export const startLabSession = mutation({
  args: { workspaceId: v.id("workspaces"), repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Workspace not found.");
    }
    if (workspace.repositoryId !== args.repositoryId) {
      throw new Error("Workspace repository mismatch.");
    }
    const repository = await requireActiveRepositoryForOwner(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      notFoundMessage: "Repository not found.",
      archivedMessage: "This repository is archived. Restore it to start Lab.",
    });

    const existing = await findReusableSession(ctx, args.workspaceId);
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

    const now = Date.now();
    return await ctx.db.insert("labSessions", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      workspaceId: args.workspaceId,
      repositoryId: args.repositoryId,
      sandboxId: repository.latestSandboxId,
      status: repository.latestSandboxId ? "active" : "starting",
      startedAt: now,
      lastActivityAt: now,
      lastResumedAt: now,
      idleAutoPauseMinutes: getIdleAutoPauseMinutes(),
      spentCents: 0,
    });
  },
});

export const pauseLabSession = mutation({
  args: { sessionId: v.id("labSessions") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Lab session not found.");
    }
    if (session.status !== "active") {
      return { paused: false, status: session.status };
    }
    await ctx.db.patch(args.sessionId, {
      status: "paused",
      pausedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.labSessionsNode.stopRemoteSandboxForSession, {
      sessionId: args.sessionId,
    });
    return { paused: true, status: "paused" as const };
  },
});

export const stopLabSession = mutation({
  args: { sessionId: v.id("labSessions") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Lab session not found.");
    }
    if (session.status === "stopped" || session.status === "ended") {
      return { stopped: false, status: session.status };
    }
    await ctx.db.patch(args.sessionId, {
      status: "stopped",
      endedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.labSessionsNode.stopRemoteSandboxForSession, {
      sessionId: args.sessionId,
    });
    return { stopped: true, status: "stopped" as const };
  },
});

export const getLabSessionCostSummary = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Workspace not found.");
    }
    const sessions = await ctx.db
      .query("labSessions")
      .withIndex("by_ownerTokenIdentifier_and_startedAt", (q) => q.eq("ownerTokenIdentifier", identity.tokenIdentifier))
      .order("desc")
      .take(100);
    const current = sessions.find(
      (session) =>
        session.workspaceId === args.workspaceId &&
        (session.status === "starting" || session.status === "active" || session.status === "paused"),
    );
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySpentCents = sessions
      .filter((session) => session.startedAt >= todayStart.getTime())
      .reduce((sum, session) => sum + session.spentCents, 0);
    return {
      current,
      todaySpentCents,
      now: Date.now(),
    };
  },
});

export const ensureLabSessionForThread = internalMutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || !thread.workspaceId || !thread.repositoryId) {
      throw new Error("Lab thread must be workspace and repository scoped.");
    }
    const reusable = thread.labSessionId
      ? await ctx.db.get(thread.labSessionId)
      : await findReusableSession(ctx, thread.workspaceId);
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
      if (thread.labSessionId !== reusable._id) {
        await ctx.db.patch(thread._id, { labSessionId: reusable._id });
      }
      return reusable._id;
    }

    const repository = await ctx.db.get(thread.repositoryId);
    if (!repository) {
      throw new Error("Repository not found.");
    }
    const now = Date.now();
    const sessionId = await ctx.db.insert("labSessions", {
      ownerTokenIdentifier: thread.ownerTokenIdentifier,
      workspaceId: thread.workspaceId,
      repositoryId: thread.repositoryId,
      sandboxId: repository.latestSandboxId,
      status: repository.latestSandboxId ? "active" : "starting",
      startedAt: now,
      lastActivityAt: now,
      lastResumedAt: now,
      idleAutoPauseMinutes: getIdleAutoPauseMinutes(),
      spentCents: 0,
    });
    await ctx.db.patch(thread._id, { labSessionId: sessionId });
    return sessionId;
  },
});

export const recordLabActivity = internalMutation({
  args: {
    sessionId: v.id("labSessions"),
    spentCentsDelta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status === "stopped" || session.status === "ended") {
      return { recorded: false };
    }
    await ctx.db.patch(args.sessionId, {
      lastActivityAt: Date.now(),
      spentCents: Math.max(0, session.spentCents + (args.spentCentsDelta ?? 0)),
    });
    return { recorded: true };
  },
});

export const getSessionInternal = internalQuery({
  args: { sessionId: v.id("labSessions") },
  handler: async (ctx, args) => await ctx.db.get(args.sessionId),
});

export const getSandboxInternal = internalQuery({
  args: { sandboxId: v.id("sandboxes") },
  handler: async (ctx, args) => await ctx.db.get(args.sandboxId),
});

export const listAutoPauseCandidates = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("labSessions")
      .withIndex("by_status_and_lastActivityAt", (q) => q.eq("status", "active"))
      .take(Math.max(1, Math.floor(args.limit)));
    return rows.filter((session) => session.lastActivityAt < args.now - session.idleAutoPauseMinutes * 60_000);
  },
});

export const markSessionPausedByIdle = internalMutation({
  args: { sessionId: v.id("labSessions"), now: v.number() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active") {
      return { paused: false };
    }
    if (session.lastActivityAt >= args.now - session.idleAutoPauseMinutes * 60_000) {
      return { paused: false };
    }
    await ctx.db.patch(args.sessionId, {
      status: "paused",
      pausedAt: args.now,
    });
    return { paused: true };
  },
});
