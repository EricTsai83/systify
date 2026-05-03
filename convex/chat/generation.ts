"use node";

/**
 * Chat-reply action.
 *
 * Plan 04 adds a Node runtime requirement here — sandbox-mode replies need
 * Daytona SDK access (which depends on Node built-ins like `axios`) to wire
 * up the `read_file` / `list_dir` tools. Discuss / docs replies still go
 * through the same code path; the only "cost" of moving from V8 is bundle
 * size, which is dominated by the AI SDK and OpenAI provider regardless.
 *
 * The action splits into two stream paths:
 *
 *   1. **Tool-driven sandbox path.** When `replyContext.sandboxTooling` is
 *      populated *and* `OPENAI_API_KEY` is set, we hand `streamText` a
 *      `ToolSet` from `createSandboxTools(...)` and a `stopWhen` step
 *      budget. We iterate `response.fullStream` so we can react to both
 *      `text-delta` (append to the streaming buffer) and the various
 *      tool events (logged for telemetry — Plan 06 turns these into a
 *      persisted trace and a live ticker).
 *
 *   2. **Text-only path.** Discuss / docs / sandbox-without-tooling all use
 *      the same shape: a plain `streamText` over `textStream`, no tools.
 *      The deltas flow through the same character-budget flush as before.
 *
 * One uniform finalize: regardless of which path ran, we collect usage,
 * compute cost, and persist via `finalizeAssistantReply`.
 */

import { openai } from "@ai-sdk/openai";
import { stepCountIs, streamText, type ToolSet } from "ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { getSandboxFsClient } from "../daytona";
import { STREAM_FLUSH_THRESHOLD } from "../lib/constants";
import { logInfo, logWarn } from "../lib/observability";
import { estimateCostUsd } from "../lib/openaiPricing";
import type { ReplyContext } from "./context";
import { buildCitationMap, buildHeuristicAnswer, buildSystemPrompt, buildUserPrompt } from "./prompting";
import { selectRelevantChunks } from "./relevance";
import { createSandboxTools } from "./sandboxTools";

/**
 * Maximum number of LLM steps in a sandbox-mode reply. Each step is one
 * model call — either the model emits text or it emits a tool call (which
 * the loop runs and feeds back as a new turn). 8 steps gives the model
 * room for a `list_dir` → 2-3 `read_file` → final answer pattern with
 * headroom for one corrective retry, and bounds total latency / cost.
 *
 * Living here (not in `prompting.ts`) keeps the budget colocated with the
 * `streamText` call that enforces it; the prompt advertises the same
 * literal so the model knows when to wrap up.
 */
const SANDBOX_STEP_BUDGET = 8;

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
      const systemPrompt = buildSystemPrompt(replyContext.mode);
      const userPromptText = buildUserPrompt(replyContext, userPrompt, relevantChunks);

      // Resolve sandbox tooling once. We only attach tools when:
      //   1. The reply is in sandbox mode.
      //   2. `getReplyContext` saw a `ready` sandbox attached to the repo
      //      (it returns `sandboxTooling: undefined` otherwise — see
      //      context.ts for the full eligibility rules).
      // Anything else falls through to the no-tool path, which produces a
      // plain text-only reply built on the same prompt — better than failing
      // a sandbox reply just because the sandbox isn't ready.
      const sandboxTools: ToolSet | undefined = replyContext.sandboxTooling
        ? await buildSandboxTools(replyContext.sandboxTooling)
        : undefined;

      const flushIfNeeded = async () => {
        if (pendingDelta.length >= STREAM_FLUSH_THRESHOLD) {
          await ctx.runMutation(internal.chat.streaming.appendAssistantStreamChunk, {
            assistantMessageId: args.assistantMessageId,
            jobId: args.jobId,
            delta: pendingDelta,
          });
          pendingDelta = "";
        }
      };

      const response = streamText({
        model: openai(modelName),
        system: systemPrompt,
        prompt: userPromptText,
        // `tools` is an optional positional argument in the AI SDK; when
        // undefined the model behaves exactly like the previous text-only
        // streamText call. `stopWhen` is only meaningful when tools are
        // present — without tools the model produces a single step and the
        // budget never fires — but passing it unconditionally keeps the
        // call shape uniform across paths.
        tools: sandboxTools,
        stopWhen: stepCountIs(SANDBOX_STEP_BUDGET),
      });

      // We always iterate `fullStream` — it is a strict superset of
      // `textStream` (every text chunk shows up as a `text-delta` event).
      // Sandbox-mode replies additionally surface `tool-call` /
      // `tool-result` / `tool-error` events here; Plan 06 turns those into
      // a persisted trace, but for Plan 04 we record them via `logInfo`
      // for backend observability without yet persisting.
      for await (const part of response.fullStream) {
        switch (part.type) {
          case "text-delta": {
            pendingDelta += part.text;
            await flushIfNeeded();
            break;
          }
          case "tool-call": {
            logInfo("chat", "sandbox_tool_call", {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolName: part.toolName,
              toolCallId: part.toolCallId,
            });
            break;
          }
          case "tool-result": {
            logInfo("chat", "sandbox_tool_result", {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolName: part.toolName,
              toolCallId: part.toolCallId,
            });
            break;
          }
          case "tool-error": {
            logWarn("chat", "sandbox_tool_error", {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              error: part.error instanceof Error ? part.error.message : String(part.error),
            });
            break;
          }
          case "error": {
            // Surface mid-stream provider errors. Re-throwing routes through
            // the outer catch which runs `failAssistantReply` exactly once.
            const message =
              part.error instanceof Error ? part.error.message : `Stream error: ${String(part.error)}`;
            throw new Error(message);
          }
          default:
            // `text-start` / `text-end` / `start-step` / `finish-step` /
            // `start` / `finish` / `reasoning-*` / `tool-input-*` / `source` /
            // `file` / `tool-output-denied` / `tool-approval-request` /
            // `abort` / `raw` — none of these affect the text we persist for
            // Plan 04. They will become hooks for the Plan 06 ticker /
            // Plan 07 cancel-mid-stream / Plan 11 step-budget feedback.
            break;
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

/**
 * Resolve a Daytona-backed `SandboxFsClient` and wrap it in the AI SDK
 * `ToolSet` shape `streamText` expects.
 *
 * Failures here (Daytona unreachable, sandbox archived between context
 * load and tool wiring, missing API key) bubble out and abort the entire
 * generation. That is the right behavior for Plan 04: if we cannot give
 * the model tools after telling it (via the system prompt) it has tools,
 * it will hallucinate file contents. The action's outer catch surfaces
 * the error to the user as a normal failure. Plan 09 introduces a richer
 * fallback (degrade to docs mode mid-session) once we have a redaction
 * layer to safely persist partial tool results.
 */
async function buildSandboxTools(
  sandboxTooling: NonNullable<ReplyContext["sandboxTooling"]>,
): Promise<ToolSet> {
  const fsClient = await getSandboxFsClient(sandboxTooling.remoteId);
  return createSandboxTools(fsClient, sandboxTooling.repoPath);
}
