"use node";

/**
 * Chat-reply action.
 *
 * Runs in the Node runtime because sandbox-mode replies need Daytona SDK
 * access (which depends on Node built-ins like `axios`) to wire up the
 * `read_file` / `list_dir` tools. Discuss / docs replies go through the
 * same code path; the only "cost" of running in Node is bundle size,
 * which is dominated by the AI SDK runtime regardless.
 *
 * The action splits into two reply paths:
 *
 *   1. **Tool-driven sandbox path.** When `replyContext.sandboxTooling` is
 *      populated *and* an API key for the picked provider is set, we build
 *      a `ToolSet` from `createSandboxTools(...)` and hand it to the
 *      reply-stream controller. The controller owns the gateway
 *      `fullStream` event loop, text / reasoning buffers, cancellation
 *      abort wiring, usage recovery, and sandbox tool trace persistence.
 *
 *   2. **Text-only path.** Library replies and ungrounded Discuss replies
 *      use the same controller shape: a gateway call with no tools. The
 *      deltas flow through the same character-budget flush inside the
 *      controller.
 *
 * One uniform finalize: regardless of which stream outcome came back, this
 * action owns the terminal Convex mutation (`finalizeAssistantReply`,
 * `markAssistantReplyCancelled`, or `failAssistantReply`).
 *
 * Provider routing lives entirely inside `llmGateway`. This file holds
 * no `@ai-sdk/openai` / `@ai-sdk/anthropic` imports — the provider-
 * isolation test (`llmGateway.test.ts`) enforces that invariant.
 */

import { type ToolSet } from "ai";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { getSandboxFsClient } from "../daytona";
import { verifyAndSyncSandbox, SandboxPreparationError } from "../lib/sandboxLiveness";
import { emitMetric, logWarn } from "../lib/observability";
import { hasProviderApiKey } from "../lib/providerEnv";
import type { ReplyContext } from "./context";
import { resolveModelForReply } from "./modelSelection";
import {
  buildCitationMap,
  buildHeuristicAnswer,
  buildSystemPrompt,
  buildUserPrompt,
  type ExtendedChatMode,
} from "./prompting";
import {
  createReplyStreamController,
  formatReplyStreamError,
  type GatewayUsage,
  type ReplyStreamOutcome,
} from "./replyStreamController";
import { selectRelevantChunks } from "./relevance";
import { createSandboxTools } from "./sandboxTools";

/**
 * Terminal-state taxonomy used as the `status` tag on the session
 * metric. Distinct from the Convex schema's `messages.status` because
 * the metric also covers paths where no message row was patched (e.g.
 * an aborted generation that bailed out before any write). Keeping the
 * tag set small and stable lets dashboards pivot by status without
 * parsing free-form strings.
 *
 *   - `completed`        — finalize wrote `messages.status = "completed"`
 *   - `failed`           — fail wrote `messages.status = "failed"`
 *   - `cancelled`        — user-initiated stop landed
 *   - `aborted_orphan`   — the job row was deleted under us; no
 *                          mutation ran, so no message-status flip
 *                          either, but the action still consumed
 *                          compute and the metric should reflect
 *                          the wasted session
 */
type SessionTerminalStatus = "completed" | "failed" | "cancelled" | "aborted_orphan";

/**
 * Accumulated session-level telemetry.
 *
 * The action doesn't know everything about its session up front: the
 * mode is unknown until `getReplyContext` returns, the model is
 * unknown until `resolveModelForReply` runs, the tool-call count
 * depends on what the model decides to do. So we keep a single
 * mutable `SessionTelemetry` object and update its fields as the
 * action makes progress. At each terminal exit, we emit one
 * `sandbox_session_finished` metric from this state.
 *
 * **Why mutable.** A `Record`-of-immutable-helpers refactor would push
 * roughly 40 of `generateAssistantReply`'s short-lived locals through
 * a function-call boundary per event. The mutable accumulator stays
 * inside one closure scope, the field names match the metric tags
 * 1:1, and there are exactly 4 terminal-state emit sites — none of
 * which is hot. Readability wins.
 */
interface SessionTelemetry {
  startedAt: number;
  /**
   * Filled in once `getReplyContext` returns; remains undefined on
   * pre-context throws.
   */
  mode?: ExtendedChatMode;
  /** Set in the streaming path once `resolveModelForReply` resolves. Heuristic / pre-context paths leave it undefined. */
  modelName?: string;
  /** True only when the streaming path actually built and passed a non-empty `ToolSet` to streamText. */
  hadTools: boolean;
  /** Counter — number of distinct `tool-call` events the model emitted. */
  toolInvocations: number;
  /** Counter — subset of invocations that surfaced as `tool-error` OR a `tool-result` envelope with `ok === false`. */
  toolErrors: number;
}

interface EmitSessionMetricArgs {
  status: SessionTerminalStatus;
  assistantMessageId: Id<"messages">;
  jobId: Id<"jobs">;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Emit the session-finished metric once per action exit.
 *
 * Sandbox-only by design: the metric tag space (model, had_tools,
 * tool counts) is shaped for sandbox-grounded sessions, and ungrounded
 * Discuss / Library replies have a distinct cost / latency profile that
 * would otherwise muddy the time series. Pre-context failures (where
 * `mode` is unknown) skip the emit — we lack the data to attribute
 * the failure correctly, and the action's existing `failAssistantReply`
 * mutation already records the failure for ops via `messages.status`.
 *
 * Wrapped in a try/catch so a logging-layer failure can never
 * destabilize the surrounding action — emit failures are logged
 * locally and swallowed.
 */
function emitSessionFinishedMetric(telemetry: SessionTelemetry, args: EmitSessionMetricArgs): void {
  if (!telemetry.hadTools) {
    return;
  }
  const durationMs = Date.now() - telemetry.startedAt;
  emitMetric("sandbox_session_finished", {
    value: durationMs,
    tags: {
      mode: telemetry.mode,
      status: args.status,
      model: telemetry.modelName,
      had_tools: telemetry.hadTools,
    },
    details: {
      assistantMessageId: String(args.assistantMessageId),
      jobId: String(args.jobId),
      tool_calls_count: telemetry.toolInvocations,
      tool_errors_count: telemetry.toolErrors,
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cost_usd: args.costUsd,
    },
  });
}

export interface ReplySessionInput {
  threadId: Id<"threads">;
  userMessageId: Id<"messages">;
  assistantMessageId: Id<"messages">;
  jobId: Id<"jobs">;
}

export async function runAssistantReplySession(ctx: ActionCtx, args: ReplySessionInput): Promise<void> {
  // Start the session timer at action entry. The window measured is
  // "action start → terminal-state finalize", so dashboards alerting
  // on `value` are tracking the work the deploy owner can
  // affect. Upstream send-mutation, queue lag, and scheduler wake are
  // intentionally excluded — user-perceived end-to-end latency is a
  // separate frontend metric. Anything that updates the telemetry below
  // mutates this same object so the terminal-state emit sites stay
  // one-liners.
  const telemetry: SessionTelemetry = {
    startedAt: Date.now(),
    hadTools: false,
    toolInvocations: 0,
    toolErrors: 0,
  };

  // Single emit helper with an idempotency guard. Every terminal exit
  // path (success finalize, cancel finalize, failure
  // finalize, the various `aborted_orphan` fast-exits) routes through
  // here so we cannot accidentally double-fire the
  // `sandbox_session_finished` metric if a future refactor introduces
  // a new exit. The action is structured so each branch ends in
  // `return`, but the guard is cheap insurance against the next
  // editor missing that invariant.
  let sessionMetricEmitted = false;
  const emitSessionExit = (
    status: SessionTerminalStatus,
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number },
  ) => {
    if (sessionMetricEmitted) {
      return;
    }
    emitSessionFinishedMetric(telemetry, {
      status,
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
      ...usage,
    });
    sessionMetricEmitted = true;
  };

  const streamController = createReplyStreamController(ctx, {
    assistantMessageId: args.assistantMessageId,
    jobId: args.jobId,
  });
  const syncStreamTelemetry = () => {
    const streamTelemetry = streamController.getTelemetry();
    telemetry.hadTools = streamTelemetry.hadTools;
    telemetry.toolInvocations = streamTelemetry.toolInvocations;
    telemetry.toolErrors = streamTelemetry.toolErrors;
  };

  streamController.startCancellationPolling();

  const markCancelled = async (cancelArgs: {
    finalDelta?: string;
    reason?: string;
    usage?: GatewayUsage;
  }): Promise<void> => {
    await ctx.runMutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
      finalDelta: cancelArgs.finalDelta,
      reason: cancelArgs.reason,
      inputTokens: cancelArgs.usage?.inputTokens,
      outputTokens: cancelArgs.usage?.outputTokens,
      cachedInputTokens: cancelArgs.usage?.cachedInputTokens,
      reasoningTokens: cancelArgs.usage?.reasoningTokens,
      costUsd: cancelArgs.usage?.costUsd,
    });
    emitSessionExit("cancelled", cancelArgs.usage);
  };

  const exitIfCancellationSettled = async (usage?: GatewayUsage): Promise<boolean> => {
    const cancellation = streamController.getCancellationState();
    if (cancellation.generationAborted) {
      emitSessionExit("aborted_orphan", usage);
      return true;
    }
    if (cancellation.wasCancelled) {
      await markCancelled({
        finalDelta: streamController.getBufferedText() || undefined,
        reason: cancellation.cancellationReason,
        usage,
      });
      return true;
    }
    return false;
  };

  const settleStreamOutcome = async (
    outcome: ReplyStreamOutcome,
    citationMap: ReturnType<typeof buildCitationMap> | undefined,
  ): Promise<void> => {
    syncStreamTelemetry();
    switch (outcome.kind) {
      case "completed": {
        await ctx.runMutation(internal.chat.streaming.finalizeAssistantReply, {
          threadId: args.threadId,
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
          finalDelta: outcome.finalDelta,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          cachedInputTokens: outcome.usage.cachedInputTokens,
          reasoningTokens: outcome.usage.reasoningTokens,
          costUsd: outcome.usage.costUsd,
          citationMap,
        });
        emitSessionExit("completed", outcome.usage);
        break;
      }
      case "cancelled": {
        await markCancelled({
          finalDelta: outcome.finalDelta,
          reason: outcome.reason,
          usage: outcome.usage,
        });
        break;
      }
      case "aborted_orphan": {
        emitSessionExit("aborted_orphan", outcome.usage);
        break;
      }
      case "failed": {
        await ctx.runMutation(internal.chat.streaming.failAssistantReply, {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
          errorMessage: outcome.errorMessage,
          finalDelta: outcome.finalDelta,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          cachedInputTokens: outcome.usage.cachedInputTokens,
          reasoningTokens: outcome.usage.reasoningTokens,
          costUsd: outcome.usage.costUsd,
        });
        emitSessionExit("failed", outcome.usage);
        break;
      }
    }
  };

  let lastStreamOutcome: ReplyStreamOutcome | undefined;

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

    // Capture the mode tag as soon as we know it from the context query
    // so even a mid-action throw still produces a session metric tagged
    // with the right mode at queue time.
    telemetry.mode = replyContext.mode;

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
    const groundedReplyContext: ReplyContext = replyContext;
    const relevantChunks = selectRelevantChunks(groundedReplyContext.chunks, userPrompt);

    // Build the citation map *before* the heuristic / streaming branches so
    // both paths persist the same `[A#] → artifactId` lookup the prompt is
    // about to advertise to the model. Skipped (left undefined) when no
    // artifacts were selected — `discuss` and unattached threads have an
    // empty list, so persisting `[]` would just add noise to the message
    // row without any frontend usefulness.
    const citationMap = buildCitationMap(groundedReplyContext);
    const persistedCitationMap = citationMap.length > 0 ? citationMap : undefined;

    // Resolve the picked `(provider, modelName)` pair early so the
    // heuristic-fallback decision below can branch on the *picked*
    // provider's API key — Claude users with `ANTHROPIC_API_KEY` set
    // (but no `OPENAI_API_KEY`) should still get LLM-powered replies.
    const modelChoice = resolveModelForReply({
      mode: replyContext.mode,
      groundSandbox: groundedReplyContext.groundSandbox,
      overrideProvider: replyContext.provider,
      overrideModelName: replyContext.modelName,
      overrideReasoningEffort: replyContext.reasoningEffort,
    });
    telemetry.modelName = modelChoice.modelName;

    if (!hasProviderApiKey(modelChoice.provider)) {
      // The heuristic path produces its full answer synchronously, so
      // there is no LLM stream to abort. We still honor a cancellation
      // that arrived between `markAssistantReplyRunning` and this point —
      // the user could have clicked Stop while the context query ran —
      // by checking the polled flag. Cooperative either way: if cancel
      // wins the race, we route through the cancel finalize variant
      // and skip the (very fast) heuristic write entirely.
      if (await exitIfCancellationSettled()) {
        return;
      }
      const heuristicAnswer = buildHeuristicAnswer(groundedReplyContext, userPrompt, relevantChunks);
      await ctx.runMutation(internal.chat.streaming.finalizeAssistantReply, {
        threadId: args.threadId,
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        finalDelta: heuristicAnswer,
        citationMap: persistedCitationMap,
      });
      emitSessionExit("completed");
      return;
    }

    const systemPrompt = buildSystemPrompt(groundedReplyContext.mode, {
      groundLibrary: groundedReplyContext.groundLibrary,
      groundSandbox: groundedReplyContext.groundSandbox,
    });
    const userPromptText = buildUserPrompt(groundedReplyContext, userPrompt, relevantChunks);

    // Resolve sandbox tooling once. We only attach tools when:
    //   1. The queued user message had `groundSandbox: true` (Discuss
    //      with sandbox grounding enabled).
    //   2. `getReplyContext` saw a `ready` sandbox attached to the repo
    //      (it returns `sandboxTooling: undefined` otherwise — see
    //      context.ts for the full eligibility rules).
    //   3. A verify-on-use probe confirms Daytona still has the sandbox.
    //      `getReplyContext` only reads the local cache; a sandbox that
    //      was manually deleted in the Daytona dashboard between import
    //      and now still looks `ready` there. Probing now both prevents
    //      a mid-stream 404 from `getSandboxFsClient` and syncs the
    //      cache so the next reply skips the sandbox tooling cleanly.
    //
    // `assertRepositoryModeEligible` (chat/send.ts) already blocks the
    // common case where the sandbox is not ready at mutation time, so
    // this verification only covers the edge case where the sandbox
    // disappears between mutation and action (e.g. manual deletion in
    // the Daytona dashboard). Throwing `SandboxPreparationError` here
    // routes through the outer catch to `failAssistantReply`, which
    // surfaces the `userFacingMessage` in the assistant bubble — the
    // user can see what happened and click Activate to recover.
    const resolvedSandboxTooling = replyContext.sandboxTooling;
    if (resolvedSandboxTooling) {
      const sandboxId = resolvedSandboxTooling.sandboxId;
      try {
        const probe = await verifyAndSyncSandbox(ctx, {
          sandboxId: resolvedSandboxTooling.sandboxId,
          remoteId: resolvedSandboxTooling.remoteId,
        });
        if (!probe.ok) {
          logWarn("chat", "sandbox_unavailable_at_verify", {
            assistantMessageId: args.assistantMessageId,
            jobId: args.jobId,
            sandboxId,
            remoteState: probe.remoteState,
            reason: probe.reason,
          });
          throw new SandboxPreparationError({
            reason: "live_source_unavailable",
            userFacingMessage: "Live source went away while preparing this reply. Activate it above and resend.",
          });
        }
      } catch (err) {
        if (err instanceof SandboxPreparationError) throw err;
        logWarn("chat", "sandbox_unavailable_at_verify", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
          sandboxId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new SandboxPreparationError({
          reason: "live_source_unavailable",
          userFacingMessage: "Live source went away while preparing this reply. Activate it above and resend.",
          cause: err,
        });
      }
    }
    const sandboxTools: ToolSet | undefined = resolvedSandboxTooling
      ? await buildSandboxTools(resolvedSandboxTooling)
      : undefined;

    const streamOutcome = await streamController.consume({
      threadId: args.threadId,
      replyContext: groundedReplyContext,
      modelChoice,
      systemPrompt,
      userPromptText,
      sandboxTools,
    });
    lastStreamOutcome = streamOutcome;
    await settleStreamOutcome(streamOutcome, persistedCitationMap);
    return;
  } catch (error) {
    syncStreamTelemetry();
    const usage = lastStreamOutcome?.usage;
    if (await exitIfCancellationSettled(usage)) {
      return;
    }
    await ctx.runMutation(internal.chat.streaming.failAssistantReply, {
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
      errorMessage: formatReplyStreamError(error),
      finalDelta: streamController.getBufferedText(),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      reasoningTokens: usage?.reasoningTokens,
      costUsd: usage?.costUsd,
    });
    emitSessionExit("failed", usage);
  } finally {
    streamController.stopCancellationPolling();
  }
}

/**
 * Resolve a Daytona-backed `SandboxFsClient` and wrap it in the AI SDK
 * `ToolSet` shape the gateway expects.
 *
 * Failures here (Daytona unreachable, sandbox archived between context
 * load and tool wiring, missing API key) bubble out and abort the entire
 * generation. That is the right behavior: if we cannot give the model
 * tools after telling it (via the system prompt) it has tools, it will
 * hallucinate file contents. The action's outer catch surfaces the
 * error to the user as a normal failure.
 */
async function buildSandboxTools(sandboxTooling: NonNullable<ReplyContext["sandboxTooling"]>): Promise<ToolSet> {
  const fsClient = await getSandboxFsClient(sandboxTooling.remoteId);
  return createSandboxTools(fsClient, sandboxTooling.repoPath);
}
