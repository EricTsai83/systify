import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { chatModeValidator } from "./lib/chatMode";
import { systemDesignKindValidator } from "./lib/systemDesign";

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
  v.literal("system_design"),
  v.literal("chat"),
  v.literal("cleanup"),
  v.literal("sandbox_activation"),
);

/**
 * Structured failure categorisation for per-kind System Design failures.
 * Drives banner copy in `system-design-status-banner.tsx` without
 * regex-matching the raw `message`. Optional so rows without a reason
 * category fall through to the `transport_other` branch in the UI.
 *
 * Failure taxonomy:
 *   - `live_source_unavailable` — the live tree (sandbox / repo files) the
 *      kind needs to read was missing or unreachable.
 *   - `model_empty_output` — the LLM returned no usable text.
 *   - `transport_rate_limit` — provider 429 or gateway RPM / concurrency
 *      acquire that the retry layer exhausted.
 *   - `transport_other` — transport-level error (network / 5xx / SDK)
 *      that isn't a rate limit. This is the catch-all for
 *      provider-layer faults.
 *   - `output_quality` — LLM produced text, but quality-gates rejected it
 *      (missing required sections, missing Mermaid block, …).
 *   - `infra` — Convex-level / our-side bug surfaced into the kind loop
 *      (mutation error, action crash, schema validation, …). Engineering
 *      alerted.
 *
 * Migration note (widen-backfill-narrow): `other` is retained as a
 * temporary literal during the rollout window. Once the backfill
 * `rewriteLegacyKindFailureReason` has rewritten every `other` row to
 * `transport_other` and the operator has confirmed zero remaining
 * `other` rows in production, a follow-up commit will drop `other`
 * from this union. Do NOT write `other` from new code paths — the
 * retain-window is read-only.
 */
const kindFailureReason = v.union(
  v.literal("live_source_unavailable"),
  v.literal("model_empty_output"),
  v.literal("transport_rate_limit"),
  v.literal("transport_other"),
  v.literal("output_quality"),
  v.literal("infra"),
  // Retained during widen-backfill-narrow rollout; dropped in a follow-up commit.
  v.literal("other"),
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

/**
 * Retired artifact kinds (`manifest`, `adr`, `risk_report`) are NOT retained
 * here as historical literals — they were removed from the union outright.
 * The narrowing only deploys cleanly against a database with no `artifacts`
 * row carrying one of those kinds; Convex schema validation otherwise fails
 * on the first read of any retired-kind row. The branch that shipped this
 * removal was deployed against an early-access database that held none. If
 * a future environment may hold such rows, run a cleanup `internalMutation`
 * (or a widen-migrate-narrow migration through `@convex-dev/migrations`)
 * BEFORE deploying this schema. The same assumption applies to
 * `systemDesignKindValidator` (`jobs.selections`, `jobs.kindFailures`).
 */
const artifactKind = v.union(
  v.literal("readme_summary"),
  v.literal("architecture_overview"),
  v.literal("architecture_diagram"),
  v.literal("entrypoints"),
  v.literal("dependency_overview"),
  v.literal("trade_off_matrix"),
  v.literal("migration_plan"),
  v.literal("capacity_estimate"),
  v.literal("design_review"),
  v.literal("data_model_overview"),
  v.literal("api_surface_overview"),
  v.literal("deployment_overview"),
  v.literal("security_overview"),
  v.literal("operations_overview"),
);

/**
 * Chat mode persisted on `threads.mode` and `messages.mode`. The enum mirrors
 * the UI's mode switcher and URL segment verbatim — DB literal, URL path, and
 * UI label all use the same word.
 *
 * - `discuss`  — free-form chat with per-message Library / Sandbox
 *                grounding toggles (see `messages.groundLibrary` /
 *                `messages.groundSandbox`).
 * - `library`  — RAG over the user's accumulated artifacts for the
 *                attached repository.
 *
 * Mode preconditions (repo-required) are enforced in `chat.sendMessage` /
 * `chat.createThread`, not in the schema.
 */
const threadMode = chatModeValidator;

const messageRole = v.union(v.literal("system"), v.literal("user"), v.literal("assistant"), v.literal("tool"));

/**
 * `cancelled` joins the terminal-state set alongside `completed` / `failed`.
 * Used when the owner stops their own in-flight reply via
 * `chat.cancel.cancelInFlightReply`. Distinct from `failed` because:
 *
 *   - the message body is not an error — partial content is still useful;
 *   - the status label should read "Cancelled" (not "Failed") in the UI;
 *   - audit trails / metrics should distinguish user intent from upstream
 *     failures.
 */
const messageStatus = v.union(
  v.literal("pending"),
  v.literal("streaming"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const repositoryColor = v.union(
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
  /**
   * Per-viewer key-value preferences. `lastActiveRepositoryId` is the
   * canonical "current repository" pointer for a viewer; the frontend keeps
   * a localStorage cache for first-paint but on conflict the DB wins.
   */
  userPreferences: defineTable({
    ownerTokenIdentifier: v.string(),
    lastActiveRepositoryId: v.optional(v.id("repositories")),
    lastActiveRepositoryUpdatedAt: v.optional(v.number()),
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
    /**
     * Per-repository UI state. `color` is round-robin allocated on import
     * (see `pickNextRepositoryColor`), `lastAccessedAt` powers the sidebar's
     * recency ordering, `lastMode` keeps the user in the mode they last
     * visited.
     */
    color: repositoryColor,
    lastAccessedAt: v.number(),
    lastMode: v.optional(chatModeValidator),
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
    .index("by_ownerTokenIdentifier_and_lastAccessedAt", ["ownerTokenIdentifier", "lastAccessedAt"])
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
    costCategory: v.union(v.literal("indexing"), v.literal("system_design"), v.literal("chat"), v.literal("ops")),
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
    kindFailures: v.optional(
      v.array(
        v.object({
          kind: systemDesignKindValidator,
          errorId: v.string(),
          message: v.string(),
          reason: v.optional(kindFailureReason),
        }),
      ),
    ),
    /**
     * Snapshot of the user-selected `systemDesignKinds` that the action
     * was scheduled to generate. Persisted on the job row so a retry
     * surface (Library banner button, future audit view) can re-run the
     * same selection set without re-derivation from the failure list.
     */
    selections: v.optional(v.array(systemDesignKindValidator)),
  })
    .index("by_repositoryId", ["repositoryId"])
    .index("by_repositoryId_and_kind", ["repositoryId", "kind"])
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
    version: v.number(),
    /**
     * `folderId` ties an artifact to a user-created `artifactFolders` row.
     * Optional: artifacts with no `folderId` surface in the navigator's
     * "Uncategorized" virtual node.
     *
     * System Design model: every artifact kind lives inside the default
     * System Design folder tree that is seeded on repository import. The
     * folders themselves are user-editable (rename, move, delete) via
     * `artifactFolders.systemKey` for stable lookup.
     */
    folderId: v.optional(v.id("artifactFolders")),
    /**
     * Wall-clock ms epoch of the most recent sandbox-grounded verification.
     * Stamped by a sandbox-grounded reply when the LLM reads / re-reads the
     * live tree to confirm the artifact is still accurate. The Library tree
     * pills derive freshness purely from this column — an artifact is
     * "verified" iff this field is set.
     */
    lastVerifiedAt: v.optional(v.number()),
    /**
     * Chunking pipeline status.
     *   - `pending`  — just-updated; the indexer hasn't produced chunks yet.
     *   - `indexed`  — `artifactChunks` rows match the current
     *                  `lastChunkedVersion`; embeddings may still be
     *                  partial when an embed fallback is in effect.
     *   - `failed`   — embedding pipeline exhausted retries; the
     *                  `retryFailedArtifactIndexing` cron will pick the
     *                  row up again.
     */
    chunkingStatus: v.optional(v.union(v.literal("pending"), v.literal("indexed"), v.literal("failed"))),
    /**
     * Wall-clock ms epoch of the most recent successful chunk write. Used
     * by the cron to detect stuck `failed` rows and retry them after the
     * configured backoff.
     */
    lastChunkedAt: v.optional(v.number()),
    /**
     * Snapshot of `version` at the time the chunks were written. Used by
     * the indexer to detect "an update raced past me — my chunk write is
     * stale, abort" and by reads to confirm the chunks correspond to the
     * artifact's current version.
     */
    lastChunkedVersion: v.optional(v.number()),
    /**
     * Import traceability — commit SHA from the owning import snapshot when
     * prose was anchored to a particular clone. Compared against
     * `repositories.latestImportId` commit for the coarse import-drift signal.
     */
    alignedImportCommitSha: v.optional(v.string()),
    /**
     * Wall-clock ms epoch of the most recent user-facing content change
     * (title / summary / contentMarkdown). Distinct from `_creationTime`
     * so the navigator's "recently changed" pulse can light up for edits
     * to existing artifacts, not just new rows. Optional because rows
     * without a recorded edit timestamp fall back to `_creationTime`.
     */
    updatedAt: v.optional(v.number()),
  })
    .index("by_repositoryId", ["repositoryId"])
    .index("by_repositoryId_and_kind", ["repositoryId", "kind"])
    .index("by_repositoryId_and_folderId", ["repositoryId", "folderId"])
    .index("by_repositoryId_and_lastVerifiedAt", ["repositoryId", "lastVerifiedAt"])
    .index("by_folderId", ["folderId"])
    .index("by_threadId", ["threadId"])
    .index("by_threadId_and_kind", ["threadId", "kind"])
    .index("by_jobId", ["jobId"])
    .index("by_jobId_and_kind", ["jobId", "kind"])
    .index("by_chunkingStatus", ["chunkingStatus"]),

  /**
   * Per-viewer "I have seen this artifact" timestamps. Drives the Library
   * navigator's "changed since you last looked" dot — see
   * `useArtifactViewState` on the client. A row exists only after the
   * viewer first opens an artifact; absence means "never viewed" and the
   * client falls back to the repository's `_creationTime` so seed
   * artifacts (imported alongside the repo) don't flood the navigator.
   *
   *   - `ownerTokenIdentifier` scopes view state to the signed-in viewer
   *     so multi-device sync works without leaking state across users.
   *   - `repositoryId` is denormalized from the parent artifact so the
   *     per-repo list query can serve the navigator without a join.
   *   - At most one row exists per `(owner, artifact)`; `markViewed`
   *     upserts via `by_ownerTokenIdentifier_and_artifactId`.
   *   - `by_artifactId` powers cascade cleanup when an artifact is
   *     deleted (see `deleteArtifactInternal`).
   */
  artifactViews: defineTable({
    ownerTokenIdentifier: v.string(),
    repositoryId: v.id("repositories"),
    artifactId: v.id("artifacts"),
    viewedAt: v.number(),
  })
    .index("by_ownerTokenIdentifier_and_repositoryId", ["ownerTokenIdentifier", "repositoryId"])
    .index("by_ownerTokenIdentifier_and_artifactId", ["ownerTokenIdentifier", "artifactId"])
    .index("by_artifactId", ["artifactId"]),

  /**
   * Per-viewer "first time I opened this repository's Library" anchor.
   *
   * This is the floor below which artifacts are treated as "already
   * seen". Without it, rolling the view-state feature out on a
   * long-lived repository would flood the navigator with dots for every
   * artifact the viewer had already worked with through other surfaces.
   * The row is written the first time `useArtifactViewState` mounts for
   * a (viewer, repository) pair and never updated afterwards — its
   * timestamp is the canonical "you arrived here at this moment". One
   * row per `(ownerTokenIdentifier, repositoryId)`, enforced by the
   * `ensureRepositoryBootstrap` mutation.
   */
  repositoryViewerBootstraps: defineTable({
    ownerTokenIdentifier: v.string(),
    repositoryId: v.id("repositories"),
    bootstrapAt: v.number(),
  }).index("by_ownerTokenIdentifier_and_repositoryId", ["ownerTokenIdentifier", "repositoryId"]),

  /**
   * Folder model: folders are repository-scoped (one tree per
   * `repositoryId`), nestable through `parentFolderId`, and hold zero or
   * more artifacts via `artifacts.folderId`. The owner token enforces
   * per-viewer access in queries.
   *
   * Design notes:
   *   - `repositoryId` is required: folders don't make sense outside a
   *     repository.
   *   - `parentFolderId` is optional; root folders have it unset. The
   *     `by_repositoryId_and_parentFolderId` index lets the navigator pull a
   *     single level on demand and build the tree client-side.
   *   - `pinnedAt` lets the user pin folders to the top of the navigator,
   *     independent of alphabetical ordering. Every folder — seeded System
   *     Design folders included — starts unpinned; pinning is purely a
   *     user action toggled via the kebab menu. The navigator currently
   *     treats the field as a boolean (presence vs absence) and sorts
   *     pinned siblings alphabetically — the timestamp value is stored to
   *     mirror `threads.pinnedAt` so a future move to pinned-recent-first
   *     ordering can land without a schema change.
   */
  artifactFolders: defineTable({
    ownerTokenIdentifier: v.string(),
    repositoryId: v.id("repositories"),
    parentFolderId: v.optional(v.id("artifactFolders")),
    name: v.string(),
    description: v.optional(v.string()),
    pinnedAt: v.optional(v.number()),
    /**
     * Stable identifier for folders seeded by the System Design generator
     * (`overview`, `architecture`, `data_model`, `api`, `infrastructure`,
     * `security`, `operations`). Lets `generateSystemDesignDocs` find the
     * destination folder even after the user renames it, and lets the seeding
     * routine avoid recreating folders that already exist.
     */
    systemKey: v.optional(v.string()),
  })
    .index("by_repositoryId", ["repositoryId"])
    .index("by_repositoryId_and_parentFolderId", ["repositoryId", "parentFolderId"])
    .index("by_repositoryId_and_systemKey", ["repositoryId", "systemKey"])
    .index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"]),

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
    .index("by_repositoryId_and_chunkKind", ["repositoryId", "chunkKind"])
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
    repositoryId: v.optional(v.id("repositories")),
    ownerTokenIdentifier: v.string(),
    title: v.string(),
    mode: threadMode,
    lastMessageAt: v.number(),
    lastAssistantMessageAt: v.optional(v.number()),
    /**
     * Library Ask scope filter, read by the RAG retriever. Empty / undefined
     * means "search the whole repository" — does NOT mean "load these
     * artifacts as context"; the actual context shrink happens via
     * per-query top-N chunk retrieval. Capped at 20 ids by mutation
     * validators so the filter list itself stays small.
     */
    artifactContext: v.optional(v.array(v.id("artifacts"))),
    /**
     * Discuss thread → repository-level sandbox session pointer. The single
     * active sandbox session per repository is shared across every Discuss
     * thread whose user has enabled sandbox grounding, so thread switching
     * never re-provisions a sandbox. Optional and unused on `library` threads
     * and on Discuss threads that have never used sandbox grounding.
     */
    sandboxSessionId: v.optional(v.id("sandboxSessions")),
    /**
     * Composer defaults for Discuss threads — the initial toggle state when
     * the user opens an existing thread. Updated whenever the user sends a
     * Discuss message with a particular grounding flag combination so the
     * thread "remembers" their last preference. Unset on `library` threads
     * and on legacy Discuss threads created before this column existed;
     * consumers default both to `false` when absent.
     */
    defaultGroundLibrary: v.optional(v.boolean()),
    defaultGroundSandbox: v.optional(v.boolean()),
    /**
     * Wall-clock ms epoch when the viewer pinned this thread to the top of
     * their sidebar. Unset on unpin (drop the field via patch). The value
     * doubles as a tiebreaker — most-recently-pinned threads sort above
     * earlier-pinned ones when multiple are pinned in the same repository.
     */
    pinnedAt: v.optional(v.number()),
    /**
     * Whether the thread title has been explicitly edited by the user.
     * Prevents `generateThreadTitle` from overwriting a user-set title with
     * an autogenerated one.
     */
    userEditedTitle: v.optional(v.boolean()),
  })
    .index("by_repositoryId_and_lastMessageAt", ["repositoryId", "lastMessageAt"])
    .index("by_ownerTokenIdentifier_and_lastMessageAt", ["ownerTokenIdentifier", "lastMessageAt"])
    /**
     * Repoless-thread range read. Convex treats `undefined` as a distinct
     * index key, so an `.eq("repositoryId", undefined)` range over this index
     * scans only the repoless slice rather than filtering the whole owner
     * table. Powers `chat.threads.listRepolessThreads` and the
     * repoless-shell "Chats" sidebar section.
     */
    .index("by_ownerTokenIdentifier_repoless_and_lastMessageAt", [
      "ownerTokenIdentifier",
      "repositoryId",
      "lastMessageAt",
    ])
    .index("by_repositoryId_and_pinnedAt", ["repositoryId", "pinnedAt"])
    .index("by_repositoryId_and_mode", ["repositoryId", "mode"])
    .index("by_repositoryId_mode_and_lastMessageAt", ["repositoryId", "mode", "lastMessageAt"])
    .index("by_repositoryId_mode_and_pinnedAt", ["repositoryId", "mode", "pinnedAt"])
    .index("by_mode", ["mode"]),

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
     * Per-message cost estimate in USD, computed from the model's reported
     * usage and a snapshot pricing table at finalize time
     * (`convex/lib/llmPricing.ts`). Used by:
     *
     *   1. The chat bubble cost-ticker ("~$0.03 (1.2k tokens, 5 tools)")
     *      so the user can correlate spend to specific replies.
     *   2. Audit / debugging — `messages.estimatedCostUsd` plus
     *      `jobs.estimatedCostUsd` lets us reconcile the per-message
     *      cost against the per-job total when an investigation needs
     *      a finer breakdown than the job-level rollup.
     *
     * Optional and only written for assistant replies whose model is in the
     * pricing table (discuss / library heuristic replies keep the field
     * unset rather than stored as 0), so the frontend can render "—" when
     * cost is genuinely unknown vs. "$0.00" when it is genuinely zero.
     */
    estimatedCostUsd: v.optional(v.number()),
    /**
     * Discuss-mode per-message grounding flags. Both are optional and
     * meaningful only for `mode === "discuss"` messages — Library Mode
     * replies do not consult these (their grounding is implicit in the
     * mode). When both are unset / false the reply is unbound LLM
     * training-only chat; the flags compose independently:
     *
     *   - `groundLibrary: true` — artifact-grounded reply with `[A#]`
     *     citations against the repository's design artifacts.
     *   - `groundSandbox: true` — live-source-grounded reply with
     *     `[path:line]` citations and read-only sandbox tool calls.
     *
     * Persisted on both the user message (as a record of what the user
     * asked for) and the assistant placeholder (so the generation action
     * can read them off the queued message). Both stay unset on
     * `library` mode messages.
     */
    groundLibrary: v.optional(v.boolean()),
    groundSandbox: v.optional(v.boolean()),
    /**
     * Numbered artifact citation map for `library` mode replies. Index 1 in
     * the array is the artifact the prompt rendered as `## [A1] …`, index 2
     * the `[A2]` artifact, and so on. The frontend uses this to turn `[A#]`
     * tokens in the assistant's content into links that jump to the right
     * artifact in the side panel. Optional and only written when the reply
     * actually had artifacts in scope (library mode).
     */
    citationMap: v.optional(
      v.array(
        v.object({
          index: v.number(),
          artifactId: v.id("artifacts"),
          /**
           * Chunk-level citation. The Library Ask flow writes one entry per
           * retrieved chunk so `[A1#section]` deep-links jump to the
           * matching heading. Optional so `library`-mode rows that only
           * carry `index + artifactId` continue to validate.
           */
          chunkId: v.optional(v.id("artifactChunks")),
          /**
           * Heading path snapshot frozen at retrieval time. Used by the
           * frontend to render "Section X.Y" beside the citation chip and
           * to scroll the artifact tab to the right heading without an
           * extra round-trip into the chunk row.
           */
          headingPath: v.optional(v.array(v.string())),
        }),
      ),
    ),
    /**
     * Frozen tool-call trace for finalized assistant replies.
     *
     * Folded from the ephemeral `messageToolCallEvents` table at finalize
     * time so the durable `messages` row carries the full, post-streaming
     * trace without joining a second table. Optional and only written when
     * the reply actually ran tools (non-sandbox replies keep the field unset
     * rather than `[]` — the frontend treats both as "no trace").
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
     * Sandbox-grounded citation lint output.
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
     * / fail / cancel time. Optional and only written for sandbox-grounded
     * replies (`groundSandbox === true`) that produced at least one
     * flagged sentence (ungrounded Discuss / Library replies keep the field
     * unset rather than `[]` — the renderer treats both as "no highlights").
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
    /**
     * Reasoning trace from extended-thinking models (OpenAI o-series,
     * Anthropic thinking). Frozen at finalize time, alongside `content`.
     * Optional and only written when the model emitted `reasoning-delta`
     * events during the stream; reasoning-less models keep this unset.
     */
    reasoning: v.optional(v.string()),
    /**
     * Wall-clock duration of the reasoning phase in milliseconds. Drives
     * the "Thought for N seconds" label in the `<Reasoning>` UI. Optional
     * and paired with `reasoning` — if one is set, both should be.
     */
    reasoningDurationMs: v.optional(v.number()),
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
    /**
     * Live reasoning tail. Mirrors how `compactedContent` works for text,
     * but reasoning chunks are appended into the same stream row rather
     * than a separate chunks table — reasoning volume is bounded
     * (a few KB) and doesn't benefit from sequence-based compaction.
     * Optional so streams started before this column was added still load.
     */
    liveReasoning: v.optional(v.string()),
    reasoningStartedAt: v.optional(v.number()),
    reasoningEndedAt: v.optional(v.number()),
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
   * Ephemeral tool-call event log used to drive the live ticker
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
   *   - `inputSummary` / `outputSummary` are pre-redacted and length-capped
   *     in `chat/streaming.ts` so a runaway tool result can't exceed
   *     Convex's 1 MB document size when folded into `messages.toolCalls`.
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
   * Sandbox tool-call audit log.
   *
   * One row per *completed* sandbox tool execution (success or tool-reported
   * error). Distinct from `messageToolCallEvents` (the ephemeral ticker
   * feed, drained at finalize) and `messages.toolCalls` (the frozen
   * per-message trace, lives as long as the parent message): this table is
   * the long-lived compliance / internal-debugging trail. It outlives
   * individual messages so a thread deletion does not erase the record of
   * which files were read or which commands were run.
   *
   * Lifecycle:
   *   - **Append**: written from `convex/chat/generation.ts` once per
   *     `tool-result` / `tool-error` event the AI SDK surfaces, *after*
   *     the matching `messageToolCallEvents` row, via
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
   *     `SANDBOX_TOOL_CALL_LOG_INPUT_MAX_CHARS` (2000) — distinct from the
   *     UI-visible 600-char cap so audit recording preserves more of long
   *     `run_shell` invocations.
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

  /**
   * Markdown-aware chunks of every artifact, indexed for hybrid lexical +
   * embedding retrieval by Library Ask. Only the *latest* version's chunks
   * live here — the indexing pipeline replaces the row set in one
   * transaction when an artifact bumps version. Historical versions are
   * still recoverable from `artifacts.contentMarkdown`, but Ask only ever
   * answers against the current snapshot.
   *
   * Why a separate table:
   *   - Per-chunk vector + search indexes need a row-per-chunk anyway.
   *   - Chunks churn (every artifact update rewrites them) and would
   *     otherwise contend with the artifact row's stable fields.
   *   - Cascading delete on artifact removal stays bounded.
   *
   * Field notes:
   *   - `artifactVersion` is the snapshot of `artifacts.version` at write
   *     time so a stale indexer continuation aborts cleanly when the
   *     parent has moved on.
   *   - `embedding` is optional so a transient OpenAI failure doesn't
   *     block lexical retrieval. The retrieval layer treats `undefined`
   *     embeddings as "lexical-only candidate" and the cron retries the
   *     embed.
   *   - `headingPath` is the H1/H2/H3 stack the chunker accumulated as it
   *     walked the markdown — `["Architecture", "Components", "API
   *     Layer"]` etc. Surfaces both as a citation chip tooltip and as a
   *     deep-link anchor to the exact heading inside the artifact.
   */
  artifactChunks: defineTable({
    ownerTokenIdentifier: v.string(),
    repositoryId: v.id("repositories"),
    artifactId: v.id("artifacts"),
    artifactVersion: v.number(),
    chunkIndex: v.number(),
    headingPath: v.array(v.string()),
    startOffset: v.number(),
    endOffset: v.number(),
    content: v.string(),
    summary: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_artifactId_and_chunkIndex", ["artifactId", "chunkIndex"])
    .index("by_repositoryId", ["repositoryId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["repositoryId", "artifactId"],
    })
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["repositoryId", "artifactId"],
    })
    .searchIndex("search_summary", {
      searchField: "summary",
      filterFields: ["repositoryId", "artifactId"],
    }),

  /**
   * Repository-level sandbox session: at most one `active` row per repository
   * at any time, shared across every Discuss thread for that repository whose
   * user has enabled the Sandbox grounding toggle. Session lifecycle:
   *
   *   `starting` → `active` → `paused` (idle auto-pause) → `active`
   *                                  ↘                        ↗
   *                                   `stopped` (user) / `ended` (cleanup)
   *
   * Cost transparency lives entirely on this row — `spentCents` is the
   * per-session running total. `idleAutoPauseMinutes` drives the cron in
   * `convex/crons.ts` so the value is observable in the dashboard rather
   * than hidden in env-var-only config.
   *
   * Indexes:
   *   - `by_repositoryId_and_status` answers "is there an active / paused
   *     session for this repository right now?" in O(1).
   *   - `by_status_and_lastActivityAt` powers the auto-pause cron — find
   *     all `active` sessions with `lastActivityAt < now - 10m`.
   *   - `by_ownerTokenIdentifier_and_startedAt` is for the daily cost
   *     rollup over a viewer's sessions.
   */
  sandboxSessions: defineTable({
    ownerTokenIdentifier: v.string(),
    repositoryId: v.id("repositories"),
    sandboxId: v.optional(v.id("sandboxes")),
    status: v.union(
      v.literal("starting"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("stopped"),
      v.literal("ended"),
    ),
    startedAt: v.number(),
    lastActivityAt: v.number(),
    lastResumedAt: v.optional(v.number()),
    pausedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    idleAutoPauseMinutes: v.number(),
    spentCents: v.number(),
  })
    .index("by_repositoryId_and_status", ["repositoryId", "status"])
    .index("by_repositoryId_and_startedAt", ["repositoryId", "startedAt"])
    .index("by_status_and_lastActivityAt", ["status", "lastActivityAt"])
    .index("by_ownerTokenIdentifier_and_startedAt", ["ownerTokenIdentifier", "startedAt"]),
});
