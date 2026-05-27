/**
 * Pure helpers for the `messageToolCallEvents` ephemeral table.
 *
 * The table itself is a fast append-only log of `start` / `end` rows produced
 * during a sandbox-mode reply. Three responsibilities live here, kept apart
 * from the `streaming.ts` mutation surface so they can be reused from cascade
 * deletes (`repositories.ts`, `chat/threads.ts`) without re-implementing the
 * iteration shape:
 *
 *   1. **Read** — `loadAllToolCallEventsByMessage` fetches up to
 *      `MAX_TOOL_CALL_EVENTS_PER_MESSAGE` rows in stable `sequence` order via
 *      the `by_messageId_and_sequence` index. Used by both the live
 *      subscription query and the finalize fold.
 *   2. **Drain** — `drainMessageToolCallEvents` deletes every event row for a
 *      message; idempotent on already-empty messages. Called by finalize,
 *      fail, recover-stale, repository cascade-delete, and thread delete.
 *   3. **Fold** — `foldToolCallEvents` paires `start` rows to their matching
 *      `end` rows by `toolCallId` and produces the persisted-shape array
 *      that lands on `messages.toolCalls`. Pure; tested directly in
 *      `chat-streaming.test.ts`.
 *
 * Why pair by `toolCallId` (and not `toolName`):
 *   - The model frequently issues two `read_file` calls in a row (e.g. one
 *     for the file under inspection and one for an adjacent dependency).
 *     Grouping by `toolName` collapses both into one entry, hiding the
 *     second call from the UI and from any future audit trail reader.
 *   - The AI SDK guarantees a unique `toolCallId` per invocation in
 *     `fullStream`, so it is the canonical correlation key.
 *
 * Why a separate file (instead of inlining into `streaming.ts`):
 *   - Cascade deletes need `drainMessageToolCallEvents`, but `streaming.ts`
 *     would otherwise pull in mutation-only types when imported from
 *     `repositories.ts` (which is V8-only).
 *   - Pure folding logic is much easier to unit-test as a free function than
 *     inside a closure-captured handler.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_TOOL_CALL_EVENTS_PER_MESSAGE } from "../lib/constants";

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/**
 * Persistent shape of a single tool call entry on `messages.toolCalls`.
 * Exported so the live query and the cascade tests share one type.
 */
export type ToolCallTraceEntry = {
  toolCallId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  startedAt: number;
  endedAt: number;
  errorCode?: string;
};

/**
 * Read every tool-call event for a single message in `sequence` order.
 *
 * Bounded by `MAX_TOOL_CALL_EVENTS_PER_MESSAGE` so the read stays inside
 * Convex's per-transaction read budget even when a future tool spike runs
 * the message over the soft cap. Callers that genuinely need to drain all
 * rows (cascade delete) should call `drainMessageToolCallEvents`, which
 * internally batches in the same way as `messageStreamChunks`.
 */
export async function loadAllToolCallEventsByMessage(
  ctx: DbCtx,
  messageId: Id<"messages">,
): Promise<Array<Doc<"messageToolCallEvents">>> {
  return await ctx.db
    .query("messageToolCallEvents")
    .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", messageId))
    .take(MAX_TOOL_CALL_EVENTS_PER_MESSAGE);
}

/**
 * Drain (delete) every event row attached to a message.
 *
 * Iterates in batches of `MAX_TOOL_CALL_EVENTS_PER_MESSAGE` so a pathological
 * over-spilled trace still terminates within a single transaction's write
 * budget. Returns the number of rows actually deleted so callers can budget
 * across multiple messages without re-running the index walk.
 *
 * Idempotent: calling on a message with no events is a no-op.
 */
export async function drainMessageToolCallEvents(ctx: MutationCtx, messageId: Id<"messages">): Promise<number> {
  let drained = 0;
  while (true) {
    const batch = await ctx.db
      .query("messageToolCallEvents")
      .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", messageId))
      .take(MAX_TOOL_CALL_EVENTS_PER_MESSAGE);
    if (batch.length === 0) {
      return drained;
    }
    for (const event of batch) {
      await ctx.db.delete(event._id);
    }
    drained += batch.length;
    if (batch.length < MAX_TOOL_CALL_EVENTS_PER_MESSAGE) {
      return drained;
    }
  }
}

/**
 * Compute the next `sequence` number for a message's events.
 *
 * Single descending lookup via the `by_messageId_and_sequence` index — O(1)
 * regardless of how many events already exist. Returns `0` for the first
 * event so the per-message sequence is dense starting at zero (matches the
 * `messageStreamChunks` invariant the rest of the streaming code relies
 * on).
 */
export async function nextToolCallEventSequence(ctx: DbCtx, messageId: Id<"messages">): Promise<number> {
  const last = await ctx.db
    .query("messageToolCallEvents")
    .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", messageId))
    .order("desc")
    .first();
  return (last?.sequence ?? -1) + 1;
}

/**
 * Pair `start` events to their matching `end` events by `toolCallId` and
 * return them in execution order.
 *
 * Behavior table:
 *   - both `start` and `end` present (normal case): full entry, end times.
 *   - only `start` present (mid-stream cancel, server crash, lost event):
 *     `endedAt === startedAt`, empty `outputSummary`. Surfaced to the UI
 *     as "interrupted" so the user can tell the model didn't finish that
 *     call rather than seeing a misleading "completed instantly" entry.
 *   - only `end` present (defensive, should never happen in normal flow):
 *     entry preserves whatever fields the `end` event carried; sorted
 *     last.
 *
 * Sort key is the `start` event's `sequence`, falling back to the `end`
 * event's `sequence`. Sequences are dense and monotonic per message, so
 * the resulting array reflects actual call order even when events arrive
 * interleaved on the AI SDK stream.
 */
export function foldToolCallEvents(events: ReadonlyArray<Doc<"messageToolCallEvents">>): ToolCallTraceEntry[] {
  if (events.length === 0) {
    return [];
  }

  type Slot = {
    start?: Doc<"messageToolCallEvents">;
    end?: Doc<"messageToolCallEvents">;
  };
  const slots = new Map<string, Slot>();
  for (const event of events) {
    const slot = slots.get(event.toolCallId) ?? {};
    if (event.type === "start") {
      slot.start = event;
    } else {
      slot.end = event;
    }
    slots.set(event.toolCallId, slot);
  }

  const ordered = [...slots.entries()].sort(([, a], [, b]) => {
    const aSeq = a.start?.sequence ?? a.end?.sequence ?? Number.POSITIVE_INFINITY;
    const bSeq = b.start?.sequence ?? b.end?.sequence ?? Number.POSITIVE_INFINITY;
    return aSeq - bSeq;
  });

  return ordered.map(([toolCallId, slot]) => {
    const startEvent = slot.start;
    const endEvent = slot.end;
    const startedAt =
      startEvent?.occurredAt ??
      (endEvent && startEvent === undefined ? Math.max(0, endEvent.occurredAt - 1) : (endEvent?.occurredAt ?? 0));
    const endedAt = endEvent?.occurredAt ?? startedAt;
    return {
      toolCallId,
      toolName: startEvent?.toolName ?? endEvent?.toolName ?? "unknown",
      inputSummary: startEvent?.inputSummary ?? endEvent?.inputSummary ?? "",
      outputSummary: endEvent?.outputSummary ?? "",
      startedAt,
      endedAt,
      errorCode: endEvent?.errorCode,
    };
  });
}
