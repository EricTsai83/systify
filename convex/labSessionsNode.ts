"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { stopSandbox } from "./daytona";
import { logInfo, logWarn } from "./lib/observability";

const AUTO_PAUSE_BATCH_SIZE = 50;

export const stopRemoteSandboxForSession = internalAction({
  args: { sessionId: v.id("labSessions") },
  handler: async (ctx, args): Promise<{ stopped: boolean; reason?: string }> => {
    const session: Doc<"labSessions"> | null = await ctx.runQuery(internal.labSessions.getSessionInternal, {
      sessionId: args.sessionId,
    });
    if (!session?.sandboxId) {
      return { stopped: false, reason: "missing_sandbox" };
    }
    const sandbox: Doc<"sandboxes"> | null = await ctx.runQuery(internal.labSessions.getSandboxInternal, {
      sandboxId: session.sandboxId,
    });
    if (!sandbox?.remoteId) {
      return { stopped: false, reason: "missing_remote" };
    }
    try {
      await stopSandbox(sandbox.remoteId);
      logInfo("labSessions", "remote_sandbox_stopped", {
        sessionId: args.sessionId,
        sandboxId: session.sandboxId,
      });
      return { stopped: true };
    } catch (error) {
      logWarn("labSessions", "remote_sandbox_stop_failed", {
        sessionId: args.sessionId,
        sandboxId: session.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { stopped: false, reason: "daytona_error" };
    }
  },
});

export const autoPauseIdleLabSessions = internalAction({
  args: {},
  handler: async (ctx): Promise<{ paused: number }> => {
    const now = Date.now();
    const sessions: Doc<"labSessions">[] = await ctx.runQuery(internal.labSessions.listAutoPauseCandidates, {
      now,
      limit: AUTO_PAUSE_BATCH_SIZE,
    });
    for (const session of sessions) {
      await ctx.runMutation(internal.labSessions.markSessionPausedByIdle, { sessionId: session._id, now });
      await ctx.runAction(internal.labSessionsNode.stopRemoteSandboxForSession, { sessionId: session._id });
    }
    return { paused: sessions.length };
  },
});
