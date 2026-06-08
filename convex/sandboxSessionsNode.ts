"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { stopSandbox } from "./daytona";
import { logInfo, logWarn } from "./lib/observability";

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
        error: stringifyError(error),
      });
      return { stopped: false, reason: "daytona_error" };
    }
  },
});
