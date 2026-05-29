"use node";

/**
 * Chat-reply action.
 *
 * Runs in the Node runtime because sandbox-mode replies need Daytona SDK
 * access (which depends on Node built-ins like `axios`) to wire up the
 * `read_file` / `list_dir` tools. Discuss / docs replies go through the
 * same code path; the only "cost" of running in Node is bundle size,
 * which is dominated by the AI SDK and OpenAI provider regardless.
 *
 * The action splits into two stream paths:
 *
 *   1. **Tool-driven sandbox path.** When `replyContext.sandboxTooling` is
 *      populated *and* `OPENAI_API_KEY` is set, we hand `streamText` a
 *      `ToolSet` from `createSandboxTools(...)` and a `stopWhen` step
 *      budget. We iterate `response.fullStream` so we can react to both
 *      `text-delta` (append to the streaming buffer) and the various
 *      tool events (logged for telemetry, turned into a persisted trace
 *      and a live ticker).
 *
 *   2. **Text-only path.** Library replies and ungrounded Discuss replies
 *      use the same shape: a plain `streamText` over `textStream`, no
 *      tools. The deltas flow through the same character-budget flush.
 *
 * One uniform finalize: regardless of which path ran, we collect usage,
 * compute cost, and persist via `finalizeAssistantReply`.
 */

import { openai } from "@ai-sdk/openai";
import { stepCountIs, streamText, type ToolSet } from "ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { getSandboxFsClient } from "../daytona";
import { verifyAndSyncSandbox, SandboxPreparationError } from "../lib/sandboxLiveness";
import { STREAM_FLUSH_THRESHOLD } from "../lib/constants";
import { emitMetric, logInfo, logWarn } from "../lib/observability";
import { estimateCostUsd } from "../lib/openaiPricing";
import type { ReplyContext } from "./context";
import { resolveModelForReply } from "./modelSelection";
import {
  buildCitationMap,
  buildHeuristicAnswer,
  buildSystemPrompt,
  buildUserPrompt,
  type ExtendedChatMode,
} from "./prompting";
import { selectRelevantChunks } from "./relevance";
import {
  countUtf8Bytes,
  extractAuditMetadataFromToolOutput,
  tryRecordSandboxToolCallLogEntry,
} from "./sandboxToolCallLog";
import { createSandboxTools } from "./sandboxTools";
import { redact } from "./redaction";

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

/**
 * Interval for the background poll that watches for owner-initiated
 * cancellation while the reply streams.
 *
 * 1 s gives the user a sub-second to ~2 s perceived latency between Stop
 * click and bubble flip (the worst case is "user clicks just after the last
 * poll fired, must wait one full interval"). The Done criteria's 5 s SLO
 * leaves comfortable headroom even if a tool call is mid-flight when the
 * cancel arrives — the loop will pick up the abort on the next iteration.
 *
 * Lower intervals would just generate more `getJobCancellationStatus`
 * queries with no UX benefit (the bottleneck is the underlying HTTP stream
 * tear-down, not our polling cadence). Higher intervals start to creep into
 * the SLO window if a tool call also runs slowly.
 */
const CANCELLATION_POLL_INTERVAL_MS = 1_000;

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

/**
 * Build the high-cardinality `details` payload shared by both
 * `sandbox_tool_invoked` emit sites (tool-result envelope and
 * tool-error). Centralised so a future addition (e.g. tagging by
 * `threadId`) lands in one place instead of drifting between the two.
 */
function buildToolMetricDetails(assistantMessageId: Id<"messages">, jobId: Id<"jobs">, toolCallId: string) {
  return {
    assistantMessageId: String(assistantMessageId),
    jobId: String(jobId),
    toolCallId,
  };
}

export const generateAssistantReply = internalAction({
  args: {
    threadId: v.id("threads"),
    userMessageId: v.id("messages"),
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const start = (await ctx.runMutation(internal.chat.streaming.markAssistantReplyRunning, {
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
    })) as { started: boolean };
    if (!start.started) {
      return;
    }

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

    // Anything still buffered in pendingDelta below STREAM_FLUSH_THRESHOLD can be lost on a crash; recoverStaleChatJob only sees persisted messageStreamChunks flushed via appendAssistantStreamChunk before compactMessageStreamTail/finalizeAssistantReply/failAssistantReply run.
    let pendingDelta = "";
    // Parallel reasoning buffer. Mirrors `pendingDelta` but for the
    // model's extended-thinking trace — flushed into
    // `messageStreams.liveReasoning` instead of a stream chunks row
    // because reasoning volume is bounded (a few KB) and doesn't benefit
    // from sequence-based compaction.
    let pendingReasoningDelta = "";
    // Defined at the action-handler scope (not inside the success-path
    // `try` block) so the catch block can also force-flush the buffer on
    // the failure / abort path — the success path defines its own usage
    // alongside `flushIfNeeded` in the stream loop, but the catch needs
    // the same callable.
    const flushReasoningIfNeeded = async (options?: { force?: boolean }) => {
      if (pendingReasoningDelta.length === 0) {
        return;
      }
      if (!options?.force && pendingReasoningDelta.length < STREAM_FLUSH_THRESHOLD) {
        return;
      }
      await ctx.runMutation(internal.chat.streaming.appendAssistantReasoningDelta, {
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        delta: pendingReasoningDelta,
      });
      pendingReasoningDelta = "";
    };

    // `streamText` response is hoisted so every exit path (success
    // / cancel / fail / aborted) can read `response.totalUsage` to harvest
    // the partial token usage and cost. Cancelled and failed replies still
    // incur cost from OpenAI (provider-side billing happens on each token
    // generated, not on stream completion), so settling that partial cost
    // is the only way to keep the daily cap honest.
    //
    // `undefined` until `streamText` is invoked, so the heuristic-path
    // fast exits and the cancel-before-streamText fast exits don't try to
    // extract usage from a non-existent stream.
    let streamResponse: ReturnType<typeof streamText> | undefined;

    // Model name is hoisted for the same reason as `streamResponse`:
    // the catch block needs to feed the post-throw cost extractor the same
    // model the stream actually ran on, otherwise a typo in the per-mode env
    // var (resolved on the success path) would diverge from the global
    // default the catch path falls back to. `undefined` before
    // `resolveModelForReply` runs — `extractStreamUsage` short-circuits on
    // `streamResponse === undefined` so the model name is moot in that
    // case.
    let modelName: string | undefined;

    // Cancellation control plane.
    //
    // The AI SDK's `streamText` accepts an `abortSignal`. When the signal
    // fires the underlying HTTP/SSE request is torn down and `fullStream`
    // either ends naturally (for clean abort points) or throws a
    // `DOMException`-shaped abort error from the for-await iterator. We
    // wrap that in a single boolean (`wasCancelled`) plus a controller so
    // every exit path (loop break, thrown abort, post-loop finalize) can
    // route through the `markAssistantReplyCancelled` finalize variant
    // instead of the failure path.
    //
    // Why we don't just check the cancel flag from inside the for-await
    // body: a long text-deltaless stretch (e.g. a 30 s tool call) would
    // never observe the flag because no event fires. The polling task is
    // independent of the stream loop and runs every
    // `CANCELLATION_POLL_INTERVAL_MS` regardless of stream activity, so
    // user clicks Stop → poll catches cancelled → controller.abort() →
    // streamText tears down → for-await exits, all without depending on
    // the model emitting another delta first.
    const cancellationController = new AbortController();
    let wasCancelled = false;
    let cancellationReason: string | undefined;
    let pollHandle: ReturnType<typeof setTimeout> | undefined;
    let pollingStopped = false;
    let generationAborted = false;

    /**
     * Self-rescheduling poll. We use `setTimeout` instead of `setInterval`
     * so a slow query (rare but possible under load) cannot create
     * overlapping in-flight polls; each tick waits for the previous
     * tick's query to complete before scheduling the next one.
     *
     * The poll never `throw`s — any error is logged and we keep polling,
     * because failing to poll is far worse than failing once: a single
     * transient failure must not strand the action with no way to learn
     * about a cancellation. If the action finishes naturally first, the
     * `finally` block stops the polling loop before the next tick fires.
     */
    const runPollTick = async (): Promise<void> => {
      if (pollingStopped) {
        return;
      }
      try {
        const status = (await ctx.runQuery(internal.chat.streaming.getJobCancellationStatus, {
          jobId: args.jobId,
        })) as { cancelled: boolean; jobMissing: boolean };
        if (pollingStopped) {
          return;
        }
        if (status.cancelled) {
          wasCancelled = true;
          cancellationReason = "Cancelled by user.";
          cancellationController.abort();
          return;
        }
        if (status.jobMissing) {
          // The job row was deleted out from under us (concurrent
          // thread / repo cascade). Abort the entire generation stream
          // and stop polling to prevent noisy mutations patching a
          // deleted job. Set the abort flag and tear down the stream
          // so the for-await iterator exits cleanly.
          generationAborted = true;
          pollingStopped = true;
          cancellationController.abort();
          return;
        }
      } catch (error) {
        logWarn("chat", "cancellation_poll_failed", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      schedulePoll();
    };
    const schedulePoll = (): void => {
      if (pollingStopped) {
        return;
      }
      // Non-async setTimeout callback so the type signature stays
      // `() => void`. The inner async function is fire-and-forget — any
      // error inside `runPollTick` is already caught and logged, so the
      // unhandled-rejection risk is bounded. Awaiting here is impossible
      // (setTimeout doesn't await its callback) and would not extend the
      // action's lifetime even if it could.
      pollHandle = setTimeout(() => {
        void runPollTick();
      }, CANCELLATION_POLL_INTERVAL_MS);
    };
    schedulePoll();

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

      if (!process.env.OPENAI_API_KEY) {
        // The heuristic path produces its full answer synchronously, so
        // there is no streamText to abort. We still honor a cancellation
        // that arrived between `markAssistantReplyRunning` and this point —
        // the user could have clicked Stop while the context query ran —
        // by checking the polled flag. Cooperative either way: if cancel
        // wins the race, we route through the cancel finalize variant
        // and skip the (very fast) heuristic write entirely.
        if (wasCancelled) {
          // If the job row was also deleted under us (generationAborted),
          // skip the cancel mutation — patching the missing job would only
          // throw on the way back to the catch block.
          if (!generationAborted) {
            await ctx.runMutation(internal.chat.streaming.markAssistantReplyCancelled, {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              finalDelta: pendingDelta || undefined,
              reason: cancellationReason,
            });
            emitSessionExit("cancelled");
          } else {
            emitSessionExit("aborted_orphan");
          }
          return;
        }
        // Same short-circuit as the streaming path: if the job row was
        // deleted between scheduling the poll and reaching here, there is no
        // lifecycle row left to settle, so skip finalize entirely.
        if (generationAborted) {
          emitSessionExit("aborted_orphan");
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

      // Pick the model based on the reply's capability requirements. The
      // sandbox-grounded Discuss path is the heaviest (tool use) and stays on
      // the full GPT-5 tier; library / ungrounded discuss stay on the mini tier.
      // The resolver also reports a per-model `reasoningEffort` so reasoning-
      // capable models opt into extended thinking automatically.
      const modelChoice = resolveModelForReply({
        mode: replyContext.mode,
        groundSandbox: groundedReplyContext.groundSandbox,
      });
      modelName = modelChoice.name;
      telemetry.modelName = modelName;
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
      telemetry.hadTools = sandboxTools !== undefined;

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

      // Local correlation map from `toolCallId` to its `start` metadata.
      // The events table also keys by `toolCallId`, but reading
      // the matching `start` row from inside the `tool-result` /
      // `tool-error` handlers would cost an extra mutation round-trip per
      // tool. Keeping the map in process is correct because:
      //   - The AI SDK guarantees `tool-call` precedes its matching
      //     `tool-result` / `tool-error` on `fullStream`, so the entry is
      //     always present when we look it up.
      //   - The action is the only writer for this assistant message, so
      //     in-process state is the source of truth for the run.
      const toolCallMap = new Map<string, { toolName: string; inputSummary: string; startedAt: number }>();

      // Cancel-before-streamText fast path. The polling task can
      // flip `wasCancelled` any time after `markAssistantReplyRunning`
      // committed; if it already did, skip the upstream fetch entirely
      // (no point hitting OpenAI just to immediately abort) and route to
      // the cancel finalize variant. `pendingDelta` is empty at this
      // point so the partial-content branch is a no-op.
      if (wasCancelled) {
        // If the job row was also deleted (generationAborted), skip the
        // cancel mutation — patching the missing job would only throw.
        if (!generationAborted) {
          await ctx.runMutation(internal.chat.streaming.markAssistantReplyCancelled, {
            assistantMessageId: args.assistantMessageId,
            jobId: args.jobId,
            finalDelta: pendingDelta || undefined,
            reason: cancellationReason,
          });
          emitSessionExit("cancelled");
        } else {
          emitSessionExit("aborted_orphan");
        }
        return;
      }
      // Mirror of the streaming-path short-circuit: bail out before
      // hitting OpenAI if the job row was already deleted under us. The
      // for-await loop would otherwise tear down on the first event due
      // to the abort signal, but skipping the call entirely saves a
      // pointless upstream fetch.
      if (generationAborted) {
        emitSessionExit("aborted_orphan");
        return;
      }

      streamResponse = streamText({
        model: openai(modelName),
        system: systemPrompt,
        prompt: userPromptText,
        // Opt-in reasoning effort, keyed off the resolved model in
        // `modelSelection.ts`. `undefined` for non-reasoning models means
        // `providerOptions` is left unset and OpenAI behaves identically
        // to today; reasoning-capable models (`gpt-5*`) get extended
        // thinking at the per-model default effort.
        providerOptions: modelChoice.reasoningEffort
          ? { openai: { reasoningEffort: modelChoice.reasoningEffort } }
          : undefined,
        // `tools` is an optional positional argument in the AI SDK; when
        // undefined the model behaves exactly like the previous text-only
        // streamText call. `stopWhen` is only meaningful when tools are
        // present — without tools the model produces a single step and the
        // budget never fires — but passing it unconditionally keeps the
        // call shape uniform across paths.
        tools: sandboxTools,
        stopWhen: stepCountIs(SANDBOX_STEP_BUDGET),
        // Surface the per-step budget consumption to the model so it can
        // self-pace mid-flight ("3 of 8 tool steps remain;
        // wrap up if your evidence is sufficient"). Only attached on the
        // tool-driven path: discuss / library replies are single-step
        // text-only and would never reach `prepareStep`'s second
        // invocation.
        //
        // Step 0 reuses the outer `system` prompt verbatim (returning
        // `undefined`) so we don't lengthen the *first* request — the
        // base sandbox prompt already advertises the 8-step ceiling.
        // From step 1 onward we override the system with a short
        // suffix so the model sees a fresh budget read on each turn.
        //
        // The override re-includes the entire base prompt because the
        // SDK's `system` field is *replace*, not *append*. Without
        // re-sending it the model would lose every instruction the
        // base prompt established (citation contract, tool semantics,
        // network ban) for the rest of the reply — a much worse
        // regression than the few hundred tokens of repeated context
        // we save. The mini overhead is amortized across the long-
        // tail steps that benefit most from the budget cue.
        prepareStep: sandboxTools
          ? ({ stepNumber }) => {
              if (stepNumber === 0) {
                return undefined;
              }
              const remaining = SANDBOX_STEP_BUDGET - stepNumber;
              return {
                system: `${systemPrompt}\n\n[Tool-budget reminder: you have used ${stepNumber} of ${SANDBOX_STEP_BUDGET} tool steps; ${remaining} remain. If your evidence is already sufficient, write the final answer now instead of taking another tool step.]`,
              };
            }
          : undefined,
        // Wire the cancellation controller into the SDK so a
        // poll-detected cancel actively tears down the underlying HTTP
        // request. Without this we'd still observe `wasCancelled === true`
        // post-loop, but the SSE connection would keep streaming bytes
        // (and burning tokens) until the model finished naturally.
        abortSignal: cancellationController.signal,
      });
      const response = streamResponse;

      // We always iterate `fullStream` — it is a strict superset of
      // `textStream` (every text chunk shows up as a `text-delta` event).
      // Sandbox-mode replies additionally surface `tool-call` /
      // `tool-result` / `tool-error` events here; these are persisted
      // into messageToolCallEvents for the live ticker and trace UI.
      for await (const part of response.fullStream) {
        // Short-circuit before processing any further events.
        // Two reasons we still need this even though we passed
        // `abortSignal` to streamText:
        //   1. The SDK / underlying provider may keep emitting buffered
        //      events for a brief window after `controller.abort()` fires.
        //      Honoring the flag immediately means we stop *persisting*
        //      those events (no more `appendAssistantToolCallEvent`
        //      writes) the moment the poll catches the cancel.
        //   2. If a tool execution is currently in flight when abort
        //      fires, the `tool-result` event may still arrive. Bailing
        //      here prevents the result from being written into the
        //      events table after `cancelInFlightReply` already drained
        //      it (which would briefly resurrect a "running" entry in
        //      the live ticker).
        //
        // We also break on `generationAborted` so that a poll-detected
        // jobMissing immediately stops further `appendAssistantStreamChunk`
        // / `appendAssistantToolCallEvent` calls — both unconditionally
        // patch the (now-missing) job row for the lease refresh and would
        // throw, propagating noisy errors all the way through the catch
        // path.
        if (wasCancelled || generationAborted) {
          break;
        }
        switch (part.type) {
          case "text-delta": {
            pendingDelta += part.text;
            await flushIfNeeded();
            break;
          }
          case "tool-call": {
            // Convert the model's tool-call args to JSON, then redact; the
            // mutation re-caps to `TOOL_CALL_EVENT_SUMMARY_MAX_CHARS` if
            // somehow the JSON is still long after redaction (e.g. a tool
            // input that legitimately needs more bytes — `run_shell`).
            const occurredAt = Date.now();
            const inputJson = JSON.stringify(part.input ?? {});
            const { redacted: inputSummary } = redact(inputJson);

            toolCallMap.set(part.toolCallId, {
              toolName: part.toolName,
              inputSummary,
              startedAt: occurredAt,
            });
            // Count *invocations* on `tool-call`, not on
            // `tool-result`. A tool-call without a matching result
            // (e.g. mid-stream cancel before the tool returns) is
            // still a real LLM-driven invocation we want reflected in
            // the session metric.
            telemetry.toolInvocations += 1;

            await ctx.runMutation(internal.chat.streaming.appendAssistantToolCallEvent, {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolCallId: part.toolCallId,
              type: "start",
              toolName: part.toolName,
              inputSummary,
              occurredAt,
            });

            logInfo("chat", "sandbox_tool_call", {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolName: part.toolName,
              toolCallId: part.toolCallId,
            });
            break;
          }
          case "tool-result": {
            const occurredAt = Date.now();
            const toolCall = toolCallMap.get(part.toolCallId);
            const resultJson = JSON.stringify(part.output ?? {});
            const { redacted: outputSummary } = redact(resultJson);

            // We always emit an `end` event keyed by the AI SDK's
            // `toolCallId` even if the local correlation map missed the
            // start (defensive — a corrupt event stream shouldn't leave a
            // dangling `start` row). `inputSummary` falls back to an
            // empty string; the fold logic in `toolCallEventStore.ts`
            // tolerates that and still produces a meaningful entry.
            await ctx.runMutation(internal.chat.streaming.appendAssistantToolCallEvent, {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolCallId: part.toolCallId,
              type: "end",
              toolName: toolCall?.toolName ?? part.toolName,
              inputSummary: toolCall?.inputSummary ?? "",
              outputSummary,
              occurredAt,
            });

            // Per-tool metric. We extract the envelope-reported error
            // code so dashboards can pivot by `path_outside_repo`
            // / `command_blocked` / `tool_timeout` / etc. and the
            // post-rollout abort condition (`error_code='io_error'` rate
            // > X%) can be expressed in one query. `auditMetadata.errorCode`
            // is `undefined` for successful tool results — that's how we
            // detect `ok` here without re-parsing the JSON.
            const auditMetadata = extractAuditMetadataFromToolOutput(part.output);
            const toolDurationMs = toolCall ? Math.max(0, occurredAt - toolCall.startedAt) : 0;
            const isOk = auditMetadata.errorCode === undefined;
            if (!isOk) {
              telemetry.toolErrors += 1;
            }
            emitMetric("sandbox_tool_invoked", {
              value: toolDurationMs,
              tags: {
                tool: toolCall?.toolName ?? part.toolName,
                ok: isOk,
                error_code: auditMetadata.errorCode,
              },
              details: buildToolMetricDetails(args.assistantMessageId, args.jobId, part.toolCallId),
            });

            // Append an audit-log row alongside the live event.
            // Two independent transactions (best-effort wrapper catches
            // any failure as a warning) so a transient audit-log outage
            // cannot tear down a reply that already produced its tool
            // effect. `outputBytes` reflects the *pre-redaction* JSON
            // size — it is a volume signal for compliance audits, not a
            // length of the redacted display string. Gated on
            // `sandboxTooling` because that is the only context where the
            // sandboxId we key against is actually known; a stray
            // tool-result on a non-sandbox reply is malformed and is
            // logged for the trace but not the audit log.
            //
            // `auditMetadata` was already extracted above for the
            // per-tool metric; reuse it here so we don't pay the JSON
            // traversal cost twice per result.
            if (replyContext.sandboxTooling) {
              await tryRecordSandboxToolCallLogEntry(ctx, {
                ownerTokenIdentifier: replyContext.ownerTokenIdentifier,
                threadId: args.threadId,
                messageId: args.assistantMessageId,
                sandboxId: replyContext.sandboxTooling.sandboxId,
                toolName: toolCall?.toolName ?? part.toolName,
                inputJson: toolCall?.inputSummary ?? "{}",
                outputBytes: countUtf8Bytes(resultJson),
                durationMs: toolDurationMs,
                errorCode: auditMetadata.errorCode,
                redactedFields: auditMetadata.redactedFields,
              });
            }

            logInfo("chat", "sandbox_tool_result", {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolName: part.toolName,
              toolCallId: part.toolCallId,
            });
            break;
          }
          case "tool-error": {
            const occurredAt = Date.now();
            const toolCall = toolCallMap.get(part.toolCallId);
            const errorMessage = part.error instanceof Error ? part.error.message : String(part.error);
            // Compute once so the persisted `outputSummary` and the
            // observability payload share the same redacted text — keeps
            // logs free of upstream HTTP bodies / secrets that the SDK
            // may have surfaced inside the error.
            const redactedError = redact(`Error: ${errorMessage}`).redacted;

            await ctx.runMutation(internal.chat.streaming.appendAssistantToolCallEvent, {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolCallId: part.toolCallId,
              type: "end",
              toolName: toolCall?.toolName ?? part.toolName,
              inputSummary: toolCall?.inputSummary ?? "",
              // The error message is already prose — wrap with a
              // recognizable prefix so the UI / LLM can distinguish it
              // from a normal `outputSummary`. Redact in case the SDK
              // surfaces an upstream HTTP body with secrets.
              outputSummary: redactedError,
              errorCode: "tool_error",
              occurredAt,
            });

            // Per-tool error metric. `tool-error` always means the
            // tool's `execute` threw (as opposed to a structured `ok:
            // false` envelope); the error_code tag is
            // the synthetic `tool_error` literal so the metric stream
            // is uniform with the envelope-error case (which uses the
            // tool's own structured `errorCode`).
            telemetry.toolErrors += 1;
            const toolErrorDurationMs = toolCall ? Math.max(0, occurredAt - toolCall.startedAt) : 0;
            emitMetric("sandbox_tool_invoked", {
              value: toolErrorDurationMs,
              tags: {
                tool: toolCall?.toolName ?? part.toolName,
                ok: false,
                error_code: "tool_error",
              },
              details: buildToolMetricDetails(args.assistantMessageId, args.jobId, part.toolCallId),
            });

            // Audit log entry on the AI SDK error path. The
            // error already happened (the tool's `execute` threw), so
            // `outputBytes` is 0 and `redactedFields` is empty; the
            // useful audit signal is "this tool call was attempted and
            // surfaced an SDK-level error" which `errorCode: "tool_error"`
            // captures. Distinguished from envelope-reported errors
            // (`extractAuditMetadataFromToolOutput`) which use the
            // tool's own structured `errorCode` like `path_outside_repo`.
            if (replyContext.sandboxTooling) {
              await tryRecordSandboxToolCallLogEntry(ctx, {
                ownerTokenIdentifier: replyContext.ownerTokenIdentifier,
                threadId: args.threadId,
                messageId: args.assistantMessageId,
                sandboxId: replyContext.sandboxTooling.sandboxId,
                toolName: toolCall?.toolName ?? part.toolName,
                inputJson: toolCall?.inputSummary ?? "{}",
                outputBytes: 0,
                durationMs: toolCall ? Math.max(0, occurredAt - toolCall.startedAt) : 0,
                errorCode: "tool_error",
                redactedFields: [],
              });
            }

            logWarn("chat", "sandbox_tool_error", {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              error: redactedError,
            });
            break;
          }
          case "reasoning-start": {
            // Stamp the start of the reasoning phase so the `<Reasoning>` UI
            // can render "Thought for N seconds" at finalize time. The
            // mutation is idempotent on the timestamp field, so a duplicate
            // `reasoning-start` (rare but possible across step boundaries)
            // does not double-count duration.
            await ctx.runMutation(internal.chat.streaming.markReasoningStarted, {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              occurredAt: Date.now(),
            });
            break;
          }
          case "reasoning-delta": {
            pendingReasoningDelta += part.text;
            await flushReasoningIfNeeded();
            break;
          }
          case "reasoning-end": {
            await flushReasoningIfNeeded({ force: true });
            await ctx.runMutation(internal.chat.streaming.markReasoningEnded, {
              assistantMessageId: args.assistantMessageId,
              jobId: args.jobId,
              occurredAt: Date.now(),
            });
            break;
          }
          case "error": {
            // Surface mid-stream provider errors. Re-throwing routes through
            // the outer catch which runs `failAssistantReply` exactly once.
            const message = part.error instanceof Error ? part.error.message : `Stream error: ${String(part.error)}`;
            throw new Error(message);
          }
          default:
            // `text-start` / `text-end` / `start-step` / `finish-step` /
            // `start` / `finish` / `tool-input-*` / `source` /
            // `file` / `tool-output-denied` / `tool-approval-request` /
            // `abort` / `raw` — none of these affect the text we persist.
            //
            // An `abort` event surfaces here when the SDK observes our
            // `abortSignal` firing. The next loop iteration's
            // `wasCancelled` check breaks out before any persistence
            // runs (since the poll that fired the abort already flipped
            // the flag), so we don't need to special-case `abort` here.
            break;
        }
      }

      // Force any reasoning delta still buffered into the stream row so
      // finalize / cancel can copy `liveReasoning` → `messages.reasoning`
      // in a single transaction. Skipped when the job row is already gone
      // — `appendAssistantReasoningDelta` would just no-op on a missing
      // stream but avoiding the round trip keeps the abort path cheap.
      if (!generationAborted) {
        await flushReasoningIfNeeded({ force: true });
      }

      // Extract usage *before* branching on cancel/success so
      // the partial-cost telemetry is available to both the cancel
      // finalize variant and the success finalize. A cancelled stream
      // can still produce a `totalUsage` resolution if the upstream sent
      // its final usage frame before the abort signal tore down the
      // connection; degrading silently to undefined when it didn't is
      // the right behavior (we charge what we know about; partial-pretty-
      // good > none-at-all for the daily cap).
      const usage = await extractStreamUsage(streamResponse, {
        modelName,
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
      });

      // If the loop exited because cancellation fired (either
      // through the in-loop `break` or because the abortSignal made
      // fullStream end early), route to the cancel finalize variant
      // instead of the normal one. Persisting whatever was already
      // streamed gives the user the partial reply they intentionally
      // interrupted to see, plus the partial cost so the daily cap
      // settles accurately.
      if (wasCancelled) {
        // Skip finalize if generation was aborted due to missing job.
        if (!generationAborted) {
          await ctx.runMutation(internal.chat.streaming.markAssistantReplyCancelled, {
            assistantMessageId: args.assistantMessageId,
            jobId: args.jobId,
            finalDelta: pendingDelta || undefined,
            reason: cancellationReason,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: usage.costUsd,
          });
          emitSessionExit("cancelled", usage);
        } else {
          emitSessionExit("aborted_orphan", usage);
        }
        return;
      }

      // Skip finalize if generation was aborted due to missing job.
      if (generationAborted) {
        emitSessionExit("aborted_orphan", usage);
        return;
      }

      await ctx.runMutation(internal.chat.streaming.finalizeAssistantReply, {
        threadId: args.threadId,
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        finalDelta: pendingDelta,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        citationMap: persistedCitationMap,
      });
      emitSessionExit("completed", usage);
    } catch (error) {
      // Even on the error path, try to extract whatever usage the SDK
      // already accumulated before the throw. Some errors fire
      // mid-stream (e.g. provider rate-limit kicking in after the model
      // produced 200 tokens) and the partial cost is real spend that
      // should count against the daily cap.
      //
      // `modelName` is the same per-mode pick the success path used.
      // The fallback only fires when the catch lands before
      // `resolveModelForReply` ever ran (e.g. `getReplyContext` threw),
      // in which case `streamResponse` is also `undefined` and
      // `extractStreamUsage` short-circuits to `{}` — so the fallback
      // string is moot at runtime, just there to satisfy the helper's
      // `string` parameter type.
      // Force any reasoning delta still buffered. Mirrors the success
      // path so partial reasoning surfaces on failures and cancellations
      // alike. `try`-wrapped because the catch is also reached on
      // pre-context throws where the stream row doesn't exist yet — a
      // flush attempt is fine to swallow there.
      if (!generationAborted) {
        try {
          await flushReasoningIfNeeded({ force: true });
        } catch (flushError) {
          logWarn("chat", "reasoning_flush_failed_on_error_path", {
            assistantMessageId: args.assistantMessageId,
            jobId: args.jobId,
            error: flushError instanceof Error ? flushError.message : String(flushError),
          });
        }
      }

      const usage = await extractStreamUsage(streamResponse, {
        modelName: modelName ?? "gpt-5-mini",
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
      });

      // Abort-induced exceptions land here too: streamText
      // surfaces a `DOMException`/`AbortError` once the SSE tear-down
      // bubbles back through `fullStream`. Distinguishing them via the
      // `wasCancelled` flag (rather than sniffing `error.name`) keeps the
      // logic decoupled from undici / AI SDK error-shape internals — if
      // the poll already saw the cancel and set the flag, we know the
      // throw is a consequence of that cancel and route accordingly.
      if (wasCancelled) {
        // Skip finalize if generation was aborted due to missing job.
        if (!generationAborted) {
          await ctx.runMutation(internal.chat.streaming.markAssistantReplyCancelled, {
            assistantMessageId: args.assistantMessageId,
            jobId: args.jobId,
            finalDelta: pendingDelta || undefined,
            reason: cancellationReason,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: usage.costUsd,
          });
          emitSessionExit("cancelled", usage);
        } else {
          emitSessionExit("aborted_orphan", usage);
        }
        return;
      }
      // Skip fail finalize if generation was aborted due to missing job.
      if (generationAborted) {
        emitSessionExit("aborted_orphan", usage);
        return;
      }
      await ctx.runMutation(internal.chat.streaming.failAssistantReply, {
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        errorMessage: error instanceof Error ? error.message : "Unknown assistant error",
        finalDelta: pendingDelta,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
      });
      emitSessionExit("failed", usage);
    } finally {
      // Always tear down the cancellation poll, regardless of
      // which exit path the action took. Setting `pollingStopped` first
      // disarms a tick that might already be queued when we hit
      // `clearTimeout`; without that, a fast queryPaused → resumed cycle
      // could let a stale `runQuery` fire after the action returned.
      pollingStopped = true;
      if (pollHandle) {
        clearTimeout(pollHandle);
      }
    }
  },
});

/**
 * Resolve a Daytona-backed `SandboxFsClient` and wrap it in the AI SDK
 * `ToolSet` shape `streamText` expects.
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

/**
 * Extract `inputTokens` / `outputTokens` / `costUsd` from a
 * (possibly aborted, possibly partial) `streamText` response.
 *
 * Returns all three as `undefined` when:
 *
 *   - `response` is undefined (fast-exit paths that never invoked
 *     `streamText`, e.g. heuristic mode or cancel-before-streamText);
 *   - `response.totalUsage` rejects (the SDK closed the stream before
 *     the upstream produced its final usage frame, common with
 *     mid-stream aborts);
 *   - the model's reported tokens or our pricing snapshot is missing.
 *
 * Logging at WARN preserves the prior behavior where unavailable usage
 * is observable in dashboards but not user-facing — the user already
 * sees the (un)cost ticker, so the warning is for ops dashboards only.
 *
 * Crucially, this never throws: every settle / finalize call site can
 * `await` the helper without its own try/catch, keeping the caller's
 * control flow flat and making the cost-extraction concern a single
 * point of change for future telemetry / pricing additions.
 */
async function extractStreamUsage(
  response: ReturnType<typeof streamText> | undefined,
  context: { modelName: string; assistantMessageId: string; jobId: string },
): Promise<{ inputTokens?: number; outputTokens?: number; costUsd?: number }> {
  if (!response) {
    return {};
  }
  try {
    const usage = await response.totalUsage;
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    const costUsd = estimateCostUsd(context.modelName, inputTokens, outputTokens);
    return { inputTokens, outputTokens, costUsd };
  } catch (error) {
    logWarn("chat", "assistant_reply_usage_unavailable", {
      assistantMessageId: context.assistantMessageId,
      jobId: context.jobId,
      model: context.modelName,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
