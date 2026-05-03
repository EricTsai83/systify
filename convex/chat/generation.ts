import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { STREAM_FLUSH_THRESHOLD } from "../lib/constants";
import { logWarn } from "../lib/observability";
import { estimateCostUsd } from "../lib/openaiPricing";
import type { ReplyContext } from "./context";
import { buildCitationMap, buildHeuristicAnswer, buildSystemPrompt, buildUserPrompt } from "./prompting";
import { selectRelevantChunks } from "./relevance";

export const generateAssistantReply = internalAction({
  args: {
    threadId: v.id("threads"),
    userMessageId: v.id("messages"),
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.chat.streaming.markAssistantReplyRunning, {
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
    });

    // Anything still buffered in pendingDelta below STREAM_FLUSH_THRESHOLD can be lost on a crash; recoverStaleChatJob only sees persisted messageStreamChunks flushed via appendAssistantStreamChunk before compactMessageStreamTail/finalizeAssistantReply/failAssistantReply run.
    let pendingDelta = "";

    try {
      // Pass `userMessageId` through to the context query so that mode,
      // search query, and the prompt content are all anchored to the *same*
      // queued message. Anchoring at the query layer (rather than re-reading
      // the message in this action) keeps the three derivations consistent
      // even if a newer user message lands between queueing and generation.
      // The query throws if the queued message has been deleted or moved to
      // another thread; the outer `catch` then runs `failAssistantReply` once,
      // matching every other failure path in this action.
      const replyContext = (await ctx.runQuery(internal.chat.context.getReplyContext, {
        threadId: args.threadId,
        userMessageId: args.userMessageId,
      })) as ReplyContext;

      // The queued message is also expected to be in the conversational
      // window so the model can see "what the user just asked" as the last
      // turn. If empty-content filtering or window truncation drops it, fall
      // back to throwing — generating a reply against a window that no
      // longer contains the user's question would still be wrong.
      const queuedUserMessage = replyContext.messages.find((message) => message.id === args.userMessageId);
      if (!queuedUserMessage || queuedUserMessage.role !== "user") {
        throw new Error("Queued user message not present in conversational window for this assistant reply.");
      }
      const userPrompt = queuedUserMessage.content;
      const relevantChunks = selectRelevantChunks(replyContext.chunks, userPrompt);

      // Build the citation map *before* the heuristic / streaming branches so
      // both paths persist the same `[A#] → artifactId` lookup the prompt is
      // about to advertise to the model. Skipped (left undefined) when no
      // artifacts were selected — `discuss` and unattached threads have an
      // empty list, so persisting `[]` would just add noise to the message
      // row without any frontend usefulness.
      const citationMap = buildCitationMap(replyContext);
      const persistedCitationMap = citationMap.length > 0 ? citationMap : undefined;

      if (!process.env.OPENAI_API_KEY) {
        const heuristicAnswer = buildHeuristicAnswer(replyContext, userPrompt, relevantChunks);
        await ctx.runMutation(internal.chat.streaming.finalizeAssistantReply, {
          threadId: args.threadId,
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
          finalDelta: heuristicAnswer,
          citationMap: persistedCitationMap,
        });
        return;
      }

      const modelName = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
      const response = streamText({
        model: openai(modelName),
        // `replyContext.mode` is the effective mode for this reply,
        // derived from the queued user message. Passing it to
        // `buildSystemPrompt` ensures the model receives the correct
        // prompt for the selected mode ("discuss" / "docs" / "sandbox"),
        // anchored to the same message that provides the user's question.
        system: buildSystemPrompt(replyContext.mode),
        prompt: buildUserPrompt(replyContext, userPrompt, relevantChunks),
      });

      for await (const delta of response.textStream) {
        pendingDelta += delta;
        if (pendingDelta.length >= STREAM_FLUSH_THRESHOLD) {
          await ctx.runMutation(internal.chat.streaming.appendAssistantStreamChunk, {
            assistantMessageId: args.assistantMessageId,
            jobId: args.jobId,
            delta: pendingDelta,
          });
          pendingDelta = "";
        }
      }

      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let costUsd: number | undefined;
      try {
        const usage = await response.totalUsage;
        inputTokens = usage.inputTokens;
        outputTokens = usage.outputTokens;
        costUsd = estimateCostUsd(modelName, inputTokens, outputTokens);
      } catch (error) {
        logWarn("chat", "assistant_reply_usage_unavailable", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
          model: modelName,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await ctx.runMutation(internal.chat.streaming.finalizeAssistantReply, {
        threadId: args.threadId,
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        finalDelta: pendingDelta,
        inputTokens,
        outputTokens,
        costUsd,
        citationMap: persistedCitationMap,
      });
    } catch (error) {
      await ctx.runMutation(internal.chat.streaming.failAssistantReply, {
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        errorMessage: error instanceof Error ? error.message : "Unknown assistant error",
        finalDelta: pendingDelta,
      });
    }
  },
});
