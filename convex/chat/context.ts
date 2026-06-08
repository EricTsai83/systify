import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { resolveDiscussGrounding } from "../lib/chatMode";
import { MAX_CONTEXT_MESSAGES } from "../lib/constants";
import type { ReasoningEffort } from "../lib/llmCatalog";
import type { LlmProvider } from "../lib/llmProvider";
import { loadViewerCustomization, type UserCustomizationPreferences } from "../lib/userPreferences";
import type { ExtendedChatMode } from "./prompting";

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
   * row has no per-message `mode` set.
   *
   * Exposed on the context so `generation.ts` can hand it to
   * `buildSystemPrompt` without re-deriving the rule.
   */
  mode: ExtendedChatMode;
  /**
   * Per-message grounding flags anchored to the queued user message.
   * Meaningful only on `mode === "discuss"` — Library mode leaves both
   * unset and uses the implicit artifact-grounded contract. Both default
   * to `false` when unset. `generation.ts` reads these to decide which
   * system prompt block to compose and whether to wire sandbox tools.
   */
  groundLibrary: boolean;
  groundSandbox: boolean;
  /**
   * Provider + model the user picked at send time (`messages.provider /
   * messages.modelName` on the queued user message). Anchored to the
   * queued message so the action uses the same pair the user picked
   * even if a later send into the same thread chose a different model.
   *
   * Optional because pre-PR-A3 messages have neither field — the action
   * falls back to the capability default via `resolveModelForReply`
   * when both are absent.
   */
  provider?: LlmProvider;
  modelName?: string;
  /**
   * Per-message reasoning-effort override (`messages.reasoningEffort`),
   * pinned at send time. Forwarded into `resolveModelForReply` so the
   * resolved `modelChoice.reasoningEffort` reflects what the user picked
   * for *this* send rather than the catalog entry's default. Optional —
   * absent on legacy messages, on Anthropic Haiku replies where the
   * picker hides itself, and on every send where the user accepted the
   * model's default effort.
   */
  reasoningEffort?: ReasoningEffort;
  customization: UserCustomizationPreferences;
  repositoryId?: Id<"repositories">;
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
  artifactChunks?: Array<{
    chunkId: Id<"artifactChunks">;
    artifactId: Id<"artifacts">;
    artifactTitle: string;
    artifactKind: Doc<"artifacts">["kind"];
    headingPath: string[];
    content: string;
    lexicalScore: number;
    semanticScore: number;
    rrfScore: number;
  }>;
  artifactContext?: Id<"artifacts">[];
  chunks: Array<{ path: string; summary: string; content: string }>;
  messages: Array<{ id: Id<"messages">; role: "user" | "assistant" | "system" | "tool"; content: string }>;
  /**
   * Sandbox-tool wiring snapshot. Populated only when the queued user
   * message has `groundSandbox: true` AND the repository already has a
   * ready sandbox at context-query time.
   *
   * This is no longer the source of truth for whether Sandbox grounding
   * should use tools. The Node generation action calls `ensureSandboxReady`
   * for every sandbox-grounded reply and replaces this handle with the
   * prepared live-source handle before constructing final tools. Keeping
   * this snapshot available is useful for ready-cache tests and legacy
   * call sites, but missing/stopped/failed/provisioning rows should not
   * be interpreted as "answer without tools."
   *
   * The fields are everything the action needs to construct a
   * `SandboxFsClient`, pass it to `createSandboxTools`, and record audit
   * log entries for every tool execution:
   *
   *   - `sandboxId` — Convex-side sandbox row id. The audit log
   *     (`sandboxToolCallLog.sandboxId`) keys against this so a future
   *     forensic query can correlate "user X's tool calls" with a
   *     specific sandbox lifecycle. Surfacing it from the context query
   *     (rather than re-fetching the sandbox row in the action) keeps the
   *     lookup transactional with the `(thread, sandbox, repository)`
   *     read.
   *   - `remoteId` — Daytona-side sandbox identifier (`sandboxes.remoteId`).
   *   - `repoPath` — absolute path of the repository's root inside the
   *     sandbox, used to scope every tool call's path validation.
   *
   * The action overwrites this with the `ensureSandboxReady` result before
   * calling the model, so audit logs always point at the sandbox that was
   * actually used for the reply.
   */
  sandboxTooling?: {
    sandboxId: Id<"sandboxes">;
    remoteId: string;
    repoPath: string;
  };
};

const DOCS_ARTIFACT_KINDS: Array<Doc<"artifacts">["kind"]> = [
  "architecture_diagram",
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
 * How aggressively `loadReplyContextMessages` over-fetches the
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
 * Filters applied while iterating from newest-first:
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
  effectiveMode: ExtendedChatMode,
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
    if (message.role === "assistant" && message.mode !== undefined && message.mode !== effectiveMode) {
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

export const getReplyContext = internalQuery({
  args: {
    threadId: v.id("threads"),
    /**
     * Anchor for mode and search-query derivation. Required so the same
     * message id that `generation.ts` is paired to determines both the
     * system prompt (via `userMessage.mode`) and the chunk-search query
     * (via `userMessage.content`). Deriving these from "the latest user
     * message in the window" is unsafe under concurrent send — a newer
     * message landing between queueing and generation would silently
     * take over both fields.
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
    // Per-message grounding flags only carry meaning on `discuss` replies.
    // Library mode ignores them — its grounding contract is implicit in
    // the mode. The resolver applies the same coercion as the queue-time
    // `chat.send.sendMessage` mutation, so a Library-mode row that
    // somehow carries a stray `groundLibrary: true` reads back as `false`
    // here without a one-off branch.
    const { groundLibrary, groundSandbox } = resolveDiscussGrounding(effectiveMode, userMessage);
    const customization = await loadViewerCustomization(ctx, thread.ownerTokenIdentifier);

    // Cross-mode filtering + empty-content filtering happen inside
    // `loadReplyContextMessages` so the helper can over-fetch a bounded
    // multiple of the cap and only then trim to MAX_CONTEXT_MESSAGES. Doing
    // both filters here in the caller would require re-applying
    // `take(MAX_CONTEXT_MESSAGES + 1)` semantics on top of an already-truncated
    // window, which silently shrinks the LLM-context view whenever a mode
    // switch left stale assistant rows in the most recent `limit` slots.
    const messages = await loadReplyContextMessages(ctx, args.threadId, effectiveMode, MAX_CONTEXT_MESSAGES);

    // Discuss with both grounding axes off is "training-only chat": no
    // repo lookup even if the thread has one attached, because the user
    // explicitly turned grounding off in the composer. The unattached-
    // thread branch shares the same empty shape — Library mode never
    // lands here (it always uses the repository-backed branch below).
    if (!thread.repositoryId || (effectiveMode === "discuss" && !groundLibrary && !groundSandbox)) {
      return {
        ownerTokenIdentifier: thread.ownerTokenIdentifier,
        mode: effectiveMode,
        groundLibrary,
        groundSandbox,
        provider: userMessage.provider,
        modelName: userMessage.modelName,
        reasoningEffort: userMessage.reasoningEffort,
        customization,
        repositoryId: undefined,
        repositorySummary: undefined,
        readmeSummary: undefined,
        architectureSummary: undefined,
        sourceRepoFullName: undefined,
        artifacts: [],
        artifactChunks: [],
        artifactContext: thread.artifactContext,
        chunks: [],
        messages: messages.map((message) => ({
          id: message._id,
          role: message.role,
          content: message.content,
        })),
      };
    }

    const repository = await ctx.db.get(thread.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== thread.ownerTokenIdentifier) {
      throw new Error("Repository not found.");
    }

    // Artifact retrieval is two-pronged:
    //   - Library mode always loads artifacts (Ask scope filter when
    //     present, latest docs artifacts otherwise).
    //   - Discuss mode loads artifacts only when the user enabled the
    //     Library grounding toggle for this message.
    //
    // Both branches read the same artifact set; the difference is the
    // toggle gate.
    let artifacts: Array<Doc<"artifacts">> = [];
    const shouldLoadArtifacts = effectiveMode === "library" || groundLibrary;
    if (shouldLoadArtifacts) {
      if (thread.artifactContext && thread.artifactContext.length > 0) {
        const scoped = await Promise.all(thread.artifactContext.map((artifactId) => ctx.db.get(artifactId)));
        artifacts = scoped.filter(
          (artifact): artifact is Doc<"artifacts"> =>
            artifact !== null &&
            artifact.repositoryId === repository._id &&
            artifact.ownerTokenIdentifier === repository.ownerTokenIdentifier,
        );
      } else {
        artifacts = await loadLatestDocsArtifacts(ctx, repository._id);
      }
    }

    // Library mode is artifact-only retrieval; sandbox-grounded Discuss
    // replies are tool-driven (the model fetches what it needs via
    // `read_file` / `list_dir` / `run_shell`). Both paths intentionally
    // skip pre-loaded code chunks so knowledge sources stay
    // non-overlapping (artifacts vs. live tool calls).
    const chunks: Array<{ path: string; summary: string; content: string }> = [];

    // Sandbox-tool wiring: surface the live sandbox handle here so the
    // action can build a `SandboxFsClient` without an extra fetch. We
    // only expose it when the message asked for sandbox grounding AND
    // the sandbox is in `ready` state — `provisioning`, `stopped`,
    // `archived`, and `failed` would all surface as a tool-call failure
    // mid-stream, which is much worse UX than answering without tools
    // and telling the user the sandbox isn't ready.
    let sandboxTooling: ReplyContext["sandboxTooling"];
    if (groundSandbox && repository.latestSandboxId) {
      const sandbox = await ctx.db.get(repository.latestSandboxId);
      if (sandbox?.status === "ready" && sandbox.remoteId && sandbox.repoPath) {
        sandboxTooling = {
          sandboxId: sandbox._id,
          remoteId: sandbox.remoteId,
          repoPath: sandbox.repoPath,
        };
      }
    }

    return {
      ownerTokenIdentifier: repository.ownerTokenIdentifier,
      mode: effectiveMode,
      groundLibrary,
      groundSandbox,
      provider: userMessage.provider,
      modelName: userMessage.modelName,
      reasoningEffort: userMessage.reasoningEffort,
      customization,
      repositoryId: repository._id,
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
      artifactChunks: [],
      artifactContext: thread.artifactContext,
      chunks,
      messages: messages.map((message) => ({
        id: message._id,
        role: message.role,
        content: message.content,
      })),
      sandboxTooling,
    };
  },
});
