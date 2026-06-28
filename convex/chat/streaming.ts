import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, internalMutation, internalQuery, query } from "../_generated/server";
import { artifactKindValidator } from "../schema";
import { loadOwnedDoc } from "../lib/ownedDocs";
import { CHAT_JOB_LEASE_MS } from "../lib/rateLimit";
import { jobCancellationStatusValidator, startedResultValidator } from "../lib/functionResultSchemas";
import { costUsdToCents } from "../lib/llmPricing";
import { logInfo, logWarn } from "../lib/observability";
import { buildUsageSourceId } from "../lib/usageAccounting";
import { settleUsageLifecycleInMutation } from "../lib/usageAccountingMutations";
import {
  MAX_LIVE_REASONING_CHARS,
  MAX_TOOL_CALL_EVENTS_PER_MESSAGE,
  TOOL_CALL_EVENT_SUMMARY_MAX_CHARS,
} from "../lib/constants";
import {
  cancelActiveJob,
  completeRunningJob,
  failRunningJob,
  failStaleActiveJob,
  isJobStaleAndRecoverable,
  markQueuedJobRunning,
  refreshRunningJobLease,
  updateRunningJobProgress,
} from "../lib/jobs";
import { lintCitations, type UnverifiedClaimRange } from "./citationLint";
import {
  compactMessageStreamTail,
  deleteMessageStreamState,
  getMessageStreamByThread,
  getMessageStreamByAssistantMessageId,
  getMessageStreamByJobId,
  loadAllStreamTailChunks,
  loadMessageStreamSnapshot,
} from "./streamStore";
import {
  drainMessageToolCallEvents,
  foldToolCallEvents,
  loadAllToolCallEventsByMessage,
  nextToolCallEventSequence,
  type ToolCallTraceEntry,
} from "./toolCallEventStore";
import { recordThreadActivityInHistory } from "./historyState";
import { loadActiveOwnedThread } from "./threadAccess";

const STALE_CHAT_JOB_ERROR_MESSAGE =
  "This reply stopped before it could finish. Try sending your message again. If it keeps happening, choose another model or check the provider configuration.";

/**
 * Soft truncation marker appended to over-long tool-call summaries before
 * they reach the events table. Visible to both the LLM (the AI SDK feeds
 * tool results back as next-step inputs) and to the trace UI, so the
 * truncation is never silent.
 */
const TOOL_CALL_SUMMARY_TRUNCATION_MARKER = "…[truncated]";

/**
 * Fold + drain helper shared by `finalizeAssistantReply`,
 * `failAssistantReply`, and `recoverStaleChatJob`.
 *
 * All three mutations need to: (1) read up to `MAX_TOOL_CALL_EVENTS_PER_MESSAGE`
 * events for the fold, (2) compute the persisted `messages.toolCalls`
 * payload, and (3) make sure *every* event row attached to this message
 * is gone before the transaction commits.
 *
 * Centralizing this matters because `loadAllToolCallEventsByMessage`
 * caps reads at `MAX_TOOL_CALL_EVENTS_PER_MESSAGE` (defensively, to keep
 * the live subscription cheap and the fold inside Convex's per-tx read
 * budget). If a buggy upstream produced more events than the cap,
 * deleting only the rows we read would leave orphans behind that the
 * live subscription can't see but that survive the message itself.
 * Always calling `drainMessageToolCallEvents` after the fold guarantees
 * a full sweep — the function is idempotent and cheap when the read
 * already deleted the first batch.
 */
async function foldAndDrainToolCallEvents(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  context: { jobId: Id<"jobs">; mutation: string },
): Promise<ToolCallTraceEntry[] | undefined> {
  const events = await loadAllToolCallEventsByMessage(ctx, messageId);
  const folded = foldToolCallEvents(events);
  // Defensive sweep: drain *all* rows even if the fold-read hit the cap.
  // Returns the actual count drained so we can log when truncation
  // happened — that's the signal that something upstream produced more
  // events than `SANDBOX_STEP_BUDGET * 2`, which is worth alerting on.
  const drained = await drainMessageToolCallEvents(ctx, messageId);
  if (events.length >= MAX_TOOL_CALL_EVENTS_PER_MESSAGE) {
    logWarn("chat", "tool_event_fold_truncated", {
      messageId,
      jobId: context.jobId,
      mutation: context.mutation,
      foldedEventCount: events.length,
      drainedEventCount: drained,
      cap: MAX_TOOL_CALL_EVENTS_PER_MESSAGE,
      hint: "messages.toolCalls reflects only the first MAX_TOOL_CALL_EVENTS_PER_MESSAGE rows; subsequent rows are dropped from the persisted trace.",
    });
  }
  return folded.length > 0 ? folded : undefined;
}

/**
 * Settle chat reply usage into the durable user ledger and, for sandbox
 * grounded replies only, the sandbox daily cost cap.
 */
async function settleChatReplyUsage(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    assistantMessage: Doc<"messages"> | null;
    occurredAtMs: number;
    usage: TerminalUsage | undefined;
  },
): Promise<void> {
  if (!args.assistantMessage) {
    return;
  }

  const isSandboxReply = args.assistantMessage.groundSandbox === true;
  const thread = isSandboxReply ? await ctx.db.get(args.assistantMessage.threadId) : null;
  const repositoryId = isSandboxReply ? (thread?.repositoryId ?? null) : null;

  const settlement = await settleUsageLifecycleInMutation(ctx, {
    sourceId: buildUsageSourceId.chatReply(args.assistantMessage._id),
    ownerTokenIdentifier: args.assistantMessage.ownerTokenIdentifier,
    repositoryId,
    feature: "chatReply",
    sandboxDailyCap: isSandboxReply ? "settleOnly" : "none",
    occurredAtMs: args.occurredAtMs,
    usage: {
      costUsd: args.usage?.costUsd,
      inputTokens: args.usage?.inputTokens,
      outputTokens: args.usage?.outputTokens,
      cachedInputTokens: args.usage?.cachedInputTokens,
      reasoningTokens: args.usage?.reasoningTokens,
    },
  });

  if (!isSandboxReply || settlement.settledCents === null) {
    return;
  }

  logInfo("chat", "sandbox_cost_settled", {
    jobId: args.jobId,
    assistantMessageId: args.assistantMessage._id,
    ownerTokenIdentifier: args.assistantMessage.ownerTokenIdentifier,
    repositoryId,
    cents: settlement.settledCents,
  });
}

async function recordSandboxSessionActivityForReply(
  ctx: MutationCtx,
  args: {
    assistantMessage: Doc<"messages"> | null;
    costUsd: number | undefined;
  },
): Promise<void> {
  if (!args.assistantMessage || args.assistantMessage.groundSandbox !== true) {
    return;
  }
  const thread = await ctx.db.get(args.assistantMessage.threadId);
  if (!thread?.sandboxSessionId) {
    return;
  }
  const session = await ctx.db.get(thread.sandboxSessionId);
  if (!session || session.status === "stopped" || session.status === "ended") {
    return;
  }
  await ctx.db.patch(session._id, {
    lastActivityAt: Date.now(),
    spentCents: Math.max(0, session.spentCents + (costUsdToCents(args.costUsd) ?? 0)),
  });
}

/**
 * Run the citation lint against a finalized assistant reply and return
 * the persisted shape (or `undefined` to clear the field).
 *
 * Gated on `groundSandbox === true`: the lint contract exists *only* for
 * sandbox-grounded replies (the prompt teaches `[path:line]` +
 * `Unverified:`). Ungrounded Discuss and Library replies have their own
 * citation conventions (`[A#]` for library; nothing for plain Discuss),
 * so applying this lint there would generate a wall of false positives.
 *
 * Empty content is also a `undefined` return — the lint produces no
 * ranges on an empty string, but spelling out the early-return keeps
 * the call sites obviously correct in the cancellation / failure
 * paths where partial content can be the empty string. `undefined`
 * rather than `[]` matches the schema-level convention (`toolCalls`,
 * `citationMap`): callers that read the field treat both as "no
 * highlights", but storing `undefined` keeps the row free of empty
 * array bookkeeping for messages that genuinely had no flagged claims.
 *
 * `lintCitations` already enforces {@link MAX_UNVERIFIED_CLAIMS_PER_MESSAGE}
 * internally via early return, so no re-cap is needed here. Re-slicing
 * would be a guaranteed no-op and would only add a layer of mistrust
 * between the module's documented contract and this caller.
 */
function lintSandboxClaims(
  message: Pick<Doc<"messages">, "groundSandbox">,
  finalContent: string,
): UnverifiedClaimRange[] | undefined {
  if (message.groundSandbox !== true) {
    return undefined;
  }
  if (finalContent.length === 0) {
    return undefined;
  }
  const ranges = lintCitations(finalContent);
  return ranges.length > 0 ? ranges : undefined;
}

/**
 * Derive the durable `messages.reasoning` / `messages.reasoningDurationMs`
 * pair from a stream row.
 *
 * Returns `undefined` on each field when the stream produced no reasoning
 * at all (the model wasn't a thinking model, or the events never fired)
 * so the persisted message stays clean rather than carrying empty-string
 * + `NaN` placeholders. The duration is computed from the stamped
 * start/end timestamps; when only the start is present (mid-cancel /
 * mid-fail), we substitute the current time so the elapsed window is
 * the partial-reasoning wall-clock rather than `NaN`.
 *
 * Optional `now` is passed in by the call site so the pair stays
 * stable when multiple writes settle in the same finalize transaction.
 */
function deriveMessageReasoning(
  stream: Pick<Doc<"messageStreams">, "liveReasoning" | "reasoningStartedAt" | "reasoningEndedAt"> | null,
  now: number,
): { reasoning: string | undefined; reasoningDurationMs: number | undefined } {
  if (!stream || !stream.liveReasoning) {
    return { reasoning: undefined, reasoningDurationMs: undefined };
  }
  const start = stream.reasoningStartedAt;
  const end = stream.reasoningEndedAt ?? now;
  const durationMs = typeof start === "number" ? Math.max(0, end - start) : undefined;
  return { reasoning: stream.liveReasoning, reasoningDurationMs: durationMs };
}

/**
 * Cap a tool-call summary at `TOOL_CALL_EVENT_SUMMARY_MAX_CHARS` characters,
 * appending the truncation marker when truncation actually happens.
 * Operates on UTF-16 code units (the same units `String.slice` uses), so
 * the resulting string never exceeds the cap by a fraction of a code point.
 */
function capSummary(value: string): string {
  if (value.length <= TOOL_CALL_EVENT_SUMMARY_MAX_CHARS) {
    return value;
  }
  return (
    value.slice(0, TOOL_CALL_EVENT_SUMMARY_MAX_CHARS - TOOL_CALL_SUMMARY_TRUNCATION_MARKER.length) +
    TOOL_CALL_SUMMARY_TRUNCATION_MARKER
  );
}

/**
 * Cost telemetry grouped together because the fields always arrive
 * together (or all arrive missing). Splitting them per-field would
 * invite partial-combination callers ("tokens but no cost") that the
 * upstream `estimateCostUsd` never produces.
 *
 * `cachedInputTokens` / `reasoningTokens` are NormalizedUsage slices the
 * gateway surfaces — they are optional because not every model emits
 * them. Persisted as `estimatedCachedInputTokens` /
 * `estimatedReasoningTokens` on the message row so the per-user cost
 * rollup (`convex/lib/userCost.ts`) can attribute cache savings and
 * reasoning spend without re-deriving from the raw provider metadata.
 */
type TerminalUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
};

/**
 * Discriminated outcome handed to {@link applyTerminalSettlement}. Each
 * variant carries only the fields its terminal path actually needs:
 *
 *   - `completed` is the only path that updates the owning thread's
 *     timestamps (so it carries `threadId`) and the only one that
 *     persists a `citationMap`.
 *   - `failed` / `cancelled` share the same shape: partial content,
 *     optional partial cost, a user-visible reason or error message.
 *   - `stale` carries only the `jobId` because the cron-driven caller
 *     does not know the assistant message id; the helper resolves both
 *     the message and the stream from job-scoped indexes.
 */
type TerminalOutcome =
  | {
      kind: "completed";
      threadId: Id<"threads">;
      assistantMessageId: Id<"messages">;
      jobId: Id<"jobs">;
      finalDelta: string;
      usage?: TerminalUsage;
      citationMap?: Array<{
        index: number;
        artifactId: Id<"artifacts">;
        artifactTitle?: string;
        artifactKind?: Doc<"artifacts">["kind"];
        artifactVersion?: number;
        chunkId?: Id<"artifactChunks">;
        headingPath?: string[];
      }>;
    }
  | {
      kind: "failed";
      assistantMessageId: Id<"messages">;
      jobId: Id<"jobs">;
      errorMessage: string;
      finalDelta?: string;
      usage?: TerminalUsage;
    }
  | {
      kind: "cancelled";
      assistantMessageId: Id<"messages">;
      jobId: Id<"jobs">;
      /**
       * Already-normalized (callers pass a default before reaching the
       * helper). Surfaced on `messages.errorMessage` so the cancelled
       * bubble can render a specific reason even when no partial content
       * was streamed.
       */
      reason: string;
      finalDelta?: string;
      usage?: TerminalUsage;
    }
  | {
      kind: "stale";
      jobId: Id<"jobs">;
      errorMessage: string;
    };

/**
 * Log breadcrumb fed to {@link foldAndDrainToolCallEvents} so a
 * truncated fold tells ops which terminal path observed the overflow.
 * Kept consistent with the pre-refactor strings so any existing log-
 * search dashboards keep matching.
 */
const MUTATION_LABEL_BY_KIND: Record<TerminalOutcome["kind"], string> = {
  completed: "finalizeAssistantReply",
  failed: "failAssistantReply",
  cancelled: "markAssistantReplyCancelled",
  stale: "recoverStaleChatJob",
};

function usageForChatRollup(outcome: TerminalOutcome, message: Doc<"messages"> | null): TerminalUsage | undefined {
  if (outcome.kind === "stale" || !message) {
    return undefined;
  }
  if (outcome.kind === "completed") {
    return outcome.usage;
  }
  return {
    inputTokens: outcome.usage?.inputTokens ?? message.estimatedInputTokens,
    outputTokens: outcome.usage?.outputTokens ?? message.estimatedOutputTokens,
    cachedInputTokens: outcome.usage?.cachedInputTokens ?? message.estimatedCachedInputTokens,
    reasoningTokens: outcome.usage?.reasoningTokens ?? message.estimatedReasoningTokens,
    costUsd: outcome.usage?.costUsd ?? message.estimatedCostUsd,
  };
}

/**
 * Single seam for the four terminal-state transitions an assistant reply
 * can reach: completed, failed, cancelled, and stale-recovered.
 *
 * All four share ~80% of their ceremony — fold + drain tool-call events,
 * patch the message into terminal status, transition the job row, settle
 * sandbox cost against the daily cap, record sandbox session activity,
 * and clean the ephemeral stream tables in `finally`. The per-kind
 * differences (which `lib/jobs` transition to call, whether thread
 * timestamps move, whether cost settlement runs) live in the switch, so
 * a future "what does termination need to do?" change has one place to
 * land instead of four.
 *
 * Contracts the helper is responsible for preserving:
 *
 *   1. **Idempotency vs already-terminal jobs.** A late `finalize` after
 *      the same job already failed must leave the failed state intact:
 *      the per-kind job transition returns null → the helper returns
 *      `false` before patching the message. The `cancelled` path further
 *      distinguishes "job is in a different terminal state" (return
 *      silently) from "job row is gone" (log warn and continue patching
 *      — the action is still the only writer that knows the final
 *      partial content).
 *
 *   2. **Stale recovery ordering.** Stale recovery patches the message
 *      *before* calling `failStaleActiveJob`, opposite to the action-
 *      driven paths. The eligibility pre-check at the caller already
 *      gates whether we reach the helper at all, so the race window for
 *      the order to matter is narrow; flipping it would be a separate
 *      change.
 *
 *   3. **Stream cleanup runs in `finally`.** A throw inside the try
 *      rolls back the whole transaction (Convex mutations are
 *      transactional), so the `finally` is partly ceremonial — but
 *      keeping the cleanup there documents the intent and protects
 *      against future refactors that might wrap individual writes in
 *      try/catch.
 *
 * Returns `true` when the helper applied a terminal transition (the
 * caller's logical operation took effect), `false` when it short-circuited
 * because the job was already in an incompatible terminal state. Most
 * callers ignore the result; the cancellation mutation uses it to gate
 * the success-side info log.
 */
async function applyTerminalSettlement(ctx: MutationCtx, outcome: TerminalOutcome): Promise<boolean> {
  const now = Date.now();
  const mutationLabel = MUTATION_LABEL_BY_KIND[outcome.kind];

  // Phase 1: resolve message + stream. Action-driven paths know the
  // assistantMessageId up front; stale recovery only has the jobId and
  // must look up both via job-scoped indexes.
  let assistantMessageId: Id<"messages"> | null;
  let stream: Doc<"messageStreams"> | null;
  let streamSnapshot: Awaited<ReturnType<typeof loadMessageStreamSnapshot>>;
  let message: Doc<"messages"> | null;

  if (outcome.kind === "stale") {
    const jobMessages = await ctx.db
      .query("messages")
      .withIndex("by_jobId", (q) => q.eq("jobId", outcome.jobId))
      .take(10);
    const assistantMessage = jobMessages.find((entry) => entry.role === "assistant") ?? null;
    assistantMessageId = assistantMessage?._id ?? null;
    message = assistantMessage;
    stream = await getMessageStreamByJobId(ctx, outcome.jobId);
    // Match the pre-refactor `recoverStaleChatJob` shape: only resolve
    // the snapshot when both the message and stream exist. Without
    // either, the lint runs against an empty string and the patch falls
    // back to the error message — exactly the original behavior.
    streamSnapshot = assistantMessage && stream ? await loadMessageStreamSnapshot(ctx, assistantMessage._id) : null;
  } else {
    assistantMessageId = outcome.assistantMessageId;
    streamSnapshot = await loadMessageStreamSnapshot(ctx, outcome.assistantMessageId);
    stream = streamSnapshot?.stream ?? null;
    message = await ctx.db.get(outcome.assistantMessageId);
  }

  // Phase 2: fold + drain. The helper sweeps past the fold's read cap so
  // a runaway producer cannot leave orphan events pointing at the
  // already-finalized message. Skipped only when we have no message id
  // (a stale recovery on a job whose messages were cascade-deleted).
  const persistedToolCalls = assistantMessageId
    ? await foldAndDrainToolCallEvents(ctx, assistantMessageId, {
        jobId: outcome.jobId,
        mutation: mutationLabel,
      })
    : undefined;

  let applied = true;
  try {
    switch (outcome.kind) {
      case "completed": {
        if (!message) {
          logWarn("chat", "finalize_assistant_message_missing", {
            assistantMessageId: outcome.assistantMessageId,
            jobId: outcome.jobId,
          });
          // The reply cannot be delivered, so mark the still-running job
          // failed. Terminal jobs are left untouched by `failRunningJob`.
          await failRunningJob(ctx, {
            jobId: outcome.jobId,
            expectedKind: "chat",
            completedAt: now,
            errorMessage: "Assistant message was deleted before the reply could be persisted.",
          });
          break;
        }
        const completedJob = await completeRunningJob(ctx, {
          jobId: outcome.jobId,
          expectedKind: "chat",
          completedAt: now,
          outputSummary: "Assistant reply generated.",
          estimatedInputTokens: outcome.usage?.inputTokens,
          estimatedOutputTokens: outcome.usage?.outputTokens,
          estimatedCostUsd: outcome.usage?.costUsd,
        });
        if (!completedJob) {
          applied = false;
          return applied;
        }
        const finalContent = `${streamSnapshot?.content ?? message.content}${outcome.finalDelta}`;
        // Citation lint runs against the finalized content *before* the
        // patch so `messages.unverifiedClaims` is committed in the same
        // transaction that flips status to `completed`. Sandbox-only via
        // `lintSandboxClaims`; non-sandbox replies leave the field unset.
        const unverifiedClaims = lintSandboxClaims(message, finalContent);
        const reasoning = deriveMessageReasoning(streamSnapshot?.stream ?? null, now);
        await ctx.db.patch(message._id, {
          content: finalContent,
          status: "completed",
          errorMessage: undefined,
          estimatedInputTokens: outcome.usage?.inputTokens,
          estimatedOutputTokens: outcome.usage?.outputTokens,
          estimatedCachedInputTokens: outcome.usage?.cachedInputTokens,
          estimatedReasoningTokens: outcome.usage?.reasoningTokens,
          estimatedCostUsd: outcome.usage?.costUsd,
          citationMap: outcome.citationMap,
          toolCalls: persistedToolCalls,
          unverifiedClaims,
          reasoning: reasoning.reasoning,
          reasoningDurationMs: reasoning.reasoningDurationMs,
        });
        // The thread may have been deleted while we were streaming.
        // Patching a missing doc throws and would roll back the whole
        // mutation (so the job lease and stream state would never be
        // cleared). Wrap so the rest of cleanup still runs.
        try {
          await ctx.db.patch(outcome.threadId, {
            lastAssistantMessageAt: now,
            lastMessageAt: now,
          });
          const updatedThread = await ctx.db.get(outcome.threadId);
          if (updatedThread) {
            await recordThreadActivityInHistory(ctx, updatedThread);
          }
        } catch (error) {
          logWarn("chat", "finalize_thread_patch_failed", {
            threadId: outcome.threadId,
            jobId: outcome.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "failed": {
        const failedJob = await failRunningJob(ctx, {
          jobId: outcome.jobId,
          expectedKind: "chat",
          completedAt: now,
          errorMessage: outcome.errorMessage,
          estimatedInputTokens: outcome.usage?.inputTokens,
          estimatedOutputTokens: outcome.usage?.outputTokens,
          estimatedCostUsd: outcome.usage?.costUsd,
        });
        if (!failedJob) {
          applied = false;
          return applied;
        }
        if (message) {
          const streamedContent = `${streamSnapshot?.content ?? message.content}${outcome.finalDelta ?? ""}`;
          // Lint the *streamed* content (not the error fallback). A
          // failed reply that produced partial prose before throwing
          // should still surface unverified-claim highlights so the
          // user can read what they got with appropriate skepticism.
          const unverifiedClaims = lintSandboxClaims(message, streamedContent);
          const reasoning = deriveMessageReasoning(streamSnapshot?.stream ?? null, now);
          await ctx.db.patch(message._id, {
            status: "failed",
            errorMessage: outcome.errorMessage,
            content: streamedContent || outcome.errorMessage,
            toolCalls: persistedToolCalls,
            unverifiedClaims,
            reasoning: reasoning.reasoning,
            reasoningDurationMs: reasoning.reasoningDurationMs,
            // Partial cost is real spend; persist it so the failed
            // bubble can show "Failed at $0.04 (800 tokens)" and the
            // daily cap can settle accurately. Falling back to existing
            // values handles the "failure fired before any usage was
            // reported" case.
            estimatedInputTokens: outcome.usage?.inputTokens ?? message.estimatedInputTokens,
            estimatedOutputTokens: outcome.usage?.outputTokens ?? message.estimatedOutputTokens,
            estimatedCachedInputTokens: outcome.usage?.cachedInputTokens ?? message.estimatedCachedInputTokens,
            estimatedReasoningTokens: outcome.usage?.reasoningTokens ?? message.estimatedReasoningTokens,
            estimatedCostUsd: outcome.usage?.costUsd ?? message.estimatedCostUsd,
          });
        } else {
          logWarn("chat", "fail_assistant_message_missing", {
            assistantMessageId: outcome.assistantMessageId,
            jobId: outcome.jobId,
          });
        }
        break;
      }
      case "cancelled": {
        const cancelledJob = await cancelActiveJob(ctx, {
          jobId: outcome.jobId,
          expectedKind: "chat",
          completedAt: now,
          errorMessage: outcome.reason,
          estimatedInputTokens: outcome.usage?.inputTokens,
          estimatedOutputTokens: outcome.usage?.outputTokens,
          estimatedCostUsd: outcome.usage?.costUsd,
        });
        if (!cancelledJob) {
          const job = await ctx.db.get(outcome.jobId);
          if (job) {
            // Job exists in a different terminal state (completed /
            // failed). Leave it alone — re-patching the message would
            // overwrite that path's bubble copy.
            applied = false;
            return applied;
          }
          logWarn("chat", "cancel_job_missing", {
            assistantMessageId: outcome.assistantMessageId,
            jobId: outcome.jobId,
          });
        }
        if (message) {
          const streamedContent = `${streamSnapshot?.content ?? message.content}${outcome.finalDelta ?? ""}`;
          // Same partial-lint rationale as the fail path: a cancelled
          // reply that produced prose before the user clicked Stop
          // benefits from the same unverified-claim highlights the
          // completed bubble would show.
          const unverifiedClaims = lintSandboxClaims(message, streamedContent);
          const reasoning = deriveMessageReasoning(streamSnapshot?.stream ?? null, now);
          await ctx.db.patch(message._id, {
            status: "cancelled",
            errorMessage: outcome.reason,
            // Empty partial replies render as the cancellation reason
            // so the bubble never shows blank.
            content: streamedContent || outcome.reason,
            toolCalls: persistedToolCalls,
            unverifiedClaims,
            reasoning: reasoning.reasoning,
            reasoningDurationMs: reasoning.reasoningDurationMs,
            estimatedInputTokens: outcome.usage?.inputTokens ?? message.estimatedInputTokens,
            estimatedOutputTokens: outcome.usage?.outputTokens ?? message.estimatedOutputTokens,
            estimatedCachedInputTokens: outcome.usage?.cachedInputTokens ?? message.estimatedCachedInputTokens,
            estimatedReasoningTokens: outcome.usage?.reasoningTokens ?? message.estimatedReasoningTokens,
            estimatedCostUsd: outcome.usage?.costUsd ?? message.estimatedCostUsd,
          });
        } else {
          logWarn("chat", "cancel_assistant_message_missing", {
            assistantMessageId: outcome.assistantMessageId,
            jobId: outcome.jobId,
          });
        }
        break;
      }
      case "stale": {
        if (message) {
          // Lint only the *streamed* portion (not the system error
          // message). When the action stalled before producing
          // anything, the snapshot content is empty and the lint
          // returns `undefined` so the bubble shows just the stall
          // message without highlights.
          const unverifiedClaims = lintSandboxClaims(message, streamSnapshot?.content ?? "");
          const reasoning = deriveMessageReasoning(streamSnapshot?.stream ?? null, now);
          await ctx.db.patch(message._id, {
            status: "failed",
            errorMessage: outcome.errorMessage,
            content: streamSnapshot?.content || outcome.errorMessage,
            toolCalls: persistedToolCalls,
            unverifiedClaims,
            reasoning: reasoning.reasoning,
            reasoningDurationMs: reasoning.reasoningDurationMs,
          });
        }
        // Stale-recovery deliberately does NOT settle cost against the
        // daily cap. The action that stalled never reached the
        // finalize / fail mutation, so we have no reliable usage data
        // — recording an arbitrary fixed cost would either double-
        // count (if the action actually completed and the settlement
        // landed before the crash) or under-count (if it stalled mid-
        // stream after burning many tokens). Logged so ops can
        // correlate billing reconciliation findings with stale-recovery
        // events.
        if (message && message.groundSandbox === true) {
          logWarn("chat", "sandbox_cost_settlement_skipped_on_stale_recovery", {
            jobId: outcome.jobId,
            assistantMessageId: message._id,
            ownerTokenIdentifier: message.ownerTokenIdentifier,
            hint: "Action never reported usage; daily cap not charged for this stalled reply.",
          });
        }
        const failedJob = await failStaleActiveJob(ctx, {
          jobId: outcome.jobId,
          expectedKind: "chat",
          now,
          errorMessage: outcome.errorMessage,
        });
        if (!failedJob) {
          applied = false;
          return applied;
        }
        break;
      }
    }

    // Settle the cost AFTER the message + job patches commit their
    // statuses. Doing it last means a hypothetical settle failure
    // never blocks the message's terminal-state write, which is the
    // user-visible part of finalize. Stale recovery skips this
    // entirely (see the per-kind comment above). Settle is a no-op for
    // non-sandbox replies and for `costUsd === undefined`.
    if (outcome.kind !== "stale") {
      const usage = usageForChatRollup(outcome, message);
      await settleChatReplyUsage(ctx, {
        jobId: outcome.jobId,
        assistantMessage: message,
        occurredAtMs: now,
        usage,
      });
      await recordSandboxSessionActivityForReply(ctx, {
        assistantMessage: message,
        costUsd: usage?.costUsd,
      });
    }

    return applied;
  } finally {
    if (stream) {
      await deleteMessageStreamState(ctx, stream._id);
    }
    // Tool-call events were already drained by
    // `foldAndDrainToolCallEvents` (sweep-past-cap), so no separate
    // cleanup is needed here.
  }
}

export const getActiveMessageStream = query({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await loadActiveOwnedThread(ctx, args.threadId);
    if (!thread) {
      return null;
    }

    if (thread.repositoryId) {
      const { doc: repository } = await loadOwnedDoc(ctx, thread.repositoryId);
      if (!repository) {
        return null;
      }
    }

    const stream = await getMessageStreamByThread(ctx, args.threadId);
    if (!stream) {
      return null;
    }

    const assistantMessage = await ctx.db.get(stream.assistantMessageId);
    if (!assistantMessage || assistantMessage.status !== "streaming") {
      return null;
    }

    const tailChunks = await loadAllStreamTailChunks(ctx, stream);

    return {
      assistantMessageId: stream.assistantMessageId,
      content: `${stream.compactedContent}${tailChunks.map((chunk) => chunk.text).join("")}`,
      // Reasoning trace for extended-thinking models. `null` (rather than
      // `undefined`) on the wire so the frontend's discriminated union
      // can pattern-match on `reasoning === null` without nullish
      // gymnastics. The same convention applies to the two timestamps.
      reasoning: stream.liveReasoning ?? null,
      reasoningStartedAt: stream.reasoningStartedAt ?? null,
      reasoningEndedAt: stream.reasoningEndedAt ?? null,
      startedAt: stream.startedAt,
      lastAppendedAt: stream.lastAppendedAt,
    };
  },
});

/**
 * Subscribable view of the running tool-call trace for a single
 * assistant message.
 *
 * Returns one entry per `toolCallId` (folded from the ephemeral
 * `messageToolCallEvents` table) plus an explicit `state` field so the UI
 * can render running / completed / errored without re-deriving the state
 * machine from `endedAt === startedAt`-style heuristics.
 *
 * Auth: must be the message's owner. Returns `null` for unauthenticated
 * viewers and unknown messages so the frontend can call this at thread-load
 * time without crashing on partial / racing snapshots.
 *
 * Lifecycle: the events table is drained at finalize / fail / stale
 * recovery in the same transaction that flips the message status, so
 * the query naturally returns `[]` for completed messages — the frontend
 * reads `messages.toolCalls` instead. This avoids the half-state where a
 * stale subscription would briefly paint "running" after the message is
 * already `completed`.
 */
export const getMessageToolCallEvents = query({
  args: {
    assistantMessageId: v.id("messages"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<ToolCallTraceEntry & { state: "running" | "completed" | "errored" }> | null> => {
    const { doc: message } = await loadOwnedDoc(ctx, args.assistantMessageId);
    if (!message) {
      return null;
    }

    const events = await loadAllToolCallEventsByMessage(ctx, args.assistantMessageId);
    if (events.length === 0) {
      return [];
    }

    const folded = foldToolCallEvents(events);
    return folded.map((entry) => {
      // We pair start↔end by toolCallId; an entry whose `endedAt` exceeds
      // `startedAt` (or whose `errorCode` is set) has seen its `end` event.
      // Anything else is still in flight.
      const hasEnded = entry.endedAt > entry.startedAt || entry.errorCode !== undefined;
      const state: "running" | "completed" | "errored" = entry.errorCode
        ? "errored"
        : hasEnded
          ? "completed"
          : "running";
      return { ...entry, state };
    });
  },
});

export const markAssistantReplyRunning = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
  },
  returns: startedResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const runningJob = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "chat",
      stage: "generating_reply",
      progress: 0.15,
      startedAt: now,
      leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
    });
    if (!runningJob) {
      return { started: false as const };
    }

    await ctx.db.patch(args.assistantMessageId, {
      status: "streaming",
    });
    return { started: true as const };
  },
});

export const updateAssistantReplyProgress = internalMutation({
  args: {
    jobId: v.id("jobs"),
    stage: v.string(),
    progress: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    const leaseExpiresAt = Date.now() + CHAT_JOB_LEASE_MS;
    await updateRunningJobProgress(ctx, {
      jobId: args.jobId,
      expectedKind: "chat",
      stage: args.stage,
      progress: args.progress,
    });
    await refreshRunningJobLease(ctx, {
      jobId: args.jobId,
      expectedKind: "chat",
      leaseExpiresAt,
    });
    return null;
  },
});

export const appendAssistantStreamChunk = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    delta: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.delta) {
      return;
    }

    const stream = await getMessageStreamByAssistantMessageId(ctx, args.assistantMessageId);
    if (!stream) {
      logWarn("chat", "assistant_stream_missing_for_chunk_append", {
        assistantMessageId: args.assistantMessageId,
        deltaLength: args.delta.length,
        hint: "messageStreamChunks append skipped before compactMessageStreamTail",
      });
      throw new Error(
        "Missing message stream while appending assistant delta: messageStreamChunks append aborted before compactMessageStreamTail.",
      );
    }

    const now = Date.now();
    await ctx.db.insert("messageStreamChunks", {
      streamId: stream._id,
      sequence: stream.nextSequence,
      text: args.delta,
    });
    await ctx.db.patch(stream._id, {
      nextSequence: stream.nextSequence + 1,
      lastAppendedAt: now,
    });

    // Refresh job lease so long streams don't get marked stale by
    // recoverStaleChatJob mid-flight. We piggy-back the previous
    // `stream.lastAppendedAt` (which is updated in lockstep with the lease in
    // markAssistantReplyRunning and on each successful append) as a free
    // proxy for "when did we last refresh the lease?". If less than half a
    // lease window has passed we skip the write — at the per-flush cadence
    // (~once per STREAM_FLUSH_THRESHOLD chars) this saves one job patch per
    // chunk for the typical sub-minute reply while still guaranteeing the
    // lease is renewed well before it expires on long-running streams.
    const leaseRefreshDeadline = now - Math.floor(CHAT_JOB_LEASE_MS / 2);
    if (stream.lastAppendedAt <= leaseRefreshDeadline) {
      await refreshRunningJobLease(ctx, {
        jobId: args.jobId,
        expectedKind: "chat",
        leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
      });
    }

    await compactMessageStreamTail(ctx, stream._id);
  },
});

/**
 * Append a reasoning delta into `messageStreams.liveReasoning`.
 *
 * Mirrors `appendAssistantStreamChunk` but for the model's extended-
 * thinking trace. Reasoning chunks are appended into the stream row's
 * `liveReasoning` column directly rather than a separate chunks table:
 * the trace is bounded (a few KB), the trace renderer doesn't need
 * sequence ordering across multiple writers, and the volume never
 * justifies the per-row overhead of a sibling table.
 *
 * Side-effect: refreshes the chat job lease using the same half-window
 * heuristic `appendAssistantToolCallEvent` applies. Reasoning-heavy
 * replies can spend 5+ minutes thinking before any text or tool event
 * fires; without this refresh a long reasoning trace would let the
 * initial 10-minute lease expire and `recoverStaleChatJob` would mark a
 * healthy in-flight job stale. We adopt the tool-event pattern
 * (`lastAppendedAt` only advances on successful lease refresh) rather
 * than the text-chunk pattern (`lastAppendedAt` always advances) so the
 * marker tracks actual refresh times — a subsequent text flush still
 * sees the correct staleness window and refreshes when needed.
 *
 * Defensive against late events on a stream that has already finalized
 * (the message can race ahead of in-flight `runMutation` calls): a
 * missing stream just logs and returns, mirroring how
 * `appendAssistantToolCallEvent` treats a missing message.
 */
export const appendAssistantReasoningDelta = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    delta: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.delta) {
      return;
    }
    const stream = await getMessageStreamByAssistantMessageId(ctx, args.assistantMessageId);
    if (!stream) {
      logWarn("chat", "reasoning_delta_stream_missing", {
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        deltaLength: args.delta.length,
      });
      return;
    }
    // Bound the accumulated trace before the patch. Each call rewrites the
    // whole `liveReasoning` column, so unbounded growth approaches Convex's
    // 1 MB per-document hard limit and creates quadratic write cost across
    // a long trace. When the cap is exceeded we drop the oldest bytes so the
    // renderer keeps showing the model's most recent thinking — the trace is
    // an auxiliary UI, not a durable transcript.
    const concatenated = `${stream.liveReasoning ?? ""}${args.delta}`;
    const next =
      concatenated.length > MAX_LIVE_REASONING_CHARS
        ? concatenated.slice(concatenated.length - MAX_LIVE_REASONING_CHARS)
        : concatenated;
    if (concatenated.length > MAX_LIVE_REASONING_CHARS) {
      logWarn("chat", "live_reasoning_truncated", {
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        droppedChars: concatenated.length - MAX_LIVE_REASONING_CHARS,
        cap: MAX_LIVE_REASONING_CHARS,
      });
    }
    await ctx.db.patch(stream._id, {
      liveReasoning: next,
    });

    const now = Date.now();
    const leaseRefreshDeadline = now - Math.floor(CHAT_JOB_LEASE_MS / 2);
    if (stream.lastAppendedAt <= leaseRefreshDeadline) {
      const refreshedJob = await refreshRunningJobLease(ctx, {
        jobId: args.jobId,
        expectedKind: "chat",
        leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
      });
      if (refreshedJob) {
        await ctx.db.patch(stream._id, {
          lastAppendedAt: now,
        });
      }
    }
  },
});

/**
 * Stamp the wall-clock start of the reasoning phase. Idempotent — a
 * second `reasoning-start` event on the same reply keeps the original
 * timestamp so the eventual "Thought for N seconds" label reflects
 * total reasoning time across all steps. Defensive against a missing
 * stream row, same shape as `appendAssistantReasoningDelta`.
 */
export const markReasoningStarted = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    occurredAt: v.number(),
  },
  handler: async (ctx, args) => {
    const stream = await getMessageStreamByAssistantMessageId(ctx, args.assistantMessageId);
    if (!stream) {
      logWarn("chat", "reasoning_start_stream_missing", {
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
      });
      return;
    }
    if (stream.reasoningStartedAt !== undefined) {
      return;
    }
    await ctx.db.patch(stream._id, {
      reasoningStartedAt: args.occurredAt,
    });
  },
});

/**
 * Stamp the wall-clock end of the reasoning phase. Overwrites any
 * previous value so the duration computed at finalize matches the
 * most recent `reasoning-end` — important when the SDK emits multiple
 * reasoning blocks per reply (each ends individually).
 */
export const markReasoningEnded = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    occurredAt: v.number(),
  },
  handler: async (ctx, args) => {
    const stream = await getMessageStreamByAssistantMessageId(ctx, args.assistantMessageId);
    if (!stream) {
      logWarn("chat", "reasoning_end_stream_missing", {
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
      });
      return;
    }
    await ctx.db.patch(stream._id, {
      reasoningEndedAt: args.occurredAt,
    });
  },
});

/**
 * Append one `start` or `end` row to `messageToolCallEvents`.
 *
 * Called from the AI SDK `fullStream` loop in `generation.ts` once per
 * `tool-call` (start) and once per `tool-result` / `tool-error` (end).
 * Each row carries:
 *
 *   - `toolCallId` — the AI SDK's correlation key. Folding pairs `start` to
 *     `end` by this id, so two `read_file` calls in one reply stay distinct.
 *   - `sequence` — per-message dense monotonic counter. Allocated here via
 *     a single descending-index lookup so the action never has to read or
 *     forward sequence state across mutations.
 *   - `inputSummary` / `outputSummary` — caller is responsible for redaction
 *     (see `convex/chat/redaction.ts` and the `generation.ts` callers).
 *     This mutation additionally character-caps both at
 *     `TOOL_CALL_EVENT_SUMMARY_MAX_CHARS` so a runaway tool result can't
 *     blow out either the events row or the eventual `messages.toolCalls`
 *     fold.
 *   - `occurredAt` — wall-clock at the time the AI SDK surfaced the event.
 *     We pass it from the action rather than reading `Date.now()` inside
 *     the mutation so the trace's `endedAt - startedAt` reflects actual
 *     tool latency, not the (possibly bursty) mutation-dispatch latency.
 *
 * Side-effect: refreshes the chat job lease via the same half-window
 * heuristic `appendAssistantStreamChunk` uses. Tool calls can be slow (a
 * 15s file download from a cold sandbox), and the model often sends no
 * text deltas between the tool call and its result — without this refresh
 * `recoverStaleChatJob` could incorrectly mark a healthy long-running tool
 * step as stale.
 */
export const appendAssistantToolCallEvent = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    toolCallId: v.string(),
    type: v.union(v.literal("start"), v.literal("end")),
    toolName: v.string(),
    inputSummary: v.string(),
    outputSummary: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    occurredAt: v.number(),
  },
  handler: async (ctx, args) => {
    // The assistant message can disappear under us mid-stream (concurrent
    // thread / repo deletion). Skip the event so the cleanup path can
    // proceed; the action's outer catch will fail the reply normally.
    const message = await ctx.db.get(args.assistantMessageId);
    if (!message) {
      logWarn("chat", "tool_event_append_message_missing", {
        assistantMessageId: args.assistantMessageId,
        toolName: args.toolName,
        type: args.type,
      });
      return;
    }

    const sequence = await nextToolCallEventSequence(ctx, args.assistantMessageId);

    await ctx.db.insert("messageToolCallEvents", {
      messageId: args.assistantMessageId,
      toolCallId: args.toolCallId,
      sequence,
      type: args.type,
      toolName: args.toolName,
      inputSummary: capSummary(args.inputSummary),
      outputSummary: args.outputSummary === undefined ? undefined : capSummary(args.outputSummary),
      errorCode: args.errorCode,
      occurredAt: args.occurredAt,
    });

    // Lease refresh, mirroring `appendAssistantStreamChunk`. We bump
    // `messageStreams.lastAppendedAt` alongside the lease so the half-window
    // heuristic stays consistent across both event types — without that,
    // a tool-call burst followed immediately by stream chunks could refresh
    // the lease twice in the same window.
    const stream = await getMessageStreamByAssistantMessageId(ctx, args.assistantMessageId);
    if (stream) {
      const now = Date.now();
      const leaseRefreshDeadline = now - Math.floor(CHAT_JOB_LEASE_MS / 2);
      if (stream.lastAppendedAt <= leaseRefreshDeadline) {
        const refreshedJob = await refreshRunningJobLease(ctx, {
          jobId: args.jobId,
          expectedKind: "chat",
          leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
        });
        if (refreshedJob) {
          await ctx.db.patch(stream._id, {
            lastAppendedAt: now,
          });
        }
      }
    }
  },
});

export const finalizeAssistantReply = internalMutation({
  args: {
    threadId: v.id("threads"),
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    finalDelta: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    /**
     * Cache + reasoning slices of the normalized usage produced by the
     * gateway. Persisted on `messages.estimatedCachedInputTokens /
     * estimatedReasoningTokens` so the per-user cost rollup can
     * attribute cache savings and reasoning spend independently of the
     * core input/output totals. Optional because not every model emits
     * the slices; the rollup treats absence as zero.
     */
    cachedInputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    /**
     * Citation map: numbered `[A#] → artifactId` entries for the artifacts
     * that ended up in the prompt. Optional so non-library replies keep
     * the field unset rather than written as an empty array — the frontend
     * treats both as "no resolvable citations".
     */
    citationMap: v.optional(
      v.array(
        v.object({
          index: v.number(),
          artifactId: v.id("artifacts"),
          artifactTitle: v.optional(v.string()),
          artifactKind: v.optional(artifactKindValidator),
          artifactVersion: v.optional(v.number()),
          chunkId: v.optional(v.id("artifactChunks")),
          headingPath: v.optional(v.array(v.string())),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await applyTerminalSettlement(ctx, {
      kind: "completed",
      threadId: args.threadId,
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
      finalDelta: args.finalDelta,
      usage: {
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        cachedInputTokens: args.cachedInputTokens,
        reasoningTokens: args.reasoningTokens,
        costUsd: args.costUsd,
      },
      citationMap: args.citationMap,
    });
  },
});

export const failAssistantReply = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
    finalDelta: v.optional(v.string()),
    /**
     * Partial cost (USD) accrued before the failure. Optional because
     * pre-stream failures (where no cost has been incurred) leave it
     * unset; the settle helper treats `undefined` as "no cost recorded"
     * and skips the cap consumption.
     */
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await applyTerminalSettlement(ctx, {
      kind: "failed",
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
      errorMessage: args.errorMessage,
      finalDelta: args.finalDelta,
      usage: {
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        cachedInputTokens: args.cachedInputTokens,
        reasoningTokens: args.reasoningTokens,
        costUsd: args.costUsd,
      },
    });
  },
});

/**
 * Minimal, hot-path query the generation action polls to discover
 * whether the user has requested cancellation of the in-flight reply.
 *
 * Kept as a tiny `internalQuery` (a single `ctx.db.get` and three field reads)
 * rather than reusing a fatter `getJob` query because it runs every
 * `CANCELLATION_POLL_INTERVAL_MS` while the LLM streams — a typical 30 s
 * sandbox-mode reply will issue ~30 of these. Returning `{ cancelled,
 * jobMissing }` instead of the full job document keeps the payload tiny
 * (parsing / serialization across the action ↔ query boundary stays
 * negligible) and discourages callers from peeking at unrelated job state on
 * the cancel hot path.
 *
 * `jobMissing` is exposed (rather than treated as a silent `cancelled = true`)
 * so the action can distinguish "user explicitly cancelled" — which means
 * `cancelInFlightReply` already wrote the `cancelled` status to the assistant
 * message and the action just needs to bow out — from "job row was deleted by
 * a concurrent thread / repo cascade", which the action wants to surface as
 * a normal failure (so finalize / fail still runs and the lease is released).
 */
export const getJobCancellationStatus = internalQuery({
  args: {
    jobId: v.id("jobs"),
  },
  returns: jobCancellationStatusValidator,
  handler: async (ctx, args): Promise<{ cancelled: boolean; jobMissing: boolean }> => {
    const job = await ctx.db.get(args.jobId);
    if (!job) {
      return { cancelled: false, jobMissing: true };
    }
    return {
      cancelled: job.status === "cancelled",
      jobMissing: false,
    };
  },
});

/**
 * Terminal-state mutation invoked when the action confirms the owner
 * cancelled the reply mid-stream.
 *
 * Mirrors `failAssistantReply` in shape (preserves partial content, drains
 * the tool-call event log, releases the job lease) but uses the dedicated
 * `cancelled` status on both the message and the job so the UI / audit log
 * can distinguish user-initiated stops from upstream errors.
 *
 * Idempotent against `cancelInFlightReply`: that mutation already flips the
 * message + job statuses to `cancelled` synchronously when the user clicks
 * Stop, so by the time the action reaches this mutation the rows are
 * typically already in the terminal state. We re-`patch` regardless because:
 *
 *   - the action is the only writer that knows the final partial content
 *     (any text the model produced before the abort fired);
 *   - the action is the only writer that can drain the events table in the
 *     same transaction the message flips to terminal state, which is the
 *     contract `getMessageToolCallEvents` relies on (events visible iff
 *     message is still streaming);
 *   - the lease must be cleared (`leaseExpiresAt: undefined`) so
 *     `recoverStaleChatJob` does not later try to "rescue" a row that
 *     already reached its terminal state.
 *
 * Why we preserve `finalDelta` instead of dropping it: the model's last
 * partial sentence is often the most useful part of a slow reply, and the
 * user clicked Stop *because* they had enough context. Discarding it would
 * be a usability regression vs. the `failed` path (which already keeps
 * partial content for the same reason).
 */
export const markAssistantReplyCancelled = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    finalDelta: v.optional(v.string()),
    /**
     * Human-readable cancellation reason surfaced as `messages.errorMessage`.
     * Defaults to "Cancelled by user." but the action passes a more specific
     * reason when the cancellation was triggered by a system path (e.g. a
     * future budget enforcement) so the UI can render the right copy.
     */
    reason: v.optional(v.string()),
    /**
     * Partial cost accrued before the user clicked Stop. Same shape as
     * the failure path: cost has already been incurred upstream, so we
     * settle it against the daily cap. Optional so stops fired before
     * any token was generated leave the field unset — the settle helper
     * treats that as "no cost".
     */
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const applied = await applyTerminalSettlement(ctx, {
      kind: "cancelled",
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
      reason: args.reason ?? "Cancelled by user.",
      finalDelta: args.finalDelta,
      usage: {
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        cachedInputTokens: args.cachedInputTokens,
        reasoningTokens: args.reasoningTokens,
        costUsd: args.costUsd,
      },
    });

    // Only log the success event when the cancellation actually applied
    // (i.e. the job was active or missing — see the helper's contract
    // notes). A no-op against an already-terminal job is not a real
    // cancellation event and would clutter the audit trail.
    if (applied) {
      logInfo("chat", "assistant_reply_cancelled", {
        assistantMessageId: args.assistantMessageId,
        jobId: args.jobId,
        hadPartialContent: Boolean(args.finalDelta && args.finalDelta.length > 0),
      });
    }
  },
});

export const recoverStaleChatJob = internalMutation({
  args: {
    jobId: v.id("jobs"),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = await ctx.db.get(args.jobId);
    // Eligibility pre-check stays at the call site so we skip every
    // read (message lookup, fold/drain, stream load) when the job is
    // not actually stale. `failStaleActiveJob` inside the shared
    // settlement re-checks the lease as a second-level guard.
    if (!isJobStaleAndRecoverable(job, now, { expectedKind: "chat" })) {
      return;
    }

    await applyTerminalSettlement(ctx, {
      kind: "stale",
      jobId: args.jobId,
      errorMessage: args.errorMessage ?? STALE_CHAT_JOB_ERROR_MESSAGE,
    });
  },
});
