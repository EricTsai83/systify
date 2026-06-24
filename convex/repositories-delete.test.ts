/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CASCADE_BATCH_SIZE } from "./lib/constants";
import { REPOSITORY_OWNED_DATA_LIFECYCLE_REGISTRY } from "./lib/repositoryOwnedDataLifecycle";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function makeHarness() {
  return convexTest(schema, modules);
}

type TestHarness = ReturnType<typeof makeHarness>;

const {
  assertSandboxProvisioningConfiguredMock,
  cloneRepositoryInSandboxMock,
  deleteSandboxMock,
  getSandboxStateMock,
  provisionSandboxMock,
  stopSandboxMock,
} = vi.hoisted(() => ({
  assertSandboxProvisioningConfiguredMock: vi.fn(),
  cloneRepositoryInSandboxMock: vi.fn(),
  deleteSandboxMock: vi.fn(),
  getSandboxStateMock: vi.fn(),
  provisionSandboxMock: vi.fn(),
  stopSandboxMock: vi.fn(),
}));

vi.mock("./daytona", () => ({
  assertSandboxProvisioningConfigured: assertSandboxProvisioningConfiguredMock,
  cloneRepositoryInSandbox: cloneRepositoryInSandboxMock,
  deleteSandbox: deleteSandboxMock,
  getSandboxState: getSandboxStateMock,
  provisionSandbox: provisionSandboxMock,
  stopSandbox: stopSandboxMock,
}));

async function seedRepositoryGraph(
  t: TestHarness,
  args: {
    ownerTokenIdentifier: string;
    sandboxStatus?: "ready" | "archived";
    repositoryDeleteSandboxCleanupAttempts?: number;
  },
): Promise<{
  repositoryId: Id<"repositories">;
  threadId: Id<"threads">;
  assistantMessageId: Id<"messages">;
  streamId: Id<"messageStreams">;
  artifactId: Id<"artifacts">;
  threadArtifactId: Id<"artifacts">;
  repoHtmlStorageId: Id<"_storage">;
  threadHtmlStorageId: Id<"_storage">;
  draftHtmlStorageId: Id<"_storage">;
  remoteId: string;
}> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const remoteId = "remote-delete-graph";
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/delete-graph",
      sourceRepoFullName: "acme/delete-graph",
      sourceRepoOwner: "acme",
      sourceRepoName: "delete-graph",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: ["TypeScript"],
      packageManagers: ["bun"],
      entrypoints: ["src/main.ts"],
      fileCount: 1,
      color: "blue",
      lastAccessedAt: now,
      archivedAt: now,
      deletionRequestedAt: now,
      repositoryDeleteSandboxCleanupAttempts: args.repositoryDeleteSandboxCleanupAttempts,
    });

    await ctx.db.insert("userPreferences", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      lastActiveRepositoryId: repositoryId,
      lastActiveRepositoryUpdatedAt: now,
    });

    const importJobId = await ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: "import",
      status: "completed",
      stage: "completed",
      progress: 1,
      costCategory: "indexing",
      triggerSource: "user",
      completedAt: now,
    });
    const chatJobId = await ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: "chat",
      status: "completed",
      stage: "completed",
      progress: 1,
      costCategory: "chat",
      triggerSource: "user",
      completedAt: now,
    });
    const importId = await ctx.db.insert("imports", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      sourceUrl: "https://github.com/acme/delete-graph",
      adapterKind: "git_clone",
      status: "completed",
      jobId: importJobId,
      completedAt: now,
    });
    const fileId = await ctx.db.insert("repoFiles", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      importId,
      path: "src/main.ts",
      parentPath: "src",
      fileType: "file",
      extension: "ts",
      language: "TypeScript",
      sizeBytes: 42,
      isEntryPoint: true,
      isConfig: false,
      isImportant: true,
    });
    await ctx.db.insert("repoChunks", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      importId,
      fileId,
      path: "src/main.ts",
      chunkIndex: 0,
      startLine: 1,
      endLine: 3,
      chunkKind: "code",
      summary: "main",
      content: "export {}",
    });

    const folderId = await ctx.db.insert("artifactFolders", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      name: "Overview",
      systemKey: "overview",
    });
    const artifactId = await ctx.db.insert("artifacts", {
      repositoryId,
      jobId: importJobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: "readme_summary",
      title: "README Summary",
      description: "Summary",
      contentMarkdown: "# Summary",
      renderFormat: "html",
      version: 1,
      folderId,
    });
    const repoHtmlStorageId = await ctx.storage.store(
      new Blob(["<!doctype html><html><head></head><body>repo artifact</body></html>"], {
        type: "text/html",
      }),
    );
    const artifactVersionId = await ctx.db.insert("artifactVersions", {
      artifactId,
      version: 1,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      title: "README Summary",
      description: "Summary",
      contentMarkdown: "# Summary",
      renderFormat: "html",
      htmlStorageId: repoHtmlStorageId,
      htmlHash: "repo-html-hash",
      htmlByteLength: 64,
      htmlValidationStatus: "valid",
      createdAt: now,
      jobId: importJobId,
    });
    await ctx.db.patch(artifactId, { currentVersionId: artifactVersionId });
    await ctx.db.insert("artifactChunks", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      artifactId,
      artifactVersion: 1,
      chunkIndex: 0,
      headingPath: ["Summary"],
      startOffset: 0,
      endOffset: 9,
      content: "# Summary",
    });
    await ctx.db.insert("artifactViews", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      artifactId,
      viewedAt: now,
    });
    const draftHtmlStorageId = await ctx.storage.store(
      new Blob(["<!doctype html><html><head></head><body>draft</body></html>"], {
        type: "text/html",
      }),
    );
    await ctx.db.insert("artifactDrafts", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      jobId: importJobId,
      operation: "create",
      status: "ready",
      prompt: "Draft a runbook.",
      title: "Draft runbook",
      description: "Draft summary",
      contentMarkdown: "# Draft",
      outputFormat: "html",
      htmlStorageId: draftHtmlStorageId,
      htmlHash: "draft-html-hash",
      htmlByteLength: 59,
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 1,
      createdAt: now,
      updatedAt: now,
      generatedAt: now,
    });
    await ctx.db.insert("repositoryViewerBootstraps", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      bootstrapAt: now,
    });
    await ctx.db.insert("systemDesignKindRuns", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      jobId: importJobId,
      kind: "readme_summary",
      artifactId,
      provider: "openai",
      modelName: "gpt-5.5",
      promptVersion: 1,
      stepCap: 1,
      actualSteps: 1,
      durationMs: 10,
      status: "succeeded",
      startedAt: now,
    });

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      title: "Delete graph thread",
      mode: "discuss",
      lastMessageAt: now,
    });
    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId: chatJobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      role: "assistant",
      status: "completed",
      mode: "discuss",
      content: "Done",
    });
    const threadArtifactId = await ctx.db.insert("artifacts", {
      threadId,
      jobId: chatJobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: "custom_document",
      title: "Thread note",
      description: "Thread-local artifact",
      contentMarkdown: "# Thread note",
      renderFormat: "html",
      version: 1,
    });
    const threadHtmlStorageId = await ctx.storage.store(
      new Blob(["<!doctype html><html><head></head><body>thread artifact</body></html>"], {
        type: "text/html",
      }),
    );
    const threadArtifactVersionId = await ctx.db.insert("artifactVersions", {
      artifactId: threadArtifactId,
      version: 1,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      title: "Thread note",
      description: "Thread-local artifact",
      contentMarkdown: "# Thread note",
      renderFormat: "html",
      htmlStorageId: threadHtmlStorageId,
      htmlHash: "thread-html-hash",
      htmlByteLength: 68,
      htmlValidationStatus: "valid",
      createdAt: now,
      jobId: chatJobId,
    });
    await ctx.db.patch(threadArtifactId, { currentVersionId: threadArtifactVersionId });
    await ctx.db.insert("messageToolCallEvents", {
      messageId: assistantMessageId,
      toolCallId: "call-1",
      sequence: 0,
      type: "start",
      toolName: "read_file",
      inputSummary: "src/main.ts",
      occurredAt: now,
    });
    const streamId = await ctx.db.insert("messageStreams", {
      repositoryId,
      threadId,
      jobId: chatJobId,
      assistantMessageId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      compactedContent: "",
      compactedThroughSequence: 0,
      nextSequence: 1,
      startedAt: now,
      lastAppendedAt: now,
    });
    await ctx.db.insert("messageStreamChunks", {
      streamId,
      sequence: 0,
      text: "Done",
    });
    await ctx.db.insert("threadShares", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      threadId,
      repositoryId,
      token: "share-delete-graph-token",
      tokenPrefix: "share-delete",
      createdAt: now,
      expiresAt: now + 60_000,
    });
    await ctx.db.insert("chatHistoryGroups", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      groupKey: `repository:${repositoryId}`,
      repositoryId,
      lastThreadAt: now,
      lastThreadId: threadId,
      threadCount: 1,
    });
    await ctx.db.insert("archivedThreadScopes", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      scopeKey: `repository:${repositoryId}`,
      repositoryId,
      lastArchivedAt: now,
      lastThreadId: threadId,
      threadCount: 1,
    });

    const sandboxId = await ctx.db.insert("sandboxes", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      provider: "daytona",
      sourceAdapter: "git_clone",
      remoteId,
      status: args.sandboxStatus ?? "archived",
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      ttlExpiresAt: now + 60_000,
      autoStopIntervalMinutes: 30,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 120,
      networkBlockAll: false,
    });
    await ctx.db.insert("sandboxRemoteObservations", {
      remoteId,
      sandboxId,
      repositoryId,
      organizationId: "org-delete-graph",
      lastObservedState: "started",
      lastObservedAt: now,
      lastWebhookAt: now,
      lastAcceptedEventAt: now,
      discoveryStatus: "known",
      firstSeenAt: now,
    });
    await ctx.db.insert("sandboxSessions", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      sandboxId,
      status: "ended",
      startedAt: now,
      lastActivityAt: now,
      endedAt: now,
      idleAutoPauseMinutes: 10,
      spentCents: 1,
    });
    await ctx.db.insert("sandboxToolCallLog", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      threadId,
      messageId: assistantMessageId,
      sandboxId,
      toolName: "read_file",
      inputJson: '{"path":"src/main.ts"}',
      outputBytes: 42,
      durationMs: 5,
      redactedFields: [],
    });

    await ctx.db.patch(repositoryId, {
      latestImportId: importId,
      latestImportJobId: importJobId,
      latestSandboxId: sandboxId,
      defaultThreadId: threadId,
    });

    return {
      repositoryId,
      threadId,
      assistantMessageId,
      streamId,
      artifactId,
      threadArtifactId,
      repoHtmlStorageId,
      threadHtmlStorageId,
      draftHtmlStorageId,
      remoteId,
    };
  });
}

async function collectRepositoryDeleteState(
  t: TestHarness,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    threadId: Id<"threads">;
    assistantMessageId: Id<"messages">;
    streamId: Id<"messageStreams">;
    artifactId: Id<"artifacts">;
    threadArtifactId: Id<"artifacts">;
    repoHtmlStorageId: Id<"_storage">;
    threadHtmlStorageId: Id<"_storage">;
    draftHtmlStorageId: Id<"_storage">;
    remoteId: string;
  },
) {
  return await t.run(async (ctx) => {
    const userPreferences = await ctx.db
      .query("userPreferences")
      .withIndex("by_ownerTokenIdentifier", (q) => q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier))
      .unique();

    return {
      repository: await ctx.db.get(args.repositoryId),
      userPreferences,
      sandboxes: await ctx.db
        .query("sandboxes")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      sandboxSessions: await ctx.db
        .query("sandboxSessions")
        .withIndex("by_repositoryId_and_startedAt", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      jobs: await ctx.db
        .query("jobs")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      imports: await ctx.db
        .query("imports")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      repoFiles: await ctx.db
        .query("repoFiles")
        .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      repoChunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      artifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      artifactVersions: [
        ...(await ctx.db
          .query("artifactVersions")
          .withIndex("by_artifactId", (q) => q.eq("artifactId", args.artifactId))
          .collect()),
        ...(await ctx.db
          .query("artifactVersions")
          .withIndex("by_artifactId", (q) => q.eq("artifactId", args.threadArtifactId))
          .collect()),
      ],
      artifactChunks: await ctx.db
        .query("artifactChunks")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      artifactFolders: await ctx.db
        .query("artifactFolders")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      artifactDrafts: await ctx.db
        .query("artifactDrafts")
        .withIndex("by_repositoryId_and_status", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      artifactViews: await ctx.db
        .query("artifactViews")
        .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
          q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("repositoryId", args.repositoryId),
        )
        .collect(),
      repositoryViewerBootstraps: await ctx.db
        .query("repositoryViewerBootstraps")
        .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
          q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("repositoryId", args.repositoryId),
        )
        .collect(),
      systemDesignKindRuns: await ctx.db
        .query("systemDesignKindRuns")
        .withIndex("by_repositoryId_and_kind", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      threadShares: await ctx.db
        .query("threadShares")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      chatHistoryGroups: await ctx.db
        .query("chatHistoryGroups")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      archivedThreadScopes: await ctx.db
        .query("archivedThreadScopes")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      threads: await ctx.db
        .query("threads")
        .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", args.repositoryId))
        .collect(),
      threadArtifacts: await ctx.db
        .query("artifacts")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .collect(),
      htmlStorageMetadata: {
        repo: await ctx.db.system.get(args.repoHtmlStorageId),
        thread: await ctx.db.system.get(args.threadHtmlStorageId),
        draft: await ctx.db.system.get(args.draftHtmlStorageId),
      },
      messages: await ctx.db
        .query("messages")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .collect(),
      messageToolCallEvents: await ctx.db
        .query("messageToolCallEvents")
        .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", args.assistantMessageId))
        .collect(),
      messageStreams: await ctx.db
        .query("messageStreams")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .collect(),
      messageStreamChunks: await ctx.db
        .query("messageStreamChunks")
        .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", args.streamId))
        .collect(),
      sandboxRemoteObservations: await ctx.db
        .query("sandboxRemoteObservations")
        .withIndex("by_remoteId", (q) => q.eq("remoteId", args.remoteId))
        .collect(),
      sandboxToolCallLog: await ctx.db
        .query("sandboxToolCallLog")
        .withIndex("by_owner_and_time", (q) => q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier))
        .collect(),
    };
  });
}

describe("repository deletion cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    assertSandboxProvisioningConfiguredMock.mockReset();
    cloneRepositoryInSandboxMock.mockReset();
    deleteSandboxMock.mockReset();
    getSandboxStateMock.mockReset();
    provisionSandboxMock.mockReset();
    stopSandboxMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("repository-owned data lifecycle registry covers cascade and retained tables", () => {
    const expectedTables = [
      "archivedThreadScopes",
      "artifactChunks",
      "artifactDrafts",
      "artifactFolders",
      "artifactViews",
      "artifacts",
      "artifactVersions",
      "chatHistoryGroups",
      "imports",
      "jobs",
      "messageStreamChunks",
      "messageStreams",
      "messageToolCallEvents",
      "messages",
      "repoChunks",
      "repoFiles",
      "repositories",
      "repositoryViewerBootstraps",
      "sandboxRemoteObservations",
      "sandboxSessions",
      "sandboxToolCallLog",
      "sandboxes",
      "systemDesignKindRuns",
      "threadShares",
      "threads",
      "userPreferences",
    ].sort();
    const registryTables = REPOSITORY_OWNED_DATA_LIFECYCLE_REGISTRY.map((entry) => entry.table);
    const retainedEntries = REPOSITORY_OWNED_DATA_LIFECYCLE_REGISTRY.filter((entry) => entry.disposition === "retain");

    expect(new Set(registryTables).size).toBe(registryTables.length);
    expect([...registryTables].sort()).toEqual(expectedTables);
    expect(retainedEntries.map((entry) => entry.table)).toEqual(["sandboxToolCallLog"]);
    expect(retainedEntries[0]?.cleanupPath).toContain("90-day TTL");
    expect(
      REPOSITORY_OWNED_DATA_LIFECYCLE_REGISTRY.filter((entry) => entry.disposition !== "retain").map(
        (entry) => entry.table,
      ),
    ).not.toContain("sandboxToolCallLog");
    for (const entry of REPOSITORY_OWNED_DATA_LIFECYCLE_REGISTRY) {
      expect(entry.order).toEqual(expect.any(Number));
      expect(entry.retryPolicy).toMatch(/^(none|immediate|sandboxCleanup)$/);
      if (entry.disposition === "retain") {
        expect(entry.adapterKey).toBeUndefined();
      } else {
        expect(entry.adapterKey).toEqual(expect.any(String));
      }
    }
  });

  test("cascadeDeleteRepository removes the repository-scoped data graph when sandboxes are already archived", async () => {
    const ownerTokenIdentifier = "user|cascade-graph";
    const t = makeHarness();
    const ids = await seedRepositoryGraph(t, { ownerTokenIdentifier, sandboxStatus: "archived" });

    await t.mutation(internal.repositories.cascadeDeleteRepository, { repositoryId: ids.repositoryId });

    const state = await collectRepositoryDeleteState(t, { ownerTokenIdentifier, ...ids });
    expect(state.repository).toBeNull();
    expect(state.userPreferences?.lastActiveRepositoryId).toBeUndefined();
    expect(state.sandboxes).toHaveLength(0);
    expect(state.sandboxSessions).toHaveLength(0);
    expect(state.jobs).toHaveLength(0);
    expect(state.imports).toHaveLength(0);
    expect(state.repoFiles).toHaveLength(0);
    expect(state.repoChunks).toHaveLength(0);
    expect(state.artifacts).toHaveLength(0);
    expect(state.artifactVersions).toHaveLength(0);
    expect(state.artifactChunks).toHaveLength(0);
    expect(state.artifactFolders).toHaveLength(0);
    expect(state.artifactDrafts).toHaveLength(0);
    expect(state.artifactViews).toHaveLength(0);
    expect(state.repositoryViewerBootstraps).toHaveLength(0);
    expect(state.systemDesignKindRuns).toHaveLength(0);
    expect(state.threadShares).toHaveLength(0);
    expect(state.chatHistoryGroups).toHaveLength(0);
    expect(state.archivedThreadScopes).toHaveLength(0);
    expect(state.threads).toHaveLength(0);
    expect(state.threadArtifacts).toHaveLength(0);
    expect(state.htmlStorageMetadata).toEqual({ repo: null, thread: null, draft: null });
    expect(state.messages).toHaveLength(0);
    expect(state.messageToolCallEvents).toHaveLength(0);
    expect(state.messageStreams).toHaveLength(0);
    expect(state.messageStreamChunks).toHaveLength(0);
    expect(state.sandboxRemoteObservations).toHaveLength(1);
    expect(state.sandboxRemoteObservations[0]?.discoveryStatus).toBe("ignored");
    expect(state.sandboxRemoteObservations[0]?.repositoryId).toBeUndefined();
    expect(state.sandboxRemoteObservations[0]?.sandboxId).toBeUndefined();
    expect(state.sandboxToolCallLog).toHaveLength(1);
    expect(state.sandboxToolCallLog[0]?.messageId).toBe(ids.assistantMessageId);
  });

  test("cascadeDeleteRepository waits for live sandbox cleanup before deleting repository jobs", async () => {
    const ownerTokenIdentifier = "user|cascade-waits";
    const t = makeHarness();
    const ids = await seedRepositoryGraph(t, { ownerTokenIdentifier, sandboxStatus: "ready" });

    await t.mutation(internal.repositories.cascadeDeleteRepository, { repositoryId: ids.repositoryId });

    const state = await collectRepositoryDeleteState(t, { ownerTokenIdentifier, ...ids });
    expect(state.repository).not.toBeNull();
    expect(state.sandboxes).toHaveLength(1);
    expect(state.sandboxes[0]?.status).toBe("ready");
    expect(state.jobs.some((job) => job.kind === "cleanup" && job.status === "queued")).toBe(true);
    expect(state.jobs.some((job) => job.kind === "import")).toBe(true);
    expect(state.jobs.some((job) => job.kind === "chat")).toBe(true);
    expect(state.sandboxRemoteObservations).toHaveLength(1);
    expect(state.sandboxRemoteObservations[0]?.discoveryStatus).toBe("known");
    expect(state.sandboxRemoteObservations[0]?.repositoryId).toBe(ids.repositoryId);
    expect(deleteSandboxMock).not.toHaveBeenCalled();
  });

  test("cascadeDeleteRepository marks deletion failed when sandbox cleanup retries are exhausted", async () => {
    const ownerTokenIdentifier = "user|cascade-retry-exhausted";
    const t = makeHarness();
    const ids = await seedRepositoryGraph(t, {
      ownerTokenIdentifier,
      sandboxStatus: "ready",
      repositoryDeleteSandboxCleanupAttempts: 24,
    });

    await t.mutation(internal.repositories.cascadeDeleteRepository, { repositoryId: ids.repositoryId });

    const state = await collectRepositoryDeleteState(t, { ownerTokenIdentifier, ...ids });
    expect(state.repository).not.toBeNull();
    expect(state.repository?.repositoryDeleteFailedAt).toEqual(expect.any(Number));
    expect(state.repository?.repositoryDeleteFailureMessage).toMatch(/sandbox cleanup retries/);
    expect(state.sandboxes).toHaveLength(1);
    expect(state.sandboxes[0]?.status).toBe("failed");
    expect(state.sandboxes[0]?.lastErrorMessage).toMatch(/exceeded 24 retries/);
    expect(state.jobs.some((job) => job.kind === "cleanup")).toBe(false);
    expect(state.sandboxRemoteObservations).toHaveLength(1);
    expect(state.sandboxRemoteObservations[0]?.discoveryStatus).toBe("known");
    expect(state.sandboxRemoteObservations[0]?.repositoryId).toBe(ids.repositoryId);
    expect(deleteSandboxMock).not.toHaveBeenCalled();
  });

  test("cascadeDeleteRepository drains large repository-owned row sets through scheduled batches", async () => {
    const ownerTokenIdentifier = "user|cascade-batches";
    const t = makeHarness();
    const ids = await seedRepositoryGraph(t, { ownerTokenIdentifier, sandboxStatus: "archived" });

    await t.run(async (ctx) => {
      for (let index = 0; index < CASCADE_BATCH_SIZE + 5; index += 1) {
        await ctx.db.insert("artifactChunks", {
          ownerTokenIdentifier,
          repositoryId: ids.repositoryId,
          artifactId: ids.artifactId,
          artifactVersion: 1,
          chunkIndex: index + 1,
          headingPath: ["Overflow"],
          startOffset: index,
          endOffset: index + 1,
          content: `chunk ${index}`,
        });
      }
    });

    await t.mutation(internal.repositories.cascadeDeleteRepository, { repositoryId: ids.repositoryId });

    const afterFirstBatch = await t.run(async (ctx) => ({
      repository: await ctx.db.get(ids.repositoryId),
    }));
    expect(afterFirstBatch.repository).not.toBeNull();

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const finalState = await collectRepositoryDeleteState(t, { ownerTokenIdentifier, ...ids });
    expect(finalState.repository).toBeNull();
    expect(finalState.artifactChunks).toHaveLength(0);
    expect(finalState.artifactVersions).toHaveLength(0);
    expect(finalState.htmlStorageMetadata).toEqual({ repo: null, thread: null, draft: null });
    expect(finalState.sandboxToolCallLog).toHaveLength(1);
  });

  test("deleteRepository deletes the remote sandbox before removing sandbox records", async () => {
    const ownerTokenIdentifier = "user|delete-cleanup";
    const t = makeHarness();
    deleteSandboxMock.mockResolvedValue(undefined);

    const repositoryId = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/delete-cleanup",
        sourceRepoFullName: "acme/delete-cleanup",
        sourceRepoOwner: "acme",
        sourceRepoName: "delete-cleanup",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });

      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-delete-cleanup",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });

      await ctx.db.patch(repositoryId, {
        latestSandboxId: sandboxId,
      });

      return repositoryId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    // The archive feature requires a repository to be archived before
    // permanent deletion. Archive first so the cascade path under test
    // is reached.
    await viewer.mutation(api.repositories.archiveRepository, { repositoryId });
    await viewer.mutation(api.repositories.deleteRepository, { repositoryId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(deleteSandboxMock).toHaveBeenCalledWith("remote-delete-cleanup");

    const remainingState = await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      const sandboxes = await ctx.db
        .query("sandboxes")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
        .take(10);
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
        .take(10);

      return { repository, sandboxes, jobs };
    });

    expect(remainingState.repository).toBeNull();
    expect(remainingState.sandboxes).toHaveLength(0);
    expect(remainingState.jobs).toHaveLength(0);
  });
});
