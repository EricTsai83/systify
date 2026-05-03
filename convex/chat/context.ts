import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import {
  CHAT_BASELINE_CHUNKS,
  CHAT_CANDIDATE_POOL_LIMIT,
  CHAT_SEARCH_RESULTS_PER_INDEX,
  MAX_CONTEXT_MESSAGES,
} from "../lib/constants";
import { buildChunkSearchQuery } from "./relevance";
import type { ChatMode } from "../chatModeResolver";

export type ReplyContext = {
  ownerTokenIdentifier: string;
  /**
   * Effective mode for this reply, anchored to the queued user message:
   * `userMessage.mode ?? thread.mode`. Anchoring to the specific queued
   * message (not "the latest user message in the window") matters under
   * concurrent send: if a second user message lands between queueing and
   * generation, "latest" would point to that newer message and the assistant
   * reply would answer message A's content with message B's mode prompt.
   * The user message's own mode is the canonical choice for "what the user
   * meant when they sent this" — falling back to `thread.mode` only when the
   * row predates the per-message `mode` field.
   *
   * Exposed on the context so `generation.ts` can hand it to
   * `buildSystemPrompt` without re-deriving the rule.
   */
  mode: ChatMode;
  repositorySummary?: string;
  readmeSummary?: string;
  architectureSummary?: string;
  sourceRepoFullName?: string;
  /**
   * Artifacts in scope for this reply. The `id` is exposed alongside the
   * displayed fields so `generation.ts` can build a numbered citation map
   * (`[A1] → artifactId`) that travels with the assistant message and lets
   * the frontend resolve `[A#]` tokens back to specific artifact rows.
   */
  artifacts: Array<{ id: Id<"artifacts">; title: string; summary: string; contentMarkdown: string }>;
  chunks: Array<{ path: string; summary: string; content: string }>;
  messages: Array<{ id: Id<"messages">; role: "user" | "assistant" | "system" | "tool"; content: string }>;
};

const DOCS_ARTIFACT_KINDS: Array<Doc<"artifacts">["kind"]> = [
  "architecture_diagram",
  "adr",
  "failure_mode_analysis",
  "deep_analysis",
  "architecture_overview",
  "design_review",
  "migration_plan",
  "trade_off_matrix",
  "capacity_estimate",
];
const DOCS_ARTIFACTS_TOTAL_LIMIT = 12;

/**
 * Load the most recent docs artifacts across all DOCS_ARTIFACT_KINDS for a
 * given repository. Uses `.take()` per kind and merges in memory so we never
 * issue multiple `.paginate()` calls; Convex only supports a single paginated
 * query per function execution.
 */
async function loadLatestDocsArtifacts(ctx: Pick<QueryCtx, "db">, repositoryId: Id<"repositories">) {
  const perKindResults = await Promise.all(
    DOCS_ARTIFACT_KINDS.map((kind) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_repositoryId_and_kind", (q) => q.eq("repositoryId", repositoryId).eq("kind", kind))
        .order("desc")
        .take(DOCS_ARTIFACTS_TOTAL_LIMIT),
    ),
  );

  const allArtifacts = perKindResults.flat();

  // Sort descending by _creationTime (tie-break on _id) and keep the top N.
  allArtifacts.sort((a, b) => {
    if (b._creationTime !== a._creationTime) {
      return b._creationTime - a._creationTime;
    }
    return b._id > a._id ? 1 : -1;
  });

  return allArtifacts.slice(0, DOCS_ARTIFACTS_TOTAL_LIMIT);
}

/**
 * Load the most recent `limit` messages on a thread for UI display.
 *
 * Returned in ascending creation-time order. This function intentionally
 * applies **no** mode-aware filtering: the chat panel must render every
 * message the user sent or received, including replies generated under a
 * previous mode, so the user can scroll back through the full thread
 * history. Mode-aware filtering for the LLM reply context lives in
 * `loadReplyContextMessages` below — that's the only call site where
 * cross-mode assistant replies must be hidden from the model.
 */
export async function loadRecentMessages(ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">, limit: number) {
  const recentMessages = await ctx.db
    .query("messages")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(limit);

  return recentMessages.reverse();
}

/**
 * Plan 03: how aggressively `loadReplyContextMessages` over-fetches the
 * `by_threadId` index before applying the cross-mode + empty-content
 * filters. With `MAX_CONTEXT_MESSAGES = 20` this caps the index read at
 * 80 rows per reply — small enough to keep transaction read budget tight,
 * large enough that a typical mode-switch (a handful of stale cross-mode
 * assistant rows + an aborted stream placeholder) still leaves the
 * post-filter window at the full 20-row cap. The factor lives as a named
 * constant so the trade-off is auditable in code review rather than
 * buried as a magic number.
 *
 * If a thread is so heavy on cross-mode replies that even 80 rows can't
 * yield 20 same-mode survivors, the model sees a smaller window — that's
 * the correct degradation: the older "same-mode" turns are by then so far
 * back in history they aren't really "recent context" anyway.
 */
const REPLY_CONTEXT_OVERFETCH_FACTOR = 4;

/**
 * Load up to `limit` recent messages eligible for the LLM reply context.
 *
 * Plan 03 contract — applied while iterating from newest-first:
 *   1. **Cross-mode assistant filter.** A previous mode's hypothetical
 *      answer must not contaminate the new mode's reply, so assistant rows
 *      whose `mode` differs from the queued reply's `effectiveMode` are
 *      dropped. User / tool / system rows are kept regardless of mode so
 *      cross-mode conversational continuity (the user's earlier questions)
 *      survives a mode switch.
 *   2. **Empty-content filter.** Stream-aborted assistant rows (and any
 *      other rows whose `content` is whitespace-only) carry no useful
 *      signal and must not enter the LLM context as blank turns. This is
 *      handled here — alongside the mode filter — so the cap math below is
 *      computed against post-filter survivors, not raw rows.
 *
 * The function over-fetches `limit * REPLY_CONTEXT_OVERFETCH_FACTOR` rows
 * from the `by_threadId` index and then keeps the newest `limit` survivors.
 * This is the robust choice over a naive `take(limit)` followed by
 * filtering: a `take(limit)` could be entirely consumed by stale cross-mode
 * rows in heavy mode-switching threads, leaving the model with little or
 * no recent context. The over-fetch is bounded by a small constant factor
 * so transaction read work stays tight.
 *
 * Returned rows are in ascending creation-time order to match the
 * downstream prompt builder's expectation of a chronologically-ordered
 * conversation.
 */
async function loadReplyContextMessages(
  ctx: Pick<QueryCtx, "db">,
  threadId: Id<"threads">,
  effectiveMode: ChatMode,
  limit: number,
) {
  const overfetchLimit = limit * REPLY_CONTEXT_OVERFETCH_FACTOR;
  const candidateMessages = await ctx.db
    .query("messages")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(overfetchLimit);

  const filtered = candidateMessages.filter((message) => {
    if (message.content.trim().length === 0) {
      return false;
    }
    if (message.role === "assistant" && message.mode !== effectiveMode) {
      return false;
    }
    return true;
  });

  // `candidateMessages` is in descending creation-time order, so `filtered`
  // preserves that order; the newest `limit` survivors are the first
  // `limit` items. Reverse to hand back ascending order for the prompt
  // builder.
  return filtered.slice(0, limit).reverse();
}

async function loadCandidateChunks(ctx: Pick<QueryCtx, "db">, importId: Id<"imports">, question: string) {
  const headCount = Math.ceil(CHAT_BASELINE_CHUNKS / 2);
  const tailCount = CHAT_BASELINE_CHUNKS - headCount;
  const [headChunks, tailChunks] = await Promise.all([
    ctx.db
      .query("repoChunks")
      .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", importId))
      .take(headCount),
    ctx.db
      .query("repoChunks")
      .withIndex("by_importId_and_path_and_chunkIndex", (q) => q.eq("importId", importId))
      .order("desc")
      .take(tailCount),
  ]);
  const searchQuery = buildChunkSearchQuery(question);
  let summaryMatches: Doc<"repoChunks">[] = [];
  let contentMatches: Doc<"repoChunks">[] = [];

  if (searchQuery) {
    [summaryMatches, contentMatches] = await Promise.all([
      ctx.db
        .query("repoChunks")
        .withSearchIndex("search_summary", (q) => q.search("summary", searchQuery).eq("importId", importId))
        .take(CHAT_SEARCH_RESULTS_PER_INDEX),
      ctx.db
        .query("repoChunks")
        .withSearchIndex("search_content", (q) => q.search("content", searchQuery).eq("importId", importId))
        .take(CHAT_SEARCH_RESULTS_PER_INDEX),
    ]);
  }

  const candidatesById = new Map<string, Doc<"repoChunks">>();
  for (const chunk of [...summaryMatches, ...contentMatches, ...headChunks, ...[...tailChunks].reverse()]) {
    if (candidatesById.has(chunk._id)) {
      continue;
    }

    candidatesById.set(chunk._id, chunk);
    if (candidatesById.size >= CHAT_CANDIDATE_POOL_LIMIT) {
      break;
    }
  }

  return Array.from(candidatesById.values());
}

export const getReplyContext = internalQuery({
  args: {
    threadId: v.id("threads"),
    /**
     * Anchor for mode and search-query derivation. Required so the same
     * message id that `generation.ts` is paired to determines both the
     * system prompt (via `userMessage.mode`) and the chunk-search query
     * (via `userMessage.content`). Anchoring to "the latest user message
     * in the window" used to be the rule here, but that derivation is
     * unsafe under concurrent send — a newer message landing between
     * queueing and generation would silently take over both fields.
     */
    userMessageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }

    const userMessage = await ctx.db.get(args.userMessageId);
    if (!userMessage || userMessage.threadId !== args.threadId || userMessage.role !== "user") {
      // The reply is paired to a specific user message at queue time. If
      // the message no longer exists, was moved to another thread, or is
      // not a user message, the entire generation must abort — answering
      // the wrong prompt is worse than failing visibly.
      throw new Error("Queued user message not found for this thread.");
    }
    const effectiveMode = userMessage.mode ?? thread.mode;

    // Plan 03: cross-mode filtering + empty-content filtering happen inside
    // `loadReplyContextMessages` so the helper can over-fetch a bounded
    // multiple of the cap and only then trim to MAX_CONTEXT_MESSAGES. Doing
    // both filters here in the caller would require re-applying
    // `take(MAX_CONTEXT_MESSAGES + 1)` semantics on top of an already-truncated
    // window, which silently shrinks the LLM-context view whenever a mode
    // switch left stale assistant rows in the most recent `limit` slots.
    const messages = await loadReplyContextMessages(ctx, args.threadId, effectiveMode, MAX_CONTEXT_MESSAGES);

    // `discuss` mode is "no repo, no sandbox" by design (per the schema/resolver
    // contract): even if the thread has a repositoryId attached, the user has
    // explicitly asked for an unattached / training-only conversation, so we
    // return the same shape as the repo-less branch and skip every
    // repo-scoped lookup. This is also why `discuss` is grouped with the
    // no-repo case here rather than with `docs`/`sandbox` below.
    if (!thread.repositoryId || effectiveMode === "discuss") {
      return {
        ownerTokenIdentifier: thread.ownerTokenIdentifier,
        mode: effectiveMode,
        repositorySummary: undefined,
        readmeSummary: undefined,
        architectureSummary: undefined,
        sourceRepoFullName: undefined,
        artifacts: [],
        chunks: [],
        messages: messages.map((message) => ({
          id: message._id,
          role: message.role,
          content: message.content,
        })),
      };
    }

    const repository = await ctx.db.get(thread.repositoryId);
    if (!repository) {
      throw new Error("Repository not found.");
    }

    const artifacts =
      effectiveMode === "docs"
        ? await loadLatestDocsArtifacts(ctx, repository._id)
        : [
            ...(repository.latestImportJobId
              ? await ctx.db
                  .query("artifacts")
                  .withIndex("by_jobId", (q) => q.eq("jobId", repository.latestImportJobId!))
                  .take(10)
              : []),
            ...(await ctx.db
              .query("artifacts")
              .withIndex("by_repositoryId_and_kind", (q) =>
                q.eq("repositoryId", repository._id).eq("kind", "deep_analysis"),
              )
              .order("desc")
              .take(10)),
          ];
    // Phase 4 rollout: `docs` mode is artifact-only retrieval. We intentionally
    // stop pulling indexed code chunks in this mode so knowledge sources stay
    // non-overlapping (`docs` => artifacts, `sandbox` => live/code-grounded).
    // `discuss` is handled by the early return above.
    //
    // The search query is taken from the *queued* user message, not from
    // "the latest user message in the window" — that keeps chunk selection
    // consistent with the mode anchor above when sends are concurrent.
    const chunks =
      effectiveMode === "docs"
        ? []
        : repository.latestImportId
          ? await loadCandidateChunks(ctx, repository.latestImportId, userMessage.content)
          : [];

    return {
      ownerTokenIdentifier: repository.ownerTokenIdentifier,
      mode: effectiveMode,
      repositorySummary: repository.summary,
      readmeSummary: repository.readmeSummary,
      architectureSummary: repository.architectureSummary,
      sourceRepoFullName: repository.sourceRepoFullName,
      artifacts: artifacts.map((artifact) => ({
        id: artifact._id,
        title: artifact.title,
        summary: artifact.summary,
        contentMarkdown: artifact.contentMarkdown,
      })),
      chunks: chunks.map((chunk) => ({
        path: chunk.path,
        summary: chunk.summary,
        content: chunk.content,
      })),
      messages: messages.map((message) => ({
        id: message._id,
        role: message.role,
        content: message.content,
      })),
    };
  },
});
