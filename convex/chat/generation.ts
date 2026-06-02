"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { runAssistantReplySession } from "./replySession";

/**
 * Convex action adapter for chat reply generation.
 *
 * The session and stream orchestration live in `replySession.ts` /
 * `replyStreamRunner.ts`; this registration remains the public internal
 * interface and the single place that marks the assistant reply running.
 */
export const generateAssistantReply = internalAction({
  args: {
    threadId: v.id("threads"),
    userMessageId: v.id("messages"),
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const start = await ctx.runMutation(internal.chat.streaming.markAssistantReplyRunning, {
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
    });
    if (!start.started) {
      return;
    }

    await runAssistantReplySession(ctx, args);
  },
});
