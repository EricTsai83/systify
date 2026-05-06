/**
 * Plan 12 — Sandbox tool-call audit log.
 *
 * Records one row per *completed* sandbox tool execution to the
 * `sandboxToolCallLog` table for compliance and internal-debugging
 * queries. Distinct from Plan 06's `messageToolCallEvents` (UI ticker)
 * and `messages.toolCalls` (per-message frozen trace) — see the design
 * boundaries below.
 *
 * Lifecycle:
 *
 *   1. **Append** — `recordSandboxToolCallLogEntry` is invoked from
 *      `chat/generation.ts` once per `tool-result` / `tool-error` event,
 *      after the matching Plan 06 event row is appended. The two writes
 *      are independent transactions; an audit-log failure logs a warning
 *      but does not fail the user-visible reply (best-effort recording —
 *      see {@link tryRecordSandboxToolCallLogEntry}).
 *   2. **Query** — the `by_owner_and_time` index supports the canonical
 *      audit query "what did user X do between time A and B" via
 *      `.withIndex("by_owner_and_time", q => q.eq("ownerTokenIdentifier", X))
 *       .order("desc").take(N)`. The implicit `_creationTime` secondary
 *      sort delivers the time component without an extra field.
 *      `by_message` lets a debugging session pivot from a specific
 *      assistant message into the calls it ran.
 *   3. **Retain** — entries are kept for 90 days, then deleted by the
 *      daily `cleanupExpiredSandboxToolCallLogs` cron (registered in
 *      `convex/crons.ts`). Time-based retention is the *only* cleanup
 *      path; parent deletes (thread / repo cascades) intentionally do
 *      *not* drain this table so a user-initiated thread delete cannot
 *      erase the compliance trail mid-window. The 90-day TTL bounds
 *      growth.
 *
 * Why a separate table (not just `messages.toolCalls` / the events
 * table):
 *   - **Lifetime mismatch**: `messages.toolCalls` lives as long as the
 *     parent message. Users delete threads. Audit logs need to outlive
 *     individual messages so a thread deletion does not erase the trail
 *     of accessed files.
 *   - **Schema mismatch**: The audit log stores `outputBytes`, not the
 *     output itself — full output already lives on the message via
 *     Plan 06. Audit answers "did this happen + with what input + how
 *     big was the response", not "what was the response".
 *   - **Index mismatch**: The audit query is owner-scoped + time-range,
 *     and would otherwise force a third index onto `messages` purely
 *     for forensics.
 *
 * Why best-effort writes (catch-and-log rather than throw):
 *   - The tool effect already happened by the time we get here — the
 *     LLM has read the file, run the command, etc. Failing the reply
 *     post-hoc on an audit-log write doesn't undo any of that; it just
 *     denies the user the answer they were already going to receive.
 *   - A persistent audit-log infrastructure failure surfaces in
 *     `logWarn("chat", "sandbox_tool_audit_log_write_failed", ...)`
 *     calls, which Plan 13's telemetry will pick up. Compliance teams
 *     correlate gaps via the warn signals.
 *   - Storing the failed-write event in some other channel would just
 *     reopen the recursive failure-mode question. The pragmatic answer
 *     is "make the audit-log write the primary path and log warnings
 *     on failure"; this matches the posture
 *     `daytonaWebhookEvents.cleanupOldWebhookEvents` and other
 *     bookkeeping mutations take in this codebase.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalMutation } from "../_generated/server";
import { logInfo, logWarn } from "../lib/observability";

/* ---------------------------------------------------------------------- *
 * Public limits.                                                         *
 * ---------------------------------------------------------------------- */

/**
 * Retention window for audit log entries (90 days, in milliseconds).
 *
 * 90 days is the spec from Plan 12. It is short enough to keep the
 * table size predictable as usage scales, long enough for a typical
 * compliance review or post-incident forensic dig.
 */
export const SANDBOX_TOOL_CALL_LOG_RETENTION_MS = 90 * 24 * 60 * 60_000;

/**
 * Per-cron-invocation delete budget. Mirrors the shape used by
 * `daytonaWebhooks.cleanupOldWebhookEvents` (100) and
 * `github.cleanupExpiredOAuthStates` (50): small enough to fit Convex's
 * per-mutation write budget with comfortable headroom; large enough
 * that a steady-state workload drains in a single nightly run. The
 * cleanup self-reschedules when a batch is full, so increasing usage
 * degrades to "more cron ticks" rather than "audit log grows
 * unboundedly".
 */
export const SANDBOX_TOOL_CALL_LOG_CLEANUP_BATCH_SIZE = 100;

/**
 * UTF-16 code-unit cap for the persisted `inputJson` field.
 *
 * Distinct from Plan 06's `TOOL_CALL_EVENT_SUMMARY_MAX_CHARS` (600,
 * UI-visible) because audit recording wants more of the original
 * input intact: a long `run_shell` command — exactly the kind of
 * tool input compliance audits care about — would lose investigative
 * value at the UI cap. 2000 chars covers any realistic tool input
 * (longest `run_shell` chains in the wild are ~1 KB) while keeping
 * the row well under Convex's 1 MB document limit even when paired
 * with the other audit fields.
 */
export const SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS = 2000;

/**
 * Marker appended to truncated `inputJson` so audit consumers can tell
 * a value was shortened from the source. Mirrors the shape Plan 06's
 * UI-summary truncation uses for symmetry.
 */
const SANDBOX_TOOL_CALL_LOG_INPUT_TRUNCATION_MARKER = "…[truncated]";

/* ---------------------------------------------------------------------- *
 * Pure helpers — exported so tests can pin the boundary directly.        *
 * ---------------------------------------------------------------------- */

/**
 * Cap `inputJson` at {@link SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS} code
 * units, appending the truncation marker iff the value was shortened.
 *
 * Operates on UTF-16 code units (matching `String.slice`'s indexing) so
 * the resulting string never exceeds the cap by a fraction of a code
 * point. A surrogate pair is either entirely kept or entirely dropped,
 * never split — same invariant Plan 06's UI-summary cap maintains.
 */
export function capAuditInputJson(value: string): string {
  if (value.length <= SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS) {
    return value;
  }
  return (
    value.slice(0, SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS - SANDBOX_TOOL_CALL_LOG_INPUT_TRUNCATION_MARKER.length) +
    SANDBOX_TOOL_CALL_LOG_INPUT_TRUNCATION_MARKER
  );
}

/**
 * Compute the byte length of a string under UTF-8 encoding without
 * materializing the encoded buffer.
 *
 * `TextEncoder.encode(s).byteLength` would also work but allocates a
 * full `Uint8Array` for what is ultimately a count. The bitwise
 * computation walks code points and sums `1 / 2 / 3 / 4` per the
 * standard UTF-8 size rules — identical output, no allocation.
 *
 * Used for `outputBytes`: the audit log records "how many bytes did the
 * tool return to the LLM" and we always have the JSON-stringified
 * payload in hand at the point of the write. Re-encoding it just to
 * count would be wasteful at the per-tool-call cadence.
 */
export function countUtf8Bytes(value: string): number {
  let total = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    total += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return total;
}

/**
 * Audit metadata extracted from an AI SDK `tool-result` payload.
 *
 * The payload shape is the tool's `execute` return value, which for the
 * SysTify tools is one of:
 *
 *   - `{ ok: true, ..., redactedTypes: string[] }` — success envelope.
 *   - `{ ok: false, errorCode: string, message: string }` — error
 *     envelope (the tool itself reported a structured error like
 *     `path_outside_repo` or `command_blocked`).
 *
 * Returned fields:
 *   - `errorCode` — the tool's reported error code on `ok: false`,
 *     `undefined` on success. Falls back to `"unknown_tool_error"` if
 *     the envelope is malformed (`ok: false` without an `errorCode`)
 *     so audit consumers always have *something* to filter on for the
 *     error class.
 *   - `redactedFields` — the success envelope's `redactedTypes`
 *     (closed set in `convex/chat/redaction.ts`) so audit consumers
 *     can detect "this tool call had a secret in the response"
 *     without reading the response itself. Empty for error envelopes
 *     (no payload to redact) and unparseable shapes.
 *
 * Defensive: the function tolerates `unknown` input because the AI
 * SDK widens `part.output` to `unknown`; an unrecognised shape produces
 * the empty-fields fallback rather than a runtime exception. Audit log
 * recording must never be the failure mode that takes down a reply.
 */
export function extractAuditMetadataFromToolOutput(output: unknown): {
  errorCode: string | undefined;
  redactedFields: string[];
} {
  if (typeof output !== "object" || output === null) {
    return { errorCode: undefined, redactedFields: [] };
  }
  const obj = output as Record<string, unknown>;
  if (obj.ok === false) {
    return {
      errorCode: typeof obj.errorCode === "string" ? obj.errorCode : "unknown_tool_error",
      redactedFields: [],
    };
  }
  if (obj.ok === true) {
    if (Array.isArray(obj.redactedTypes)) {
      return {
        errorCode: undefined,
        redactedFields: obj.redactedTypes.filter((entry): entry is string => typeof entry === "string"),
      };
    }
    return { errorCode: undefined, redactedFields: [] };
  }
  return { errorCode: undefined, redactedFields: [] };
}

/* ---------------------------------------------------------------------- *
 * Mutations.                                                             *
 * ---------------------------------------------------------------------- */

/**
 * Insert one audit-log row.
 *
 * Defensive normalization on the way in:
 *   - `inputJson` is re-capped via {@link capAuditInputJson}. Callers
 *     pass the redacted JSON unmodified; the cap lives here so a future
 *     change to the policy is one-file change.
 *   - `outputBytes` and `durationMs` are floored to non-negative
 *     integers so a buggy upstream cannot insert NaN / negative numbers
 *     that would confuse audit aggregations.
 *
 * The schema's `redactedFields: v.array(v.string())` is kept loose
 * (not a closed-union literal) on purpose — Plan 05's
 * {@link import("./redaction").RedactionType} can grow without forcing
 * a migration here.
 */
export const recordSandboxToolCallLogEntry = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    sandboxId: v.id("sandboxes"),
    toolName: v.string(),
    inputJson: v.string(),
    outputBytes: v.number(),
    durationMs: v.number(),
    errorCode: v.optional(v.string()),
    redactedFields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("sandboxToolCallLog", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      threadId: args.threadId,
      messageId: args.messageId,
      sandboxId: args.sandboxId,
      toolName: args.toolName,
      inputJson: capAuditInputJson(args.inputJson),
      outputBytes: Math.max(0, Math.floor(args.outputBytes)),
      durationMs: Math.max(0, Math.floor(args.durationMs)),
      errorCode: args.errorCode,
      redactedFields: args.redactedFields,
    });
  },
});

/**
 * Daily retention sweep.
 *
 * Strategy:
 *   - Walk `_creationTime` ascending (Convex's default order) and take a
 *     bounded {@link SANDBOX_TOOL_CALL_LOG_CLEANUP_BATCH_SIZE} batch.
 *     The oldest rows arrive first; once we hit a row whose
 *     `_creationTime >= cutoff` every subsequent row is even fresher,
 *     so we stop scanning. This keeps the work per invocation bounded
 *     even on a table that has accumulated months of fresh entries.
 *   - When the batch was fully expired (delete count == batch size),
 *     self-reschedule on the next tick to drain the backlog without
 *     breaching the per-transaction write budget. A partial batch
 *     means we hit the live edge of the retention window and there is
 *     nothing more to delete this run.
 *
 * Returns `{ deletedCount, rescheduled }` so callers (today: only the
 * cron registration) can observe the work done. Tests assert this
 * shape directly.
 */
export const cleanupExpiredSandboxToolCallLogs = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deletedCount: number; rescheduled: boolean }> => {
    const cutoff = Date.now() - SANDBOX_TOOL_CALL_LOG_RETENTION_MS;

    const candidates = await ctx.db
      .query("sandboxToolCallLog")
      .order("asc")
      .take(SANDBOX_TOOL_CALL_LOG_CLEANUP_BATCH_SIZE);

    let deletedCount = 0;
    for (const candidate of candidates) {
      if (candidate._creationTime >= cutoff) {
        // Ascending order: every subsequent row is at least this fresh.
        break;
      }
      await ctx.db.delete(candidate._id);
      deletedCount += 1;
    }

    const rescheduled = deletedCount === SANDBOX_TOOL_CALL_LOG_CLEANUP_BATCH_SIZE;
    if (rescheduled) {
      await ctx.scheduler.runAfter(0, internal.chat.sandboxToolCallLog.cleanupExpiredSandboxToolCallLogs, {});
    }

    if (deletedCount > 0) {
      logInfo("chat", "sandbox_tool_call_log_cleanup", {
        deletedCount,
        rescheduled,
        cutoff,
      });
    }

    return { deletedCount, rescheduled };
  },
});

/* ---------------------------------------------------------------------- *
 * Action-side adapter — best-effort recording from `generation.ts`.      *
 * ---------------------------------------------------------------------- */

/**
 * Arguments mirror {@link recordSandboxToolCallLogEntry}'s mutation
 * args, expressed as a TS type so the action can build the payload
 * once and the wrapper can forward it without re-listing the fields.
 */
export type RecordSandboxToolCallLogEntryArgs = {
  ownerTokenIdentifier: string;
  threadId: Id<"threads">;
  messageId: Id<"messages">;
  sandboxId: Id<"sandboxes">;
  toolName: string;
  inputJson: string;
  outputBytes: number;
  durationMs: number;
  errorCode?: string;
  redactedFields: string[];
};

/**
 * Best-effort wrapper for the audit log write. Intended call site is
 * the `tool-result` / `tool-error` handlers in `chat/generation.ts`.
 *
 * The wrapper catches every error from the underlying mutation and
 * re-routes it to a structured warning. This is the documented policy
 * (see file header): the tool effect already happened by the time we
 * get here, so failing the reply post-hoc serves no remediation purpose
 * — we just need the operational signal so a persistent audit-log
 * infrastructure outage is observable.
 */
export async function tryRecordSandboxToolCallLogEntry(
  ctx: Pick<ActionCtx, "runMutation">,
  args: RecordSandboxToolCallLogEntryArgs,
): Promise<void> {
  try {
    await ctx.runMutation(internal.chat.sandboxToolCallLog.recordSandboxToolCallLogEntry, args);
  } catch (error) {
    logWarn("chat", "sandbox_tool_audit_log_write_failed", {
      threadId: args.threadId,
      messageId: args.messageId,
      sandboxId: args.sandboxId,
      toolName: args.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
