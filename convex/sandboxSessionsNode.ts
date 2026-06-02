"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { stopSandbox } from "./daytona";
import { logInfo, logWarn } from "./lib/observability";

const AUTO_PAUSE_BATCH_SIZE = 50;

export const stopRemoteSandboxForSession = internalAction({
  args: { sessionId: v.id("sandboxSessions") },
  handler: async (ctx, args): Promise<{ stopped: boolean; reason?: string }> => {
    const session: Doc<"sandboxSessions"> | null = await ctx.runQuery(internal.sandboxSessions.getSessionInternal, {
      sessionId: args.sessionId,
    });
    if (!session?.sandboxId) {
      return { stopped: false, reason: "missing_sandbox" };
    }
    const sandbox: Doc<"sandboxes"> | null = await ctx.runQuery(internal.sandboxSessions.getSandboxInternal, {
      sandboxId: session.sandboxId,
    });
    if (!sandbox?.remoteId) {
      return { stopped: false, reason: "missing_remote" };
    }
    try {
      await stopSandbox(sandbox.remoteId);
      logInfo("sandboxSessions", "remote_sandbox_stopped", {
        sessionId: args.sessionId,
        sandboxId: session.sandboxId,
      });
      return { stopped: true };
    } catch (error) {
      logWarn("sandboxSessions", "remote_sandbox_stop_failed", {
        sessionId: args.sessionId,
        sandboxId: session.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { stopped: false, reason: "daytona_error" };
    }
  },
});

export const autoPauseIdleSandboxSessions = internalAction({
  args: {},
  handler: async (ctx): Promise<{ paused: number; skipped?: boolean }> => {
    const now = Date.now();
    let sessions: Doc<"sandboxSessions">[];
    try {
      sessions = await ctx.runQuery(internal.sandboxSessions.listAutoPauseCandidates, {
        now,
        limit: AUTO_PAUSE_BATCH_SIZE,
      });
    } catch (error) {
      logWarn("sandboxSessions", "auto_pause_candidate_query_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { paused: 0, skipped: true };
    }

    let pausedCount = 0;
    for (const session of sessions) {
      try {
        const pauseResult = await ctx.runMutation(internal.sandboxSessions.markSessionPausedByIdle, {
          sessionId: session._id,
          now,
        });
        if (pauseResult.paused) {
          pausedCount++;
          await ctx.runAction(internal.sandboxSessionsNode.stopRemoteSandboxForSession, { sessionId: session._id });
        }
      } catch (error) {
        logWarn("sandboxSessions", "auto_pause_session_failed", {
          sessionId: session._id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { paused: pausedCount };
  },
});
