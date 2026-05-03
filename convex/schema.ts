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

const messageStatus = v.union(
  v.literal("pending"),
  v.literal("streaming"),
  v.literal("completed"),
  v.literal("failed"),
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
  })
    .index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"])
    .index("by_ownerTokenIdentifier_and_lastImportedAt", ["ownerTokenIdentifier", "lastImportedAt"])
    .index("by_ownerTokenIdentifier_and_sourceUrl", ["ownerTokenIdentifier", "sourceUrl"])
    .index("by_sourceRepoFullName", ["sourceRepoFullName"]),

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
    .index("by_repositoryId_and_status", ["repositoryId", "status"])
    .index("by_threadId", ["threadId"])
    .index("by_status_and_leaseExpiresAt", ["status", "leaseExpiresAt"])
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
