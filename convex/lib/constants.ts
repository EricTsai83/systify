/** Maximum number of files captured during an import's tree fetch. */
export const MAX_LISTED_FILES = 400;

/** Maximum number of chunks extracted per file. */
export const MAX_CHUNKS_PER_FILE = 4;

/** Maximum number of artifacts included in a chat context prompt. */
export const MAX_CONTEXT_ARTIFACTS = 6;

/** Maximum number of recent messages loaded into the chat UI. */
export const MAX_VISIBLE_MESSAGES = 100;

/** Maximum number of recent messages loaded for a chat reply. */
export const MAX_CONTEXT_MESSAGES = 20;

/**
 * Maximum number of relevant code chunks selected for a chat reply.
 *
 * `docs` (artifact-only) and `sandbox` (LLM-driven via tools) replies
 * don't pre-load chunks; the relevance selector is still imported by
 * `chat/generation.ts` and exercised by direct unit tests in
 * `chat-context.test.ts`, so the cap stays here as the contract for any
 * future caller that introduces chunk pre-selection.
 */
export const MAX_RELEVANT_CHUNKS = 6;

/** Number of documents to delete per batch in cascade operations. */
export const CASCADE_BATCH_SIZE = 200;

/**
 * Soft cap on the total `messageStreamChunks` rows a single thread-level
 * cleanup mutation is allowed to delete. Each `deleteMessageStreamState`
 * call fully drains its stream's chunks, so without a per-pass cap one
 * mutation could fan out into thousands of deletes and approach Convex's
 * per-transaction read/write limits. When the budget is hit the caller
 * re-enqueues `cleanupOrphanedMessageStreams`; `deleteMessageStreamState`
 * is idempotent on already-drained streams.
 *
 * Sized to stay roughly in line with `cascadeDeleteRepository`'s effective
 * per-stream budget (`STREAM_CHUNK_DRAIN_PASS_LIMIT * CASCADE_BATCH_SIZE`)
 * so both cleanup paths consume similar shares of a transaction's
 * write capacity.
 */
export const MAX_STREAM_CHUNKS_PER_PASS = 1500;

/** Minimum character delta before flushing a streaming assistant reply. */
export const STREAM_FLUSH_THRESHOLD = 240;

/** Number of stream chunks to compact into the stream header. */
export const MESSAGE_STREAM_COMPACT_CHUNK_THRESHOLD = 8;

/** Default minutes before a sandbox auto-stops (Daytona). */
export const DEFAULT_AUTO_STOP_MINUTES = 10;

/** Default minutes before a sandbox is auto-archived (Daytona). */
export const DEFAULT_AUTO_ARCHIVE_MINUTES = 60 * 24;

/** Default minutes before a sandbox is auto-deleted (Daytona). */
export const DEFAULT_AUTO_DELETE_MINUTES = 60 * 24;

/**
 * Defensive upper bound on `messageStreams.liveReasoning` size.
 *
 * Each `appendAssistantReasoningDelta` rewrites the whole `liveReasoning`
 * column on the stream row (Convex documents are rewritten in full on every
 * patch), so unbounded growth has two failure modes:
 *   - Convex's 1 MB per-document hard limit eventually rejects the patch,
 *     which would tear down the reply mid-stream.
 *   - Even well below the limit, repeated full-string rewrites of an
 *     ever-larger value approach O(n²) total bytes written across a single
 *     reasoning trace.
 *
 * The expected per-reply trace is a few KB; this cap is a defensive
 * backstop for pathological cases (high reasoning effort on a long
 * prompt). When the cap is hit, the oldest bytes are dropped so the
 * trace renderer always shows the model's most recent thinking.
 */
export const MAX_LIVE_REASONING_CHARS = 64_000;

/**
 * Defensive upper bound on the number of `messageToolCallEvents`
 * rows pulled in a single read.
 *
 * In practice the count is bounded by `SANDBOX_STEP_BUDGET * 2` (one `start`
 * + one `end` per call). 64 sits comfortably above that with 4× headroom
 * for any future step-budget bump *and* a defensive margin against duplicate
 * events from a buggy AI SDK release. Any single message that genuinely
 * produced more than this is a malformed trace; capping the read keeps the
 * subscription query cheap (a constant-time index walk) and the finalize
 * fold within Convex's transaction-read budget.
 */
export const MAX_TOOL_CALL_EVENTS_PER_MESSAGE = 64;

/**
 * Character cap applied to each tool-call event's `inputSummary`
 * and `outputSummary` *before* it lands in the events table.
 *
 * Rationale:
 *   - Read-side: `messages.toolCalls` is folded from these summaries and
 *     persisted on the message row. A pathological tool result (e.g. a
 *     `run_shell` that prints 32 KiB even after byte-level truncation)
 *     would push the message document past Convex's 1 MB size limit if
 *     all 16 events carried full payloads.
 *   - Write-side: the values flow into the LLM's next-step input *and*
 *     into the live ticker UI. The tool itself already returns a
 *     redacted, size-bounded result (`SANDBOX_READ_FILE_MAX_BYTES`,
 *     `SANDBOX_TRUNCATION_MARKER`); this cap is a second-line defense
 *     against future tools whose output the layer above us hasn't
 *     bounded yet.
 *
 * The cap is applied with a `[…truncated…]` marker so the model and the
 * UI can both tell that the visible payload is partial.
 */
export const TOOL_CALL_EVENT_SUMMARY_MAX_CHARS = 600;
