/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createTestConvex, type SystifyTestConvex } from "../../test/convex/harness";

const mocks = vi.hoisted(() => {
  class MockSandboxPreparationError extends Error {
    readonly reason: string;
    readonly userFacingMessage: string;

    constructor(message: string, reason = "live_source_unavailable") {
      super(message);
      this.name = "SandboxPreparationError";
      this.reason = reason;
      this.userFacingMessage = message;
    }
  }

  return {
    ensureSandboxReady: vi.fn(),
    MockSandboxPreparationError,
    getSandboxFsClient: vi.fn(),
    createSandboxTools: vi.fn(),
    hasProviderApiKey: vi.fn(),
    retrieveArtifactChunks: vi.fn(),
    consume: vi.fn(),
  };
});

vi.mock("../lib/sandboxLiveness", () => ({
  ensureSandboxReady: mocks.ensureSandboxReady,
  SandboxPreparationError: mocks.MockSandboxPreparationError,
}));

vi.mock("../daytona", () => ({
  getSandboxFsClient: mocks.getSandboxFsClient,
}));

vi.mock("./sandboxTools", () => ({
  createSandboxTools: mocks.createSandboxTools,
}));

vi.mock("../lib/providerEnv", () => ({
  hasProviderApiKey: mocks.hasProviderApiKey,
}));

vi.mock("../lib/artifactRag", () => ({
  retrieveArtifactChunks: mocks.retrieveArtifactChunks,
}));

vi.mock("./replyStreamController", () => ({
  createReplyStreamController: () => ({
    startCancellationPolling: vi.fn(),
    stopCancellationPolling: vi.fn(),
    getCancellationState: vi.fn(() => ({ wasCancelled: false, generationAborted: false })),
    getBufferedText: vi.fn(() => ""),
    getTelemetry: vi.fn(() => ({ hadTools: false, toolInvocations: 0, toolErrors: 0 })),
    consume: mocks.consume,
  }),
  formatReplyStreamError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const OWNER = "user|reply-session";

function replyActionArgs(ids: {
  threadId: Id<"threads">;
  userMessageId: Id<"messages">;
  assistantMessageId: Id<"messages">;
  jobId: Id<"jobs">;
}) {
  return {
    threadId: ids.threadId,
    userMessageId: ids.userMessageId,
    assistantMessageId: ids.assistantMessageId,
    jobId: ids.jobId,
  };
}

async function seedSandboxGroundedReply(t: SystifyTestConvex) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: OWNER,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/reply-session",
      sourceRepoFullName: "acme/reply-session",
      sourceRepoOwner: "acme",
      sourceRepoName: "reply-session",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 1,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
    const sandboxId = await ctx.db.insert("sandboxes", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      provider: "daytona",
      sourceAdapter: "git_clone",
      remoteId: "remote-prepared",
      status: "ready",
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      ttlExpiresAt: Date.now() + 60_000,
      autoStopIntervalMinutes: 10,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 1440,
      networkBlockAll: false,
    });
    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      title: "Reply session",
      mode: "discuss",
      lastMessageAt: Date.now(),
    });
    const jobId = await ctx.db.insert("jobs", {
      repositoryId,
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "chat",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "system_design",
      triggerSource: "user",
      leaseExpiresAt: Date.now() + 60_000,
    });
    const userMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier: OWNER,
      role: "user",
      status: "completed",
      mode: "discuss",
      groundSandbox: true,
      content: "Inspect the live source.",
      provider: "openai",
      modelName: "gpt-5.5",
    });
    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier: OWNER,
      role: "assistant",
      status: "pending",
      mode: "discuss",
      groundSandbox: true,
      content: "",
      provider: "openai",
      modelName: "gpt-5.5",
    });
    await ctx.db.insert("messageStreams", {
      repositoryId,
      threadId,
      jobId,
      assistantMessageId,
      ownerTokenIdentifier: OWNER,
      compactedContent: "",
      compactedThroughSequence: -1,
      nextSequence: 0,
      startedAt: Date.now(),
      lastAppendedAt: Date.now(),
    });

    return { repositoryId, sandboxId, threadId, jobId, userMessageId, assistantMessageId };
  });
}

async function seedLibraryGroundedReply(t: SystifyTestConvex) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: OWNER,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/reply-session-library",
      sourceRepoFullName: "acme/reply-session-library",
      sourceRepoOwner: "acme",
      sourceRepoName: "reply-session-library",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 1,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      title: "Library reply session",
      mode: "library",
      lastMessageAt: Date.now(),
    });
    const jobId = await ctx.db.insert("jobs", {
      repositoryId,
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "chat",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "chat",
      triggerSource: "user",
      leaseExpiresAt: Date.now() + 60_000,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_overview",
      title: "Architecture overview",
      description: "Runtime boundaries.",
      contentMarkdown: "Fallback artifact body.",
      version: 1,
    });
    await ctx.db.patch(threadId, { artifactContext: [artifactId] });
    const chunkId = await ctx.db.insert("artifactChunks", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      artifactId,
      artifactVersion: 1,
      chunkIndex: 0,
      headingPath: ["Runtime"],
      startOffset: 0,
      endOffset: 30,
      content: "Runtime evidence from retrieved chunks.",
      summary: "Runtime evidence.",
    });
    const userMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier: OWNER,
      role: "user",
      status: "completed",
      mode: "library",
      content: "What does runtime use?",
      provider: "openai",
      modelName: "gpt-5.5",
    });
    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier: OWNER,
      role: "assistant",
      status: "pending",
      mode: "library",
      content: "",
      provider: "openai",
      modelName: "gpt-5.5",
    });
    await ctx.db.insert("messageStreams", {
      repositoryId,
      threadId,
      jobId,
      assistantMessageId,
      ownerTokenIdentifier: OWNER,
      compactedContent: "",
      compactedThroughSequence: -1,
      nextSequence: 0,
      startedAt: Date.now(),
      lastAppendedAt: Date.now(),
    });

    return { repositoryId, threadId, jobId, artifactId, chunkId, userMessageId, assistantMessageId };
  });
}

beforeEach(() => {
  mocks.ensureSandboxReady.mockReset();
  mocks.getSandboxFsClient.mockReset().mockResolvedValue({ readFile: vi.fn() });
  mocks.createSandboxTools.mockReset().mockReturnValue({ read_file: {} });
  mocks.hasProviderApiKey.mockReset().mockReturnValue(true);
  mocks.retrieveArtifactChunks.mockReset().mockResolvedValue([]);
  mocks.consume.mockReset().mockResolvedValue({ kind: "completed", finalDelta: "Live answer.", usage: {} });
});

describe("runAssistantReplySession artifact grounding", () => {
  test("hydrates Library Ask artifact evidence before streaming and persists the ready citation map", async () => {
    const t = createTestConvex();
    const ids = await seedLibraryGroundedReply(t);
    mocks.retrieveArtifactChunks.mockResolvedValue([
      {
        chunkId: ids.chunkId,
        artifactId: ids.artifactId,
        artifactTitle: "Architecture overview",
        artifactKind: "architecture_overview",
        artifactVersion: 1,
        headingPath: ["Runtime"],
        content: "Runtime evidence from retrieved chunks.",
        lexicalScore: 1,
        semanticScore: 0.5,
        rrfScore: 0.03,
      },
    ]);

    await t.action(internal.chat.generation.generateAssistantReply, replyActionArgs(ids));

    expect(mocks.retrieveArtifactChunks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerTokenIdentifier: OWNER,
        repositoryId: ids.repositoryId,
        query: "What does runtime use?",
        threadId: ids.threadId,
        messageId: ids.userMessageId,
        artifactScope: [ids.artifactId],
      }),
    );
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        userPromptText: expect.stringContaining("Runtime evidence from retrieved chunks."),
        groundingAudit: { ownerTokenIdentifier: OWNER },
        sandboxTools: undefined,
      }),
    );

    const assistant = await t.run(async (ctx) => await ctx.db.get(ids.assistantMessageId));
    expect(assistant?.citationMap).toEqual([
      {
        index: 1,
        artifactId: ids.artifactId,
        artifactTitle: "Architecture overview",
        artifactKind: "architecture_overview",
        artifactVersion: 1,
        chunkId: ids.chunkId,
        headingPath: ["Runtime"],
      },
    ]);
  });
});

describe("runAssistantReplySession live-source preparation", () => {
  test("prepares live source and passes prepared sandbox tooling to the stream controller", async () => {
    const t = createTestConvex();
    const ids = await seedSandboxGroundedReply(t);
    mocks.ensureSandboxReady.mockResolvedValue({
      sandboxId: ids.sandboxId,
      remoteId: "remote-prepared",
      repoPath: "/workspace/repo",
    });

    await t.action(internal.chat.generation.generateAssistantReply, replyActionArgs(ids));

    expect(mocks.ensureSandboxReady).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: ids.repositoryId,
        ownerTokenIdentifier: OWNER,
      },
      expect.any(Function),
    );
    expect(mocks.getSandboxFsClient).toHaveBeenCalledWith("remote-prepared");
    expect(mocks.createSandboxTools).toHaveBeenCalledWith(expect.anything(), "/workspace/repo");
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        groundingAudit: {
          ownerTokenIdentifier: OWNER,
          sandboxTooling: {
            sandboxId: ids.sandboxId,
            remoteId: "remote-prepared",
            repoPath: "/workspace/repo",
          },
        },
        sandboxTools: { read_file: {} },
      }),
    );
    expect(mocks.consume.mock.calls[0]?.[0]).not.toHaveProperty("replyContext");
  });

  test("fails the assistant message when live source preparation fails", async () => {
    const t = createTestConvex();
    const ids = await seedSandboxGroundedReply(t);
    mocks.ensureSandboxReady.mockRejectedValue(new mocks.MockSandboxPreparationError("raw provider error"));

    await t.action(internal.chat.generation.generateAssistantReply, replyActionArgs(ids));

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(ids.jobId),
      assistant: await ctx.db.get(ids.assistantMessageId),
    }));
    expect(state.job?.status).toBe("failed");
    expect(state.assistant?.status).toBe("failed");
    expect(state.assistant?.errorMessage).toBe("Live source couldn't be prepared. Retry the message.");
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  test("does not call the model when cancellation lands during preparation", async () => {
    const t = createTestConvex();
    const ids = await seedSandboxGroundedReply(t);
    mocks.ensureSandboxReady.mockImplementation(async (ctx) => {
      await ctx.runMutation(internal.chat.streaming.markAssistantReplyCancelled, {
        assistantMessageId: ids.assistantMessageId,
        jobId: ids.jobId,
        reason: "Cancelled by user.",
      });
      return {
        sandboxId: ids.sandboxId as Id<"sandboxes">,
        remoteId: "remote-prepared",
        repoPath: "/workspace/repo",
      };
    });

    await t.action(internal.chat.generation.generateAssistantReply, replyActionArgs(ids));

    expect(mocks.consume).not.toHaveBeenCalled();
  });

  test("passes both artifact evidence and sandbox tools when both grounding axes are enabled", async () => {
    const t = createTestConvex();
    const ids = await seedLibraryGroundedReply(t);
    const sandboxId = await t.run(async (ctx) => {
      await ctx.db.patch(ids.threadId, { mode: "discuss" });
      await ctx.db.patch(ids.userMessageId, {
        mode: "discuss",
        groundLibrary: true,
        groundSandbox: true,
      });
      await ctx.db.patch(ids.assistantMessageId, {
        mode: "discuss",
        groundLibrary: true,
        groundSandbox: true,
      });
      return await ctx.db.insert("sandboxes", {
        repositoryId: ids.repositoryId,
        ownerTokenIdentifier: OWNER,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-both",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 10,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 1440,
        networkBlockAll: false,
      });
    });
    mocks.retrieveArtifactChunks.mockResolvedValue([
      {
        chunkId: ids.chunkId,
        artifactId: ids.artifactId,
        artifactTitle: "Architecture overview",
        artifactKind: "architecture_overview",
        artifactVersion: 1,
        headingPath: ["Runtime"],
        content: "Runtime evidence from retrieved chunks.",
        lexicalScore: 1,
        semanticScore: 0.5,
        rrfScore: 0.03,
      },
    ]);
    mocks.ensureSandboxReady.mockResolvedValue({
      sandboxId,
      remoteId: "remote-both",
      repoPath: "/workspace/repo",
    });

    await t.action(internal.chat.generation.generateAssistantReply, replyActionArgs(ids));

    expect(mocks.retrieveArtifactChunks).toHaveBeenCalled();
    expect(mocks.ensureSandboxReady).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: ids.repositoryId,
        ownerTokenIdentifier: OWNER,
      },
      expect.any(Function),
    );
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        userPromptText: expect.stringContaining("Runtime evidence from retrieved chunks."),
        groundingAudit: {
          ownerTokenIdentifier: OWNER,
          sandboxTooling: {
            sandboxId,
            remoteId: "remote-both",
            repoPath: "/workspace/repo",
          },
        },
        sandboxTools: { read_file: {} },
      }),
    );
  });
});
