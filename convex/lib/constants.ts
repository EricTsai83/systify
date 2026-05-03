/** Maximum number of files listed during repository tree walk. */
export const MAX_LISTED_FILES = 400;

/** Maximum directory nesting depth for repository tree walk. */
export const MAX_TREE_DEPTH = 6;

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
 * Plan 04 retired the chunk-pre-loading path for both `docs` (artifact-only)
 * and `sandbox` (LLM-driven via tools). The relevance selector is still
 * imported by `chat/generation.ts` and exercised by direct unit tests in
 * `chat-context.test.ts`, so the cap stays here as the contract for any
 * future caller that re-introduces chunk pre-selection.
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
