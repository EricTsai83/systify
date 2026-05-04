import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import { CHAT_JOB_LEASE_MS } from "../lib/rateLimit";
import { logWarn } from "../lib/observability";
import { TOOL_CALL_EVENT_SUMMARY_MAX_CHARS } from "../lib/constants";
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
 * Plan 06 — soft truncation marker appended to over-long tool-call summaries
 * before they reach the events table. Visible to both the LLM (the AI SDK
 * feeds tool results back as next-step inputs) and to the trace UI, so the
 * truncation is never silent.
 */
const TOOL_CALL_SUMMARY_TRUNCATION_MARKER = "…[truncated]";

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
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }

    if (thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }

    if (thread.repositoryId) {
      const repository = await ctx.db.get(thread.repositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Thread not found.");
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
      startedAt: stream.startedAt,
      lastAppendedAt: stream.lastAppendedAt,
    };
  },
});

/**
 * Plan 06 — subscribable view of the running tool-call trace for a single
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
  ): Promise<
    Array<ToolCallTraceEntry & { state: "running" | "completed" | "errored" }> | null
  > => {
    const identity = await requireViewerIdentity(ctx);
    const message = await ctx.db.get(args.assistantMessageId);
    if (!message) {
      return null;
    }
    if (message.ownerTokenIdentifier !== identity.tokenIdentifier) {
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
    await ctx.db.patch(args.assistantMessageId, {
      status: "streaming",
    });
    await ctx.db.patch(args.jobId, {
      status: "running",
      stage: "generating_reply",
      progress: 0.15,
      startedAt: now,
      leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
    });
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
      await ctx.db.patch(args.jobId, {
        leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
      });
    }

    await compactMessageStreamTail(ctx, stream._id);
  },
});

/**
 * Plan 06 — append one `start` or `end` row to `messageToolCallEvents`.
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
        await ctx.db.patch(args.jobId, {
          leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
        });
        await ctx.db.patch(stream._id, {
          lastAppendedAt: now,
        });
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
     * Plan 02 citation map: numbered `[A#] → artifactId` entries for the
     * artifacts that ended up in the prompt. Optional so non-docs replies
     * (and pre-Plan-02 messages) keep the field unset rather than written as
     * an empty array — the frontend treats both as "no resolvable citations".
     */
    citationMap: v.optional(
      v.array(
        v.object({
          index: v.number(),
          artifactId: v.id("artifacts"),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const message = await ctx.db.get(args.assistantMessageId);
    const streamSnapshot = await loadMessageStreamSnapshot(ctx, args.assistantMessageId);

    // Plan 06 — fold the ephemeral tool-call event log into the durable
    // `messages.toolCalls` field, then drain the events. Doing both inside
    // the same transaction means the frontend never sees a half-state where
    // events still exist but the message is already `completed`; the
    // `getMessageToolCallEvents` subscription either returns the running
    // trace (pre-finalize) or the empty list (post-finalize, with
    // `messages.toolCalls` taking over).
    const toolCallEvents = await loadAllToolCallEventsByMessage(ctx, args.assistantMessageId);
    const foldedToolCalls = foldToolCallEvents(toolCallEvents);
    const persistedToolCalls = foldedToolCalls.length > 0 ? foldedToolCalls : undefined;

    try {
      if (message) {
        const finalContent = `${streamSnapshot?.content ?? message.content}${args.finalDelta}`;
        await ctx.db.patch(args.assistantMessageId, {
          content: finalContent,
          status: "completed",
          errorMessage: undefined,
          estimatedInputTokens: args.inputTokens,
          estimatedOutputTokens: args.outputTokens,
          citationMap: args.citationMap,
          toolCalls: persistedToolCalls,
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

      // Always release the job lease so the per-thread in-flight gate clears,
      // even when the assistant message has been deleted (e.g. concurrent
      // thread or repository deletion). If the message is gone we can't
      // deliver the reply, so mark the job as failed instead of completed.
      if (message) {
        await ctx.db.patch(args.jobId, {
          status: "completed",
          stage: "completed",
          progress: 1,
          completedAt: now,
          outputSummary: "Assistant reply generated.",
          estimatedInputTokens: args.inputTokens,
          estimatedOutputTokens: args.outputTokens,
          estimatedCostUsd: args.costUsd,
          leaseExpiresAt: undefined,
        });
      } else {
        await ctx.db.patch(args.jobId, {
          status: "failed",
          stage: "failed",
          progress: 1,
          completedAt: now,
          errorMessage: "Assistant message was deleted before the reply could be persisted.",
          leaseExpiresAt: undefined,
        });
      }
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
      // Drain tool-call events. Same `finally`-block rationale as the stream
      // cleanup: a future refactor that wraps individual writes in try/catch
      // must not leave orphan events behind.
      for (const event of toolCallEvents) {
        await ctx.db.delete(event._id);
      }
    }
  },
});

export const failAssistantReply = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
    finalDelta: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const streamSnapshot = await loadMessageStreamSnapshot(ctx, args.assistantMessageId);
    const message = await ctx.db.get(args.assistantMessageId);

    // Plan 06 — surface partial tool-call traces on failures so the user can
    // see which tool the reply was running when it died. Unfinished entries
    // (only `start` events) fold to `endedAt === startedAt` and the trace
    // UI renders them as "interrupted".
    const toolCallEvents = await loadAllToolCallEventsByMessage(ctx, args.assistantMessageId);
    const foldedToolCalls = foldToolCallEvents(toolCallEvents);
    const persistedToolCalls = foldedToolCalls.length > 0 ? foldedToolCalls : undefined;

    try {
      if (message) {
        const streamedContent = `${streamSnapshot?.content ?? message.content}${args.finalDelta ?? ""}`;
        await ctx.db.patch(args.assistantMessageId, {
          status: "failed",
          errorMessage: args.errorMessage,
          content: streamedContent || args.errorMessage,
          toolCalls: persistedToolCalls,
        });
      } else {
        logWarn("chat", "fail_assistant_message_missing", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
        });
      }

      // Always fail the job and release its lease, regardless of whether the
      // assistant message still exists. Otherwise the in-flight gate would
      // stay engaged until the lease expires and recoverStaleChatJob fires.
      await ctx.db.patch(args.jobId, {
        status: "failed",
        stage: "failed",
        progress: 1,
        completedAt: now,
        errorMessage: args.errorMessage,
        leaseExpiresAt: undefined,
      });
    } finally {
      if (streamSnapshot) {
        await deleteMessageStreamState(ctx, streamSnapshot.stream._id);
      }
      for (const event of toolCallEvents) {
        await ctx.db.delete(event._id);
      }
    }
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

    // Plan 06 — same partial-trace fold as `failAssistantReply` so the user
    // can tell what was running when the job stalled. Drained in the same
    // mutation; orphan events from a stalled-then-recovered reply must not
    // outlive the message (they'd leak via the live subscription forever).
    const toolCallEvents = assistantMessage
      ? await loadAllToolCallEventsByMessage(ctx, assistantMessage._id)
      : [];
    const foldedToolCalls = foldToolCallEvents(toolCallEvents);
    const persistedToolCalls = foldedToolCalls.length > 0 ? foldedToolCalls : undefined;

    try {
      if (assistantMessage) {
        await ctx.db.patch(assistantMessage._id, {
          status: "failed",
          errorMessage: message,
          content: streamSnapshot?.content || message,
          toolCalls: persistedToolCalls,
        });
      }

      await ctx.db.patch(args.jobId, {
        status: "failed",
        stage: "failed",
        progress: 1,
        completedAt: now,
        errorMessage: message,
        leaseExpiresAt: undefined,
      });
    } finally {
      if (stream) {
        await deleteMessageStreamState(ctx, stream._id);
      }
      for (const event of toolCallEvents) {
        await ctx.db.delete(event._id);
      }
    }
  },
});

/**
 * Re-export for cascade-delete code paths (`repositories.ts`,
 * `chat/threads.ts`) that need to drain orphan events alongside their
 * existing per-thread / per-message cleanup. Living on the streaming
 * surface keeps the caller list discoverable from one file.
 */
export { drainMessageToolCallEvents };
