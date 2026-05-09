import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const repositoryStatus = v.union(
  v.literal("idle"),
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

const importStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("cancelled"),
  v.literal("failed"),
);

const jobKind = v.union(
  v.literal("import"),
  v.literal("index"),
  v.literal("deep_analysis"),
  v.literal("chat"),
  v.literal("cleanup"),
);

const jobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const sandboxStatus = v.union(
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("stopped"),
  v.literal("archived"),
  v.literal("failed"),
);

const daytonaWebhookEventStatus = v.union(
  v.literal("received"),
  v.literal("processing"),
  v.literal("processed"),
  v.literal("ignored"),
  v.literal("retryable_error"),
  v.literal("dead_letter"),
);

const normalizedRemoteSandboxState = v.union(
  v.literal("started"),
  v.literal("stopped"),
  v.literal("archived"),
  v.literal("destroyed"),
  v.literal("error"),
  v.literal("unknown"),
);

const sandboxRemoteDiscoveryStatus = v.union(
  v.literal("known"),
  v.literal("unknown_pending_confirmation"),
  v.literal("confirmed_orphan"),
  v.literal("deleted"),
  v.literal("ignored"),
);

const artifactKind = v.union(
  v.literal("manifest"),
  v.literal("readme_summary"),
  v.literal("architecture_overview"),
  v.literal("architecture_diagram"),
  v.literal("entrypoints"),
  v.literal("dependency_overview"),
  v.literal("deep_analysis"),
  v.literal("risk_report"),
  v.literal("adr"),
  v.literal("failure_mode_analysis"),
  v.literal("trade_off_matrix"),
  v.literal("migration_plan"),
  v.literal("capacity_estimate"),
  v.literal("design_review"),
);

/**
 * Chat mode persisted on `threads.mode` and `messages.mode`. The enum mirrors
 * the UI's mode selector verbatim (no legacy quick/deep aliasing) per the PRD's
 * Architectural reversal section: frontend and backend share one vocabulary.
 *
 * - `discuss`  — LLM training only; no repo, no sandbox.
 * - `docs`     — RAG over the user's accumulated artifacts for the attached
 *                repository. Requires `thread.repositoryId`.
 * - `sandbox`  — live filesystem + execution in a Daytona sandbox. Requires
 *                `thread.repositoryId` and the repo's latest sandbox to be
 *                in `ready` state at send time.
 *
 * Mode preconditions (repo-required, sandbox-required) are enforced in
 * `chat.sendMessage` / `chat.createThread`, not in the schema.
 */
const threadMode = v.union(v.literal("discuss"), v.literal("docs"), v.literal("sandbox"));

const messageRole = v.union(v.literal("system"), v.literal("user"), v.literal("assistant"), v.literal("tool"));

/**
 * Plan 07 — `cancelled` joins the terminal-state set alongside `completed` /
 * `failed`. Used when the owner stops their own in-flight reply via
 * `chat.cancel.cancelInFlightReply`. Distinct from `failed` because:
 *
 *   - the message body is not an error — partial content is still useful;
 *   - the status label should read "Cancelled" (not "Failed") in the UI;
 *   - audit trails / metrics should distinguish user intent from upstream
 *     failures.
 *
 * Schema migration: pure widen (the union now accepts an additional literal
 * the database has never previously held). No backfill — existing rows still
 * map cleanly to one of the four legacy values.
 */
const messageStatus = v.union(
  v.literal("pending"),
  v.literal("streaming"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const workspaceColor = v.union(
  v.literal("blue"),
  v.literal("emerald"),
  v.literal("amber"),
  v.literal("violet"),
  v.literal("rose"),
  v.literal("cyan"),
  v.literal("orange"),
  v.literal("teal"),
);

export default defineSchema({
  workspaces: defineTable({
    ownerTokenIdentifier: v.string(),
    repositoryId: v.optional(v.id("repositories")),
    name: v.string(),
    color: workspaceColor,
    lastAccessedAt: v.number(),
  })
    .index("by_ownerTokenIdentifier_and_lastAccessedAt", ["ownerTokenIdentifier", "lastAccessedAt"])
    .index("by_ownerTokenIdentifier_and_repositoryId", ["ownerTokenIdentifier", "repositoryId"]),

  /**
   * Per-viewer key-value preferences that need to follow the user across
   * devices. Today this only carries the last active workspace so that
   * re-entering the app on a different browser converges to the same
   * selection; future user-level prefs (default chat mode, theme, etc.)
   * extend this table without touching the workspace data model.
   *
   * Source-of-truth boundary: `lastActiveWorkspaceId` is the canonical
   * "current workspace" for a viewer. The frontend keeps a localStorage
   * cache for first-paint, but on conflict the DB wins (see
   * `docs/workspace-persistence-system-design.md`).
   */
  userPreferences: defineTable({
    ownerTokenIdentifier: v.string(),
    lastActiveWorkspaceId: v.optional(v.id("workspaces")),
    lastActiveWorkspaceUpdatedAt: v.optional(v.number()),
  }).index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"]),

  repositories: defineTable({
    ownerTokenIdentifier: v.string(),
    sourceHost: v.literal("github"),
    sourceUrl: v.string(),
    sourceRepoFullName: v.string(),
    sourceRepoOwner: v.string(),
    sourceRepoName: v.string(),
    defaultBranch: v.optional(v.string()),
    visibility: v.union(v.literal("public"), v.literal("private"), v.literal("unknown")),
    accessMode: v.union(v.literal("public"), v.literal("private")),
    importStatus: repositoryStatus,
    latestImportId: v.optional(v.id("imports")),
    latestImportJobId: v.optional(v.id("jobs")),
    latestAnalysisJobId: v.optional(v.id("jobs")),
    latestSandboxId: v.optional(v.id("sandboxes")),
    defaultThreadId: v.optional(v.id("threads")),
    summary: v.optional(v.string()),
    readmeSummary: v.optional(v.string()),
    architectureSummary: v.optional(v.string()),
    detectedLanguages: v.array(v.string()),
    packageManagers: v.array(v.string()),
    entrypoints: v.array(v.string()),
    fileCount: v.number(),
    lastImportedAt: v.optional(v.number()),
    lastIndexedAt: v.optional(v.number()),
    lastSyncedCommitSha: v.optional(v.string()),
    latestRemoteSha: v.optional(v.string()),
    lastCheckedForUpdatesAt: v.optional(v.number()),
    deletionRequestedAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
  })
    .index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"])
    .index("by_ownerTokenIdentifier_and_deletionRequestedAt_and_importedAt", [
      "ownerTokenIdentifier",
      "deletionRequestedAt",
      "lastImportedAt",
    ])
    .index("by_ownerTokenIdentifier_and_sourceUrl_and_deletionRequestedAt", [
      "ownerTokenIdentifier",
      "sourceUrl",
      "deletionRequestedAt",
    ])
    .index("by_ownerTokenIdentifier_and_archivedAt", ["ownerTokenIdentifier", "archivedAt"])
    .index("by_sourceRepoFullName", ["sourceRepoFullName"])
    .searchIndex("search_full_name", {
      searchField: "sourceRepoFullName",
      filterFields: ["ownerTokenIdentifier"],
    }),

  imports: defineTable({
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    sourceUrl: v.string(),
    branch: v.optional(v.string()),
    adapterKind: v.union(v.literal("git_clone"), v.literal("source_service")),
    status: importStatus,
    jobId: v.id("jobs"),
    sandboxId: v.optional(v.id("sandboxes")),
    remoteSandboxId: v.optional(v.string()),
    commitSha: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_repositoryId", ["repositoryId"])
    .index("by_jobId", ["jobId"])
    .index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"]),

  sandboxes: defineTable({
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    provider: v.literal("daytona"),
    sourceAdapter: v.union(v.literal("git_clone"), v.literal("source_service")),
    remoteId: v.string(),
    status: sandboxStatus,
    workDir: v.string(),
    repoPath: v.string(),
    cpuLimit: v.number(),
    memoryLimitGiB: v.number(),
    diskLimitGiB: v.number(),
    ttlExpiresAt: v.number(),
    autoStopIntervalMinutes: v.number(),
    autoArchiveIntervalMinutes: v.number(),
    autoDeleteIntervalMinutes: v.number(),
    networkBlockAll: v.boolean(),
    networkAllowList: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    lastErrorMessage: v.optional(v.string()),
  })
    .index("by_repositoryId", ["repositoryId"])
    .index("by_remoteId", ["remoteId"])
    .index("by_status_and_ttlExpiresAt", ["status", "ttlExpiresAt"]),

  jobs: defineTable({
    repositoryId: v.optional(v.id("repositories")),
    ownerTokenIdentifier: v.string(),
    sandboxId: v.optional(v.id("sandboxes")),
    threadId: v.optional(v.id("threads")),
    kind: jobKind,
    status: jobStatus,
    stage: v.string(),
    progress: v.number(),
    costCategory: v.union(v.literal("indexing"), v.literal("deep_analysis"), v.literal("chat"), v.literal("ops")),
    triggerSource: v.union(v.literal("user"), v.literal("system")),
    requestedCommand: v.optional(v.string()),
    outputSummary: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    estimatedInputTokens: v.optional(v.number()),
    estimatedOutputTokens: v.optional(v.number()),
    estimatedCostUsd: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
  })
    .index("by_repositoryId", ["repositoryId"])
    .index("by_threadId", ["threadId"])
    .index("by_threadId_and_kind_and_status_and_leaseExpiresAt", ["threadId", "kind", "status", "leaseExpiresAt"])
    .index("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", [
      "repositoryId",
      "kind",
      "status",
      "leaseExpiresAt",
    ])
    .index("by_status_and_kind_and_leaseExpiresAt", ["status", "kind", "leaseExpiresAt"])
    .index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"]),

  daytonaWebhookEvents: defineTable({
    providerDeliveryId: v.optional(v.string()),
    dedupeKey: v.string(),
    eventType: v.union(v.literal("sandbox.created"), v.literal("sandbox.state.updated")),
    remoteId: v.string(),
    organizationId: v.string(),
    eventTimestamp: v.number(),
    normalizedState: v.optional(normalizedRemoteSandboxState),
    payloadJson: v.string(),
    status: daytonaWebhookEventStatus,
    attemptCount: v.number(),
    nextAttemptAt: v.number(),
    processingLeaseExpiresAt: v.optional(v.number()),
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
    lastErrorMessage: v.optional(v.string()),
    retentionExpiresAt: v.number(),
  })
    .index("by_dedupeKey", ["dedupeKey"])
    .index("by_remoteId", ["remoteId"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_status_and_processingLeaseExpiresAt", ["status", "processingLeaseExpiresAt"])
    .index("by_retentionExpiresAt", ["retentionExpiresAt"]),

  sandboxRemoteObservations: defineTable({
    remoteId: v.string(),
    sandboxId: v.optional(v.id("sandboxes")),
    repositoryId: v.optional(v.id("repositories")),
    organizationId: v.string(),
    lastObservedState: normalizedRemoteSandboxState,
    lastObservedAt: v.number(),
    lastWebhookAt: v.number(),
    lastAcceptedEventAt: v.number(),
    discoveryStatus: sandboxRemoteDiscoveryStatus,
    firstSeenAt: v.number(),
    confirmAfterAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_remoteId", ["remoteId"])
    .index("by_discoveryStatus_and_confirmAfterAt", ["discoveryStatus", "confirmAfterAt"]),

  artifacts: defineTable({
    repositoryId: v.optional(v.id("repositories")),
    threadId: v.optional(v.id("threads")),
    jobId: v.optional(v.id("jobs")),
    ownerTokenIdentifier: v.string(),
    kind: artifactKind,
    title: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
    source: v.union(v.literal("heuristic"), v.literal("llm"), v.literal("sandbox")),
    version: v.number(),
  })
    .index("by_repositoryId", ["repositoryId"])
    .index("by_repositoryId_and_kind", ["repositoryId", "kind"])
    .index("by_threadId", ["threadId"])
    .index("by_threadId_and_kind", ["threadId", "kind"])
    .index("by_jobId", ["jobId"])
    .index("by_jobId_and_kind", ["jobId", "kind"]),

  repoFiles: defineTable({
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    importId: v.id("imports"),
    path: v.string(),
    parentPath: v.string(),
    fileType: v.union(v.literal("file"), v.literal("dir")),
    extension: v.optional(v.string()),
    language: v.optional(v.string()),
    sizeBytes: v.number(),
    isEntryPoint: v.boolean(),
    isConfig: v.boolean(),
    isImportant: v.boolean(),
    summary: v.optional(v.string()),
  })
    .index("by_repositoryId_and_path", ["repositoryId", "path"])
    .index("by_repositoryId_and_parentPath", ["repositoryId", "parentPath"])
    .index("by_importId", ["importId"])
    .index("by_importId_and_path", ["importId", "path"]),

  repoChunks: defineTable({
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    importId: v.id("imports"),
    fileId: v.id("repoFiles"),
    path: v.string(),
    chunkIndex: v.number(),
    startLine: v.number(),
    endLine: v.number(),
    chunkKind: v.union(v.literal("code"), v.literal("summary"), v.literal("readme")),
    symbolName: v.optional(v.string()),
    symbolKind: v.optional(v.string()),
    summary: v.string(),
    content: v.string(),
  })
    .index("by_repositoryId_and_path", ["repositoryId", "path"])
    .index("by_fileId_and_chunkIndex", ["fileId", "chunkIndex"])
    .index("by_importId_and_path_and_chunkIndex", ["importId", "path", "chunkIndex"])
    .searchIndex("search_summary", {
      searchField: "summary",
      filterFields: ["importId"],
      staged: false,
    })
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["importId"],
      staged: false,
    }),

  threads: defineTable({
    workspaceId: v.optional(v.id("workspaces")),
    repositoryId: v.optional(v.id("repositories")),
    ownerTokenIdentifier: v.string(),
    title: v.string(),
    mode: threadMode,
    lastMessageAt: v.number(),
    lastAssistantMessageAt: v.optional(v.number()),
  })
    .index("by_repositoryId_and_lastMessageAt", ["repositoryId", "lastMessageAt"])
    .index("by_ownerTokenIdentifier_and_lastMessageAt", ["ownerTokenIdentifier", "lastMessageAt"])
    .index("by_workspaceId_and_lastMessageAt", ["workspaceId", "lastMessageAt"]),

  messages: defineTable({
    repositoryId: v.optional(v.id("repositories")),
    threadId: v.id("threads"),
    jobId: v.optional(v.id("jobs")),
    ownerTokenIdentifier: v.string(),
    role: messageRole,
    status: messageStatus,
    mode: threadMode,
    content: v.string(),
    errorMessage: v.optional(v.string()),
    estimatedInputTokens: v.optional(v.number()),
    estimatedOutputTokens: v.optional(v.number()),
    /**
     * Plan 10 — per-message cost estimate in USD, computed from the
     * model's reported usage and a snapshot pricing table at finalize
     * time (`convex/lib/openaiPricing.ts`). Used by:
     *
     *   1. The chat bubble cost-ticker ("~$0.03 (1.2k tokens, 5 tools)")
     *      so the user can correlate spend to specific replies.
     *   2. Audit / debugging — `messages.estimatedCostUsd` plus
     *      `jobs.estimatedCostUsd` lets us reconcile the per-message
     *      cost against the per-job total when an investigation needs
     *      a finer breakdown than the job-level rollup.
     *
     * Optional + only written for assistant replies whose model is in the
     * pricing table; messages predating Plan 10 (and discuss / docs
     * heuristic replies) keep the field unset rather than stored as 0,
     * so the frontend can render "—" instead of "$0.00" when cost is
     * genuinely unknown vs. genuinely zero.
     */
    estimatedCostUsd: v.optional(v.number()),
    /**
     * Numbered artifact citation map for `docs` mode replies. Index 1 in the
     * array is the artifact the prompt rendered as `## [A1] …`, index 2 the
     * `[A2]` artifact, and so on. The frontend uses this to turn `[A#]`
     * tokens in the assistant's content into links that jump to the right
     * artifact in the side panel. Optional + only written when the reply
     * actually had artifacts in scope (docs mode), so messages predating
     * Plan 02 stay valid without backfill (widen-migrate-narrow).
     */
    citationMap: v.optional(
      v.array(
        v.object({
          index: v.number(),
          artifactId: v.id("artifacts"),
        }),
      ),
    ),
    /**
     * Plan 06 — frozen tool-call trace for finalized assistant replies.
     *
     * Folded from the ephemeral `messageToolCallEvents` table at finalize
     * time so the durable `messages` row carries the full, post-streaming
     * trace without joining a second table. Optional + only written when the
     * reply actually ran tools, so messages predating Plan 06 (and any non-
     * sandbox reply) keep the field unset rather than `[]` — the frontend
     * treats both as "no trace".
     *
     * Each entry corresponds to *one* tool invocation, correlated by the AI
     * SDK's `toolCallId` during folding. Multiple calls of the same tool
     * (e.g. two `read_file`s in the same reply) appear as distinct entries
     * in execution order. `inputSummary` / `outputSummary` are already
     * redaction-passed (see `convex/chat/redaction.ts`) and capped in size
     * to keep the document under Convex's 1 MB row limit on long replies.
     *
     * `startedAt` / `endedAt` are wall-clock millisecond epochs from the
     * action's perspective — a tool that completed has `endedAt > startedAt`;
     * a tool whose `end` event was lost (mid-stream cancellation, server
     * crash) has `endedAt === startedAt` and is rendered as "interrupted"
     * by the trace UI.
     */
    toolCalls: v.optional(
      v.array(
        v.object({
          toolCallId: v.string(),
          toolName: v.string(),
          inputSummary: v.string(),
          outputSummary: v.string(),
          startedAt: v.number(),
          endedAt: v.number(),
          errorCode: v.optional(v.string()),
        }),
      ),
    ),
    /**
     * Plan 11 — sandbox-mode citation lint output.
     *
     * Half-open `[start, end)` offsets into `messages.content` marking
     * sentences the model emitted without either (a) a `[path:line]`
     * citation pointing at a tool-verified source, or (b) the literal
     * `Unverified:` excuse prefix the system prompt teaches. Used by the
     * chat bubble to render a soft yellow `<mark>` underline so the user
     * can read flagged sentences with extra skepticism — non-blocking by
     * design (we never reject the model's output).
     *
     * Computed by `convex/chat/citationLint.ts:lintCitations` at finalize
     * / fail / cancel time. Optional + only written for sandbox-mode
     * replies that produced at least one flagged sentence; messages
     * predating Plan 11 (and discuss / docs replies) keep the field
     * unset rather than `[]` — the renderer treats both as "no
     * highlights", so this matches the widen-migrate-narrow contract
     * documented in `docs/sandbox-mode-system-design.md`.
     *
     * Capped at `MAX_UNVERIFIED_CLAIMS_PER_MESSAGE` (50) inside the lint
     * function so a runaway pathological reply cannot push the message
     * document past Convex's 1 MB row limit. Offsets are over UTF-16
     * code units, the same indexing the renderer uses to slice the
     * content, so `content.slice(start, end)` round-trips losslessly to
     * the flagged sentence text.
     */
    unverifiedClaims: v.optional(
      v.array(
        v.object({
          start: v.number(),
          end: v.number(),
        }),
      ),
    ),
  })
    .index("by_threadId", ["threadId"])
    .index("by_threadId_and_status", ["threadId", "status"])
    .index("by_jobId", ["jobId"]),

  /**
   * Application invariant: each assistant reply owns at most one `messageStreams`
   * row per `assistantMessageId` and per `jobId`; its `messageStreamChunks`
   * rows are the canonical persisted tail for that singleton stream.
   */
  messageStreams: defineTable({
    repositoryId: v.optional(v.id("repositories")),
    threadId: v.id("threads"),
    jobId: v.id("jobs"),
    assistantMessageId: v.id("messages"),
    ownerTokenIdentifier: v.string(),
    compactedContent: v.string(),
    compactedThroughSequence: v.number(),
    nextSequence: v.number(),
    startedAt: v.number(),
    lastAppendedAt: v.number(),
  })
    .index("by_threadId", ["threadId"])
    .index("by_assistantMessageId", ["assistantMessageId"])
    .index("by_jobId", ["jobId"]),

  /**
   * `messageStreamChunks` only belong to that single canonical `messageStreams`
   * row and should never be shared across duplicate stream records.
   */
  messageStreamChunks: defineTable({
    streamId: v.id("messageStreams"),
    sequence: v.number(),
    text: v.string(),
  }).index("by_streamId_and_sequence", ["streamId", "sequence"]),

  /**
   * Plan 06 — ephemeral tool-call event log used to drive the live ticker
   * and to fold a durable `messages.toolCalls` trace at finalize time.
   *
   * Lifecycle (per assistant reply):
   *   1. `appendAssistantToolCallEvent` writes a `start` row when the AI
   *      SDK's `fullStream` emits `tool-call`, then an `end` row when the
   *      same `toolCallId` emits `tool-result` or `tool-error`.
   *   2. `getMessageToolCallEvents` (subscribable query) lets the frontend
   *      reactively render the running tool while the reply streams.
   *   3. `finalizeAssistantReply` / `failAssistantReply` /
   *      `recoverStaleChatJob` fold these rows into `messages.toolCalls`
   *      (paired by `toolCallId`) and drain them in the same transaction.
   *
   * Why a separate table (rather than appending to a `messages` array):
   *   - Convex documents are rewritten in full on every patch. An array
   *     field that gets two writes per tool call would re-marshal the
   *     entire `messages` row each time, contending with the durable
   *     `content` patch on every flush.
   *   - The `by_messageId_and_sequence` index gives the live query an
   *     O(events-per-message) scan with stable ordering, independent of
   *     row insertion order on the underlying table.
   *
   * Field notes:
   *   - `toolCallId` is the AI SDK's correlation key. Folding pairs the
   *     `start` row to its `end` row by this id, so two calls of the same
   *     `toolName` (e.g. two `read_file`s) stay distinct in the persisted
   *     trace.
   *   - `sequence` is a per-message monotonically-increasing counter
   *     allocated at insert time (`max(sequence)+1`). Stable order is the
   *     contract the frontend relies on for ticker UX — the AI SDK does
   *     not guarantee event ordering across `fullStream` consumers.
   *   - `occurredAt` is wall-clock at the time of the event. Used to
   *     derive `startedAt`/`endedAt` durations in the trace; we do *not*
   *     reuse `_creationTime` for this because the row may have been
   *     written long after the underlying tool started (e.g. `end` event
   *     after a slow shell command).
   *   - `inputSummary` / `outputSummary` are pre-redacted (Plan 05) and
   *     length-capped in `chat/streaming.ts` so a runaway tool result
   *     can't exceed Convex's 1 MB document size when folded into
   *     `messages.toolCalls`.
   */
  messageToolCallEvents: defineTable({
    messageId: v.id("messages"),
    toolCallId: v.string(),
    sequence: v.number(),
    type: v.union(v.literal("start"), v.literal("end")),
    toolName: v.string(),
    inputSummary: v.string(),
    outputSummary: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    occurredAt: v.number(),
  }).index("by_messageId_and_sequence", ["messageId", "sequence"]),

  /**
   * Plan 12 — Sandbox tool-call audit log.
   *
   * One row per *completed* sandbox tool execution (success or tool-reported
   * error). Distinct from `messageToolCallEvents` (Plan 06's ephemeral
   * ticker feed, drained at finalize) and `messages.toolCalls` (Plan 06's
   * frozen per-message trace, lives as long as the parent message): this
   * table is the long-lived compliance / internal-debugging trail. It
   * outlives individual messages so a thread deletion does not erase the
   * record of which files were read or which commands were run.
   *
   * Lifecycle:
   *   - **Append**: written from `convex/chat/generation.ts` once per
   *     `tool-result` / `tool-error` event the AI SDK surfaces, *after*
   *     the matching Plan 06 event row, via
   *     `convex/chat/sandboxToolCallLog.ts:recordSandboxToolCallLogEntry`.
   *   - **Query**: `by_owner_and_time` answers "what user X did between
   *     time A and B"; the implicit `_creationTime` secondary sort
   *     delivers the time component without an extra field.
   *     `by_message` lets a future audit consumer or debugging session
   *     pivot from a specific assistant message into the tool calls it
   *     ran.
   *   - **Retain**: 90 days, enforced by the daily cron
   *     `cleanupExpiredSandboxToolCallLogs`. Time-based retention only —
   *     parent deletion (thread / repo cascades) intentionally does *not*
   *     drain this table, so a user-initiated delete cannot erase the
   *     compliance trail mid-window. The 90-day TTL bounds growth.
   *
   * Field notes:
   *   - `inputJson` is the redacted, JSON-stringified tool input (`part.input`
   *     from the AI SDK). The mutation re-caps via
   *     `SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS` (2000) — distinct from
   *     Plan 06's UI-visible 600-char cap so audit recording preserves
   *     more of long `run_shell` invocations.
   *   - `outputBytes` is the byte length of the JSON-stringified tool
   *     output (`part.output`), pre-redaction. The audit log deliberately
   *     does *not* duplicate the output payload — `messages.toolCalls`
   *     already stores a 600-char redacted summary; this table just
   *     records the volume.
   *   - `durationMs` is the wall-clock time between the AI SDK's
   *     `tool-call` event and its matching `tool-result` / `tool-error`,
   *     measured by the action.
   *   - `errorCode` mirrors the tool's reported `errorCode` on
   *     `ok: false` envelopes; `"tool_error"` on AI SDK `tool-error`
   *     events; absent on success.
   *   - `redactedFields` carries the success envelope's `redactedTypes`
   *     (closed set in `convex/chat/redaction.ts`) so audit consumers
   *     can detect "this tool call had a secret in the response" without
   *     reading the response itself. Empty on error envelopes.
   */
  sandboxToolCallLog: defineTable({
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
  })
    .index("by_owner_and_time", ["ownerTokenIdentifier"])
    .index("by_message", ["messageId"]),

  githubInstallations: defineTable({
    ownerTokenIdentifier: v.string(),
    installationId: v.number(),
    accountLogin: v.string(),
    accountType: v.union(v.literal("User"), v.literal("Organization")),
    status: v.union(v.literal("active"), v.literal("suspended"), v.literal("deleted")),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
    connectedAt: v.number(),
    suspendedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"])
    .index("by_ownerTokenIdentifier_and_status", ["ownerTokenIdentifier", "status"])
    .index("by_installationId", ["installationId"]),

  githubOAuthStates: defineTable({
    state: v.string(),
    ownerTokenIdentifier: v.string(),
    returnTo: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    consumed: v.boolean(),
  })
    .index("by_state", ["state"])
    .index("by_expiresAt", ["expiresAt"]),
});
