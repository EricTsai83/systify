import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, internalMutation, internalQuery, query } from "../_generated/server";
import { loadOwnedDoc, requireOwnedDoc } from "../lib/ownedDocs";
import { CHAT_JOB_LEASE_MS, consumeSandboxDailyCost } from "../lib/rateLimit";
import { costUsdToCents } from "../lib/openaiPricing";
import { logInfo, logWarn } from "../lib/observability";
import { MAX_TOOL_CALL_EVENTS_PER_MESSAGE, TOOL_CALL_EVENT_SUMMARY_MAX_CHARS } from "../lib/constants";
import {
  cancelActiveJob,
  completeRunningJob,
  failRunningJob,
  failStaleActiveJob,
  markQueuedJobRunning,
  refreshRunningJobLease,
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

const STALE_CHAT_JOB_ERROR_MESSAGE = "The assistant reply stalled and was automatically marked as failed.";

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
 * Settle the actual reply cost against the per-user and (when applicable)
 * per-repository daily caps.
 *
 * Called from every terminal-state path:
 *   - `finalizeAssistantReply` (success)
 *   - `failAssistantReply` (upstream error / mid-stream failure)
 *   - `markAssistantReplyCancelled` (user-initiated stop)
 *   - `recoverStaleChatJob` (lease expired)
 *
 * Settling on every path matters because partial replies still incur
 * cost from OpenAI — a sandbox reply that was cancelled after 30s of
 * tool calls produced real spend that must count against the cap.
 * Skipping settlement on cancellation/failure would let users repeatedly
 * hit Stop just before finalize and bypass the cap.
 *
 * Idempotent on `cents <= 0` so the call site can pass through whatever
 * `estimateCostUsd` produced (including `undefined`) without checking
 * it first.
 */
async function settleSandboxReplyCost(
  ctx: MutationCtx,
  args: {
    jobId: Id<"jobs">;
    assistantMessage: Doc<"messages"> | null;
    costUsd: number | undefined;
  },
): Promise<void> {
  // Only sandbox-grounded replies bill against the daily cap. The check on
  // `assistantMessage.groundSandbox` is the source of truth — using the job's
  // `costCategory` would also work today (sandbox ↔ system_design), but
  // the message-level groundSandbox flag keeps this code resilient if the
  // costCategory mapping ever changes.
  if (!args.assistantMessage || args.assistantMessage.groundSandbox !== true) {
    return;
  }
  const cents = costUsdToCents(args.costUsd);
  if (cents === undefined || cents <= 0) {
    // Heuristic-only replies (no OPENAI_API_KEY) and pricing-table
    // misses arrive here. We deliberately do not settle in those cases:
    //   - heuristic replies are free (no LLM call)
    //   - pricing-miss replies have unknowable cost; double-counting
    //     them as "free" is the conservative direction (better than
    //     guessing a number and starving the user's quota by accident)
    return;
  }

  // Look up the repository from the thread (the message stores threadId,
  // not repositoryId). Concurrent thread deletion makes this a defensive
  // fetch — if the thread is gone, we still want the per-user settlement
  // to land, so a missing thread degrades to "user-only settlement" rather
  // than blocking the cost recording entirely.
  const thread = await ctx.db.get(args.assistantMessage.threadId);
  const repositoryId = thread?.repositoryId ?? null;

  await consumeSandboxDailyCost(ctx, {
    ownerTokenIdentifier: args.assistantMessage.ownerTokenIdentifier,
    repositoryId,
    cents,
  });

  logInfo("chat", "sandbox_cost_settled", {
    jobId: args.jobId,
    assistantMessageId: args.assistantMessage._id,
    ownerTokenIdentifier: args.assistantMessage.ownerTokenIdentifier,
    repositoryId,
    cents,
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

export const getActiveMessageStream = query({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const { doc: thread } = await requireOwnedDoc(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });

    if (thread.repositoryId) {
      await requireOwnedDoc(ctx, thread.repositoryId, {
        notFoundMessage: "Thread not found.",
      });
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
    const next = `${stream.liveReasoning ?? ""}${args.delta}`;
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
          chunkId: v.optional(v.id("artifactChunks")),
          headingPath: v.optional(v.array(v.string())),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const message = await ctx.db.get(args.assistantMessageId);
    const streamSnapshot = await loadMessageStreamSnapshot(ctx, args.assistantMessageId);

    // Fold the ephemeral tool-call event log into the durable
    // `messages.toolCalls` field, then drain the events. Doing both inside
    // the same transaction means the frontend never sees a half-state where
    // events still exist but the message is already `completed`; the
    // `getMessageToolCallEvents` subscription either returns the running
    // trace (pre-finalize) or the empty list (post-finalize, with
    // `messages.toolCalls` taking over). The helper also drains beyond the
    // fold's read cap so a runaway producer doesn't leave orphan rows.
    const persistedToolCalls = await foldAndDrainToolCallEvents(ctx, args.assistantMessageId, {
      jobId: args.jobId,
      mutation: "finalizeAssistantReply",
    });

    try {
      if (message) {
        const completedJob = await completeRunningJob(ctx, {
          jobId: args.jobId,
          expectedKind: "chat",
          completedAt: now,
          outputSummary: "Assistant reply generated.",
          estimatedInputTokens: args.inputTokens,
          estimatedOutputTokens: args.outputTokens,
          estimatedCostUsd: args.costUsd,
        });
        if (!completedJob) {
          return;
        }

        const finalContent = `${streamSnapshot?.content ?? message.content}${args.finalDelta}`;
        // Citation lint runs against the finalized content *before* the
        // patch so `messages.unverifiedClaims` is committed in the same
        // transaction that flips status to `completed`. The chat bubble
        // derives "is this reply linted?" from the message status (it
        // only renders highlights for terminal states), so a
        // transactional write means a refresh-after-finalize never sees
        // the message as completed-but-unlinted. Sandbox-only via
        // `lintSandboxClaims`; discuss / library return `undefined` and
        // the optional schema field stays unset.
        const unverifiedClaims = lintSandboxClaims(message, finalContent);
        const reasoning = deriveMessageReasoning(streamSnapshot?.stream ?? null, now);
        await ctx.db.patch(args.assistantMessageId, {
          content: finalContent,
          status: "completed",
          errorMessage: undefined,
          estimatedInputTokens: args.inputTokens,
          estimatedOutputTokens: args.outputTokens,
          // Persist the per-message cost so the chat bubble's cost
          // ticker can render an exact value rather than re-deriving it
          // from tokens + model on every render. Stays `undefined` when
          // usage was unavailable or the model wasn't priced (the ticker
          // degrades gracefully to "—" in that case).
          estimatedCostUsd: args.costUsd,
          citationMap: args.citationMap,
          toolCalls: persistedToolCalls,
          unverifiedClaims,
          reasoning: reasoning.reasoning,
          reasoningDurationMs: reasoning.reasoningDurationMs,
        });
        // The thread may have been deleted while we were streaming. Patching a
        // missing doc throws and would roll back the whole mutation (so the
        // job lease and persisted stream state would never be cleared). Wrap
        // it so the rest of the cleanup still runs.
        try {
          await ctx.db.patch(args.threadId, {
            lastAssistantMessageAt: now,
            lastMessageAt: now,
          });
        } catch (error) {
          logWarn("chat", "finalize_thread_patch_failed", {
            threadId: args.threadId,
            jobId: args.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        logWarn("chat", "finalize_assistant_message_missing", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
        });
      }

      // If the assistant message is gone we can't deliver the reply, so mark
      // the still-running job as failed. Terminal jobs are left untouched.
      if (!message) {
        await failRunningJob(ctx, {
          jobId: args.jobId,
          expectedKind: "chat",
          completedAt: now,
          errorMessage: "Assistant message was deleted before the reply could be persisted.",
        });
      }

      // Settle the cost AFTER the message + job patches commit their
      // statuses. Doing it last means a hypothetical settle failure
      // never blocks the message's terminal-state write, which is the
      // user-visible part of finalize. Settle is a no-op for non-sandbox
      // replies, so this is also free for discuss / library.
      await settleSandboxReplyCost(ctx, {
        jobId: args.jobId,
        assistantMessage: message ?? null,
        costUsd: args.costUsd,
      });
      await recordSandboxSessionActivityForReply(ctx, {
        assistantMessage: message ?? null,
        costUsd: args.costUsd,
      });
    } finally {
      // Always remove persisted stream state on completion. Note: Convex
      // mutations are transactional, so if any write above throws the
      // transaction rolls back and this cleanup is reverted along with the
      // rest of the writes (recoverStaleChatJob will retry from the lease).
      // Keeping the cleanup in `finally` documents the intent and protects
      // against future refactors that wrap individual writes in try/catch.
      if (streamSnapshot) {
        await deleteMessageStreamState(ctx, streamSnapshot.stream._id);
      }
      // Tool-call events are already drained by `foldAndDrainToolCallEvents`
      // above (which sweeps past the fold's read cap), so there's no
      // separate cleanup to do here.
    }
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
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const streamSnapshot = await loadMessageStreamSnapshot(ctx, args.assistantMessageId);
    const message = await ctx.db.get(args.assistantMessageId);

    // Surface partial tool-call traces on failures so the user can
    // see which tool the reply was running when it died. Unfinished entries
    // (only `start` events) fold to `endedAt === startedAt` and the trace
    // UI renders them as "interrupted". The helper also drains beyond the
    // fold's read cap so failure paths can't leak orphan events.
    const persistedToolCalls = await foldAndDrainToolCallEvents(ctx, args.assistantMessageId, {
      jobId: args.jobId,
      mutation: "failAssistantReply",
    });

    try {
      const failedJob = await failRunningJob(ctx, {
        jobId: args.jobId,
        expectedKind: "chat",
        completedAt: now,
        errorMessage: args.errorMessage,
        estimatedInputTokens: args.inputTokens,
        estimatedOutputTokens: args.outputTokens,
        estimatedCostUsd: args.costUsd,
      });
      if (!failedJob) {
        return;
      }

      if (message) {
        const streamedContent = `${streamSnapshot?.content ?? message.content}${args.finalDelta ?? ""}`;
        // Lint the *streamed* content (not the error fallback).
        // A failed reply that produced 200 tokens of partial prose
        // before throwing should still surface unverified-claim
        // highlights so the user can read the partial answer with
        // appropriate skepticism. When the stream produced nothing,
        // `streamedContent` is empty and `lintSandboxClaims` returns
        // `undefined`, so the bubble just shows the error message
        // without any highlights — the right behavior, since the
        // error message is system text and never contains model
        // claims to flag.
        const unverifiedClaims = lintSandboxClaims(message, streamedContent);
        const reasoning = deriveMessageReasoning(streamSnapshot?.stream ?? null, now);
        await ctx.db.patch(args.assistantMessageId, {
          status: "failed",
          errorMessage: args.errorMessage,
          content: streamedContent || args.errorMessage,
          toolCalls: persistedToolCalls,
          unverifiedClaims,
          reasoning: reasoning.reasoning,
          reasoningDurationMs: reasoning.reasoningDurationMs,
          // Partial cost is still real spend; persist it so the failed
          // bubble can show "Failed at $0.04 (800 tokens)" in the cost
          // ticker, and the daily cap can settle accurately.
          estimatedInputTokens: args.inputTokens ?? message.estimatedInputTokens,
          estimatedOutputTokens: args.outputTokens ?? message.estimatedOutputTokens,
          estimatedCostUsd: args.costUsd ?? message.estimatedCostUsd,
        });
      } else {
        logWarn("chat", "fail_assistant_message_missing", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
        });
      }

      // Even on failure, the cost has been incurred upstream (OpenAI
      // charges for streamed tokens regardless of whether the stream
      // completed). Settling on this path prevents users from bypassing
      // the daily cap by repeatedly triggering errors.
      await settleSandboxReplyCost(ctx, {
        jobId: args.jobId,
        assistantMessage: message ?? null,
        costUsd: args.costUsd,
      });
      await recordSandboxSessionActivityForReply(ctx, {
        assistantMessage: message ?? null,
        costUsd: args.costUsd,
      });
    } finally {
      if (streamSnapshot) {
        await deleteMessageStreamState(ctx, streamSnapshot.stream._id);
      }
      // Tool-call events are already drained by `foldAndDrainToolCallEvents`
      // above (sweep-past-cap), so there's no separate cleanup to do here.
    }
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
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const reason = args.reason ?? "Cancelled by user.";
    const streamSnapshot = await loadMessageStreamSnapshot(ctx, args.assistantMessageId);
    const message = await ctx.db.get(args.assistantMessageId);

    // Drain in the same transaction the message flips to terminal state —
    // same lifecycle invariant `failAssistantReply` enforces, see the
    // comment on `foldAndDrainToolCallEvents`. Without this, the live
    // `getMessageToolCallEvents` subscription could briefly paint
    // "running" after the user already saw "Cancelled" in the bubble.
    const persistedToolCalls = await foldAndDrainToolCallEvents(ctx, args.assistantMessageId, {
      jobId: args.jobId,
      mutation: "markAssistantReplyCancelled",
    });

    try {
      const cancelledJob = await cancelActiveJob(ctx, {
        jobId: args.jobId,
        expectedKind: "chat",
        completedAt: now,
        errorMessage: reason,
        estimatedInputTokens: args.inputTokens,
        estimatedOutputTokens: args.outputTokens,
        estimatedCostUsd: args.costUsd,
      });
      if (!cancelledJob) {
        const job = await ctx.db.get(args.jobId);
        if (job) {
          return;
        }
        logWarn("chat", "cancel_job_missing", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
        });
      }

      if (message) {
        const streamedContent = `${streamSnapshot?.content ?? message.content}${args.finalDelta ?? ""}`;
        // Same rationale as the fail path: a cancelled reply that
        // produced partial prose before the user clicked Stop benefits
        // from the same unverified-claim highlights so the user can scan
        // what they got with the same skepticism the completed-state
        // bubble would offer. Empty `streamedContent` (stop arrived
        // before any token was streamed) returns `undefined` so the
        // bubble just shows the cancellation reason.
        const unverifiedClaims = lintSandboxClaims(message, streamedContent);
        const reasoning = deriveMessageReasoning(streamSnapshot?.stream ?? null, now);
        await ctx.db.patch(args.assistantMessageId, {
          status: "cancelled",
          errorMessage: reason,
          // Empty partial replies render as the cancellation reason so the
          // bubble never shows blank — `failAssistantReply` uses the same
          // fallback for the same reason.
          content: streamedContent || reason,
          toolCalls: persistedToolCalls,
          unverifiedClaims,
          reasoning: reasoning.reasoning,
          reasoningDurationMs: reasoning.reasoningDurationMs,
          // Preserve partial-cost telemetry on cancellation for both
          // UI display and audit. Falling back to the existing values
          // (rather than overwriting with `undefined`) handles the
          // "stop arrived before generation produced any tokens" case
          // where the action passes `costUsd: undefined`.
          estimatedInputTokens: args.inputTokens ?? message.estimatedInputTokens,
          estimatedOutputTokens: args.outputTokens ?? message.estimatedOutputTokens,
          estimatedCostUsd: args.costUsd ?? message.estimatedCostUsd,
        });
      } else {
        logWarn("chat", "cancel_assistant_message_missing", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
        });
      }

      // Settle the partial cost. Cancellation is a common path (user
      // clicked Stop because the reply was taking too long or going off
      // the rails) so charging the actual spend prevents the cap from
      // being a no-op for power users. Settle is a no-op for non-sandbox
      // replies and for `costUsd === undefined`.
      await settleSandboxReplyCost(ctx, {
        jobId: args.jobId,
        assistantMessage: message ?? null,
        costUsd: args.costUsd,
      });
      await recordSandboxSessionActivityForReply(ctx, {
        assistantMessage: message ?? null,
        costUsd: args.costUsd,
      });
    } finally {
      if (streamSnapshot) {
        await deleteMessageStreamState(ctx, streamSnapshot.stream._id);
      }
      // Tool-call events were drained by `foldAndDrainToolCallEvents`
      // above; nothing else to clean up.
    }

    logInfo("chat", "assistant_reply_cancelled", {
      assistantMessageId: args.assistantMessageId,
      jobId: args.jobId,
      hadPartialContent: Boolean(args.finalDelta && args.finalDelta.length > 0),
    });
  },
});

export const recoverStaleChatJob = internalMutation({
  args: {
    jobId: v.id("jobs"),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (
      !job ||
      job.kind !== "chat" ||
      (job.status !== "queued" && job.status !== "running") ||
      typeof job.leaseExpiresAt !== "number" ||
      job.leaseExpiresAt > now
    ) {
      return;
    }

    const message = args.errorMessage ?? STALE_CHAT_JOB_ERROR_MESSAGE;
    const jobMessages = await ctx.db
      .query("messages")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .take(10);
    const assistantMessage = jobMessages.find((entry) => entry.role === "assistant");
    const stream = await getMessageStreamByJobId(ctx, args.jobId);
    const streamSnapshot =
      assistantMessage && stream ? await loadMessageStreamSnapshot(ctx, assistantMessage._id) : null;

    // Same partial-trace fold as `failAssistantReply` so the user
    // can tell what was running when the job stalled. Drained in the same
    // mutation; orphan events from a stalled-then-recovered reply must not
    // outlive the message (they'd leak via the live subscription forever).
    // The helper sweeps past the fold's read cap, so even a runaway
    // producer can't leave rows pointing at a failed message.
    const persistedToolCalls = assistantMessage
      ? await foldAndDrainToolCallEvents(ctx, assistantMessage._id, {
          jobId: args.jobId,
          mutation: "recoverStaleChatJob",
        })
      : undefined;

    try {
      if (assistantMessage) {
        // Lint only the *streamed* portion (not the system error
        // message that takes over when the stream produced nothing).
        // When the stale-recovery rescues a reply that had
        // already streamed partial prose the user can still benefit
        // from unverified-claim highlights; when the action stalled
        // before producing anything, `streamSnapshot?.content` is
        // empty and `lintSandboxClaims` returns `undefined` so the
        // bubble shows just the stall message.
        const unverifiedClaims = lintSandboxClaims(assistantMessage, streamSnapshot?.content ?? "");
        const reasoning = deriveMessageReasoning(streamSnapshot?.stream ?? null, now);
        await ctx.db.patch(assistantMessage._id, {
          status: "failed",
          errorMessage: message,
          content: streamSnapshot?.content || message,
          toolCalls: persistedToolCalls,
          unverifiedClaims,
          reasoning: reasoning.reasoning,
          reasoningDurationMs: reasoning.reasoningDurationMs,
        });
      }

      // Note: stale-recovery deliberately does NOT settle cost
      // against the daily cap. The action that crashed/stalled never
      // reached the finalize / fail mutation, so we have no reliable
      // usage data — recording an arbitrary fixed cost here would either
      // double-count (if the action actually completed and the
      // settlement landed before the crash) or under-count (if it
      // stalled mid-stream after burning many tokens). We accept this
      // as a known shortfall: the daily cap may be slightly under-
      // recorded for stalled replies. Logged so ops can correlate
      // billing reconciliation findings with stale-recovery events.
      if (assistantMessage && assistantMessage.groundSandbox === true) {
        logWarn("chat", "sandbox_cost_settlement_skipped_on_stale_recovery", {
          jobId: args.jobId,
          assistantMessageId: assistantMessage._id,
          ownerTokenIdentifier: assistantMessage.ownerTokenIdentifier,
          hint: "Action never reported usage; daily cap not charged for this stalled reply.",
        });
      }

      const failedJob = await failStaleActiveJob(ctx, {
        jobId: args.jobId,
        expectedKind: "chat",
        now,
        errorMessage: message,
      });
      if (!failedJob) {
        return;
      }
    } finally {
      if (stream) {
        await deleteMessageStreamState(ctx, stream._id);
      }
      // Tool-call events are already drained by `foldAndDrainToolCallEvents`
      // above (sweep-past-cap), so there's no separate cleanup to do here.
    }
  },
});
